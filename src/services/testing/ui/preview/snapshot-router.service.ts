/**
 * Snapshot Router (Etap 2)
 *
 * Single entry point for all snapshot collection. Routes between three
 * sources based on caller context, feature flags, and runtime conditions:
 *
 *   1. CDP hybrid (`CdpSnapshotService`) — primary in background regression
 *      once Week 4 rollout completes. DOMSnapshot + AXTree + minimal
 *      `page.evaluate` for runtime fields. ~1-2s on 11k-DOM pages.
 *
 *   2. page.evaluate full collect (`SnapshotCollector.collect`) — current
 *      production path. 12-16s on dense pages but covers 100% of fields
 *      including framework detection. Always available as fallback.
 *
 *   3. Throttle/cache layer (TODO Week 1.5+) — sits ABOVE the router and
 *      short-circuits if DOM hasn't changed. Not implemented in this skeleton.
 *
 * Routing strategy is documented in `etap2-cdp/01-fields-audit.md`.
 *
 * What this file does NOT do (yet):
 *   - Implement CDP path (Week 2 — `cdp-snapshot.service.ts`)
 *   - Compare results in shadow mode (Week 3 — separate validation harness)
 *   - Log per-source latency metrics (added incrementally as paths land)
 *
 * Today's behaviour: every call delegates to `SnapshotCollector.collect`
 * — zero behaviour change. Foundation for the migration.
 */

import type { CDPSession, Page } from 'playwright';
import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';
import { logger } from '@/utils/core/logger';
import {
  SNAPSHOT_ROUTER_FLAGS,
  riskGroupForContext,
  type SnapshotRouterContext,
} from '@/config/testing/snapshot-router.config';
import type { LiteSnapshot } from '@/agent/core/lite/lite-types';
import { CdpSnapshotError, CdpSnapshotService } from './cdp-snapshot.service';
import { diffSnapshots } from './snapshot-diff.util';

export interface SnapshotRouterOptions {
  /**
   * Caller's role. Drives routing rules (preview vs background vs
   * lite-engine). Default `'unknown'` falls through to evaluate path.
   */
  context?: SnapshotRouterContext;
  /**
   * Forwarded to underlying collectors — captures elements outside the
   * viewport. Same semantics as today's SnapshotCollector option.
   */
  fullPage?: boolean;
  /**
   * Forwarded — skips the visual-stability wait when caller did its own.
   */
  skipStabilityWait?: boolean;
  /**
   * Existing CDP session to reuse (preview piggyback, Week 5). When
   * provided, the CDP path will use it instead of opening a new
   * `newCDPSession`, avoiding the screencast-conflict invariant.
   *
   * Type intentionally `unknown` — the router doesn't import Playwright
   * CDP types in foundation phase. The CDP service casts at the boundary.
   */
  existingCdpSession?: unknown;
  /**
   * Last-known interactive node count for the same page. Used by the
   * "dense page" auto-detection — preview path may switch to CDP for
   * pages above `denseThreshold`. Optional; absent → treated as 0
   * (always evaluate path on preview).
   */
  lastDomNodeCount?: number;
  /**
   * Caller-supplied diagnostic id. Logged with route decisions so we can
   * trace specific calls in shadow-mode divergence reports. Pass through
   * `previewSessionId` / `runId` / etc. as appropriate.
   */
  diagId?: string;
}

/**
 * Source classification, exposed for logging / metrics. Matches the
 * three sources in the migration plan.
 */
export type SnapshotSource = 'cdp' | 'evaluate' | 'cdp_with_fallback';

export class SnapshotRouter {
  /**
   * Process-lifetime counters for at-a-glance health monitoring.
   * Logged with every CDP success and every fallback so operators
   * can compute the running fallback rate from a single log line.
   * NOT persisted across process restarts — that's intentional, the
   * counters reset to a fresh baseline per worker so a stale issue
   * on one box doesn't poison metrics on another.
   *
   * Test-only reset: `__resetCountersForTests()` — keeps tests
   * deterministic across runs in the same process.
   */
  static cdpCallCount = 0;
  static fallbackCount = 0;

