/**
 * Phase B7 — mobile chat metrics.
 *
 * In-process counters + histograms with periodic log dumps. Same style as
 * `cache-metrics.ts` (single file, no external infra) but with two
 * differences:
 *
 *   1. Free-form bucket names (counter labels) instead of `hit`/`miss`.
 *      Mobile chat needs to count by tool name, outcome, foreground
 *      mismatch verdict, etc. — none of which map cleanly to a binary
 *      hit/miss model.
 *   2. Histograms for latency. Eager-snapshot fetch and per-tool
 *      durations vary enough that a single average hides outliers; we
 *      compute count / sum / p50 / p95 / p99 inside the interval and
 *      log them.
 *
 * Why not prom-client:
 *   The project doesn't pull it in today (verified `package.json`), and
 *   the existing winston-based metrics pattern is good enough for the
 *   per-fortnight "is this thing alive?" question we're trying to
 *   answer. If alerting / dashboards become a real ask, swap this out
 *   for `prom-client` — every call site uses tiny helpers (`incCounter`,
 *   `observeMs`) that translate trivially to Prometheus primitives.
 *
 * Why a separate file from cache-metrics:
 *   Different naming convention (`mobile_chat.*` vs `cache.*`), different
 *   primitives (histograms vs hit-ratio). Sharing the dump loop would
 *   force one of them to compromise.
 */

import { logger } from './logger';

// ── Dump cadence ──────────────────────────────────────────────────────────

/**
 * How often the loop prints accumulated counters/histograms to the log.
 * 5 minutes matches `cache-metrics.ts` so a single `tail | grep` window
 * catches both signals.
 *
 * Exported for tests so they can shorten the interval — production
 * stays at the default.
 */
export const MOBILE_CHAT_METRICS_DUMP_INTERVAL_MS = 5 * 60_000;

// ── Counters ──────────────────────────────────────────────────────────────

/**
 * Two-level counter: name → label → count. Interval counts reset each
 * dump; lifetime counts accumulate for the life of the process.
 */
const intervalCounters = new Map<string, Map<string, number>>();
const lifetimeCounters = new Map<string, Map<string, number>>();

/**
 * Bump a counter. `name` namespaces the metric ("eager_snapshot",
 * "tool_call"); `label` qualifies it ("success", "failed", "get_foreground").
 *
 * Hot-path safe: O(1), no allocations on the steady-state path after
 * the first increment for a (name, label) pair.
 */
export function incCounter(name: string, label: string, by = 1): void {
  bump(intervalCounters, name, label, by);
  bump(lifetimeCounters, name, label, by);
}

function bump(m: Map<string, Map<string, number>>, name: string, label: string, by: number): void {
  let inner = m.get(name);
  if (!inner) {
    inner = new Map();
    m.set(name, inner);
  }
  inner.set(label, (inner.get(label) ?? 0) + by);
}

// ── Histograms ────────────────────────────────────────────────────────────

/**
 * Per-name observation buffer. We keep raw samples for the interval so
 * we can compute real percentiles on dump; lifetime stats track only
 * count + sum (percentiles aren't useful across hours of mixed traffic).
 *
 * Cap at MAX_HISTOGRAM_SAMPLES per interval to bound memory under load
 * — once we hit the cap we drop further samples for that interval and
 * the next dump notes truncation in the log.
 */
const MAX_HISTOGRAM_SAMPLES = 10_000;

interface HistogramInterval {
  samples: number[];
  dropped: number;
}

interface HistogramLifetime {
  count: number;
  sum: number;
}

const intervalHistograms = new Map<string, HistogramInterval>();
const lifetimeHistograms = new Map<string, HistogramLifetime>();

/**
 * Record a duration in milliseconds. Negative / NaN / Infinity values
 * are silently dropped — they confuse percentile math and usually
 * indicate a bug in the caller (e.g. forgot to subtract `startedAt`).
 */
export function observeMs(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;

  let interval = intervalHistograms.get(name);
  if (!interval) {
    interval = { samples: [], dropped: 0 };
    intervalHistograms.set(name, interval);
  }
  if (interval.samples.length < MAX_HISTOGRAM_SAMPLES) {
    interval.samples.push(ms);
  } else {
    interval.dropped += 1;
  }

  let lifetime = lifetimeHistograms.get(name);
  if (!lifetime) {
    lifetime = { count: 0, sum: 0 };
    lifetimeHistograms.set(name, lifetime);
  }
  lifetime.count += 1;
  lifetime.sum += ms;
}

