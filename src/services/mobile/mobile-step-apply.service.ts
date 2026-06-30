/**
 * Mobile Step Apply Service
 *
 * Shared apply logic for mobile steps — invoked from both the REST endpoint
 * (/api/v1/mobile/sessions/:sessionId/apply) and the WebSocket handler
 * (`mobile:step:apply`). Mirrors the structure of PreviewStepApplyService
 * used for web, so callers on either transport get the same semantics:
 *
 *   - Fast path: `lintElement()` on the runner → execute by coordinates.
 *   - Fallback: `runSteps()` pipeline with full resolve (A11y tree + LLM).
 *   - Always returns `appliedStep` on success with `bindingHints` + `evidence`
 *     so the UI can clear the "needs apply" orange dot.
 *
 * Callers are responsible for:
 *   - Editor trace logging (REST and WS both use EditorTraceService).
 *   - Auto-persist to DB (backend decides based on transport/caller).
 */

import { getMobileRunnerClientForSession } from './session-runner-routing';
import type { MobileCompiledPlan } from './mobile-runner.types';
import { logger } from '@/utils/core/logger';

// ── Constants ─────────────────────────────────────────────────────────────

/** Step types that go through the fast lint-then-execute path. */
const LINT_TYPES = new Set([
  'click', 'tap', 'double_tap', 'long_press',
  'open', 'toggle', 'check', 'uncheck',
  'select', 'hover', 'type', 'fill',
]);

/** Frontend step type → runner step type. */
const STEP_TYPE_MAP: Record<string, string> = { tap: 'click', fill: 'type' };

/** Frontend step type → lint action type (tap vs type_text). */
const LINT_ACTION_TYPE_MAP: Record<string, string> = {
  click: 'tap', tap: 'tap', double_tap: 'tap', long_press: 'tap',
  open: 'tap', toggle: 'tap', check: 'tap', uncheck: 'tap',
  select: 'tap', hover: 'tap', type: 'type_text', fill: 'type_text',
};

/** Frontend step type → raw runner command. */
const RAW_CMD_MAP: Record<string, string> = {
  click: 'tap', tap: 'tap', open: 'tap', toggle: 'tap',
  check: 'tap', uncheck: 'tap', select: 'tap', hover: 'tap',
  double_tap: 'double_tap', long_press: 'long_press',
};

// ── Plan upgrade ranking ─────────────────────────────────────────────────
//
// Mobile equivalent of preview-step-apply.service.ts STRATEGY_RANK. Used by
// shouldUpgradeCompiledPlan to decide whether a freshly-built plan should
// REPLACE an existing one in the DB. Higher rank = more reliable strategy.
//
// Why each rank:
//   creation_location (9) — Flutter widget's source creation site
//     (file:line:col from the Widget Inspector). Deterministic across runs,
//     label-independent (works for icon-only widgets), and survives layout
//     rewrites + translations. The strongest Flutter key — ranked ABOVE
//     resource_id so a Flutter creation_location plan is never downgraded to
//     a weaker strategy.
//   resource_id / accessibility_id (8) — developer-controlled IDs, stable
//     across translations / DPI changes / minor refactors. The strongest
//     signal we have on Android (`android:id`) and iOS
//     (`accessibilityIdentifier`).
//   label_exact (5) — visible text + className/role. Translation-fragile
//     but exact match is unambiguous when text is unique.
//   label_partial (4) — substring match (e.g. "Cart" → "Cart (3)"). Weaker
//     than exact because of false positives, but stronger than positional.
//   near_text (2) — anchor-relative; depends on layout staying close.
//     Useful for icon-only elements, brittle on reflow.
//   bounds_region (1) — 3×3 grid last-resort; matches lots of unrelated
//     elements in the same screen quadrant.
//
// Numbers are gaps so a future strategy can slot in without renumbering.
const MOBILE_STRATEGY_RANK: Record<string, number> = {
  creation_location: 9,
  resource_id: 8,
  accessibility_id: 8,
  label_exact: 5,
  label_partial: 4,
  near_text: 2,
  bounds_region: 1,
};