  /**
   * One-shot startup log. Fires on the FIRST router call per process,
   * dumping every flag's resolved value plus the env vars that drove it.
   * Without this, operators flipping `SNAPSHOT_USE_CDP_PREVIEW=true` in
   * `.env.local` couldn't tell at a glance whether the env was actually
   * read — they'd have to grep for `[SNAPSHOT_ROUTER] Collected source: 'cdp'`
   * to confirm. The startup log is the answer in one line.
   *
   * Static field acts as a once-per-process gate; resetCountersForTests
   * also resets it so tests can verify the log fires.
   */
  static startupLogEmitted = false;

  private static emitStartupLogOnce(): void {
    if (SnapshotRouter.startupLogEmitted) return;
    SnapshotRouter.startupLogEmitted = true;
    const flags = SNAPSHOT_ROUTER_FLAGS;
    logger.info('[SNAPSHOT_ROUTER] Startup config (logs once per process)', {
      production: {
        useCdpForBackground: flags.useCdpForBackground,
        useCdpForAi: flags.useCdpForAi,
        useCdpForPreview: flags.useCdpForPreview,
        useCdpForPreviewPoll: flags.useCdpForPreviewPoll,
      },
      shadow: {
        useCdpForBackground_shadow: flags.useCdpForBackground_shadow,
        useCdpForPreview_shadow: flags.useCdpForPreview_shadow,
        useCdpForPreviewTick_shadow: flags.useCdpForPreviewTick_shadow,
        shadowSamplingRate: flags.shadowSamplingRate,
      },
      previewTickPolicy: flags.useCdpForPreviewPoll
        ? 'CDP (with fallback to evaluate) — useCdpForPreviewPoll=true'
        : 'evaluate (default) — flip SNAPSHOT_USE_CDP_PREVIEW_POLL=true to switch',
      // env vars actually read
      env: {
        SNAPSHOT_USE_CDP_BACKGROUND: process.env.SNAPSHOT_USE_CDP_BACKGROUND ?? '(unset)',
        SNAPSHOT_USE_CDP_AI: process.env.SNAPSHOT_USE_CDP_AI ?? '(unset)',
        SNAPSHOT_USE_CDP_PREVIEW: process.env.SNAPSHOT_USE_CDP_PREVIEW ?? '(unset)',
        SNAPSHOT_USE_CDP_PREVIEW_POLL: process.env.SNAPSHOT_USE_CDP_PREVIEW_POLL ?? '(unset)',
        SNAPSHOT_USE_CDP_BACKGROUND_SHADOW: process.env.SNAPSHOT_USE_CDP_BACKGROUND_SHADOW ?? '(unset)',
        SNAPSHOT_USE_CDP_PREVIEW_SHADOW: process.env.SNAPSHOT_USE_CDP_PREVIEW_SHADOW ?? '(unset)',
        SNAPSHOT_USE_CDP_PREVIEW_TICK_SHADOW: process.env.SNAPSHOT_USE_CDP_PREVIEW_TICK_SHADOW ?? '(unset)',
        SNAPSHOT_SHADOW_SAMPLING_RATE: process.env.SNAPSHOT_SHADOW_SAMPLING_RATE ?? '(unset)',
        LOG_LEVEL: process.env.LOG_LEVEL ?? '(unset)',
      },
    });
  }

  /**
   * Per-context CDP latency tracking. Maps context → array of recent
   * `cdpMs` durations (capped at 100 entries per context). Used by
   * the periodic health log to print rolling p50/p95 — useful for
   * spotting context-specific perf regressions without external APM.
   *
   * Map iteration is O(contexts × 100) every HEALTH_LOG_INTERVAL
   * calls — negligible. NOT cleared between health logs (rolling
   * window so we keep ~100 most-recent samples per context).
   */
  private static latencySamples = new Map<string, number[]>();

