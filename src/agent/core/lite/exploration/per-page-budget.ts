/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PER-PAGE FLOW BUDGET — fairness cap across discovered pages
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Problem:
 *
 *   Without this, a single page with many entry points (SPA dashboard, a
 *   paginated catalogue that produced 20 branch points) can consume the
 *   entire global maxFlows budget while the other 9 surveyed pages get
 *   zero flows. The tree discovers diversity; the flow queue should
 *   spend that diversity.
 *
 *   Scout makes this worse — every completed flow on page X can feed more
 *   branches *also sourced from X*, creating an amplifying loop.
 *
 * Solution:
 *
 *   Count reservations per page (keyed by URL pattern so /products/123 and
 *   /products/456 share one bucket) and refuse dequeue of entries whose
 *   source page is saturated. Deferred entries remain in the queue for
 *   reporting as skipped at run end; dequeue does not deadlock because we
 *   still return saturated entries if every other entry is also saturated
 *   (same fallback as the dependency check).
 *
 * Non-goals:
 *
 *   - Releasing quota when a flow fails/skips. The cap counts starts, not
 *     successes. An endless retry loop is prevented by maxFlows anyway.
 *   - Moving counting to enqueue. Enqueue is the wrong gate — the same
 *     entry can pass dedup once and then be considered for execution
 *     multiple times if the queue is reordered.
 */

import { normalizeUrlWithPattern } from './url-pattern';
import type { EntryPoint } from './types';

/** Default cap per page pattern. Overridable via ExplorationBudget. */
export const DEFAULT_MAX_FLOWS_PER_PAGE = 3;

/** Reason an entry was refused at dequeue. Exposed for traces. */
export type PerPageGateReason = 'saturated' | 'invalid_source_url';

/**
 * Lightweight counter keyed by URL pattern. Not thread-safe on its own —
 * the caller (FlowQueue) serializes mutations under its existing mutex.
 */
export class PerPageBudget {
  /** URL pattern → flows started on that page. */
  private counts: Map<string, number> = new Map();
  /** Cap per page. 0 or negative disables the gate entirely. */
  private readonly cap: number;

  constructor(cap: number = DEFAULT_MAX_FLOWS_PER_PAGE) {
    this.cap = cap;
  }

  /**
   * Return the cap as a non-zero finite positive number, or null when
   * the gate is disabled. Tiny helper used by tests + for tracing.
   */
  getCap(): number | null {
    if (!Number.isFinite(this.cap) || this.cap <= 0) return null;
    return this.cap;
  }

  /**
   * Does `ep.sourcePageUrl` still have room for another flow?
   * Returns true when the gate is disabled or when the pattern has
   * headroom left. Returns false when the page is saturated.
   *
   * An entry with a missing / unparseable sourcePageUrl is always allowed
   * through — we have no bucket to count it against, and rejecting is
   * worse than letting a few mis-bucketed flows through.
   */
  canReserve(ep: EntryPoint): boolean {
    const cap = this.getCap();
    if (cap === null) return true;
    const key = this.keyFor(ep.sourcePageUrl);
    if (key === null) return true;
    const used = this.counts.get(key) ?? 0;
    return used < cap;
  }

  /**
   * Record one flow as started against the page that sourced this entry.
   * Call AFTER a successful dequeue + budget reservation, not before —
   * otherwise a failed reservation would poison the counter.
   */
  reserve(ep: EntryPoint): void {
    const cap = this.getCap();
    if (cap === null) return;
    const key = this.keyFor(ep.sourcePageUrl);
    if (key === null) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /**
   * Number of flows already reserved against `pageUrl` (pattern-normalized).
   * Exported for diagnostics/tests only.
   */
  countFor(pageUrl: string): number {
    const key = this.keyFor(pageUrl);
    if (key === null) return 0;
    return this.counts.get(key) ?? 0;
  }

  /**
   * Produce a per-pattern summary for logs / test assertions.
   * Sorted descending by count so "biggest offenders" read first.
   */
  snapshot(): Array<{ pattern: string; count: number }> {
    return Array.from(this.counts.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Normalize the source page URL to a pattern. Returns null on unparseable
   * input so the caller can short-circuit cleanly.
   */
  private keyFor(url: string | undefined): string | null {
    if (!url || typeof url !== 'string') return null;
    // normalizeUrlWithPattern returns its input on parse failure; we treat
    // that as an opaque bucket rather than guessing. An opaque-but-stable
    // bucket is still useful — two invalid URLs of the same string share
    // a key and get capped together, which is fine for fairness.
    return normalizeUrlWithPattern(url);
  }
}