/**
 * Decide whether to REPLACE `existing` compiled plan with `candidate` in
 * the DB. Returns `true` only when the candidate is provably as strong or
 * stronger; defaults to `false` (preserve) on any ambiguity. The contract
 * is asymmetric on purpose: a working plan in the DB is a known-good asset,
 * a fresh apply may have been a flake.
 *
 * Decision rules (first match wins):
 *
 *   1. No candidate / empty → refuse. Never overwrite with nothing.
 *
 *   2. No existing / empty → upgrade. First plan wins by default.
 *
 *   3. candidate.bestRank > existing.bestRank → upgrade.
 *      Example: existing has only [label_exact], candidate found
 *      [resource_id, label_exact]. resource_id beats label_exact at the
 *      top tier — clear win.
 *
 *   4. candidate.bestRank < existing.bestRank → refuse.
 *      Example: existing was [resource_id, label_exact], candidate is
 *      [label_exact] only (LLM missed the resource_id this time, or
 *      bounds_region last-resort fallback). Replacing here would
 *      silently downgrade healing strength.
 *
 *   5. Tied bestRank:
 *        - existing.kinds ⊆ candidate.kinds AND candidate has MORE kinds
 *          → upgrade (enrichment — same primary, more fallbacks).
 *        - Otherwise → refuse. This intentionally rejects:
 *          - identical plans (no churn for no benefit),
 *          - secondary swaps (existing label_exact replaced by near_text
 *            keeps the same primary but loses secondary strength),
 *          - cross-platform primary changes (accessibility_id ↔ resource_id
 *            at the top tier — shouldn't happen in practice; if it does,
 *            preserving the original platform's plan is the safer call).
 *
 * Why "best rank" instead of "primary index 0":
 *   The previous draft compared existing.strategies[0].kind directly and
 *   missed the case "candidate primary same kind, but secondary swapped
 *   to weaker". By taking the max rank across all strategies and additionally
 *   gating on subset-ness for ties, we never accept a plan whose
 *   strategy SET is strictly weaker than existing.
 *
 * Web equivalent: preview-step-apply.service.ts:shouldUpgradeCompiledPlan.
 * Mobile rules are stricter because mobile plans see less churn between
 * applies (a single test case typically has 5-50 steps vs web's deeper
 * funnels), so the cost of a false-upgrade is higher per step.
 */
