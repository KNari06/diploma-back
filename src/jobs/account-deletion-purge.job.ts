/**
 * Account-Deletion Purge Job
 *
 * Daily sweep that finds soft-deleted users whose grace period has
 * elapsed and runs the full hard-purge cascade against each.
 *
 * Companion to `services/auth/account-deletion.service.ts:hardPurgeAccount`
 * — this file is just the scheduler + batching, all heavy lifting lives
 * in the service so the same code can be triggered ad-hoc from an admin
 * script.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Why setInterval and not a BullMQ repeatable
 * ──────────────────────────────────────────────────────────────────────
 *
 * The existing scheduler primitive in this codebase (`test-scheduler.job.ts`)
 * uses a process-level setInterval rather than BullMQ repeatables. We
 * follow the same pattern for consistency — one daily tick, no Redis
 * round-trips, no risk of the repeatable getting orphaned in Redis after
 * a deploy that changed its key format. The down-side (one process
 * instance fires the cron) is fine for a daily low-volume sweep.
 *
 * If the deployment moves to multi-instance with a primary/secondary
 * pattern, gate `start()` behind an env-driven leader-elect flag.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Operational notes
 * ──────────────────────────────────────────────────────────────────────
 *
 * - Picks at most BATCH_SIZE users per tick to bound the blast radius
 *   of any single tick. Anything not picked up this tick will be picked
 *   up the next day. Backlog isn't expected to exceed a handful at any
 *   real-world adoption rate.
 * - Failures on individual users are logged + skipped — the loop never
 *   throws, so a single bad row can't poison the whole sweep.
 * - Idempotent end-to-end: `hardPurgeAccount` re-checks `deleted_at` and
 *   returns early if the row was meanwhile restored by support.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { hardPurgeAccount } from '@/services/auth/account-deletion.service';

/** Max users hard-purged per tick. Generous default — the per-user
 *  cascade is cheap (storage list/remove + a handful of DELETEs). */
const BATCH_SIZE = parseInt(process.env.ACCOUNT_DELETION_PURGE_BATCH ?? '100', 10);

/** Default tick interval — 24h. Easily reducible on staging via env. */
const DEFAULT_TICK_MS = parseInt(
  process.env.ACCOUNT_DELETION_PURGE_INTERVAL_MS ?? String(24 * 60 * 60 * 1000),
  10,
);

export class AccountDeletionPurgeJob {
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Start the daily sweep. Calling `start()` twice is a no-op and logs
   * a warn — matches the test-scheduler pattern.
   *
   * @param intervalMs Override the tick interval. Used by tests; in
   *   production the env var is the canonical knob.
   */
  static start(intervalMs: number = DEFAULT_TICK_MS): void {
    if (this.intervalId) {
      logger.warn('[ACCOUNT_DELETION_PURGE] Already running');
      return;
    }

    logger.info('[ACCOUNT_DELETION_PURGE] Starting purge sweep', { intervalMs });

    // Fire once immediately so a deploy doesn't sit on a backlog for up
    // to 24h before the first tick. The initial call is async-fired,
    // not awaited, so it doesn't block server startup.
    this.tick().catch((err) => {
      logger.error('[ACCOUNT_DELETION_PURGE] Initial tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.intervalId = setInterval(() => {
      this.tick().catch((err) => {
        logger.error('[ACCOUNT_DELETION_PURGE] Scheduled tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);
    // No `.unref()` — keep the process alive on this timer the same way
    // the test scheduler does.
  }

  /** Stop the sweep. Used by tests + graceful shutdown. */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[ACCOUNT_DELETION_PURGE] Stopped');
    }
  }

  /**
   * Process one tick: pick due users and hard-purge them.
   *
   * Exported as `tick` (not `process`) to avoid colliding with Node's
   * `process` global if anyone destructures the class. Also makes it
   * easy to call from a `pnpm script` for a manual one-shot sweep.
   */
  static async tick(): Promise<{
    selected: number;
    succeeded: number;
    failed: number;
  }> {
    // Find users whose grace period has lapsed. `deletion_scheduled_for
    // <= now()` AND `deleted_at IS NOT NULL` — the latter is technically
    // redundant given the partial index but kept explicit for clarity.
    const { data: due, error } = await supabaseAdmin
      .from('users')
      .select('id, email, deletion_scheduled_for')
      .not('deleted_at', 'is', null)
      .lte('deletion_scheduled_for', new Date().toISOString())
      .limit(BATCH_SIZE);

    if (error) {
      logger.error('[ACCOUNT_DELETION_PURGE] Query for due rows failed', {
        error: error.message,
      });
      return { selected: 0, succeeded: 0, failed: 0 };
    }

    if (!due || due.length === 0) {
      logger.debug('[ACCOUNT_DELETION_PURGE] No accounts due for purge');
      return { selected: 0, succeeded: 0, failed: 0 };
    }

    logger.info('[ACCOUNT_DELETION_PURGE] Processing batch', { count: due.length });

    let succeeded = 0;
    let failed = 0;
    for (const row of due) {
      try {
        const result = await hardPurgeAccount(row.id as string);
        if (result.ok) {
          succeeded += 1;
          logger.info('[ACCOUNT_DELETION_PURGE] User purged', {
            userId: row.id,
            steps: result.steps,
          });
        } else {
          failed += 1;
          logger.warn('[ACCOUNT_DELETION_PURGE] User purge incomplete (will retry next tick)', {
            userId: row.id,
            steps: result.steps,
          });
        }
      } catch (err) {
        failed += 1;
        logger.error('[ACCOUNT_DELETION_PURGE] User purge threw (will retry next tick)', {
          userId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[ACCOUNT_DELETION_PURGE] Batch finished', {
      selected: due.length,
      succeeded,
      failed,
    });
    return { selected: due.length, succeeded, failed };
  }
}
