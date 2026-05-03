/**
 * Snapshot Router config (Etap 2)
 *
 * Feature flags for the CDP-vs-evaluate routing decision. All flags
 * default to FALSE — every consumer goes through the existing
 * `SnapshotCollector.collect` (page.evaluate) path until a flag is
 * flipped via env var.
 *
 * ─── PHASE 4 RAMP-UP PLAN (read this before flipping anything) ───
 *
 * Goal: ship CDP path to production safely without an integration test
 * to catch regressions. We rely on (a) per-call diagnostic logs added
 * in [snapshot-router.service.ts] / [cdp-snapshot.service.ts] and (b)
 * a process-lifetime fallback-rate counter for at-a-glance health.
 *
 * Order (do NOT skip stages):
 *
 *   STAGE A — DEV (1 day on local machine)
 *     SNAPSHOT_USE_CDP_BACKGROUND=true
 *     Trigger a regression run in dev. Watch logs for:
 *       - `[SNAPSHOT_ROUTER] Collected source: 'cdp'` — ramp firing
 *       - `[CDP_SNAPSHOT] Collected timings.totalMs` — speedup vs evaluate
 *       - `[CDP_SNAPSHOT] runtime` — runtime fields populated (non-zero
 *         counts on a React/Vue page indicate Phase 4 enrichment OK)
 *       - NO `[SNAPSHOT_ROUTER] CDP fallback fired` warns
 *     Pass criteria: ≥10 successful CDP collects, 0 fallbacks, totalMs
 *     not regressed vs evaluate baseline.
 *
 *   STAGE B — STAGING / DEV-VM (3 days, all 3 processes)
 *     SNAPSHOT_USE_CDP_BACKGROUND=true (workers — regression jobs)
 *     SNAPSHOT_USE_CDP_AI=true        (workers — lite-engine, exploration)
 *     Watch fallback-rate:
 *       grep '[SNAPSHOT_ROUTER]' logs/combined.log | grep fallbackRatePct
 *     Pass criteria: fallbackRatePct ≤ 1% over ≥500 calls.
 *
 *   STAGE C — PRODUCTION background+ai (7 days)
 *     Same env vars in prod. Daily check fallback rate. Investigate
 *     any CdpSnapshotError 'kind' that wasn't seen in staging.
 *     Pass criteria: fallback rate stays ≤ 1% for full week, no
 *     user-reported regressions in regression-test correctness.
 *
 *   STAGE D — PRODUCTION preview (3 days)
 *     SNAPSHOT_USE_CDP_PREVIEW=true   (api process — live editor)
 *     This is the riskiest flip (live screencast contention).
 *     Watch FOR USER REPORTS of editor lag in addition to log metrics.
 *     Pass criteria: no FPS regression on screencast, fallback rate
 *     stays ≤ 2% (slightly higher tolerance — preview pages are more
 *     diverse than regression fixtures).
 *
 *   STAGE E — CLEANUP (after Stage D succeeds for 7 days)
 *     Promote env-var defaults to `true` here, drop SNAPSHOT_USE_CDP_*
 *     env reads. Then in a SEPARATE PR delete `SnapshotCollector.collect`
 *     (it stays as fallback during stages A-D — never delete fallback
 *     while flags are still mutable).
 *
 * Roll-back at any stage: set flag back to false in env, restart
 * affected process. Code path is symmetric — fallback to evaluate
 * is the default behaviour, no migration data to revert.
 *
 * ─── ENV VARS (single source of truth) ───
 *   SNAPSHOT_USE_CDP_BACKGROUND       — Stage A flip
 *   SNAPSHOT_USE_CDP_AI               — Stage B flip
 *   SNAPSHOT_USE_CDP_PREVIEW          — Stage D flip
 *   SNAPSHOT_USE_CDP_BACKGROUND_SHADOW — optional shadow validation
 *   SNAPSHOT_USE_CDP_PREVIEW_SHADOW   — optional shadow validation
 *   SNAPSHOT_USE_CDP_PREVIEW_TICK_SHADOW — optional shadow for hot tick path
 *   SNAPSHOT_SHADOW_SAMPLING_RATE     — 0..1, throttle shadow overhead (default 1)
 *   SNAPSHOT_DENSE_THRESHOLD          — DEPRECATED (kept for shadow sampling cap only)
 */