  /**
   * Health log fires every HEALTH_LOG_INTERVAL CDP calls. Trade-off:
   *   - too small (≤10) → log spam under load
   *   - too large (≥1000) → operator misses issues for hours
   *   - 100 → ~1 log/minute on hot paths, ~1/day on cold paths
   * Single source of truth so the threshold can be moved without
   * grepping the file.
   */
  private static readonly HEALTH_LOG_INTERVAL = 100;

  /** @internal — for tests only */
  static __resetCountersForTests(): void {
    SnapshotRouter.cdpCallCount = 0;
    SnapshotRouter.fallbackCount = 0;
    SnapshotRouter.latencySamples.clear();
    SnapshotRouter.startupLogEmitted = false;
  }

  /**
   * Record a CDP call's latency for the rolling window. Called on
   * every successful CDP collect.
   */
  private static recordLatency(context: string, durationMs: number): void {
    let arr = SnapshotRouter.latencySamples.get(context);
    if (!arr) {
      arr = [];
      SnapshotRouter.latencySamples.set(context, arr);
    }
    arr.push(durationMs);
    if (arr.length > 100) arr.shift();
  }

  /**
   * Emit `[SNAPSHOT_HEALTH]` summary if call count crossed the
   * interval boundary. Fire-and-forget; never throws (any sort/percentile
   * math wrapped in try/catch). Includes per-context p50/p95 so
   * regressions in one context don't get hidden by a healthy mean.
   */
  private static maybeEmitHealthLog(): void {
    if (SnapshotRouter.cdpCallCount % SnapshotRouter.HEALTH_LOG_INTERVAL !== 0) return;
    if (SnapshotRouter.cdpCallCount === 0) return;
    try {
      const total = SnapshotRouter.cdpCallCount + SnapshotRouter.fallbackCount;
      const fallbackRatePct = total === 0
        ? 0
        : Math.round((SnapshotRouter.fallbackCount / total) * 1000) / 10;

      const perContext: Record<string, { count: number; p50: number; p95: number; max: number }> = {};
      for (const [ctx, samples] of SnapshotRouter.latencySamples) {
        if (samples.length === 0) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const p50 = sorted[Math.floor(sorted.length * 0.5)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
        const max = sorted[sorted.length - 1];
        perContext[ctx] = { count: samples.length, p50, p95, max };
      }

      logger.info('[SNAPSHOT_HEALTH] Periodic summary', {
        cdpCallCount: SnapshotRouter.cdpCallCount,
        fallbackCount: SnapshotRouter.fallbackCount,
        fallbackRatePct,
        // Reading guide: if any context's p95 climbs above ~3000ms or
        // its `max` blows past 10000ms, that's a regression worth
        // investigating. Healthy juz40-class dense pages: p95 ~1500ms.
        perContextLatency: perContext,
      });
    } catch (err) {
      // Health logging must never affect production paths.
      logger.debug('[SNAPSHOT_HEALTH] log emit failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Collect a snapshot. Always returns a `LiteSnapshot` — every source
   * conforms to the same shape so callers don't branch on source.
   *
   * Failure semantics:
   *   - CDP path throws → automatic fallback to evaluate (logged)
   *   - Evaluate path throws → propagates to caller (current behaviour)
   *   - Both throw → caller's responsibility (extremely rare; would
   *     mean the page itself is unreachable)
   */
  static async collect(
    page: Page,
    options: SnapshotRouterOptions = {},
  ): Promise<LiteSnapshot> {
    // Print resolved flags + env on the very first call. Cheap one-shot
    // — operators get a single grep target to verify their `.env.local`
    // changes actually reached the process.
    SnapshotRouter.emitStartupLogOnce();

    const startedAt = Date.now();
    const context: SnapshotRouterContext = options.context ?? 'unknown';
    const flags = SNAPSHOT_ROUTER_FLAGS;
    const decided = this.decideSource(context, options);

    // ── Shadow mode ──────────────────────────────────────────────────
    // When a `_shadow` flag matches the context, we run BOTH paths in
    // parallel for diff harvesting. Production result still comes from
    // evaluate — CDP runs only to feed the divergence logger.
    //
    // Decided early because shadow runs even when the regular `useCdp*`
    // flag is OFF — the whole point is to validate before flipping that
    // flag in Week 4.
    // Suppress shadow when production for the same risk group is
    // already on CDP — running CDP twice (once for prod, once for
    // shadow) would just waste CPU and produce a trivially-matching
    // diff. Shadow's purpose is to validate BEFORE flipping prod;
    // once prod is flipped, shadow is moot.
    const productionAlreadyOnCdp =
      (context === 'background-regression' && flags.useCdpForBackground)
      || (riskGroupForContext(context) === 'preview' && flags.useCdpForPreview)
      || (riskGroupForContext(context) === 'preview-poll' && flags.useCdpForPreviewPoll)
      || (riskGroupForContext(context) === 'ai' && flags.useCdpForAi);

    // Shadow eligibility: the per-group "_shadow" flag must be on. The
    // dense-page gate is GONE (Phase 2 contract): we want CDP coverage
    // on sparse pages too, otherwise we flip production without ever
    // having shadow data for that distribution. Sampling rate is the
    // single throttle now — set `SNAPSHOT_SHADOW_SAMPLING_RATE=0.05`
    // in prod to cap overhead at 5% of calls regardless of page size.
    const shadowEligible =
      !productionAlreadyOnCdp
      && (
        (context === 'background-regression' && flags.useCdpForBackground_shadow)
        || (context === 'preview-apply' && flags.useCdpForPreview_shadow)
        // Preview-tick uses its own flag because tick fires ~1×/s while
        // the editor is open, so it benefits from independent ramp-up
        // (turn it on later than apply, or sample more aggressively).
        || (context === 'preview-tick' && flags.useCdpForPreviewTick_shadow)
      );

    // Sampling kill-switch: rate=0 disables shadow entirely; rate<1 runs
    // a per-call random gate so prod can keep CDP overhead bounded while
    // the rollout matures. Decided here (not inside shadow path) so the
    // skipped calls don't pay any extra cost.
    const shouldShadow = shadowEligible
      && flags.shadowSamplingRate > 0
      && (flags.shadowSamplingRate >= 1 || Math.random() < flags.shadowSamplingRate);

    if (shouldShadow) {
      return this.collectInShadowMode(page, options, context, startedAt);
    }

    // ── Production routing ───────────────────────────────────────────
    // CDP-with-fallback path: try CDP first; on any throw, fall back
    // to evaluate. Both throwing is the only error state the caller
    // sees — the rare case where the page itself is unreachable.
    //
    // ── Preview screencast collision — measured trade-off ──────────
    // For preview contexts (live editor with screencast), CDP service
    // opens its OWN CDPSession via `context.newCDPSession(page)`. The
    // empirical test (cdp-screencast-collision.integration.test.ts)
    // measured the impact:
    //   - Sparse pages (snapshot < 16ms): video keeps flowing at 60+ FPS
    //   - Dense pages (snapshot ~90ms): video drops to ~11 FPS during
    //     snapshot, recovers to 60 FPS immediately after
    //   - Same-session piggyback: 100% freeze (worse than separate)
    // Trade-off vs evaluate path: evaluate is ~16s on dense pages
    // (no video freeze, but lint/apply unresponsive); CDP is ~1.5s
    // (brief video stutter, lint/apply fast). User-visible UX is a
    // judgment call — operator decides via SNAPSHOT_USE_CDP_PREVIEW.
    if (decided === 'cdp_with_fallback' || decided === 'cdp') {
      try {
        const cdpSnapshot = await CdpSnapshotService.collect(page, {
          existingCdpSession: options.existingCdpSession as CDPSession | undefined,
          fullPage: options.fullPage,
          skipStabilityWait: options.skipStabilityWait,
          diagId: options.diagId,
        });
        const durationMs = Date.now() - startedAt;
        // INFO level: every successful CDP collect logged so we can
        // grep production for `source: 'cdp'` and confirm the rollout
        // is firing where expected (no need to enable debug). Also
        // surfaces durationMs for at-a-glance speedup verification.
        SnapshotRouter.cdpCallCount++;
        SnapshotRouter.recordLatency(context, durationMs);
        logger.info('[SNAPSHOT_ROUTER] Collected', {
          context,
          diagId: options.diagId,
          source: 'cdp',
          nodeCount: cdpSnapshot.elements.length,
          durationMs,
          cdpCallCount: SnapshotRouter.cdpCallCount,
          fallbackCount: SnapshotRouter.fallbackCount,
        });
        // Emit periodic health summary on the success path only —
        // fallback path also bumps cdpCallCount? No: fallbackCount is
        // separate. The interval boundary check fires once per HEALTH_LOG_INTERVAL
        // successes, giving a steady cadence under load.
        SnapshotRouter.maybeEmitHealthLog();
        return cdpSnapshot;
      } catch (cdpErr) {
        // Categorise the failure for metrics — known kinds bubble up
        // from CdpSnapshotError; anything else is logged as 'unknown'
        // so we can spot patterns in shadow logs that would have
        // mattered.
        const cdpKind = cdpErr instanceof CdpSnapshotError ? cdpErr.kind : 'unknown';
        if (decided === 'cdp_with_fallback') {
          SnapshotRouter.fallbackCount++;
          // WARN level — every fallback deserves attention. We track
          // the count so at-a-glance log scan tells you the failure
          // rate (e.g. `fallbackCount: 3, cdpCallCount: 247` → 1.2%
          // fallback rate; >5% would block the Phase 4 default flip).
          logger.warn('[SNAPSHOT_ROUTER] CDP fallback fired', {
            context,
            diagId: options.diagId,
            cdpKind,
            error: cdpErr instanceof Error ? cdpErr.message : String(cdpErr),
            cdpCallCount: SnapshotRouter.cdpCallCount,
            fallbackCount: SnapshotRouter.fallbackCount,
            fallbackRatePct: SnapshotRouter.cdpCallCount === 0
              ? 0
              : Math.round((SnapshotRouter.fallbackCount / Math.max(1, SnapshotRouter.cdpCallCount + SnapshotRouter.fallbackCount)) * 1000) / 10,
          });
          // Fall through to evaluate path below.
        } else {
          // 'cdp' (no fallback) — re-throw so caller sees the kind.
          // Currently no caller resolves to plain 'cdp'; reserved
          // for future tighter-coupling paths.
          logger.error('[SNAPSHOT_ROUTER] CDP path failed (no fallback)', {
            context,
            diagId: options.diagId,
            cdpKind,
            error: cdpErr instanceof Error ? cdpErr.message : String(cdpErr),
          });
          throw cdpErr;
        }
      }
    }

    try {
      const snapshot = await SnapshotCollector.collect(page, {
        fullPage: options.fullPage,
        skipStabilityWait: options.skipStabilityWait,
      });
      const durationMs = Date.now() - startedAt;
      logger.debug('[SNAPSHOT_ROUTER] Collected', {
        context,
        diagId: options.diagId,
        source: 'evaluate',
        nodeCount: snapshot.elements.length,
        durationMs,
      });
      return snapshot;
    } catch (err) {
      logger.error('[SNAPSHOT_ROUTER] Evaluate path failed', {
        context,
        diagId: options.diagId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Shadow mode — run both paths SEQUENTIALLY, return evaluate, log
   * divergence.
   *
   * Why sequential and not parallel:
   *   Both paths write `window.__agentRefCounter` and
   *   `__agentFingerprintMap` to assign `data-agent-ref` attributes.
   *   In parallel, each path sees the other's mutations mid-flight →
   *   ref collisions / non-deterministic numbering, and the diff
   *   reports false divergence on every element. The cost is wall-clock
   *   `evalMs + cdpMs` instead of `max(evalMs, cdpMs)` — only paid in
   *   shadow mode, which is sampled and disabled in production today.
   *
   * Order: evaluate first (production source — must always run), then
   * CDP. If evaluate throws we never even start CDP — saves work and
   * keeps the failure surface identical to the non-shadow path.
   *
   * Critical properties:
   *   1. CDP failure NEVER affects production — captured via try/catch.
   *   2. Evaluate failure DOES propagate (production is broken regardless).
   *   3. Per-path timing logged separately for trend graphs.
   *   4. Diff is computed only when both paths succeed — "CDP got nothing"
   *      otherwise looks like 100% divergence.
   */
  private static async collectInShadowMode(
    page: Page,
    options: SnapshotRouterOptions,
    context: SnapshotRouterContext,
    startedAt: number,
  ): Promise<LiteSnapshot> {
    // Phase A: evaluate (production source). Failure propagates.
    const evalStart = Date.now();
    let evalSnapshot: LiteSnapshot;
    try {
      evalSnapshot = await SnapshotCollector.collect(page, {
        fullPage: options.fullPage,
        skipStabilityWait: options.skipStabilityWait,
      });
    } catch (err) {
      logger.warn('[SNAPSHOT_SHADOW_DIVERGENCE] Evaluate failed; CDP not attempted', {
        context,
        diagId: options.diagId,
        evalMs: Date.now() - evalStart,
      });
      throw err;
    }
    const evalMs = Date.now() - evalStart;

    // Phase B: CDP shadow run. Wrapped in try/catch so failure never
    // propagates — production already has its result.
    const cdpStart = Date.now();
    type CdpOutcome =
      | { status: 'fulfilled'; value: LiteSnapshot }
      | { status: 'rejected'; reason: unknown };
    let cdpResult: CdpOutcome;
    try {
      const value = await CdpSnapshotService.collect(page, {
        existingCdpSession: options.existingCdpSession as CDPSession | undefined,
        fullPage: options.fullPage,
        skipStabilityWait: options.skipStabilityWait,
        diagId: options.diagId,
      });
      cdpResult = { status: 'fulfilled', value };
    } catch (reason) {
      cdpResult = { status: 'rejected', reason };
    }
    const cdpMs = Date.now() - cdpStart;

    // Shadow log — fires whether CDP succeeded or not, but the
    // payload differs.
    if (cdpResult.status === 'rejected') {
      logger.warn('[SNAPSHOT_SHADOW_DIVERGENCE] CDP shadow failed', {
        context,
        diagId: options.diagId,
        cdpKind: cdpResult.reason instanceof CdpSnapshotError ? cdpResult.reason.kind : 'unknown',
        cdpError: cdpResult.reason instanceof Error ? cdpResult.reason.message : String(cdpResult.reason),
        evalMs,
        cdpMs,
        evalNodeCount: evalSnapshot.elements.length,
      });
    } else {
      const cdpSnapshot = cdpResult.value;
      const diff = diffSnapshots(evalSnapshot, cdpSnapshot);

      // One-line structured log per divergence call. Even when
      // match=true we log a debug — useful for "% match rate"
      // metric without bumping log level filters.
      const histogram = diff.summary.fieldDivergenceHistogram;
      const topFields = Object.entries(histogram)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([field, count]) => `${field}:${count}`)
        .join(',');

      const payload = {
        context,
        diagId: options.diagId,
        match: diff.match,
        evalNodeCount: diff.summary.aElementCount,
        cdpNodeCount: diff.summary.bElementCount,
        matchedCount: diff.summary.matchedElementCount,
        elementsWithDiffs: diff.summary.elementsWithFieldDiffs,
        topLevelDiffCount: diff.topLevelDiffs.length,
        // Refs only in evaluate result — CDP missed them. Most
        // diagnostically useful, capped to keep log line bounded.
        onlyInEvaluate: diff.onlyInA.slice(0, 10),
        onlyInCdp: diff.onlyInB.slice(0, 10),
        topDivergentFields: topFields,
        evalMs,
        cdpMs,
        // CDP phase timings — extracted from snapshot for trend graphs.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cdpPhases: (cdpSnapshot as any).__cdpPhaseTimings,
      };

      if (diff.match) {
        logger.debug('[SNAPSHOT_SHADOW_DIVERGENCE]', payload);
      } else {
        logger.warn('[SNAPSHOT_SHADOW_DIVERGENCE]', payload);
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.debug('[SNAPSHOT_ROUTER] Collected', {
      context,
      diagId: options.diagId,
      source: 'evaluate', // Production source — CDP only shadowed.
      shadowMode: true,
      nodeCount: evalSnapshot.elements.length,
      durationMs,
    });
    return evalSnapshot;
  }

  /**
   * Decide which source applies for this caller — risk-based routing
   * (Phase 2). Each context maps to one of three risk groups via
   * `riskGroupForContext`; the group's flag controls the flip:
   *
   *   background → useCdpForBackground   (safest, ramped first)
   *   ai         → useCdpForAi           (middle, ramped second)
   *   preview    → useCdpForPreview      (riskiest, ramped last)
   *
   * Why dropped the dense-gate:
   *   The Phase 1 hypothesis "CDP is faster than evaluate on every
   *   page" makes the per-tick `lastDomNodeCount` check vestigial —
   *   it added a path-dependent branch with no production benefit
   *   once we accept CDP as the new default. Routing now mirrors the
   *   ramp plan (group → flag) without inspecting the page.
   *
   *   Sparse-page CDP latency: in benchmarks, CDP DS+AX on a 200-node
   *   page is ~80-150ms wall-clock; evaluate-path is ~50-100ms.
   *   Difference is below the 500ms throttle in preview-session, so
   *   no user-visible impact. We trade ~50ms for one consistent path.
   *
   * Always returns 'cdp_with_fallback' (never bare 'cdp') — fallback
   * to evaluate is unconditional on any CdpSnapshotError. Removing the
   * fallback is a Phase 4 final step, after a 1-week soak with low
   * fallback rate.
   */
  private static decideSource(
    context: SnapshotRouterContext,
    _options: SnapshotRouterOptions,
  ): SnapshotSource {
    const flags = SNAPSHOT_ROUTER_FLAGS;
    const group = riskGroupForContext(context);

    switch (group) {
      case 'background':
        return flags.useCdpForBackground ? 'cdp_with_fallback' : 'evaluate';
      case 'ai':
        return flags.useCdpForAi ? 'cdp_with_fallback' : 'evaluate';
      case 'preview':
        return flags.useCdpForPreview ? 'cdp_with_fallback' : 'evaluate';
      case 'preview-poll':
        // Previously hard-pinned to evaluate (raw CDP newSession
        // conflicted with screencast and froze video). Etap 2 rewrote
        // the CDP path to reuse Playwright's managed channel, removing
        // the collision. Flag default stays OFF — flipping it on routes
        // the periodic 500ms tick through CDP, which fires regardless
        // of user activity, so per-call regressions compound quickly.
        // Validate FPS stability before flipping in any environment.
        return flags.useCdpForPreviewPoll ? 'cdp_with_fallback' : 'evaluate';
    }
  }
}
