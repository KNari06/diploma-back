/**
 * Scheduler leader lock
 *
 * Lets the (auto-scaled) worker process host the scheduler bundle WITHOUT
 * double-firing when there are N worker replicas. Under normal operation
 * exactly one replica holds a Redis leader lock and runs the bundle; the others
 * stand by and take over within one TTL if the leader dies. The guarantee is
 * at-most-one in steady state, NOT a hard mutual exclusion: if a leader's event
 * loop stalls past the TTL (heavy GC / blocking job), another replica can
 * acquire the lock and both run the bundle until the stalled leader's next
 * renew tick (≤ LEADER_RENEW_MS) sees a foreign owner and stops. The blast
 * radius of that brief window is bounded — TestSchedulerJobHandler is per-
 * schedule atomic via claimDueSchedule(), and the sweeps are coarse-interval,
 * idempotent age-based deletes — so a double-run wastes work rather than
 * corrupting state.
 *
 * Why a single bundle-wide lock instead of per-job guards: TestSchedulerJobHandler
 * is already per-schedule safe via claimDueSchedule(), but the five sweep jobs
 * (AutoLearnRetire / AccountDeletionPurge / StaleRunReaper / AiCallLogsRetention
 * / ArtifactRetention) have NO cross-instance dedupe — they were written assuming
 * a single scheduler process. The leader lock is the one guard that makes all six
 * safe in the worker, touching only this file.
 *
 * The bundle started here MUST mirror src/scheduler/index.ts main() — that file
 * remains the entry for local docker-compose (dedicated scheduler container);
 * this path is for prod, gated by env.SCHEDULER_IN_WORKER.
 */

import { ScreenshotCaptureFeature } from '@/config/features/screenshot-capture';
import { redisConnection } from '@/config/infrastructure/queues';
import { env } from '@/config/environment/env';
import { AccountDeletionPurgeJob } from '@/jobs/account-deletion-purge.job';
import { AiCallLogsRetentionJob } from '@/jobs/ai-call-logs-retention.job';
import { ArtifactRetentionJob } from '@/jobs/artifact-retention.job';
import { AutoLearnRetireJob } from '@/jobs/auto-learn-retire.job';
import { ExpiringPlansJob } from '@/jobs/expiring-plans.job';
import { StaleRunReaperJob } from '@/jobs/stale-run-reaper.job';
import { TestSchedulerJobHandler } from '@/jobs/test-scheduler.job';
import { logger } from '@/utils/core/logger';

const LEADER_KEY = `${env.QUEUE_PREFIX}scheduler:leader`;
// TTL bounds the worst-case takeover delay after a HARD worker kill (where the
// graceful release can't run): the stale lock self-expires after at most this.
// 30s keeps takeover snappy while staying well above the 10s refresh cadence.
const LEADER_TTL_SEC = 30; // lock auto-expires if the leader dies
// When we ALREADY hold the lock, refresh at 1/3 the TTL (10s) so a brief Redis
// blip can't let it lapse.
const LEADER_RENEW_MS = 10_000;
// When we DON'T hold the lock, poll often (5s) so a fresh worker grabs the lock
// within seconds of the previous holder's TTL expiring — this is what collapses
// the post-restart "schedule fires 4-5 min late" window down to ~tens of seconds.
const LEADER_CONTEND_MS = 5_000;

// Atomic compare-and-extend / compare-and-delete. A plain GET-then-EXPIRE (or
// GET-then-DEL) is a TOCTOU race: at the TTL boundary the key can expire and be
// re-acquired by another replica between the GET and the second command, so we
// would extend / delete a lock we no longer own. Running the compare and the
// action in one server-side Lua eval removes that window. Returns 1 on success,
// 0 if the key is no longer ours.
const RENEW_IF_OWNER = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('expire', KEYS[1], ARGV[2])
  else
    return 0
  end`;
const RELEASE_IF_OWNER = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end`;