export interface SnapshotRouterFlags {
  /**
   * Run CDP path in shadow mode for background regression. Production
   * still uses evaluate result; CDP runs in parallel solely so we can
   * compare snapshots and log divergence.
   */
  useCdpForBackground_shadow: boolean;
  /**
   * Use CDP path as the PRIMARY source for background regression, with
   * evaluate as fallback. Enable only after shadow data shows ≥95% match
   * for 1+ week.
   */
  useCdpForBackground: boolean;
  /**
   * Same as `_shadow` but for preview sessions (live editor / Apply All).
   * Riskier than background because of potential WebSocket bandwidth
   * contention with the screencast CDP session — we measure FPS impact
   * before any prod rollout.
   */
  useCdpForPreview_shadow: boolean;
  /**
   * Shadow CDP for the periodic preview-tick snapshot used by the live
   * editor and lint flow. This is the snapshot that pays the 12-16s tax
   * on dense pages (juz40 folders-control: 11k DOM → 15.8s). Gated by
   * `denseThreshold` so sparse pages skip the overhead. Production source
   * stays evaluate; CDP runs only to feed the divergence logger.
   *
   * Why a separate flag from `useCdpForPreview_shadow`:
   * preview-apply runs on user click (rare); preview-tick runs every
   * ~1s while the editor is open (very frequent). Different blast
   * radius — split flags so we can ramp them independently.
   */
  useCdpForPreviewTick_shadow: boolean;
  /**
   * CDP primary for preview-* contexts (preview-tick, preview-apply,
   * page-interactive-check, unknown). Riskiest group — these run on
   * the live editor session that ALSO drives the screencast CDP
   * channel, so we ramp this LAST after `useCdpForBackground` and
   * `useCdpForAi` are stable in production.
   */
  useCdpForPreview: boolean;
  /**
   * CDP primary for autonomous-AI contexts (lite-action, lite-verification,
   * lite-recovery, lite-engine, pipeline-observe, exploration-*).
   * Middle-risk group: snapshot is consumed by the AI agent rather than
   * a live user, so any timing wobble doesn't show up in the editor UX —
   * but the AI is shape-sensitive (relies on `transientState`,
   * `obstacleFacts`, framework detection), so we ramp this AFTER
   * background and BEFORE preview to surface any regressions in regression
   * runs first.
   */
  useCdpForAi: boolean;
  /**
   * @deprecated Phase 2 dropped the dense-page heuristic — risk-based
   * routing decides per-context, not per-snapshot-size. Kept for binary
   * compatibility (existing tests / configs) and used ONLY by the
   * preview-tick / preview-apply SHADOW flags as a sampling cap (we
   * don't want to shadow on every sparse page during ramp-up).
   *
   * Will be deleted once `_shadow` flags are retired (Phase 4 final).
   */
  denseThreshold: number;
  /**
   * Sampling rate for shadow mode — fraction of eligible calls (0..1)
   * that actually run the CDP path alongside evaluate. Set <1 in prod
   * to bound CDP overhead at scale; per-call random gate keeps the
   * sample unbiased across pages.
   *
   * 1   = every shadow-eligible call runs CDP (full coverage, dev/staging)
   * 0.1 = 10% sample (recommended initial prod setting)
   * 0   = shadow flags become no-ops (safety kill switch)
   */
  shadowSamplingRate: number;
}

/**
 * Read a boolean env flag. Treats `'1' | 'true' | 'yes' | 'on'` as true,
 * everything else (including unset) as the supplied default. Centralised
 * so all flags share the same coercion rule.
 */
function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const normalised = raw.trim().toLowerCase();
  return normalised === '1' || normalised === 'true' || normalised === 'yes' || normalised === 'on';
}