export function shouldUpgradeCompiledPlan(
  existing: MobileCompiledPlan | undefined,
  candidate: MobileCompiledPlan | undefined,
): boolean {
  // Rule 1: no candidate → cannot upgrade.
  if (!candidate || !candidate.strategies || candidate.strategies.length === 0) {
    return false;
  }
  // Rule 2: no existing → take the candidate.
  if (!existing || !existing.strategies || existing.strategies.length === 0) {
    return true;
  }

  // Helper: best (highest) rank across the plan's strategies. Unknown kinds
  // fall through to -1 sentinel so they never beat a known kind. Two unknown
  // kinds compare equal at -1, leaving the subset-check below as tiebreaker.
  const bestRank = (plan: MobileCompiledPlan): number => {
    let best = -1;
    for (const s of plan.strategies) {
      const rank = MOBILE_STRATEGY_RANK[String(s.kind)] ?? -1;
      if (rank > best) best = rank;
    }
    return best;
  };

  const existingBest = bestRank(existing);
  const candidateBest = bestRank(candidate);

  // Rule 3: strictly stronger top-tier strategy.
  if (candidateBest > existingBest) return true;
  // Rule 4: strictly weaker top-tier strategy.
  if (candidateBest < existingBest) return false;

  // Rule 5: tied on best — accept only when candidate is a strict superset.
  const existingKinds = new Set(existing.strategies.map((s) => String(s.kind)));
  const candidateKinds = new Set(candidate.strategies.map((s) => String(s.kind)));

  // Existing must be a subset of candidate (no kind dropped).
  for (const kind of existingKinds) {
    if (!candidateKinds.has(kind)) return false;
  }
  // And candidate must have at least one extra kind (otherwise identical sets
  // → no churn).
  return candidateKinds.size > existingKinds.size;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface MobileApplyInput {
  sessionId: string;
  stepDraft: any;
  userId: string;
  /**
   * Optional abort signal. When it fires (HTTP client disconnected mid-
   * request), the outgoing fetch to the runner is aborted so the runner's
   * step loop exits at the next boundary and releases the session mutex.
   * Without this, a Stop+Run cycle can hit "busy" because the runner is
   * still executing the previous step long after the client has gone.
   */
  signal?: AbortSignal;
}

export interface MobileApplyOutput {
  success: boolean;
  error?: string;
  stepResult?: {
    success: boolean;
    error?: string;
    screenshot?: string;
    resolvedVia?: string;
    durationMs?: number;
    /**
     * Advisory warnings from the runner (e.g. `install_app` flags release
     * APKs that lack `WebView.setWebContentsDebuggingEnabled(true)`). Absent
     * when there are none; callers should truthy-check.
     */
    warnings?: Array<{
      code: string;
      message: string;
      packageName?: string;
    }>;
  };
  appliedStep?: {
    id: string;
    type: string;
    description: string;
    value?: string;
    options?: Record<string, any>;
    bindingHints: Record<string, any>;
    evidence: Record<string, any>;
    /**
     * Freshly-built compiled locator plan from this apply. Present when the runner's
     * smartResolve succeeded and built a plan; absent for fast-path lint (no plan
     * available from /commands/:id/lint endpoint) or failures.
     */
    compiled?: MobileCompiledPlan;
  };
  status: 'passed' | 'failed';
}

// ── Service ───────────────────────────────────────────────────────────────

export class MobileStepApplyService {
  /**
   * Execute a single mobile step and return the enriched result.
   *
   * Does NOT write to DB — the caller decides whether/how to persist the
   * `appliedStep`. Does NOT write editor trace — the caller (REST controller
   * or WS handler) is the right layer for tracing (it knows the userId and
   * trace-session scoping).
   */
  static async apply(input: MobileApplyInput): Promise<MobileApplyOutput> {
    const { sessionId, stepDraft, signal, userId } = input;
    const client = await getMobileRunnerClientForSession(sessionId);

    const rawStepType = stepDraft.type || stepDraft.kind || 'click';
    const stepType = STEP_TYPE_MAP[rawStepType] || rawStepType;

    // Normalize description: strip surrounding quotes (handles whole-wrap +
    // balanced inline pairs). See normalize-description.ts for the failure
    // modes of the previous one-shot regex.
    const { normalizeMobileDescription } = await import('./normalize-description');
    const description = normalizeMobileDescription(stepDraft.elementDescription || stepDraft.description);

    const applyStart = Date.now();

    // If the step already has a compiled plan from a prior apply, skip the
    // lint-then-execute fast path and go straight to runSteps — the runner's
    // tryCompiledFastPath() will short-circuit the LLM pipeline in ~5ms,
    // which beats a 200-500ms lintElement round-trip.
    const hasCompiled = !!(stepDraft.intentStep?.compiled || stepDraft.compiled);

    // ── Fast path: lint first, execute by coordinates ───────────────────
    // Only for steps WITHOUT a compiled plan (first apply / manual adds).
    if (!hasCompiled && description && LINT_TYPES.has(rawStepType)) {
      const lintActionType = LINT_ACTION_TYPE_MAP[rawStepType] || 'tap';

      try {
        const lintResult = await client.lintElement(sessionId, description, lintActionType, undefined, { userId });

        if (lintResult.status === 'resolved' && lintResult.boundingBox) {
          const bb = lintResult.boundingBox;
          const centerX = Math.round(bb.x + bb.width / 2);
          const centerY = Math.round(bb.y + bb.height / 2);
          // Forward the resolver's confidence onto the command so the runner
          // can decide whether to trust these coords on the next replay or
          // re-resolve via vision/LLM (release-build layout shifts, DPR
          // changes, etc.). See runner TapParams.coordsConfidence.
          let coordsConfidence = typeof lintResult.confidence === 'number'
            ? lintResult.confidence
            : undefined;
          // Vision-sourced coords are low-trust by nature: the element was
          // resolved from a screenshot (no a11y/inspector text match), so the
          // point is a best-guess pixel, not a tree-anchored node. Common on
          // Semantics-less Flutter screens. The vision model often reports high
          // confidence (~0.9) even when it grabbed the wrong widget, which would
          // trip the runner's TRUST_COORDS_THRESHOLD (≥0.9) and dispatch the bad
          // point blindly. Demote below that threshold so smartResolve re-fetches
          // a fresh (now inspector-sourced) tree and re-resolves by text/keys
          // instead of tapping the stale vision pixel.
          if (lintResult.visionMode) {
            coordsConfidence = Math.min(coordsConfidence ?? 0.5, 0.5);
          }
          // Pass `intent` (the normalized description) alongside the
          // coordinates so the runner's smartResolve can re-validate the
          // target if `coordsConfidence < 0.9`. Without intent, smartResolve
          // takes the early-return passthrough branch (no-intent → no
          // re-resolve possible) and dispatches the bare coordinates blindly
          // — which is wrong when 200-700ms have elapsed between lint and
          // dispatch (HTTP roundtrip + lint compute) and the screen has
          // shifted (animation finished, snackbar dismissed, app pushed a
          // dialog). With intent + low confidence the runner re-fetches a
          // fresh tree and re-resolves, correcting the coords. With intent
          // + high confidence (≥ 0.9) it still passthroughs — no perf hit
          // on the happy path.
          const coordParams: Record<string, unknown> = {
            x: centerX,
            y: centerY,
            intent: description,
          };
          if (coordsConfidence !== undefined) coordParams.coordsConfidence = coordsConfidence;

          const commands: Array<{ type: string; params: Record<string, unknown> }> = [];

          if (rawStepType === 'type' || rawStepType === 'fill') {
            commands.push({ type: 'tap', params: { ...coordParams } });
            if (stepDraft.value) {
              commands.push({
                type: 'type_text',
                params: {
                  // Pass the same coordinates the preceding tap used so the
                  // runner's dispatch takes the coordinates branch: re-tap +
                  // waitForKeyboardReady + typeText. Without x/y it falls into
                  // the 'direct' branch and blind-fires `adb shell input text`
                  // before the IME is actually up — text lands in whatever
                  // field previously held focus (symptom in prod: VTE reads
                  // back stale text and triggers two retries).
                  ...coordParams,
                  text: stepDraft.value,
                  clearFirst: !!(stepDraft.options?.replaceContent),
                  // Editor "type like a human" toggle. Forwarded to the runner,
                  // which on Flutter types per-character ('human') / atomically
                  // ('instant'), or applies its heuristic ('auto'/undefined).
                  ...(stepDraft.options?.typeMode ? { typeMode: stepDraft.options.typeMode } : {}),
                },
              });
              if (stepDraft.options?.pressEnter) {
                commands.push({ type: 'press_key', params: { keycode: 'KEYCODE_ENTER' } });
              }
            }
          } else {
            commands.push({ type: RAW_CMD_MAP[rawStepType] || 'tap', params: { ...coordParams } });
          }

          await client.executeBatchCommands(sessionId, commands, { userId });
          const durationMs = Date.now() - applyStart;

          const appliedStep = {
            id: stepDraft.id || `apply_${Date.now()}`,
            type: stepType,
            description,
            value: stepDraft.value,
            options: stepDraft.options,
            bindingHints: {
              ...(stepDraft.intentStep?.bindingHints || stepDraft.bindingHints || {}),
              ...(lintResult.elementText ? { label: lintResult.elementText } : {}),
              ...(lintResult.elementType ? { role: lintResult.elementType } : {}),
            },
            evidence: {
              resolvedVia: lintResult.resolvedVia || 'lint',
              confidence: lintResult.confidence,
              boundingBox: lintResult.boundingBox,
              appliedAt: new Date().toISOString(),
            },
            // Carry the lint-built compiled plan onto the IntentStep so the NEXT
            // apply (regression / replay) goes through runner's fast-path
            // instead of re-linting via LLM.
            ...(lintResult.compiledPlan ? { compiled: lintResult.compiledPlan } : {}),
          };

          return {
            success: true,
            stepResult: { success: true, resolvedVia: lintResult.resolvedVia || 'lint', durationMs },
            appliedStep,
            status: 'passed',
          };
        }

        // Lint didn't resolve — fall through to runSteps
      } catch (lintError) {
        logger.warn('[MOBILE_STEP_APPLY] Lint path failed, falling back to runSteps', {
          sessionId,
          error: lintError instanceof Error ? lintError.message : String(lintError),
        });
        // Fall through
      }
    }

    // ── Fallback: full runSteps pipeline ────────────────────────────────
    // CRITICAL: forward `compiled` so the runner's fast-path resolver can
    // short-circuit the LLM pipeline. Without this the plan is written to
    // DB on first apply but never used on subsequent runs.
    const intentStep = {
      id: stepDraft.id || `apply_${Date.now()}`,
      type: stepType,
      description,
      value: stepDraft.value,
      assertionText: stepDraft.assertionText,
      appPackage: stepDraft.appPackage,
      options: stepDraft.options,
      // Priority: top-level `stepDraft.bindingHints` (edited by the user in
      // the inspector) > `stepDraft.intentStep.bindingHints` (recorded
      // snapshot). The frontend `buildStepDraft` already applies the same
      // precedence when picking which hints to set on `stepDraft.bindingHints`,
      // so reaching `intentStep.bindingHints` here means the user did not
      // edit and we fall back to the recorded set. The previous order had
      // intentStep first which silently ignored in-editor hint edits.
      bindingHints: stepDraft.bindingHints || stepDraft.intentStep?.bindingHints || {},
      // Compiled plan: top-level (manual rebuild path) > intentStep (saved
      // step / recorded session). Either source has already passed the
      // frontend's intentStepDirty safeguard, so trust whichever exists.
      compiled: stepDraft.compiled || stepDraft.intentStep?.compiled,
    };

    const result = await client.runSteps(sessionId, [intentStep], {
      screenshotEachStep: true,
      stopOnFailure: false,
      signal,
      userId,
    });

    const stepResult = result.steps?.[0];
    const success = stepResult?.success ?? false;

    // On failure we still want to forward `appliedStep` when the runner
    // emitted a compiled plan AND it was a "proven" plan — i.e. resolveVia
    // was compiled_fast_path or cache, meaning the plan already matched the
    // current tree before the run started; the failure happened downstream
    // of resolution (dispatch / VTE / app crash) and the plan is still
    // worth persisting. Without this, every failed run discards a
    // perfectly-good plan and the next run re-pays full LLM cost.
    // We do NOT forward fresh LLM plans on failure — that would risk
    // locking in an incorrect element pick.
    const PROVEN_RESOLVED_VIA: ReadonlySet<string> = new Set([
      'compiled', 'compiled_fast_path', 'cache',
      // text_match: resolved by a direct, unambiguous tree text match (LLM-free).
      // It picks a real node, so its compiled plan is just as trustworthy to
      // persist as the compiled/cache paths — and lets the next run skip the LLM.
      'text_match',
    ]);
    const planIsProven = !!stepResult?.resolvedVia
      && PROVEN_RESOLVED_VIA.has(stepResult.resolvedVia);
    // Runner-flagged stale plan (VTE mismatch / foreground mismatch) —
    // dispatch reported success but evidence contradicts the resolved
    // element. Don't carry such a plan onto appliedStep.compiled, otherwise
    // the next run's fast-path locks in the wrong element.
    const planIsStale = !!stepResult?.planStaleReason;
    const shouldEmitAppliedStep = success
      || (!!stepResult?.compiledPlan && planIsProven && !planIsStale);

    const appliedStep = shouldEmitAppliedStep
      ? {
          id: intentStep.id,
          type: stepType,
          description,
          value: stepDraft.value,
          options: stepDraft.options,
          bindingHints: intentStep.bindingHints || {},
          evidence: {
            resolvedVia: stepResult!.resolvedVia,
            appliedAt: new Date().toISOString(),
            ...(stepResult!.evidence ? { runtime: stepResult!.evidence } : {}),
          },
          // Carry the runner-built compiled plan onto the IntentStep. Next run's
          // apply will short-circuit the LLM pipeline if this plan still matches.
          // Strip the plan when the runner flagged it stale post-dispatch even
          // though `success === true` — saving it would re-introduce the bug.
          ...(stepResult!.compiledPlan && !planIsStale
            ? { compiled: stepResult!.compiledPlan }
            : {}),
        }
      : undefined;

    return {
      success: true, // service call succeeded; stepResult reports step success/failure
      stepResult: {
        success,
        error: stepResult?.error,
        screenshot: stepResult?.screenshot,
        resolvedVia: stepResult?.resolvedVia,
        durationMs: stepResult?.durationMs,
        // Only attach when the runner actually emitted warnings, so the
        // frontend can do a truthy-check rather than a length-check.
        ...(stepResult?.warnings && stepResult.warnings.length > 0
          ? { warnings: stepResult.warnings }
          : {}),
      },
      appliedStep,
      status: success ? 'passed' : 'failed',
    };
  }
}
