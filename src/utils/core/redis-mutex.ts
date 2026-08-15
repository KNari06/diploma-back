/**
 * Redis mutex — owner-token acquire, compare-and-delete release, bounded wait.
 *
 * WHY THE TOKEN. A bare `SET NX EX` + `DEL` cross-releases: if the critical
 * section outlives the TTL, the lock expires, a second caller acquires it, and
 * the first caller's `DEL` then frees *the second caller's* lock — so two
 * bodies run concurrently while both believe they hold it. The release here is
 * a Lua compare-and-delete, so a holder can only ever delete its own lock.
 *
 * WHY THE WAIT. For a mutex guarding a slow, idempotent-per-caller section
 * (a CI publish), rejecting a contender outright turns a normal parallel
 * pipeline into a failed job. Waiting turns it into a queue. `waitMs: 0` keeps
 * the reject-immediately behaviour where that is the right answer.
 *
 * Modelled on `withSourceMutex` in
 * `services/testing/negative/negative-generation.service.ts`, which got this
 * right first. That copy — and the ones in `scheduler/leader.ts` and
 * `api/chat/shared/chat-test-lock.ts` — should migrate here; see
 * `.claude/deferred/`.
 */

import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

/** Delete the key ONLY if we still own it. Prevents cross-release. */
const RELEASE_IF_OWNER = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end`;

/**
 * Thrown when the LOCK ITSELF could not be reached — never for an error raised
 * by the guarded body.
 *
 * Callers need to tell those apart: an unreachable Redis is transient and
 * deserves a 503, while a failure inside the body is a real error that must
 * keep its own status and reach error monitoring. A caller that wraps the whole
 * `withRedisMutex` call in one try/catch and answers 503 would otherwise report
 * a dead database as "the mutex is briefly unavailable".
 */
export class RedisMutexUnavailableError extends Error {
  constructor(key: string, cause: unknown) {
    super(`Could not acquire Redis mutex "${key}": ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'RedisMutexUnavailableError';
  }
}

export interface RedisMutexOptions {
  /** Fully-qualified Redis key, including any namespace prefix. */
  key: string;
  /** Crash ceiling — an abandoned holder's lock expires after this. */
  ttlSec: number;
  /** Total time to wait for a busy lock. 0 (default) rejects immediately. */
  waitMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Log prefix, e.g. `CI_PUBLISH`. */
  logTag: string;
}

export type RedisMutexResult<T> =
  | { acquired: true; value: T }
  /**
   * The lock was held for the whole wait window — `fn` never ran.
   * `retryAfterSec` is the holder's REMAINING TTL, so a caller can tell the
   * client how long to actually wait instead of quoting its own wait window
   * (which is a constant and is wrong the moment the holder is nearly done).
   */
  | { acquired: false; retryAfterSec: number };

const DEFAULT_POLL_MS = 250;
/**
 * Contenders that start together would otherwise re-issue their SET in
 * lockstep for the whole window. Spread each sleep by up to this fraction.
 */
const POLL_JITTER = 0.3;

/**
 * Owner token. Only needs to be distinct between contenders, so pid plus a
 * per-process counter is enough — no dependency on clock or RNG behaviour.
 */
let tokenCounter = 0;
function nextToken(): string {
  tokenCounter = (tokenCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${process.pid}:${tokenCounter}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding `key`. Returns `{ acquired: false }` without running
 * `fn` if the lock stays busy for the whole wait window.
 *
 * Redis errors during acquire PROPAGATE — a mutex that silently degrades to
 * "no mutex" defeats its own purpose. Errors during *release* are swallowed
 * and logged, because the TTL is the backstop and the body already ran.
 */
export async function withRedisMutex<T>(
  options: RedisMutexOptions,
  fn: () => Promise<T>,
): Promise<RedisMutexResult<T>> {
  const { key, ttlSec, waitMs = 0, pollMs = DEFAULT_POLL_MS, logTag } = options;
  const token = nextToken();
  const deadline = Date.now() + waitMs;

  let acquired = false;
  for (;;) {
    let ok: string | null;
    try {
      ok = await redisConnection.set(key, token, 'EX', ttlSec, 'NX');
    } catch (err) {
      // Tagged so the caller can answer 503 for THIS without also catching
      // errors thrown by the body below.
      throw new RedisMutexUnavailableError(key, err);
    }
    if (ok === 'OK') {
      acquired = true;
      break;
    }
    if (Date.now() >= deadline) break;
    // Jittered so simultaneous contenders (a matrix pipeline's lanes all start
    // at once) stop retrying in lockstep.
    const jittered = pollMs * (1 + Math.random() * POLL_JITTER);
    await sleep(Math.min(jittered, Math.max(0, deadline - Date.now())));
  }

  if (!acquired) {
    // Report the HOLDER's remaining time, not our wait window. -1 (no expiry)
    // and -2 (key vanished between the SET and the TTL read) both mean "we
    // cannot tell", so fall back to one poll interval rather than a negative.
    let retryAfterSec = Math.ceil(pollMs / 1000);
    try {
      const ttl = await redisConnection.ttl(key);
      if (ttl > 0) retryAfterSec = ttl;
    } catch {
      // Keep the fallback — a failed TTL read must not turn a 429 into a 500.
    }
    logger.info(`[${logTag}] Mutex busy — gave up after waiting`, { key, waitMs, retryAfterSec });
    return { acquired: false, retryAfterSec };
  }

  try {
    return { acquired: true, value: await fn() };
  } finally {
    try {
      await redisConnection.eval(RELEASE_IF_OWNER, 1, key, token);
    } catch (err) {
      logger.warn(`[${logTag}] Failed to release mutex (TTL will expire it)`, {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