// Per-process identity so a stalled instance never renews a lock another
// replica already grabbed after our TTL lapsed.
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2)}`;

let leaderTimer: NodeJS.Timeout | null = null;
let isLeader = false;
let stopped = false;
// When renew has been failing (Redis unreachable) — used to self-demote after
// the TTL so a partitioned leader can't keep running a second bundle.
let renewFailingSince: number | null = null;

/** Start the single-instance jobs. Mirrors src/scheduler/index.ts main(). */
export function startSchedulerBundle(): void {
  TestSchedulerJobHandler.start(60000);
  AutoLearnRetireJob.start();
  AccountDeletionPurgeJob.start();
  StaleRunReaperJob.start();
  AiCallLogsRetentionJob.start();
  ExpiringPlansJob.start();
  if (ScreenshotCaptureFeature.isEnabled()) {
    ScreenshotCaptureFeature.logStatus();
    ArtifactRetentionJob.start();
  }
}

/** Stop the jobs. Mirrors src/scheduler/index.ts shutdown(). */
export function stopSchedulerBundle(): void {
  TestSchedulerJobHandler.stop();
  AutoLearnRetireJob.stop();
  AccountDeletionPurgeJob.stop();
  StaleRunReaperJob.stop();
  AiCallLogsRetentionJob.stop();
  ExpiringPlansJob.stop();
  ArtifactRetentionJob.stop();
}

/**
 * Try to acquire the leader lock (and start the bundle) or, if already leader,
 * renew it. Non-leaders that win the lock start the bundle; a leader that lost
 * the lock (stalled past TTL) stops the bundle and re-contends next tick.
 * Best-effort — any Redis error is logged and swallowed (we retry next tick).
 */
export async function tryBecomeOrRenewLeader(): Promise<void> {
  try {
    if (!isLeader) {
      const ok = await redisConnection.set(LEADER_KEY, INSTANCE_ID, 'EX', LEADER_TTL_SEC, 'NX');
      if (ok === 'OK') {
        isLeader = true;
        logger.info('[SCHEDULER_LEADER] Acquired leader lock — starting sweep bundle', {
          instance: INSTANCE_ID,
        });
        startSchedulerBundle();
      }
      return;
    }

    // Renew only if we still own it — atomic compare-and-extend (see scripts).
    const renewed = await redisConnection.eval(
      RENEW_IF_OWNER,
      1,
      LEADER_KEY,
      INSTANCE_ID,
      String(LEADER_TTL_SEC)
    );
    renewFailingSince = null; // a reachable Redis resets the failure clock
    if (renewed !== 1) {
      logger.warn('[SCHEDULER_LEADER] Lost leadership — stopping sweep bundle', {
        instance: INSTANCE_ID,
      });
      isLeader = false;
      stopSchedulerBundle();
    }
  } catch (err) {
    // A renew that THROWS (Redis unreachable / partition) does NOT prove we still
    // hold the lock — after TTL seconds of failures the key has certainly expired
    // and another replica may have acquired it. If we kept isLeader=true we'd run
    // a second bundle (double-fire). Self-demote once failures span the TTL.
    if (isLeader) {
      const now = Date.now();
      if (renewFailingSince === null) renewFailingSince = now;
      if (now - renewFailingSince >= LEADER_TTL_SEC * 1000) {
        logger.warn('[SCHEDULER_LEADER] Renew unreachable past TTL — self-demoting to avoid double-bundle', {
          instance: INSTANCE_ID,
          failingMs: now - renewFailingSince,
        });
        isLeader = false;
        stopSchedulerBundle();
        renewFailingSince = null;
      }
    }
    logger.warn('[SCHEDULER_LEADER] Leader check failed (non-fatal, will retry)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Self-rescheduling tick: poll fast (LEADER_CONTEND_MS) while we're trying to
// become leader, slow (LEADER_RENEW_MS) once we hold it. A fixed setInterval
// can't do this — and the fast contention cadence is what makes a restarted
// worker take over within seconds instead of waiting a full 30s refresh.
function scheduleNextTick(): void {
  if (stopped) return;
  const delay = isLeader ? LEADER_RENEW_MS : LEADER_CONTEND_MS;
  leaderTimer = setTimeout(async () => {
    await tryBecomeOrRenewLeader();
    scheduleNextTick();
  }, delay);
}

/** Begin contending for leadership. Idempotent. */
export function startLeaderElection(): void {
  if (leaderTimer) return; // already running
  stopped = false;
  logger.info('[SCHEDULER_LEADER] Contending for scheduler leader lock', { instance: INSTANCE_ID });
  void (async () => {
    await tryBecomeOrRenewLeader();
    scheduleNextTick();
  })();
}

/**
 * Stop contending, stop the bundle, and release the lock if we hold it (so a
 * surviving replica takes over immediately instead of waiting out the TTL).
 * Best-effort on shutdown.
 */
export async function stopLeaderElection(): Promise<void> {
  stopped = true;
  if (leaderTimer) {
    clearTimeout(leaderTimer);
    leaderTimer = null;
  }
  stopSchedulerBundle();
  // Wait for any in-flight schedule tick to finish before we release the lock /
  // let the process exit — so a deploy doesn't abandon a just-claimed schedule
  // mid-dispatch (a one_time row is already deactivated at claim time, so an
  // interrupted dispatch would lose that run with no record).
  await TestSchedulerJobHandler.waitForIdle();
  if (isLeader) {
    isLeader = false;
    try {
      // Atomic compare-and-delete: only release the lock if it is still ours,
      // so we never delete a lock another replica acquired after our TTL lapsed.
      await redisConnection.eval(RELEASE_IF_OWNER, 1, LEADER_KEY, INSTANCE_ID);
    } catch {
      // TTL will expire it; nothing more to do.
    }
  }
}