function envNumber(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

export const SNAPSHOT_ROUTER_FLAGS: SnapshotRouterFlags = {
  useCdpForBackground_shadow: envBool('SNAPSHOT_USE_CDP_BACKGROUND_SHADOW', false),
  useCdpForBackground: envBool('SNAPSHOT_USE_CDP_BACKGROUND', false),
  useCdpForPreview_shadow: envBool('SNAPSHOT_USE_CDP_PREVIEW_SHADOW', false),
  useCdpForPreviewTick_shadow: envBool('SNAPSHOT_USE_CDP_PREVIEW_TICK_SHADOW', false),
  useCdpForPreview: envBool('SNAPSHOT_USE_CDP_PREVIEW', false),
  useCdpForAi: envBool('SNAPSHOT_USE_CDP_AI', false),
  denseThreshold: envNumber('SNAPSHOT_DENSE_THRESHOLD', 2000, 0, 100_000),
  shadowSamplingRate: envNumber('SNAPSHOT_SHADOW_SAMPLING_RATE', 1, 0, 1),
};

/**
 * Risk groups for ramp-up. Each context maps to ONE group; the group
 * controls which production flag flips it to CDP. Splitting like this
 * lets the rollout proceed in safe stages:
 *
 *   1. Background first (no live UI impact, fallback always free).
 *   2. AI second (consumed by agents, not displayed to users; any
 *      shape regression shows up in regression runs before reaching
 *      the editor).
 *   3. Preview last (live screencast contention risk + visible to
 *      users, so it ramps only after both above are stable).
 *   4. Preview-poll — the 500ms periodic DOM tick. Empirically
 *      measured (cdp-screencast-collision.test): CDP on this path
 *      causes continuous video stutter (~11-20 FPS) on dense pages
 *      because the tick fires twice per second regardless of user
 *      activity. Hard-pinned to evaluate path; never CDP.
 */
export type SnapshotRiskGroup = 'background' | 'ai' | 'preview' | 'preview-poll';

export function riskGroupForContext(context: SnapshotRouterContext): SnapshotRiskGroup {
  switch (context) {
    case 'background-regression':
      return 'background';
    case 'lite-engine':
    case 'lite-action':
    case 'lite-verification':
    case 'lite-recovery':
    case 'pipeline-observe':
    case 'exploration-survey':
    case 'exploration-flow':
    case 'exploration-dismiss':
    // legacy-orchestrator runs in `IntelligentTestOrchestrator`, which
    // is NOT a queued background job — it's a synchronous agent loop
    // that blocks on every snapshot. Same blast radius as lite-engine,
    // not the same as background-regression. Audit caught this — the
    // name is misleading because the file is in `agent/core/` and was
    // historically considered "legacy non-Lite", but the lifecycle is
    // identical to other autonomous-AI consumers. Belongs in `ai`.
    case 'legacy-orchestrator':
      return 'ai';
    case 'preview-tick':
      // Periodic 500ms polling (preview.handler.ts:1008). NEVER CDP —
      // would cause continuous video stutter visible to user. Stays
      // on evaluate forever. The user's editor shows smooth video and
      // gets DOM panel updates twice per second, which is enough.
      return 'preview-poll';
    case 'preview-apply':
    case 'page-interactive-check':
    case 'unknown':
      // Action-triggered (Apply / Lint) — opt-in CDP via flag.
      // Tradeoff: short video stutter (200-1500ms) vs 10× faster
      // snapshot. Operator decides via SNAPSHOT_USE_CDP_PREVIEW.
      return 'preview';
  }
}

/**
 * Routing context — caller's role identifies which flag block applies.
 *
 * Why an enum and not a boolean: future contexts may need their own
 * routing rules (e.g., autonomous exploration runs in lite-engine and
 * may want a different default than background regression even though
 * neither has a screencast). Enum keeps the call sites readable.
 */
export type SnapshotRouterContext =
  | 'preview-tick'           // Recording UI tick — emits preview:page on DOM change
  | 'preview-apply'          // User clicked Apply on a step
  | 'background-regression'  // BullMQ replay job, no live screencast
  // Lite-engine subdivisions — split because their cadence and risk
  // differ. Action snapshots are the hottest path (every iteration
  // pre/post action); verification snapshots are quieter; recovery is
  // cold path. Splitting lets us flip CDP for hot path first, leave
  // cold paths on evaluate during soak if needed.
  | 'lite-engine'            // Generic / unspecified lite-engine call
  | 'lite-action'            // LiteEngine pre/post-action snapshot (hot)
  | 'lite-verification'      // LiteEngine post-action verification
  | 'lite-recovery'          // LiteEngine retry / micro-correction
  // Pipeline v2 (CommandExecutor) — observe_page / post-overlay re-collect.
  | 'pipeline-observe'
  // Exploration agents — autonomous site survey + flow execution.
  | 'exploration-survey'     // SurveyAgent BFS + landmark / scroll passes
  | 'exploration-flow'       // FlowRunner — flow execution snapshots
  | 'exploration-dismiss'    // OverlayDismisser — re-collects after dismiss attempts
  // Misc readiness probes (page-interactive heuristic, legacy orchestrator).
  | 'page-interactive-check'
  | 'legacy-orchestrator'
  | 'unknown';               // Default when caller didn't specify
