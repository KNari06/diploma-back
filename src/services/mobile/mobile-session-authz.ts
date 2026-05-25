/**
 * Mobile Session Authorisation
 *
 * Backend-side ownership check for `mobileSessionId` values supplied by
 * the client in chat `context`. Without this, the LLM-driving handlers
 * (`mobile_agent`, `mobile_action`) take the client-supplied session id
 * at face value and shovel it straight into runner calls
 * (`fetchUiState`, `executeBatchCommands`, `web_evaluate`, ...).
 *
 * Trust model the chat surface assumes today:
 *   1. The user authenticated via `authenticateToken` → `req.user.id`.
 *   2. The user previously called `POST /api/v1/mobile/sessions/warmup`,
 *      which created a Redis key
 *           `mobile_warmup:{projectId}:{userId}` → { sessionId, ... }
 *      binding ONE warm session to that user.
 *   3. Therefore any `mobileSessionId` the user supplies in a chat
 *      `context` MUST appear in one of THEIR warmup keys.
 *
 * The runner has its own `X-User-Token` ACL, but:
 *   - The token is minted only when `env.RUNNER_USER_TOKEN_SECRET` is
 *     non-empty (default = '').
 *   - On the runner side, the matching `RUNNER_REQUIRE_USER_ID` defaults
 *     to OFF.
 *   In shipped defaults, neither side enforces ownership — so we do it
 *   here, independent of runner config. Defence in depth.
 *
 * Performance: a per-turn SCAN of `mobile_warmup:*` would be wasteful for
 * back-to-back chat messages from the same user. We keep a tiny
 * in-process LRU keyed by `{userId}:{sessionId}` with a short TTL — long
 * enough to cover a fast multi-turn conversation, short enough that if
 * the session was destroyed (idle, manual logout, runner crash) the next
 * turn re-validates.
 */

import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';
import { WARMUP_PREFIX, type WarmupData } from '@/api/mobile/session.controller';

/**
 * Distinct error so callers can `instanceof`-check and return a 403
 * without coupling to a string message.
 */
export class MobileSessionAuthzError extends Error {
  constructor(
    public readonly reason:
      | 'missing_userId'
      | 'missing_sessionId'
      | 'no_warmup'
      | 'session_not_owned'
      | 'redis_error',
    message: string,
  ) {
    super(message);
    this.name = 'MobileSessionAuthzError';
  }
}

/**
 * Positive cache. Sessions don't migrate between users at runtime, so a
 * confirmed `(userId, sessionId)` pair stays valid until the warmup
 * binding is dropped. We expire entries anyway so a session destroyed by
 * `mobile-idle.service.ts` or by `cleanupSession` is re-checked on the
 * next turn.
 *
 * The TTL is intentionally short — burning one Redis SCAN every 30s per
 * active user is cheap, and the upside is that a deleted/expired warmup
 * binding stops authorising chat within at most TTL.
 */
const POSITIVE_CACHE_TTL_MS = 30_000;

/**
 * Negative cache for "not owned" verdicts so a curl-bashing attacker
 * doesn't get a free Redis SCAN per probe. Shorter TTL — if the legit
 * user immediately warms a NEW session whose id collides with the one
 * we just rejected, we want them unblocked quickly.
 */
const NEGATIVE_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  authorised: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Bounded LRU-ish: evict in FIFO order when we exceed the cap. The cap
 * is generous (10k pairs) — well under the memory of a single redis
 * connection but enough to cover a busy backend before any eviction.
 */
const CACHE_MAX_ENTRIES = 10_000;

function cacheKey(userId: string, mobileSessionId: string): string {
  return `${userId}|${mobileSessionId}`;
}

