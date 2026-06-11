/**
 * Resolve `intent_test_cases.priority` for a given `tests.id`.
 *
 * Background: the legacy `tests` table has no FK to `intent_test_cases`,
 * so notification / integration code that knows only a `testId` (Jira
 * sync, Telegram, webhooks) cannot read the curator-set priority
 * directly. The link lives on `test_executions.test_case_id`, which is
 * populated for every saved-case run but NULL for ad-hoc / chat-lite
 * runs (see migration 20260217_analytics_chat_lite_support.sql).
 *
 * This helper hides the 2-hop join behind one call so we don't repeat
 * the same code in every integration. Guarantees:
 *
 *   1. ALWAYS fail-open: any error (RLS, schema drift, missing row)
 *      returns `undefined`. NEVER throws. The caller's notification /
 *      integration path must not be blocked by a metadata lookup.
 *   2. Validates the value against the `intent_test_cases.priority`
 *      CHECK constraint domain. If the DB drifts (or someone bypassed
 *      the constraint), garbage strings are coerced to `undefined`.
 *   3. Multiple executions for one test_id → picks the most recent
 *      (`order by created_at DESC limit 1`). For the syncOnCreate path
 *      there is at most one; tie-break is safe-by-default.
 *
 * Returns `undefined` for: ad-hoc runs (no test_case_id), API tests
 * (api_test_configs has no priority column repo-wide — see
 * analytics-query.service:838), DB errors, unrecognized priority values.
 *
 * ────────────────────────────────────────────────────────────────────────
 * PERFORMANCE — process-local cache + singleflight
 * ────────────────────────────────────────────────────────────────────────
 * Every test failure currently triggers up to FOUR notification paths
 * (Jira syncOnCreate, manual Telegram failure, AI-analysis critical-
 * issues Telegram, webhook). Without dedup that's 4× this helper × 2
 * DB roundtrips = 8 Supabase calls for one failure. On a regression run
 * of 100 tests with a webhook integration enabled, that's ~800 extra
 * roundtrips on top of the run itself.
 *
 * Cache shape: `testId → { value, expiresAt }`. TTL = 60s. The cached
 * value is exactly what a fresh DB read would have returned (including
 * `undefined`), so cache hits and misses are observationally identical.
 *
 * Singleflight: when N callers race on the SAME testId simultaneously
 * (typical: Jira + Telegram + Webhook fire in parallel), only one
 * actually queries the DB; the rest await the same in-flight Promise.
 * Prevents thundering-herd against Supabase on the spike at test
 * completion.
 *
 * Eviction: opportunistic — on every lookup we sweep up to 8 expired
 * entries (O(1) amortized). The map is also hard-capped at 5000 entries;
 * once full the oldest are dropped first. Both bounds are conservative
 * — a single regression run of 100 tests adds ~100 entries living for
 * 60s, well under the cap.
 *
 * Why not a shared cache (Redis)? Three reasons:
 *   - DB lookup is cheap (~3ms typical) — Redis hop would erase the
 *     savings vs cold path.
 *   - Cache miss is fail-open already, so cross-process inconsistency
 *     just means an extra DB read, not wrong data.
 *   - Process-local has zero deploy surface; Redis cache would need
 *     invalidation when a curator PATCHes priority.
 *
 * ────────────────────────────────────────────────────────────────────────
 * KNOWN BEHAVIORAL QUIRKS
 * ────────────────────────────────────────────────────────────────────────
 *
 * - Stale on user update: if a curator PATCHes a test's priority while
 *   a 60s cache entry is live, subsequent notifications in that window
 *   will use the OLD priority. Acceptable because (a) the test result
 *   itself was created BEFORE the PATCH, and (b) re-running with the
 *   new priority is a single 60s wait. Don't add explicit invalidation
 *   from PATCH — it adds cross-process complexity for marginal value.
 *
 * - Race vs default-medium: `IntentTestCaseService.create()` now writes
 *   priority='medium' as the default. If a brand-new test fails and is
 *   then immediately re-tagged 'critical' BEFORE the next AI-analysis
 *   job fires, the first analysis still uses 'medium'. This is the
 *   same staleness category as the previous bullet — observed once,
 *   self-heals on next run.
 */