/**
 * Percentile from a pre-sorted array. p ∈ [0,1]. Returns 0 for empty
 * arrays (caller decides if that's interesting). Linear interpolation —
 * close enough for the "how slow is the slow path?" question.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Dump ──────────────────────────────────────────────────────────────────

/**
 * Snapshot of one counter for the dump record. Public so tests can read
 * it without re-deriving from logs.
 */
export interface CounterDump {
  name: string;
  interval: Record<string, number>;
  lifetime: Record<string, number>;
}

export interface HistogramDump {
  name: string;
  interval: {
    count: number;
    sum: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    dropped: number;
  };
  lifetime: {
    count: number;
    sum: number;
    /** Mean over the entire process lifetime — coarse but useful baseline. */
    mean: number;
  };
}

export interface MobileChatMetricsDump {
  counters: CounterDump[];
  histograms: HistogramDump[];
}

/**
 * Build a dump record AND reset the per-interval state. Exported for
 * tests + manual /debug routes; the timer loop calls this internally.
 *
 * Lifetime data is NOT reset — that's the whole point of separating
 * the two layers.
 */
export function snapshotAndReset(): MobileChatMetricsDump {
  const counters: CounterDump[] = [];
  for (const name of intervalCounters.keys()) {
    const interval = mapToRecord(intervalCounters.get(name));
    const lifetime = mapToRecord(lifetimeCounters.get(name));
    counters.push({ name, interval, lifetime });
  }
  intervalCounters.clear();

  const histograms: HistogramDump[] = [];
  for (const name of intervalHistograms.keys()) {
    const interval = intervalHistograms.get(name)!;
    const lifetime = lifetimeHistograms.get(name) ?? { count: 0, sum: 0 };
    const sorted = [...interval.samples].sort((a, b) => a - b);
    histograms.push({
      name,
      interval: {
        count: sorted.length,
        sum: sorted.reduce((s, v) => s + v, 0),
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
        dropped: interval.dropped,
      },
      lifetime: {
        count: lifetime.count,
        sum: lifetime.sum,
        mean: lifetime.count === 0 ? 0 : lifetime.sum / lifetime.count,
      },
    });
  }
  intervalHistograms.clear();

  return { counters, histograms };
}

function mapToRecord(m: Map<string, number> | undefined): Record<string, number> {
  if (!m) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

// ── Periodic dump loop ────────────────────────────────────────────────────

let dumpTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic dump loop. Idempotent — second call is a no-op.
 * Importing this module does NOT auto-start the loop (different from
 * cache-metrics.ts) so tests can opt in explicitly.
 */
export function startDumpLoop(intervalMs: number = MOBILE_CHAT_METRICS_DUMP_INTERVAL_MS): void {
  if (dumpTimer) return;
  dumpTimer = setInterval(() => {
    const dump = snapshotAndReset();
    // Skip the log line when nothing happened in the interval (idle
    // workers don't need to emit noise).
    if (dump.counters.length === 0 && dump.histograms.length === 0) return;
    logger.info('[MOBILE_CHAT_METRICS] dump', {
      counters: dump.counters,
      histograms: dump.histograms,
    });
  }, intervalMs);
  // Don't keep the event loop alive for the timer alone — process
  // exit (jest tests, graceful shutdown) shouldn't hang waiting for
  // the next dump tick.
  dumpTimer.unref?.();
}

/**
 * Stop the dump loop. Used by tests and graceful shutdown handlers.
 */
export function stopDumpLoop(): void {
  if (dumpTimer) {
    clearInterval(dumpTimer);
    dumpTimer = null;
  }
}

/**
 * Reset EVERYTHING — counters, histograms, both interval and lifetime.
 * Test-only utility; production callers should never touch this.
 */
export function _resetAllForTests(): void {
  intervalCounters.clear();
  lifetimeCounters.clear();
  intervalHistograms.clear();
  lifetimeHistograms.clear();
}
