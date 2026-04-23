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

import { getMobileRunnerClient } from './mobile-runner-client';
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
    const { sessionId, stepDraft, signal } = input;
    const client = getMobileRunnerClient();

    const rawStepType = stepDraft.type || stepDraft.kind || 'click';
    const stepType = STEP_TYPE_MAP[rawStepType] || rawStepType;

    // Normalize description: strip surrounding quotes (users often type "Login" etc.)
    const rawDescription = stepDraft.elementDescription || stepDraft.description || '';
    const description = rawDescription.replace(/['"]+([^'"]+)['"]+/g, '$1').trim();

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
        const lintResult = await client.lintElement(sessionId, description, lintActionType);

        if (lintResult.status === 'resolved' && lintResult.boundingBox) {
          const bb = lintResult.boundingBox;
          const centerX = Math.round(bb.x + bb.width / 2);
          const centerY = Math.round(bb.y + bb.height / 2);
          // Forward the resolver's confidence onto the command so the runner
          // can decide whether to trust these coords on the next replay or
          // re-resolve via vision/LLM (release-build layout shifts, DPR
          // changes, etc.). See runner TapParams.coordsConfidence.
          const coordsConfidence = typeof lintResult.confidence === 'number'
            ? lintResult.confidence
            : undefined;
          const coordParams: Record<string, unknown> = { x: centerX, y: centerY };
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
                },
              });
              if (stepDraft.options?.pressEnter) {
                commands.push({ type: 'press_key', params: { keycode: 'KEYCODE_ENTER' } });
              }
            }
          } else {
            commands.push({ type: RAW_CMD_MAP[rawStepType] || 'tap', params: { ...coordParams } });
          }

          await client.executeBatchCommands(sessionId, commands);
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
      bindingHints: stepDraft.intentStep?.bindingHints || stepDraft.bindingHints || {},
      compiled: stepDraft.intentStep?.compiled || stepDraft.compiled,
    };

    const result = await client.runSteps(sessionId, [intentStep], {
      screenshotEachStep: true,
      stopOnFailure: false,
      signal,
    });

    const stepResult = result.steps?.[0];
    const success = stepResult?.success ?? false;

    const appliedStep = success
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
          ...(stepResult!.compiledPlan ? { compiled: stepResult!.compiledPlan } : {}),
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
