/**
 * In-process cache metrics — minimal counters with periodic log dumps.
 *
 * Why this exists:
 *   The element resolution pipeline has 4 layers (evidence shortcut → compiled
 *   plan → LLM resolver → degraded fallback). We can't tell which layers are
 *   actually doing work in production without instrumenting them — a 10%
 *   change in evidence-shortcut hit rate could mean huge LLM cost shifts
 *   that nobody notices until the bill arrives.
 *
 *   This util gives us hit/miss counters with named buckets ("reasons") and
 *   dumps them to logger.info every N minutes so they're greppable in the
 *   normal log stream. No Prometheus / no Grafana required — works with the
 *   existing winston setup.
 *
 * What this is NOT:
 *   • Not a replacement for proper metrics infra (Prometheus, OpenTelemetry).
 *     If/when you need percentiles, alerting, dashboards, plug those in
 *     separately and treat this as a stop-gap.
 *   • Not for high-cardinality keys. Bucket names should be a small fixed
 *     set ('hit', 'miss', 'ttl_expired'). Putting URLs or step IDs in here
 *     blows memory.
 *   • Not request-scoped. Counters are process-global and survive across
 *     requests, just like a Prometheus counter would.
 *
 * Usage:
 *   import { cacheMetrics } from '@/utils/core/cache-metrics';
 *   cacheMetrics.inc('llm-select', 'hit');
 *   cacheMetrics.inc('evidence-shortcut', 'ttl_expired');
 *
 *   The dump loop starts on first import and runs forever. It is a no-op
 *   when no counters were touched in the interval (avoids log noise on
 *   idle workers).
 */

import { logger } from './logger';

/**
 * Map of cache name → bucket name → count. Two-level on purpose so dumps
 * group naturally and JSON output stays readable.
 */
const counters = new Map<string, Map<string, number>>();

/**
 * Cumulative counters for "lifetime" totals. Periodic dumps reset the
 * per-interval counters but lifetime keeps growing — useful when reading
 * a single log line to know "how many evidence hits since process start".
 */
const lifetime = new Map<string, Map<string, number>>();

/**
 * Increment a bucket. Cheap (Map.get + Map.set), safe to call from hot paths.
 * The `cache` and `bucket` arguments should come from a finite set of string
 * literals defined per cache (see callers).
 */
function inc(cache: string, bucket: string, by = 1): void {
  let m = counters.get(cache);
  if (!m) {
    m = new Map();
    counters.set(cache, m);
  }
  m.set(bucket, (m.get(bucket) ?? 0) + by);

  let lm = lifetime.get(cache);
  if (!lm) {
    lm = new Map();
    lifetime.set(cache, lm);
  }
  lm.set(bucket, (lm.get(bucket) ?? 0) + by);
}

/**
 * Snapshot for a single cache: per-interval counts + computed hit ratio
 * when both 'hit' and 'miss' buckets are present.
 */
interface CacheSnapshot {
  cache: string;
  intervalCounts: Record<string, number>;
  intervalTotal: number;
  intervalHitRatio?: number;
  lifetimeCounts: Record<string, number>;
  lifetimeTotal: number;
  lifetimeHitRatio?: number;
}

function snapshot(cache: string): CacheSnapshot {
  const intervalMap = counters.get(cache) ?? new Map<string, number>();
  const lifetimeMap = lifetime.get(cache) ?? new Map<string, number>();

  const intervalCounts: Record<string, number> = {};
  let intervalTotal = 0;
  for (const [k, v] of intervalMap) {
    intervalCounts[k] = v;
    intervalTotal += v;
  }

  const lifetimeCounts: Record<string, number> = {};
  let lifetimeTotal = 0;
  for (const [k, v] of lifetimeMap) {
    lifetimeCounts[k] = v;
    lifetimeTotal += v;
  }

  // Hit ratio is meaningful only when 'hit' and 'miss' both exist.
  // Skipped (returned undefined) for caches that report by reason name.
  let intervalHitRatio: number | undefined;
  let lifetimeHitRatio: number | undefined;
  const intHit = intervalMap.get('hit') ?? 0;
  const intMiss = intervalMap.get('miss') ?? 0;
  if (intHit + intMiss > 0) {
    intervalHitRatio = Math.round((intHit / (intHit + intMiss)) * 100) / 100;
  }
  const lifeHit = lifetimeMap.get('hit') ?? 0;
  const lifeMiss = lifetimeMap.get('miss') ?? 0;
  if (lifeHit + lifeMiss > 0) {
    lifetimeHitRatio = Math.round((lifeHit / (lifeHit + lifeMiss)) * 100) / 100;
  }

  return {
    cache,
    intervalCounts,
    intervalTotal,
    intervalHitRatio,
    lifetimeCounts,
    lifetimeTotal,
    lifetimeHitRatio,
  };
}

/**
 * Dump all caches that had any activity since the last dump, then reset
 * per-interval counters. Lifetime counters are preserved.
 *
 * Skipped silently when no counters were touched — keeps idle workers
 * out of the log stream.
 */
function dumpAndReset(): void {
  if (counters.size === 0) return;

  let touchedAny = false;
  for (const cache of counters.keys()) {
    const snap = snapshot(cache);
    if (snap.intervalTotal === 0) continue;
    touchedAny = true;
    logger.info('[CACHE_METRICS]', snap);
  }

  if (touchedAny) {
    counters.clear();
  }
}

/**
 * Dump interval (ms). 5 minutes is short enough to feel near-real-time
 * for ops, long enough to be cheap. Override via env if needed.
 *
 * Keep > 30s to avoid log flooding on busy workers.
 */
const DUMP_INTERVAL_MS = (() => {
  const raw = process.env.CACHE_METRICS_DUMP_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 30_000) return parsed;
  return 5 * 60 * 1000; // 5 minutes
})();

/**
 * Start the dump loop. Runs once per interval until process exit. We use
 * `unref()` so the timer never keeps the process alive — fine for a
 * background metrics dump.
 *
 * Idempotent: only one timer is ever created. Tests can opt out via
 * `CACHE_METRICS_ENABLED=false`.
 */
let timerStarted = false;
function ensureDumpLoop(): void {
  if (timerStarted) return;
  if (process.env.CACHE_METRICS_ENABLED === 'false') return;
  timerStarted = true;
  const t = setInterval(() => {
    try {
      dumpAndReset();
    } catch (err) {
      // Never let the dump loop crash a worker.
      // eslint-disable-next-line no-console
      console.warn('[CACHE_METRICS] dump failed', err);
    }
  }, DUMP_INTERVAL_MS);
  t.unref();
}

ensureDumpLoop();

export const cacheMetrics = {
  /** Increment a bucket. Hot-path safe. */
  inc,
  /** Read a snapshot for a cache (mostly for tests / on-demand inspection). */
  snapshot,
  /** Force a dump now (mostly for tests). Resets per-interval counters. */
  dumpNow: dumpAndReset,
};