import { fetchPriorityByTestId } from './db/regression.db';
import { logger } from '@/utils/core/logger';

export type TestCasePriority = 'critical' | 'high' | 'medium' | 'low';

const VALID_PRIORITIES: ReadonlySet<string> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

/**
 * Numeric rank for dispatch ordering: critical=0 … low=3. NULL / unknown /
 * wrongly-cased values collapse to the medium bucket — same semantics the
 * runByTag sorter has always used (legacy NULL rows must not jump ahead of
 * or behind explicit 'medium').
 */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function priorityRank(priority: string | null | undefined): number {
  const key = typeof priority === 'string' ? priority.toLowerCase() : '';
  return PRIORITY_ORDER[key] ?? PRIORITY_ORDER.medium;
}

// ────────────────────────────────────────────────────────────────────
// Cache + singleflight (see "PERFORMANCE" in module JSDoc)
// ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;          // 60s — short enough to self-heal, long enough to dedup a regression run
const CACHE_MAX_ENTRIES = 5_000;
const SWEEP_BATCH = 8;

interface CacheEntry {
  value: TestCasePriority | undefined;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TestCasePriority | undefined>>();

/**
 * Drop up to SWEEP_BATCH expired entries from the front of the Map.
 * Map iteration order is insertion order, so expired entries are
 * front-loaded most of the time. Bounded work per call keeps the hot
 * path predictable.
 */
function sweepExpired(now: number): void {
  let removed = 0;
  for (const [key, entry] of cache) {
    if (removed >= SWEEP_BATCH) break;
    if (entry.expiresAt <= now) {
      cache.delete(key);
      removed++;
    } else {
      // Stop at first non-expired — insertion order means everything
      // after this is at least as fresh. Saves a full-map scan on
      // healthy caches.
      break;
    }
  }
}

/**
 * Hard-cap eviction: drop the oldest entries when the map exceeds
 * CACHE_MAX_ENTRIES. Insertion order = age order in a Map.
 */
function evictIfFull(): void {
  if (cache.size < CACHE_MAX_ENTRIES) return;
  const dropCount = Math.max(1, Math.floor(CACHE_MAX_ENTRIES * 0.1));
  let dropped = 0;
  for (const key of cache.keys()) {
    if (dropped >= dropCount) break;
    cache.delete(key);
    dropped++;
  }
}

async function fetchFromDb(testId: string): Promise<TestCasePriority | undefined> {
  try {
    const priority = await fetchPriorityByTestId(testId);
    if (priority && VALID_PRIORITIES.has(priority)) {
      return priority as TestCasePriority;
    }
    return undefined;
  } catch (err) {
    // Best-effort: any DB / RLS / network error must NOT block the
    // notification path. Log at debug — operators don't need a warn
    // every time an ad-hoc run skips priority lookup.
    logger.debug('[resolveTestCasePriority] lookup failed — returning undefined', {
      testId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function resolveTestCasePriorityForTestId(
  testId: string,
): Promise<TestCasePriority | undefined> {
  if (!testId) return undefined;

  const now = Date.now();

  // Cache hit (fresh)
  const cached = cache.get(testId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // Singleflight: in-flight Promise for the same testId — reuse it.
  // Prevents thundering-herd when Jira + Telegram + Webhook fire in
  // parallel from the same notification path.
  const pending = inflight.get(testId);
  if (pending) return pending;

  const promise = (async () => {
    const value = await fetchFromDb(testId);
    cache.set(testId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    sweepExpired(Date.now());
    evictIfFull();
    return value;
  })();

  inflight.set(testId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(testId);
  }
}

// ────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────

/** @internal — reset cache between tests so they don't interfere. */
export function _resetPriorityCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** @internal — observe cache size in tests. */
export function _getPriorityCacheSizeForTests(): number {
  return cache.size;
}