function readCache(userId: string, sessionId: string): boolean | null {
  const key = cacheKey(userId, sessionId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // Touch — refresh insertion order so hot entries survive eviction.
  cache.delete(key);
  cache.set(key, entry);
  return entry.authorised;
}

function writeCache(userId: string, sessionId: string, authorised: boolean): void {
  const key = cacheKey(userId, sessionId);
  const ttl = authorised ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
  cache.set(key, { authorised, expiresAt: Date.now() + ttl });

  if (cache.size > CACHE_MAX_ENTRIES) {
    // Drop the oldest 10% — cheap and bounds the worst case.
    const drop = Math.ceil(CACHE_MAX_ENTRIES * 0.1);
    const it = cache.keys();
    for (let i = 0; i < drop; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      cache.delete(k);
    }
  }
}

/**
 * SCAN the user's `mobile_warmup:*:{userId}` keys and look for one that
 * binds the supplied `sessionId`. Returns `true` only on a confirmed
 * match; redis errors return `false` and log — fail closed.
 *
 * This is the slow path; callers should go through `assertMobileSessionOwnership`
 * which adds the cache layer.
 */
async function scanWarmupForOwnership(userId: string, sessionId: string): Promise<boolean> {
  // Anchoring `:{userId}` in MATCH isn't possible (Redis glob has no
  // end-anchor), so we glob `mobile_warmup:*` and post-filter in JS,
  // mirroring how `mobile-idle.service.ts` does it.
  const targetSuffix = `:${userId}`;
  const stream = redisConnection.scanStream({
    match: `${WARMUP_PREFIX}*`,
    count: 200,
  });

  const matchedKeys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      for (const k of keys) {
        if (k.endsWith(targetSuffix)) matchedKeys.push(k);
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
  });

  if (matchedKeys.length === 0) return false;

  // Pull the JSON values in parallel — there are at most a handful of
  // warmup entries per user (typically one).
  const values = await Promise.all(matchedKeys.map((k) => redisConnection.get(k)));
  for (const raw of values) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as WarmupData;
      // Defensive: `_booting` placeholders or stale entries without a
      // real sessionId never authorise anything.
      if (parsed?.sessionId && parsed.sessionId !== '_booting' && parsed.sessionId === sessionId) {
        return true;
      }
    } catch {
      // Malformed JSON in a warmup key is a data-integrity bug; surface
      // via the caller's log line but don't let it grant access.
    }
  }
  return false;
}

/**
 * Throw `MobileSessionAuthzError` if the supplied `mobileSessionId`
 * isn't bound to `userId` in any current warmup record. Callers should
 * catch and surface as 403.
 *
 * Both arguments are required. Empty strings throw immediately — we
 * don't want a stray `''` accidentally authorising the first user that
 * shows up with an empty warmup payload.
 */
export async function assertMobileSessionOwnership(
  userId: string | undefined | null,
  mobileSessionId: string | undefined | null,
): Promise<void> {
  if (!userId) {
    throw new MobileSessionAuthzError(
      'missing_userId',
      'assertMobileSessionOwnership: userId is required',
    );
  }
  if (!mobileSessionId) {
    throw new MobileSessionAuthzError(
      'missing_sessionId',
      'assertMobileSessionOwnership: mobileSessionId is required',
    );
  }

  const cached = readCache(userId, mobileSessionId);
  if (cached === true) return;
  if (cached === false) {
    throw new MobileSessionAuthzError(
      'session_not_owned',
      `Session ${mobileSessionId} is not bound to user ${userId}`,
    );
  }

  let ok: boolean;
  try {
    ok = await scanWarmupForOwnership(userId, mobileSessionId);
  } catch (err) {
    // Fail closed: a Redis hiccup must NOT grant access. Don't cache
    // — we want the next turn to retry rather than carry a bogus
    // negative for 5 seconds.
    logger.error('[MOBILE_AUTHZ] Redis SCAN failed — denying request', {
      userId,
      mobileSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new MobileSessionAuthzError(
      'redis_error',
      'Could not verify mobile session ownership (Redis unavailable)',
    );
  }

  writeCache(userId, mobileSessionId, ok);
  if (!ok) {
    throw new MobileSessionAuthzError(
      'no_warmup',
      `No warmup binding found for user ${userId} → session ${mobileSessionId}`,
    );
  }
}

/**
 * Test-only: drop the entire in-memory cache. Exported so the Jest
 * suite for this file can isolate per-test state without exposing the
 * underlying Map. Not part of the production API surface.
 */
export function __resetAuthzCacheForTests(): void {
  cache.clear();
}
