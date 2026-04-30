/**
 * Preview Run Service V11
 * Orchestrates "Run from start" feature in AI editor
 * Executes steps sequentially in existing preview browser session
 * Features: cancel support, per-step progress tracking, stop-on-fail, best-effort persistence
 *
 * V9: Extracted runStepsOnPreview() for ephemeral (DB-free) draft step execution.
 *     runSavedSteps() is now a thin wrapper that resolves steps from DB then delegates.
 * V10: Global run timeout (5 min), always emit completion (even pre-started failures),
 *      timeout guards on finally-block cleanup to prevent hanging.
 * V11: Post-navigate page summary for better error context, step-level retry (1 attempt)
 *      for transient failures (element not visible, click intercepted, DOM re-rendering).
 */

import { LiteTraceWriter } from '@/agent/core/lite/trace/lite-trace-writer';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { IntentTestCaseService } from './intent-test-case.service';
import { PreviewStepApplyService } from './preview-step-apply.service';
import { getPreviewSessionService } from './preview-session.service';
import type { IntentActionType, IntentStep } from './preview.types';
import { shouldSkipLookaheadAfter, waitForStepReadiness, waitForApiIdle } from './step-readiness.service';
import { StepTelemetryCollector } from './step-telemetry-collector.service';
import { STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';
import { injectAutoWaitForSteps, normalizeUrlForComparison } from './auto-wait-for.utils';
import { diagnoseStepBlocker, actOnDiagnosis } from './step-blocker-diagnosis.service';
import { waitForPageInteractive } from './page-interactive.utils';

/** Base timeout for run setup (navigation, init). */
/**
 * V23: Decision-trace emission gate. Trace is BUILT in every env (so the
 * apply contract stays the same and unit tests can assert on it), but only
 * WRITTEN to preview_run JSONL when not in production. Override via
 * `PREVIEW_TRACE_DECISIONS=true` if you ever need it on prod for one-off
 * diagnosis — default off because the payload can be ~2 KB per step and we
 * don't want to bloat regression run logs that travel through the upload
 * pipeline.
 *
 * Resolution is per-call (not module-level) so changes to env at runtime
 * (tests, dynamic config) take effect without a process restart.
 */
function shouldEmitDecisionTrace(): boolean {
  if (process.env.PREVIEW_TRACE_DECISIONS === 'true') return true;
  if (process.env.PREVIEW_TRACE_DECISIONS === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

const BASE_RUN_TIMEOUT_MS = 60 * 1000; // 1 minute for setup
/** Per-step timeout budget. Total = BASE + (steps × PER_STEP). */
const PER_STEP_TIMEOUT_MS = 15 * 1000; // 15 seconds per step
/** Absolute maximum regardless of step count. */
const MAX_RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes hard cap

/** Maximum time for cleanup operations (batch persist, trace close) in finally block. */
const CLEANUP_TIMEOUT_MS = 10_000; // 10 seconds

/** Wrap a promise with a timeout. Rejects with TimeoutError if exceeded. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[TimeoutError] ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Wait for DOM to stabilize after navigation (SPA hydration).
 * Uses MutationObserver — does NOT wait for images/fonts/analytics.
 */
async function waitForDOMStability(
  page: import('playwright').Page,
  maxWaitMs: number = STEP_READINESS_CONFIG.defaults.maxWaitMs,
  stabilityMs: number = STEP_READINESS_CONFIG.domStableThresholdMs.navigation,
): Promise<void> {
  try {
    await page.evaluate(
      ({ maxWait, stability }: { maxWait: number; stability: number }) => {
        return new Promise<void>((resolve) => {
          // @ts-expect-error - document exists in browser context
          const root = document.body || document.documentElement;
          if (!root) { resolve(); return; }
          let lastMutation = Date.now();
          // @ts-expect-error - MutationObserver exists in browser context
          const observer = new MutationObserver(() => { lastMutation = Date.now(); });
          observer.observe(root, { childList: true, subtree: true, attributes: true });
          const check = () => {
            if (Date.now() - lastMutation >= stability) { observer.disconnect(); resolve(); return; }
            setTimeout(check, 100);
          };
          setTimeout(check, 100);
          setTimeout(() => { observer.disconnect(); resolve(); }, maxWait);
        });
      },
      { maxWait: maxWaitMs, stability: stabilityMs }
    );
  } catch {
    // Page navigating/crashed — continue
  }
}

// ── LLM Blocker Diagnosis + Retry Helper (DRY — used in both result and exception paths) ──

interface DiagnosisRetryResult {
  /** The final step result after LLM-guided retry (or null if not attempted) */
  result: Awaited<ReturnType<typeof PreviewStepApplyService.applyStep>> | null;
  /** True if LLM diagnosis was attempted */
  diagnosed: boolean;
  /** The diagnosis (if attempted) */
  diagnosis: Awaited<ReturnType<typeof diagnoseStepBlocker>> | undefined;
  /** True if actOnDiagnosis wait succeeded */
  waitSucceeded?: boolean;
}

/**
 * After a deterministic retry fails, ask LLM what's blocking the step,
 * wait for the suggested selector, then retry once more.
 *
 * @returns null result if diagnosis was skipped/failed/not-retryable
 */
async function attemptLLMDiagnosisAndRetry(params: {
  page: import('playwright').Page;
  step: IntentStep;
  error: string;
  previewSessionId: string;
  userId: string;
  stepWithCachePolicy: IntentStep;
  runStartTime: number;
  signal: AbortSignal;
}): Promise<DiagnosisRetryResult> {
  const { page, step, error, previewSessionId, userId, stepWithCachePolicy, runStartTime, signal } = params;

  const elapsedTotal = Date.now() - runStartTime;
  if (signal.aborted || elapsedTotal >= MAX_RUN_TIMEOUT_MS - 15000) {
    return { result: null, diagnosed: false, diagnosis: undefined };
  }

  try {
    const diagnosis = await diagnoseStepBlocker(page, step, error);

    if (diagnosis && diagnosis.shouldRetry) {
      logger.info('[PreviewRun] LLM diagnosis suggests retry', {
        previewSessionId,
        stepId: step.id,
        blocker: diagnosis.blocker,
        waitForSelector: diagnosis.waitForSelector,
        confidence: diagnosis.confidence,
      });

      const waitSucceeded = await actOnDiagnosis(page, diagnosis);

      const result = await PreviewStepApplyService.applyStep({
        previewSessionId,
        stepDraft: {
          ...stepWithCachePolicy,
          options: {
            ...stepWithCachePolicy.options,
            disableCaching: true,
            timeout: Math.max(stepWithCachePolicy.options?.timeout || 10000, 15000),
          },
        },
        userId,
        skipPostActionWait: true,
      });

      if (!result.success) {
        logger.warn('[PreviewRun] LLM-guided retry also failed', {
          previewSessionId,
          stepId: step.id,
          blocker: diagnosis.blocker,
          retryError: result.error,
        });
      }

      return { result, diagnosed: true, diagnosis, waitSucceeded };
    }

    if (diagnosis) {
      logger.info('[PreviewRun] LLM diagnosis: not retryable', {
        previewSessionId,
        stepId: step.id,
        blocker: diagnosis.blocker,
        confidence: diagnosis.confidence,
      });
    }

    return { result: null, diagnosed: true, diagnosis };
  } catch (diagError) {
    logger.warn('[PreviewRun] LLM diagnosis failed', {
      previewSessionId,
      stepId: step.id,
      error: diagError instanceof Error ? diagError.message : String(diagError),
    });
    return { result: null, diagnosed: false, diagnosis: undefined };
  }
}

// ── Post-Navigate Page Summary (diagnostic context for better error messages) ──

interface PageSummary {
  url: string;
  title: string;
  headings: string[];   // Up to 5 h1/h2 headings
  landmarks: string[];  // Up to 5 aria landmarks
}

/**
 * Collect a lightweight page summary after navigation.
 * Fast (~20-50ms): one page.title() + one page.evaluate(). Non-fatal on failure.
 */
async function collectLightPageSummary(page: import('playwright').Page): Promise<PageSummary> {
  try {
    const [title, summary] = await Promise.all([
      page.title().catch(() => ''),
      page.evaluate(() => {
        // @ts-expect-error - document exists in browser context
        const headingEls = document.querySelectorAll('h1, h2');
        const headings = Array.from(headingEls)
          .slice(0, 5)
          .map((el: any) => el.textContent?.trim() || '')
          .filter(Boolean);
        // @ts-expect-error - document exists in browser context
        const landmarkEls = document.querySelectorAll('nav, main, aside, header, footer, [role="navigation"], [role="main"]');
        const landmarks = Array.from(landmarkEls)
          .slice(0, 5)
          .map((el: any) => {
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            const label = el.getAttribute('aria-label') || '';
            return label ? `${role}(${label})` : role;
          });
        return { headings, landmarks };
      }).catch(() => ({ headings: [] as string[], landmarks: [] as string[] })),
    ]);
    return { url: page.url(), title, headings: summary.headings, landmarks: summary.landmarks };
  } catch {
    return { url: page.url(), title: '', headings: [], landmarks: [] };
  }
}

/**
 * Augment a step error message with navigation page context.
 * Gives the user actionable info: what page they're on and what content is visible.
 *
 * Optionally includes a `urlMismatch` hint when the run started on a page that
 * doesn't match where the test was originally recorded (typically: user is
 * already authenticated and the recorded login flow doesn't apply anymore).
 * The hint is only added to the FIRST few step failures so it doesn't pollute
 * later, unrelated errors.
 */
function augmentErrorWithPageContext(
  error: string,
  pageSummary: PageSummary | null,
  urlMismatch?: UrlMismatchInfo | null,
): string {
  const sections: string[] = [error];

  if (pageSummary) {
    const parts = [`Page: ${pageSummary.url}`];
    if (pageSummary.title) parts.push(`Title: "${pageSummary.title}"`);
    if (pageSummary.headings.length > 0) parts.push(`Headings: ${pageSummary.headings.join(', ')}`);
    sections.push(`[Page context after last navigation]\n${parts.join('\n')}`);
  }

  if (urlMismatch) {
    // Show normalized URLs (origin + pathname only) in the user-visible
    // hint — raw URLs may contain session tokens, CSRF nonces, OAuth state
    // params, etc. that we don't want to leak into error messages.
    const recordedDisplay = normalizeUrlForComparison(urlMismatch.recordedUrl);
    const actualDisplay = normalizeUrlForComparison(urlMismatch.actualUrl);
    sections.push(
      `[Possible cause — page diverged from recording]\n` +
      `Test was recorded on: ${recordedDisplay}\n` +
      `Run actually landed on: ${actualDisplay}\n` +
      `${urlMismatch.sameOrigin
        ? 'Same site, different path. The site may have redirected you (e.g. you are already authenticated and skipped past the login form).'
        : 'Different origin. The site may be redirecting to an SSO/OAuth provider that the recording did not capture.'}\n` +
      `If you intended to test from the recorded starting page, try logging out (or using an incognito session) and re-running.`
    );
  }

  return sections.join('\n\n');
}

// ── Auth/URL mismatch detection ────────────────────────────────────────────

/**
 * Information about a divergence between where the test was recorded and where
 * the actual run landed after initial navigation. Populated by
 * `detectInitialUrlMismatch` after `waitForPageInteractive` settles.
 */
interface UrlMismatchInfo {
  recordedUrl: string;
  actualUrl: string;
  /** True iff the two URLs share an origin but differ in pathname. */
  sameOrigin: boolean;
  /** Index of the recorded step the recordedUrl was sourced from. */
  sourceStepIndex: number;
}

/**
 * Number of consecutive failing steps for which we still show the URL-mismatch
 * hint. After this many steps it's almost certainly not the auth-mismatch
 * cause anymore — adding the hint to step 17's error would be misleading.
 */
const URL_MISMATCH_HINT_MAX_STEPS = 5;

/**
 * Find the URL of the first recorded step that captured one. Falls back across
 * compiled.context.pageUrl → evidence.pageUrl → none. Returns null if no step
 * in the supplied list ever had a captured URL — in that case we cannot
 * detect mismatches and proceed without warning.
 */
function findFirstRecordedStepUrl(
  steps: IntentStep[],
): { url: string; stepIndex: number } | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const compiled = step.compiled?.context?.pageUrl;
    if (typeof compiled === 'string' && compiled.length > 0) {
      return { url: compiled, stepIndex: i };
    }
    const evidence = step.evidence?.pageUrl;
    if (typeof evidence === 'string' && evidence.length > 0) {
      return { url: evidence, stepIndex: i };
    }
  }
  return null;
}

/**
 * Detect whether the actual landing URL diverged from the URL the test was
 * originally recorded on. Returns null when:
 *   - No recorded URL was available (nothing to compare against)
 *   - URLs match after normalization (origin + pathname, ignoring query/hash)
 *   - Either URL is unparseable (we can't make a meaningful comparison)
 *
 * Returns a `UrlMismatchInfo` object when the normalized paths differ — this
 * is the signal that the user is probably on a different page than what the
 * recorded steps were captured on (most commonly: already authenticated and
 * redirected past the recorded login form).
 */
function detectInitialUrlMismatch(
  actualUrl: string,
  steps: IntentStep[],
): UrlMismatchInfo | null {
  if (!actualUrl || actualUrl === 'about:blank') return null;

  const recorded = findFirstRecordedStepUrl(steps);
  if (!recorded) return null;

  const normalizedActual = normalizeUrlForComparison(actualUrl);
  const normalizedRecorded = normalizeUrlForComparison(recorded.url);

  if (normalizedActual === normalizedRecorded) return null;

  // Compute origin (best-effort) so callers can tell SSO redirects apart from
  // intra-app drift. URL parsing is wrapped in try/catch because the recorded
  // URL was captured on a different machine and could be in any state.
  let actualOrigin = '';
  let recordedOrigin = '';
  try { actualOrigin = new URL(actualUrl).origin; } catch { /* leave empty */ }
  try { recordedOrigin = new URL(recorded.url).origin; } catch { /* leave empty */ }

  return {
    recordedUrl: recorded.url,
    actualUrl,
    sameOrigin: actualOrigin !== '' && actualOrigin === recordedOrigin,
    sourceStepIndex: recorded.stepIndex,
  };
}

// ── Step-Level Retry ───────────────────────────────────────────────────────

/** Step types that should NOT be retried on failure — either non-recoverable or LLM-evaluated */
const NO_RETRY_STEP_TYPES = new Set(['ai_check', 'wait', 'wait_for_email', 'dialog', 'download', 'switch_tab']);

/** Wait time (ms) for DOM stability before retry attempt */
const RETRY_SETTLE_MS = 1500;

/**
 * Internal state for active runs
 */
interface RunState {
  running: boolean;
  cancelled: boolean;
  startTime: number;
  currentStepIndex: number;
  abortController: AbortController;
}

/**
 * Race a promise against an AbortSignal.
 * Rejects immediately with AbortError when signal fires — used to interrupt
 * long-running Playwright/LLM operations on user cancel.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  ]);
}

/**
 * Per-session run registry to prevent concurrent runs
 * Key: previewSessionId
 */
const activeRuns = new Map<string, RunState>();

// ═══════════════════════════════════════════════════════════════════════════
// V12: Email variable interpolation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace {{email.variableName}} placeholders in step.value with extracted email values.
 * Pure function — returns original step unchanged if no placeholders found.
 *
 * Values are stored in session.contextData by the wait_for_email handler
 * (e.g., contextData['email.otp'] = '123456').
 */
/**
 * Interpolate {{key}} context variable placeholders in step fields.
 *
 * Supports any key stored in session.contextData — not just email.* variables.
 * Email variables ({{email.otp}}) continue to work since they are stored as
 * contextData['email.otp'] and the pattern matches any dot-notation key.
 *
 * Used as cross-step scratchpad: wait_for_email stores `email.otp`,
 * store meta-steps write arbitrary keys, and subsequent steps resolve them.
 */
function interpolateContextVariables(step: IntentStep, previewSessionId: string): IntentStep {
  const sessionService = getPreviewSessionService();
  const session = sessionService.getSession(previewSessionId);
  const contextData = session?.contextData;
  if (!contextData || Object.keys(contextData).length === 0) return step;

  const resolve = (s: string): string => {
    if (!s.includes('{{')) return s;
    return s.replace(/\{\{([\w.-]+)\}\}/g, (match, key) => {
      const replacement = contextData[key];
      return typeof replacement === 'string' ? replacement : match;
    });
  };

  let changed = false;
  const result = { ...step };

  if (result.value) {
    const resolved = resolve(result.value);
    if (resolved !== result.value) { result.value = resolved; changed = true; }
  }
  if (result.assertionText) {
    const resolved = resolve(result.assertionText);
    if (resolved !== result.assertionText) { result.assertionText = resolved; changed = true; }
  }
  if (result.description) {
    const resolved = resolve(result.description);
    if (resolved !== result.description) { result.description = resolved; changed = true; }
  }

  return changed ? result : step;
}

/**
 * Result summary returned by runStepsOnPreview / runSavedSteps after the run
 * has fully completed (or errored). Mirrors the payload of preview:run:completed
 * so callers (chat tools, AI agents) can answer "did the run succeed?" without
 * subscribing to WebSocket events.
 */
export interface PreviewRunSummary {
  success: boolean;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  cancelled: boolean;
  timedOut: boolean;
  duration: number;
  /** Failed step details (truncated to first 5) for human-readable error messages */
  failedStepDetails?: Array<{
    stepIndex: number;
    description: string;
    action: string;
    error?: string;
  }>;
  /** First failed step error (for quick AI summary) */
  firstError?: string;
}

/**
 * Service for running steps in preview session
 */
export class PreviewRunService {
  /**
   * Start "Run from start" - load saved steps from DB and execute sequentially.
   * This is a thin wrapper: resolves steps/startUrl from DB, then delegates to runStepsOnPreview().
   *
   * @param previewSessionId - Preview session ID (must be active)
   * @param intentTestCaseId - Test case ID to load steps from
   * @param userId - User ID for ownership verification
   * @param options.inlineSteps - If provided, save these steps to DB first and use them directly
   *   (avoids the load-from-DB round-trip). Used by "Apply All" to save + run in one call.
   * @param options.startUrl - Override startUrl (used when inlineSteps are provided and
   *   the test case may not have a startUrl yet).
   */
  static async runSavedSteps(
    previewSessionId: string,
    intentTestCaseId: string,
    userId: string,
    options?: {
      inlineSteps?: IntentStep[];
      startUrl?: string;
      /** Optional per-run authReset override (see `runStepsOnPreview` docs). */
      authReset?: 'always' | 'never';
      /**
       * "Apply New Only" — start at this step index instead of 0. The
       * preview is left where it currently is (no goto, no auth wipe).
       * Steps 0..startFromIndex-1 are persisted to DB but not executed.
       * Validated upstream (handler) to be a positive finite integer.
       */
      startFromIndex?: number;
    },
  ): Promise<PreviewRunSummary> {
    // ─── Early guards (fail-fast before any DB work) ───────────────────
    if (activeRuns.has(previewSessionId)) {
      throw new Error('Run already in progress for this session');
    }

    const sessionService = getPreviewSessionService();
    if (!sessionService.isSessionOwned(previewSessionId, userId)) {
      throw new Error('Session not owned by user');
    }

    // ─── Resolve steps and startUrl from DB ──────────────────────────────

    let savedSteps: IntentStep[] | null = null;
    let startUrl: string | undefined;

    if (options?.inlineSteps && options.inlineSteps.length > 0) {
      // "Apply All" path: save inline steps to DB first, then use them directly.
      // This avoids a double round-trip (save → load) and keeps the flow atomic.
      const patch: Record<string, unknown> = { steps: options.inlineSteps };
      if (options.startUrl) {
        patch.url = options.startUrl;
        patch.startUrl = options.startUrl;
      }
      await IntentTestCaseService.update({
        id: intentTestCaseId,
        userId,
        ...patch,
      });
      savedSteps = options.inlineSteps;
      startUrl = options.startUrl;
      logger.info('[PreviewRun] Saved inline steps to DB before run', {
        previewSessionId, intentTestCaseId, stepCount: savedSteps.length,
      });
    }

    // Standard path (or inline without startUrl): load from DB
    if (!savedSteps || !startUrl) {
      const testCase = await IntentTestCaseService.getById(intentTestCaseId, userId);
      if (!savedSteps) {
        if (!testCase || !testCase.stepsJson) {
          throw new Error('Test case not found or has no saved steps');
        }
        savedSteps = testCase.stepsJson;
      }
      if (!startUrl) {
        startUrl = testCase?.startUrl || testCase?.url || undefined;
      }
    }

    if (savedSteps.length === 0) {
      throw new Error('No steps to run');
    }

    // V13: Fallback to recording-time page URL if no startUrl from DB/frontend
    if (!startUrl) {
      startUrl = sessionService.getRecordingStartUrl(previewSessionId, userId);
      if (startUrl) {
        logger.info('[PreviewRun] Using recordingStartUrl as fallback', {
          previewSessionId, startUrl,
        });
      }
    }

    if (!startUrl) {
      throw new Error('Test case has no startUrl or url');
    }

    // "Apply New Only": clamp index to valid range and force authReset
    // off. The whole point of this mode is to run against the live
    // preview state — wiping cookies would defeat it. Invalid indices
    // (>= step count) collapse to undefined so the run still works as
    // a normal Apply All instead of failing silently.
    let effectiveStartFromIndex: number | undefined;
    let effectiveAuthReset = options?.authReset;
    if (typeof options?.startFromIndex === 'number'
        && options.startFromIndex > 0
        && options.startFromIndex < savedSteps.length) {
      effectiveStartFromIndex = options.startFromIndex;
      effectiveAuthReset = 'never';
      logger.info('[PreviewRun] Apply New Only mode', {
        previewSessionId,
        intentTestCaseId,
        startFromIndex: effectiveStartFromIndex,
        totalSteps: savedSteps.length,
        stepsToExecute: savedSteps.length - effectiveStartFromIndex,
      });
    }

    // ─── Delegate to core execution loop with persistence enabled ────────
    return PreviewRunService.runStepsOnPreview(
      previewSessionId,
      savedSteps,
      startUrl,
      userId,
      {
        intentTestCaseId,
        persistAppliedSteps: true,
        _skipOwnershipCheck: true, // Already verified above
        authReset: effectiveAuthReset,
        startFromIndex: effectiveStartFromIndex,
      },
    );
  }

  /**
   * Execute steps directly on preview session — core execution loop.
   *
   * When persistAppliedSteps is false (default), this method performs ZERO DB reads or writes.
   * Used for ephemeral "draft" runs triggered from the AI chat, as well as internally by runSavedSteps().
   *
   * Emits standard WebSocket events (preview:run:started/step/completed) — frontend works unchanged.
   * Uses the same activeRuns map for concurrency/cancellation — both ephemeral and saved runs are mutually exclusive.
   *
   * @param previewSessionId - Active preview session
   * @param steps - IntentStep array to execute
   * @param startUrl - URL to navigate to before execution
   * @param userId - User ID (for session ownership + WebSocket)
   * @param options.intentTestCaseId - Optional test case ID (for trace metadata only when persistAppliedSteps is false)
   * @param options.persistAppliedSteps - If true, persist appliedStep to DB per step (default: false)
   * @param options.chatSessionId - Reserved for future use (chat:processing:step was removed due to
   *   conflict with fire-and-forget pattern — frontend subscribes to preview:run:* directly)
   */
  static async runStepsOnPreview(
    previewSessionId: string,
    steps: IntentStep[],
    startUrl: string,
    userId: string,
    options?: {
      intentTestCaseId?: string;
      persistAppliedSteps?: boolean;
      chatSessionId?: string;
      /**
       * Whether to clear cookies + localStorage + sessionStorage before the run.
       * 'always' — clear every run so each start is deterministic; prevents a
       *   successful login from a prior run carrying over and pushing the replay
       *   into a different code path (e.g. /login → /dashboard), which would
       *   silently "pass" against the wrong page.
       * 'never' (DEFAULT) — keep the current context state. Use for tests that
       *   expect a persistent session (user manually logged in before recording,
       *   chained tests, or SPAs that gate content on localStorage flags).
       *
       * Default rationale: originally this shipped as 'always' default but that
       * broke every site whose first-visit experience differs from repeat
       * visits — the wipe deleted localStorage keys like `joyride:seen`,
       * re-triggering an onboarding tour whose overlay intercepts every click
       * with a Playwright timeout. See repro 2026-04-21 on repetino.kz tutors
       * page. Flipping the default to 'never' restores pre-2026-04-20 behaviour
       * while keeping the explicit opt-in for tests that need a clean slate.
       *
       * Test Resources with kind='auth' will drive this per-test-case once the
       * UI toggle lands.
       */
      authReset?: 'always' | 'never';
      /** @internal Skip ownership check when caller (runSavedSteps) already verified */
      _skipOwnershipCheck?: boolean;
      /**
       * "Apply New Only" — skip steps before this index (don't execute,
       * don't goto, don't auth-reset). Caller must enforce authReset='never'
       * when this is set; we don't double-check here.
       */
      startFromIndex?: number;
    },
  ): Promise<PreviewRunSummary> {
    const intentTestCaseId = options?.intentTestCaseId;
    const persistAppliedSteps = options?.persistAppliedSteps ?? false;
    const authReset: 'always' | 'never' = options?.authReset ?? 'never';
    // Validated by callers. Default 0 = run from start (full Apply All).
    const startFromIndex: number =
      typeof options?.startFromIndex === 'number'
      && options.startFromIndex > 0
      && options.startFromIndex < steps.length
        ? options.startFromIndex
        : 0;
    const skipNavigationAndAuthReset = startFromIndex > 0;

    // 1. Check if already running
    if (activeRuns.has(previewSessionId)) {
      throw new Error('Run already in progress for this session');
    }

    // 2. Verify session ownership (skipped when called from runSavedSteps which already verified)
    const sessionService = getPreviewSessionService();
    if (!options?._skipOwnershipCheck && !sessionService.isSessionOwned(previewSessionId, userId)) {
      throw new Error('Session not owned by user');
    }

    // 3. Initialize run state early (before awaits) to make cancellation/concurrency deterministic
    const runState: RunState = {
      running: true,
      cancelled: false,
      startTime: Date.now(),
      currentStepIndex: 0,
      abortController: new AbortController(),
    };
    const signal = runState.abortController.signal;

    let startedEmitted = false;
    let timedOut = false;

    let passedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;

    // Capture per-failure details for the returned summary (used by chat tools/AI)
    const failedStepDetails: NonNullable<PreviewRunSummary['failedStepDetails']> = [];

    // Built in finally — returned to caller after the run fully completes.
    let runSummary: PreviewRunSummary | null = null;

    // Populated by `detectInitialUrlMismatch` after the initial navigation
    // settles. When set, the first few step failures will include a hint
    // explaining that the page diverged from the recorded one — typically
    // because the user is already authenticated. Cleared on every URL gate
    // pass; never set to a stale value.
    let urlMismatchInfo: UrlMismatchInfo | null = null;

    // Batch accumulator: collect enriched steps in-memory, persist once at end
    const enrichedSteps = new Map<string, IntentStep>();

    // Initialize trace writer for JSONL logging
    const traceId = intentTestCaseId
      ? `preview_run_${previewSessionId}`
      : `draft_run_${previewSessionId}`;
    const traceWriter = new LiteTraceWriter({
      testId: traceId,
      logsDir: undefined, // Use default test_logs/
      maxFileSizeBytes: 50 * 1024 * 1024, // 50MB for preview runs
      maxPayloadChars: 10_000,
    });
    const rootSpanId = traceWriter.getRootSpanId();

    // Dynamic timeout: scales with step count, capped at MAX_RUN_TIMEOUT_MS
    // 5 steps → 1min + 75s = ~2.25 min
    // 20 steps → 1min + 300s = ~6 min
    // 50 steps → 1min + 750s = ~13.5 min
    // 100 steps → capped at 15 min
    const dynamicTimeoutMs = Math.min(
      BASE_RUN_TIMEOUT_MS + (steps.length * PER_STEP_TIMEOUT_MS),
      MAX_RUN_TIMEOUT_MS,
    );

    const globalTimeout = setTimeout(() => {
      timedOut = true;
      runState.cancelled = true;
      runState.abortController.abort();
      logger.error('[PreviewRun] Global timeout exceeded, forcing cancellation', {
        previewSessionId,
        timeoutMs: dynamicTimeoutMs,
        totalSteps: steps.length,
        currentStepIndex: runState.currentStepIndex,
      });
    }, dynamicTimeoutMs);

    // V14: Per-step telemetry collector — declared outside try for finally cleanup
    let telemetryCollector: StepTelemetryCollector | null = null;

    // Capture any error thrown inside the run loop so the finally block
    // can record it in the returned summary (used by chat tools/AI agents).
    let caughtRunError: unknown = null;

    // Publish the activeRuns lock as the LAST statement before `try` so
    // that any sync throw above cannot leak the entry. The finally handler
    // will always delete it via the identity check on runState. A prior
    // layout published the lock 50+ lines earlier — if LiteTraceWriter's
    // constructor (fs.mkdirSync) or any other pre-try line threw, the
    // lock stayed set forever and every subsequent Run rejected with
    // "Run already in progress" until the server was restarted.
    activeRuns.set(previewSessionId, runState);

    try {
      // Disable the external-nav trap for the duration of the run. Recorded
      // tests legitimately cross origins (OAuth hand-off, payment providers)
      // and the trap would revert those mid-replay. Guaranteed paired with
      // `resumeTrap` in the finally block below because we're inside try now.
      try {
        const { suspendTrap } = await import('./external-nav-trap');
        suspendTrap(previewSessionId);
      } catch { /* non-fatal */ }

      // 4. Get session page
      const session = sessionService.getSession(previewSessionId);
      if (!session?.page) {
        throw new Error('Session has no active page');
      }

      // V14: Initialize collector now that page is available
      telemetryCollector = new StepTelemetryCollector(session.page, {
        testCaseId: intentTestCaseId || undefined,
        startUrl,
      });

      logger.info('[PreviewRun] Starting run', {
        previewSessionId,
        intentTestCaseId: intentTestCaseId ?? '(ephemeral)',
        userId,
        totalSteps: steps.length,
        startUrl,
        ephemeral: !persistAppliedSteps,
      });

      // Trace run_start
      traceWriter.write({
        stage: 'initialization',
        eventType: 'run_start',
        spanId: rootSpanId,
        payload: {
          previewSessionId,
          intentTestCaseId: intentTestCaseId ?? undefined,
          userId,
          totalSteps: steps.length,
          startUrl,
          mode: persistAppliedSteps ? 'preview_run' : 'draft_run',
          startTime: new Date(runState.startTime).toISOString(),
        },
      });

      // 5. Emit started event
      // Apply New Only: report only the count of steps actually being
      // executed so the progress bar reads "1/20" instead of "16/35"
      // (the prior 15 are skipped on the wire — the user explicitly
      // chose this mode to avoid re-running them).
      const visibleTotalSteps = startFromIndex > 0
        ? Math.max(0, steps.length - startFromIndex)
        : steps.length;
      webSocketService.emitToUser(userId, 'preview:run:started', {
        previewSessionId,
        totalSteps: visibleTotalSteps,
        startUrl,
        ephemeral: !persistAppliedSteps, // true for draft runs (from chat), false for saved test runs
        timestamp: new Date().toISOString(),
      });
      startedEmitted = true;

      // Editor trace: session_context — single-shot snapshot of who/what/where
      // so a reader doesn't have to correlate events to reconstruct the run.
      try {
        const ctxTrace = (await import('./editor-trace.service')).EditorTraceService.get(previewSessionId);
        if (ctxTrace) {
          ctxTrace.writeSessionContext({
            previewSessionId,
            userId,
            intentTestCaseId,
            isMobile: false,
            isRecording: sessionService.isRecording(previewSessionId, userId),
            startUrl,
            currentUrl: session.page.url(),
            stepCount: steps.length,
            hasAuthBinding: false, // populated by runSavedSteps caller via separate writeSessionContext call when known
            authReset,
            runMode: persistAppliedSteps ? 'run_all' : 'single_apply',
          });
        }
      } catch { /* non-fatal */ }

      // 6. Reset session state for fresh run (prevents stale state from previous run)
      session.lastSnapshotEmit = 0;
      session.lastPageSignature = '';
      session.lastScreenshotEmitAt = 0;
      sessionService.setDialogMode(previewSessionId, userId, 'passive');
      // Close extra tabs from previous run (keep only active tab)
      if (session.pages.length > 1) {
        for (const p of session.pages) {
          if (p !== session.page && !p.isClosed()) {
            try { await p.close().catch(() => {}); } catch { /* best effort */ }
          }
        }
        session.pages = [session.page];
        session.activeTabIndex = 0;
      }

      // 7. Navigate to startUrl before executing steps
      // If already on startUrl, force reload to clear DOM state (refs, form values, modals)
      // If different URL, normal goto works (full navigation)
      const currentUrl = session.page.url();
      const needsReload = normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(startUrl);

      // "Apply New Only" — skip the whole goto+auth-reset+readiness block.
      // The whole point is that the live preview is ALREADY in the state we
      // want to test (right where the user just finished recording). A
      // wipe-then-goto here would defeat the mode entirely. The user must
      // have triggered this from the new "Apply New Only" dropdown, which
      // pre-checks current preview URL against the recorded URL of the
      // first-to-execute step — so we trust the input here.
      if (skipNavigationAndAuthReset) {
        logger.info('[PreviewRun] Apply New Only — skipping goto + auth-reset', {
          previewSessionId,
          startFromIndex,
          currentUrl,
        });
      }

      logger.info('[PreviewRun] Navigating to startUrl', {
        previewSessionId,
        startUrl,
        needsReload,
        skipNavigation: skipNavigationAndAuthReset,
      });

      // Test-run pre-navigation is user-intent. Tell the external-nav trap
      // to accept the new landing origin as the fresh baseline so a
      // test that starts from a cross-origin URL isn't reverted on load.
      // (Skipped in Apply New Only — preview already where the user
      // wants it, no navigation happening from us.)
      if (!skipNavigationAndAuthReset) {
        try {
          const { markIntentionalGoto } = await import('./external-nav-trap');
          markIntentionalGoto(previewSessionId, startUrl);
        } catch { /* non-fatal */ }
      }

      // Apply New Only branch: skip the whole "auth reset → goto → wait
      // for interactive → URL mismatch detect" block. The preview is
      // already where the user wants it (where they finished recording),
      // and we already declined to register markIntentionalGoto above.
      // We do NOT throw if anything looks weird — the per-step URL
      // mismatch check will surface a yellow badge if step N+1 finds
      // itself on the wrong page, which is the right granularity here.
      if (!skipNavigationAndAuthReset) {
      // Auth reset (Phase 0).
      //
      // Rationale: without this, a prior run that logged the user in leaves cookies +
      // localStorage populated. The next run of the same login-flow test lands on the
      // authenticated page instead of /login, LLM picks some generic elements, and
      // steps "pass" against the wrong page. See log analysis 2026-04-20 for the
      // original fake-pass incident.
      //
      // We must clear BOTH cookies AND localStorage/sessionStorage BEFORE the goto —
      // otherwise app JS runs at goto-time, reads the stale auth token, and can even
      // mint a brand-new session cookie via /api/refresh. Clearing after goto is too
      // late.
      //
      // localStorage is origin-scoped, so we can only clear it while the page is on
      // the target origin. If the session's current page is already same-origin with
      // startUrl (the common case for repeated runs of the same test) we can clear
      // pre-goto. Otherwise we fall back to post-goto + reload, which is still correct
      // because nothing on the current page can mint auth tokens for startUrl's
      // origin.
      //
      // We snapshot counts BEFORE clearing so the UI warning tells the user something
      // actually happened — silent cleanup makes a failing second run look like a
      // mysterious regression.
      //
      // Cost: +1 reload (~500ms) only when post-goto storage cleanup was required.
      // Same-origin sessions and pristine contexts pay near-zero.
      const normalizedStartUrl = (() => {
        try { return new URL(startUrl); } catch { return null; }
      })();
      const normalizedCurrentPageUrl = (() => {
        try { return new URL(session.page.url()); } catch { return null; }
      })();
      const currentPageIsSameOrigin =
        !!normalizedStartUrl
        && !!normalizedCurrentPageUrl
        && normalizedCurrentPageUrl.origin === normalizedStartUrl.origin;

      let clearedCookieCount = 0;
      let clearedLocalStorageKeyCount = 0;
      let clearedSessionStorageKeyCount = 0;
      let postGotoStorageClearNeeded = false;
      const shouldClearAuth = authReset === 'always';

      if (shouldClearAuth) {
        // 1. Clear cookies — context-level, no page navigation required.
        try {
          const ctx = session.page.context();
          const cookiesBefore = await ctx.cookies();
          clearedCookieCount = cookiesBefore.length;
          if (clearedCookieCount > 0) {
            await ctx.clearCookies();
          }
        } catch (clearErr) {
          logger.warn('[PreviewRun] Failed to clear cookies (proceeding anyway)', {
            previewSessionId,
            error: clearErr instanceof Error ? clearErr.message : String(clearErr),
          });
        }

        // 2. Clear localStorage/sessionStorage. If same-origin, clear NOW (pre-goto) so
        //    the upcoming goto/reload runs against a truly empty slate. If different
        //    origin, we can't touch the target origin's storage yet — defer to
        //    post-goto.
        if (currentPageIsSameOrigin) {
          try {
            const counts = await session.page.evaluate(() => {
              // @ts-expect-error - localStorage exists in browser context
              const localCount = localStorage.length;
              // @ts-expect-error - sessionStorage exists in browser context
              const sessionCount = sessionStorage.length;
              // @ts-expect-error - localStorage exists in browser context
              try { localStorage.clear(); } catch { /* storage may be disabled */ }
              // @ts-expect-error - sessionStorage exists in browser context
              try { sessionStorage.clear(); } catch { /* storage may be disabled */ }
              return { localCount, sessionCount };
            });
            clearedLocalStorageKeyCount = counts.localCount ?? 0;
            clearedSessionStorageKeyCount = counts.sessionCount ?? 0;
          } catch (storageErr) {
            logger.warn('[PreviewRun] Failed to pre-clear page storage (will retry post-goto)', {
              previewSessionId,
              error: storageErr instanceof Error ? storageErr.message : String(storageErr),
            });
            postGotoStorageClearNeeded = true;
          }
        } else {
          // Cross-origin current page — can't touch target origin's storage yet,
          // so we must check + wipe after goto. We flag regardless of cookie count
          // because localStorage-only auth (JWT stored in localStorage with no
          // cookies) is a common OAuth pattern and cookie count won't tell us
          // anything about it.
          postGotoStorageClearNeeded = true;
        }

        if (clearedCookieCount > 0 || clearedLocalStorageKeyCount > 0 || clearedSessionStorageKeyCount > 0) {
          logger.info('[PreviewRun] Cleared auth state before run', {
            previewSessionId,
            cookiesCleared: clearedCookieCount,
            localStorageKeysCleared: clearedLocalStorageKeyCount,
            sessionStorageKeysCleared: clearedSessionStorageKeyCount,
            storageClearPhase: currentPageIsSameOrigin ? 'pre-goto' : 'post-goto-pending',
          });
        }
      }

      // Notify the UI BEFORE we navigate whenever we have final numbers: cookies +
      // same-origin storage were both handled pre-goto. Cross-origin runs defer the
      // emit to the post-goto branch below, once storage counts are known — avoids
      // sending "cookiesCleared: 12, localStorage: 0" when localStorage on the
      // target origin was actually 8. The correlated in-run signal is worth the
      // ~200ms delay for that specific case.
      const totalClearedArtifacts =
        clearedCookieCount + clearedLocalStorageKeyCount + clearedSessionStorageKeyCount;
      if (shouldClearAuth && totalClearedArtifacts > 0 && !postGotoStorageClearNeeded) {
        webSocketService.emitToUser(userId, 'preview:run:auth-reset', {
          previewSessionId,
          cookiesCleared: clearedCookieCount,
          localStorageKeysCleared: clearedLocalStorageKeyCount,
          sessionStorageKeysCleared: clearedSessionStorageKeyCount,
          reason: 'authReset=always — each run starts from a clean slate. Set authReset=never in the run options if your test expects a persistent session.',
          timestamp: new Date().toISOString(),
        });
      }

      try {
        if (needsReload) {
          await raceAbort(session.page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          }), signal);
        } else {
          await raceAbort(session.page.goto(startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          }), signal);
        }

        // Post-goto cleanup path — used when the session's current page was on a
        // different origin than startUrl (so we couldn't pre-clear localStorage), OR
        // when the pre-goto clear threw. We always check storage, but only pay for a
        // second reload if something was actually present — the target origin may
        // have no localStorage at all (common: first time the test runs against a
        // new domain in this session).
        if (shouldClearAuth && postGotoStorageClearNeeded) {
          try {
            const counts = await session.page.evaluate(() => {
              // @ts-expect-error - localStorage exists in browser context
              const localCount = localStorage.length;
              // @ts-expect-error - sessionStorage exists in browser context
              const sessionCount = sessionStorage.length;
              // @ts-expect-error - localStorage exists in browser context
              try { localStorage.clear(); } catch { /* storage may be disabled */ }
              // @ts-expect-error - sessionStorage exists in browser context
              try { sessionStorage.clear(); } catch { /* storage may be disabled */ }
              return { localCount, sessionCount };
            });
            clearedLocalStorageKeyCount = counts.localCount ?? 0;
            clearedSessionStorageKeyCount = counts.sessionCount ?? 0;
            const hadStorage =
              clearedLocalStorageKeyCount > 0 || clearedSessionStorageKeyCount > 0;
            if (hadStorage) {
              // App already ran with stale storage on the first goto — reload so it
              // re-initializes empty.
              await raceAbort(session.page.reload({
                waitUntil: 'domcontentloaded',
                timeout: 30000,
              }), signal);
              logger.info('[PreviewRun] Post-goto storage cleanup + reload complete', {
                previewSessionId,
                localStorageKeysCleared: clearedLocalStorageKeyCount,
                sessionStorageKeysCleared: clearedSessionStorageKeyCount,
              });
            }

            // Emit the UI warning now with FINAL counts — covers both the
            // "cookies + storage" case (reload was needed) and the "cookies only,
            // storage was empty on target origin" case (no reload, but user still
            // deserves to know cookies got wiped). Skipped only when nothing at
            // all was cleared.
            if (
              clearedCookieCount > 0
              || clearedLocalStorageKeyCount > 0
              || clearedSessionStorageKeyCount > 0
            ) {
              webSocketService.emitToUser(userId, 'preview:run:auth-reset', {
                previewSessionId,
                cookiesCleared: clearedCookieCount,
                localStorageKeysCleared: clearedLocalStorageKeyCount,
                sessionStorageKeysCleared: clearedSessionStorageKeyCount,
                reason: 'authReset=always — each run starts from a clean slate. Set authReset=never in the run options if your test expects a persistent session.',
                timestamp: new Date().toISOString(),
              });
            }
          } catch (storageErr) {
            logger.warn('[PreviewRun] Failed to clear page storage post-goto (proceeding anyway)', {
              previewSessionId,
              error: storageErr instanceof Error ? storageErr.message : String(storageErr),
            });
          }
        }

        // Wait until the page is **actually interactive for a bot**, not just
        // "DOM stopped mutating for 500ms". The old waitForDOMStability() was
        // fooled by SSO/OAuth redirect chains (e.g. dlkz.doculite.kz →
        // accounttest.doculite.kz/oauth/authorize → …): mutations quiet down
        // between redirects, so it returned ready while the login form wasn't
        // even on screen yet. See preview-run `No interactive elements found
        // on page` incident, 2026-04-07.
        //
        // waitForPageInteractive is a composite gate that only returns ready
        // once:
        //   1. URL has stopped changing (redirect chain finished)
        //   2. API idle + DOM stable + loading indicators cleared
        //   3. SnapshotCollector.collect() returns ≥1 interactive element
        //      (same collector the step resolver uses — if it sees elements
        //      here, step 1 is guaranteed to resolve a target).
        // Fails open on timeout so we preserve the old "always try" behavior.
        // Passes the cancel signal natively — no raceAbort wrapper needed,
        // waitForPageInteractive checks signal.aborted each iteration and
        // returns early with { ready: false, reason: 'aborted' }.
        const initialReadiness = await waitForPageInteractive(session.page, {
          previewSessionId,
          signal,
        });

        // If the caller cancelled, propagate the same AbortError the old
        // raceAbort path used — so the outer catch block can still detect
        // cancellation uniformly.
        if (initialReadiness.reason === 'aborted') {
          throw new DOMException('Run cancelled', 'AbortError');
        }

        logger.info('[PreviewRun] Navigation to startUrl complete', {
          previewSessionId,
          currentUrl: session.page.url(),
          readinessReady: initialReadiness.ready,
          readinessWaited: initialReadiness.waited,
          readinessElementCount: initialReadiness.elementCount,
          ...(initialReadiness.reason ? { readinessReason: initialReadiness.reason } : {}),
        });

        // ── URL mismatch detection ─────────────────────────────────────────
        // The page is now stable (waitForPageInteractive has settled all
        // redirect chains and confirmed interactive elements exist). This is
        // the right moment to compare where we actually landed against where
        // the test was originally recorded. If they diverge — most commonly
        // because the user is already authenticated and the site redirected
        // past the recorded login form — we log a warning now and stash the
        // info on `urlMismatchInfo` so the first few step failures can show
        // a useful hint instead of dying with a generic "element not found".
        //
        // We do NOT hard-fail here. The recorded URL could be wrong (old
        // recording, bug in the recorder, OAuth chain that wasn't fully
        // captured), and a false positive would be worse than the current
        // behavior. So we let the run proceed, and only the actual step
        // failures will pick up the hint via augmentErrorWithPageContext.
        //
        // We pass the original `steps` (not `stepsToExecute`) because:
        //   1. stepsToExecute is computed later in the function
        //   2. injectAutoWaitForSteps only adds wait_for steps BETWEEN existing
        //      ones — it never reorders or removes the original first step,
        //      so the first recorded URL is identical in both arrays.
        //
        // Wrapped in defensive try/catch: this is a best-effort observability
        // feature, never a reason to fail a run. session.page.url() can throw
        // if the page closed mid-flight; URL parsing inside the detector is
        // already guarded, but belt-and-braces.
        try {
          urlMismatchInfo = detectInitialUrlMismatch(session.page.url(), steps);
          if (urlMismatchInfo) {
            logger.warn('[PreviewRun] Page URL diverged from recording', {
              previewSessionId,
              recordedUrl: urlMismatchInfo.recordedUrl,
              actualUrl: urlMismatchInfo.actualUrl,
              sameOrigin: urlMismatchInfo.sameOrigin,
              sourceStepIndex: urlMismatchInfo.sourceStepIndex,
              hint: 'User may already be authenticated, or the site redirected past the recorded starting page',
            });
          }
        } catch (mismatchError) {
          logger.debug('[PreviewRun] URL mismatch detection threw (non-fatal)', {
            previewSessionId,
            error: mismatchError instanceof Error ? mismatchError.message : String(mismatchError),
          });
          urlMismatchInfo = null;
        }
      } catch (navError) {
        // AbortError from raceAbort — run was cancelled during initial navigation
        if (navError instanceof DOMException && navError.name === 'AbortError') {
          logger.info('[PreviewRun] Initial navigation aborted by cancel signal', { previewSessionId });
          throw navError; // Propagate to outer catch — finally block will emit completion
        }
        logger.error('[PreviewRun] Failed to navigate to startUrl', {
          previewSessionId,
          startUrl,
          error: navError instanceof Error ? navError.message : String(navError),
        });
        throw new Error(`Failed to navigate to startUrl: ${navError instanceof Error ? navError.message : String(navError)}`);
      }
      } // end of `if (!skipNavigationAndAuthReset)` — Apply New Only branches around the goto/auth block

      // Allow other events (cancel/isRunning) to observe activeRuns state.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // V15: Per-tab URL tracking for evidence shortcut policy
      const trackedUrls = new Map<number, string>();
      trackedUrls.set(session.activeTabIndex, session.page.url());
      let trackedUrl = session.page.url(); // Backward compat alias for current tab
      // Track page summary after navigation for better error context
      let lastNavigationSummary: PageSummary | null = null;

      // Adaptive settle threshold: tracks actual settle times PER ACTION TYPE.
      // After click (navigation risk) → longer settle. After type (input) → shorter settle.
      // Groups match getDomStableThresholdMs categories: navigation, input, assertion, default.
      const adaptiveSettleByCategory = new Map<string, number[]>();
      const getActionCategory = (actionType: IntentActionType | string): string => {
        if (['click', 'open', 'close', 'toggle', 'select', 'dblclick'].includes(actionType)) return 'navigation';
        if (['type', 'press'].includes(actionType)) return 'input';
        if (['assert', 'ai_check'].includes(actionType)) return 'assertion';
        return 'default';
      };
      const getAdaptiveSettleMs = (prevActionType?: IntentActionType | string): number => {
        const category = prevActionType ? getActionCategory(prevActionType) : 'default';
        const samples = adaptiveSettleByCategory.get(category);
        if (!samples || samples.length < 2) return STEP_READINESS_CONFIG.defaults.settleMs; // Not enough data
        // p75 × 1.5 safety margin, clamped to [150, 3000]
        const sorted = [...samples].sort((a, b) => a - b);
        const p75 = sorted[Math.floor(sorted.length * 0.75)];
        return Math.max(150, Math.min(3000, Math.round(p75 * 1.5)));
      };
      const recordSettleTime = (prevActionType: IntentActionType | string, waitedMs: number): void => {
        const category = getActionCategory(prevActionType);
        const samples = adaptiveSettleByCategory.get(category) || [];
        samples.push(waitedMs);
        // Keep last 10 samples per category to stay responsive to changes
        if (samples.length > 10) samples.shift();
        adaptiveSettleByCategory.set(category, samples);
      };

      // V13: Pre-inject auto-wait steps for first-run stability.
      // On second+ runs these are already in the DB from batchUpdateStepsFromRun().
      // The injection is idempotent — it skips if the next step is already wait_for.
      // Uses evidence.pageUrl (captured during recording) as fallback when compiled plans are missing.
      //
      // Apply New Only: slice off the already-applied prefix BEFORE the
      // auto-wait injection. We intentionally do this on `steps` (original
      // array) rather than after injection — wait_for is only useful as a
      // pre-step warm-up before the actual interaction. The user's first
      // un-applied step IS the first interaction we're running, so prefacing
      // it with a wait_for derived from earlier steps would just block on
      // state we already trust (the live preview is exactly where the user
      // recorded from).
      const stepsAfterSlice = startFromIndex > 0 ? steps.slice(startFromIndex) : steps;
      const stepsToExecute = injectAutoWaitForSteps(stepsAfterSlice);
      if (stepsToExecute.length !== stepsAfterSlice.length) {
        logger.info('[PreviewRun] Pre-injected auto-wait steps for first-run stability', {
          previewSessionId,
          originalSteps: stepsAfterSlice.length,
          withAutoWaits: stepsToExecute.length,
          injectedCount: stepsToExecute.length - stepsAfterSlice.length,
        });
      }

      logger.debug('[PreviewRun] Starting run with URL tracking', {
        previewSessionId,
        initialUrl: trackedUrl,
        totalSteps: stepsToExecute.length,
      });

      // V13: Switch dialog handler to replay mode — use pre-installed actions from recorded dialog steps
      sessionService.setDialogMode(previewSessionId, userId, 'replay');

      // Skip compiled shortcut for remaining steps if first compiled plan failed (likely stale after deploy)
      let skipCompiledForRemaining = false;

      // ─── Step execution loop ───────────────────────────────────────────
      for (let i = 0; i < stepsToExecute.length; i++) {
        // Apply New Only: when steps are sliced (startFromIndex > 0), `i`
        // is the slice-local index (0..N-1) but downstream consumers
        // (frontend step rows keyed by stepIndex, telemetry, run summary)
        // expect the ORIGINAL index from the editor (e.g. 16..35). Use
        // this whenever we emit stepIndex outside the loop body — i alone
        // would lie about which step in the editor's list is currently
        // executing. injectAutoWaitForSteps may also have inserted
        // synthetic wait_for steps which don't have a recorded position;
        // for those we still report the ORIGINAL position of the next
        // real step the wait is preceding (i.e. just clamp to the slice's
        // start offset — UI keys steps by id anyway, the index is for
        // ordering / progress display).
        const originalStepIndex = startFromIndex + i;
        // Check cancellation
        const currentRunState = activeRuns.get(previewSessionId);
        if (!currentRunState || runState.cancelled || currentRunState.cancelled) {
          logger.info('[PreviewRun] Run cancelled, skipping remaining steps', {
            previewSessionId,
            currentStep: i,
            remainingSteps: stepsToExecute.length - i,
          });

          // Emit remaining steps as skipped
          for (let j = i; j < stepsToExecute.length; j++) {
            const step = stepsToExecute[j];
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: startFromIndex + j,
              stepId: step.id,
              status: 'skipped',
              action: step.type,
              description: step.description,
              timestamp: new Date().toISOString(),
            });
            skippedSteps++;
          }
          break;
        }

        runState.currentStepIndex = i;
        const step = stepsToExecute[i];

        logger.info('[PreviewRun] Executing step', {
          previewSessionId,
          stepIndex: originalStepIndex,
          stepId: step.id,
          stepType: step.type,
          description: step.description?.slice(0, 80),
        });

        // Trace step_start
        const stepSpanId = traceWriter.generateSpanId();
        traceWriter.write({
          iteration: i,
          stage: 'step_execution',
          eventType: 'step_start',
          spanId: stepSpanId,
          parentSpanId: rootSpanId,
          payload: {
            stepIndex: originalStepIndex,
            stepId: step.id,
            stepType: step.type,
            description: step.description,
            hasCompiled: !!step.compiled,
            hasEvidence: !!step.evidence?.lastSuccessRef,
            hasRecordedFingerprint: !!step.recordedFingerprint,
            recordedId: step.recordedFingerprint?.elementId,
            recordedTestId: step.recordedFingerprint?.testIdAttr,
            recordedTag: step.recordedFingerprint?.tag,
          },
        });

        // Per-step URL mismatch detection.
        // Catches the "user clicked around the preview between Apply All and
        // recording the next batch" case. If step 16 was recorded on /admin/x
        // but the test currently sits on / (because authReset cleared session
        // and steps 1-15 ended elsewhere), the click is doomed before it
        // starts — but the failure looks like a generic "element not found"
        // and the user has no way to know why.
        //
        // We compare normalized URLs (origin + pathname, ignoring query/hash
        // to allow benign navigation like ?tab=2 or #section). Only emitted
        // when the step has a recorded URL — manual steps without recording
        // history are skipped (nothing to compare against).
        //
        // i=0 is normally skipped because the run-wide `urlMismatchInfo`
        // already covers the initial-landing case. But in Apply New Only
        // mode we never run the goto/auth-reset block, so urlMismatchInfo
        // is always null and the first step IS the user's first new step
        // — exactly the one most at risk. So we DO check i=0 in that mode.
        let perStepUrlMismatch: { recorded: string; actual: string } | null = null;
        if (i > 0 || skipNavigationAndAuthReset) {
          try {
            const recordedUrl =
              (step.compiled?.context?.pageUrl && typeof step.compiled.context.pageUrl === 'string'
                ? step.compiled.context.pageUrl
                : undefined)
              || (typeof step.evidence?.pageUrl === 'string' ? step.evidence.pageUrl : undefined);
            if (recordedUrl) {
              const actualUrl = session.page.url();
              const normRecorded = normalizeUrlForComparison(recordedUrl);
              const normActual = normalizeUrlForComparison(actualUrl);
              if (normRecorded && normActual && normRecorded !== normActual) {
                perStepUrlMismatch = { recorded: recordedUrl, actual: actualUrl };
                logger.warn('[PreviewRun] Per-step URL mismatch detected', {
                  previewSessionId,
                  stepIndex: originalStepIndex,
                  stepId: step.id,
                  recordedUrl,
                  actualUrl,
                });
                // Trace event so post-hoc analysis can correlate with fail
                // type. Non-fatal — we still execute the step so that legit
                // redirects (login flow, OAuth) don't get false-flagged.
                traceWriter.write({
                  iteration: i,
                  stage: 'step_execution',
                  eventType: 'url_mismatch',
                  spanId: traceWriter.generateSpanId(),
                  parentSpanId: stepSpanId,
                  payload: {
                    stepIndex: originalStepIndex,
                    stepId: step.id,
                    recordedUrl,
                    actualUrl,
                  },
                });
                // WS event for the frontend yellow badge. Frontend renders
                // a non-blocking hint on this step row; user can re-record
                // the step or click Reset to recreate the recorded context.
                webSocketService.emitToUser(userId, 'preview:run:url-mismatch', {
                  previewSessionId,
                  stepIndex: originalStepIndex,
                  stepId: step.id,
                  recordedUrl,
                  actualUrl,
                });
              }
            }
          } catch (e) {
            // Best-effort — never let URL diagnostic crash the run.
            logger.debug('[PreviewRun] Per-step URL mismatch check failed', {
              previewSessionId,
              stepIndex: originalStepIndex,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        // Editor trace: step_meta — what THIS step is supposed to do. Without
        // this, replaying a trace turns into "what was step `f293...` again?".
        try {
          const metaTrace = (await import('./editor-trace.service')).EditorTraceService.get(previewSessionId);
          if (metaTrace) {
            const stepKind = (step as unknown as { kind?: string }).kind;
            const isManualStep = !/^rec_/.test(step.id || '');
            metaTrace.writeStepMeta({
              stepId: step.id,
              type: step.type,
              kind: stepKind,
              description: step.description || '',
              value: typeof step.value === 'string' ? step.value : undefined,
              targetText: (step as unknown as { targetText?: string }).targetText,
              cssSelector: step.options?.cssSelector,
              iframeSelector: step.options?.iframe?.selector,
              // For ai_check the assertionText is the actual prompt sent to
              // the model — without it the trace shows "AI check" with no
              // hint of what was being verified, and a fail reason only
              // appears in run_summary. Surface it here so the step is
              // self-explanatory.
              assertionText: typeof (step as unknown as { assertionText?: string }).assertionText === 'string'
                ? (step as unknown as { assertionText: string }).assertionText
                : undefined,
              hasCompiled: !!step.compiled,
              hasEvidence: !!step.evidence?.lastSuccessRef,
              isManual: isManualStep,
              options: step.options as Record<string, unknown> | undefined,
            });
          }
        } catch { /* non-fatal */ }

        // V15: Lightweight page state snapshot for the editor trace — answers
        // "what state was the page in when this step started?" without needing
        // to reproduce the session. Fire-and-forget, capped at 200ms hard timeout.
        void (async () => {
          try {
            const stateEditorTrace = (await import('./editor-trace.service')).EditorTraceService.get(previewSessionId);
            if (!stateEditorTrace) return;
            const stateProbe = await Promise.race([
              session.page.evaluate(() => {
                // @ts-expect-error - browser context
                const doc = document;
                // @ts-expect-error - browser context
                const win = window;
                const keys = Object.keys(doc.documentElement || {}).join(' ');
                const bodyKeys = doc.body ? Object.keys(doc.body).join(' ') : '';
                return {
                  readyState: doc.readyState,
                  title: (doc.title || '').slice(0, 120),
                  bodyTextLength: (doc.body?.innerText || '').length,
                  interactiveElementCount: doc.querySelectorAll(
                    'a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]'
                  ).length,
                  frameworks: {
                    react: keys.includes('__reactFiber') || bodyKeys.includes('__reactFiber') || !!(win as any).React,
                    angular: !!(win as any).getAllAngularRootElements || !!(win as any).ng || !!(doc.querySelector('[ng-version]')),
                    vue: !!(win as any).Vue || !!(win as any).__VUE__,
                    alpine: !!(win as any).Alpine,
                    htmx: !!(win as any).htmx,
                    svelte: !!(win as any).__svelte,
                  },
                  // @ts-expect-error - navigator exists in browser context
                  hasServiceWorker: !!navigator?.serviceWorker?.controller,
                };
              }),
              new Promise<null>(resolve => setTimeout(() => resolve(null), 200)),
            ]);
            if (!stateProbe) return;
            stateEditorTrace.writePageState({
              stepId: step.id,
              when: 'step_start',
              url: session.page.url(),
              title: stateProbe.title,
              readyState: stateProbe.readyState,
              bodyTextLength: stateProbe.bodyTextLength,
              interactiveElementCount: stateProbe.interactiveElementCount,
              frameworks: stateProbe.frameworks,
              hasServiceWorker: stateProbe.hasServiceWorker,
            });

            // Detect mounted modals/dialogs/overlays so the trace shows
            // whether the click was happening on a perceived-clean page or
            // on top of an open dialog/drawer.
            try {
              const modalProbe = await Promise.race([
                session.page.evaluate(() => {
                  // @ts-expect-error - browser context
                  const doc = document;
                  const dialogs = doc.querySelectorAll(
                    '[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]'
                  );
                  const bodyChildCount = doc.body ? doc.body.children.length : 0;
                  let topZIndex: number | undefined;
                  let hasOverlay = false;
                  let activeModalText: string | undefined;
                  for (const child of (doc.body ? Array.from(doc.body.children) as any[] : [])) {
                    try {
                      const cs = (child.ownerDocument?.defaultView || (globalThis as any).window).getComputedStyle(child);
                      const z = parseInt(cs.zIndex || '', 10);
                      if (!isNaN(z) && (topZIndex === undefined || z > topZIndex)) topZIndex = z;
                      const pos = cs.position;
                      const rect = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
                      if ((pos === 'fixed' || pos === 'absolute') && rect && rect.width > 100 && rect.height > 100) {
                        hasOverlay = true;
                      }
                    } catch { /* ignore */ }
                  }
                  if (dialogs.length > 0) {
                    const first = dialogs[0] as any;
                    activeModalText = (first.innerText || first.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150);
                  }
                  return {
                    dialogCount: dialogs.length,
                    bodyChildCount,
                    topZIndex,
                    hasOverlay,
                    activeModalText,
                  };
                }),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
              ]);
              if (modalProbe) {
                stateEditorTrace.writePageModalState({
                  stepId: step.id,
                  dialogCount: modalProbe.dialogCount,
                  bodyChildCount: modalProbe.bodyChildCount,
                  topZIndex: modalProbe.topZIndex,
                  hasOverlay: modalProbe.hasOverlay,
                  activeModalText: modalProbe.activeModalText,
                });
              }
            } catch { /* non-fatal */ }
          } catch { /* non-fatal diagnostic */ }
        })();

        // Emit step running
        webSocketService.emitToUser(userId, 'preview:run:step', {
          previewSessionId,
          stepIndex: originalStepIndex,
          stepId: step.id,
          status: 'running',
          action: step.type,
          description: step.description,
          timestamp: new Date().toISOString(),
        });

        // NOTE: We do NOT emit chat:processing:step here. The draft run is fire-and-forget
        // so clientRequestInFlightRef is already false on the frontend, and processing steps
        // would be silently discarded. Frontend subscribes to preview:run:* directly instead.

        // Give a chance for a cancellation request to land before executing the step.
        await new Promise<void>((resolve) => setImmediate(resolve));

        const stateBeforeExecute = activeRuns.get(previewSessionId);
        if (!stateBeforeExecute || runState.cancelled || stateBeforeExecute.cancelled) {
          logger.info('[PreviewRun] Cancel detected before step execute, skipping remaining steps', {
            previewSessionId,
            currentStep: i,
            remainingSteps: stepsToExecute.length - i,
          });

          // Current step already received 'running' — emit it as cancelled, then skip the rest
          webSocketService.emitToUser(userId, 'preview:run:step', {
            previewSessionId,
            stepIndex: originalStepIndex,
            stepId: step.id,
            status: 'skipped',
            action: step.type,
            description: step.description,
            timestamp: new Date().toISOString(),
          });
          skippedSteps++;
          for (let j = i + 1; j < stepsToExecute.length; j++) {
            const remaining = stepsToExecute[j];
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: startFromIndex + j,
              stepId: remaining.id,
              status: 'skipped',
              action: remaining.type,
              description: remaining.description,
              timestamp: new Date().toISOString(),
            });
            skippedSteps++;
          }
          break;
        }

        // V7+V15: URL-based evidence policy — per-tab URL tracking
        const currentUrl = session.page.url();
        const tabTrackedUrl = trackedUrls.get(session.activeTabIndex) || '';
        trackedUrl = tabTrackedUrl; // Update alias for logging/diagnosis
        const urlChanged = currentUrl !== tabTrackedUrl;
        const disableCaching = urlChanged;

        logger.debug('[PreviewRun] Evidence policy check', {
          previewSessionId,
          stepIndex: originalStepIndex,
          stepId: step.id,
          urlChanged,
          disableCaching,
          trackedUrl: trackedUrl.slice(0, 80),
          currentUrl: currentUrl.slice(0, 80),
        });

        // Execute step via PreviewStepApplyService
        const stepWithCachePolicy: IntentStep = {
          ...step,
          options: {
            ...step.options,
            disableCaching, // URL-based: true if URL changed, false if same page
          },
        };

        // ── Scratchpad: handle 'store' meta-step (no Playwright action) ──
        if (stepWithCachePolicy.type === 'store') {
          const storeKey = stepWithCachePolicy.description?.trim();
          const storeValue = stepWithCachePolicy.value;
          if (storeKey && storeValue) {
            const sessionService = getPreviewSessionService();
            const session = sessionService.getSession(previewSessionId);
            const existingData = session?.contextData || {};
            sessionService.setContextData(previewSessionId, userId, { ...existingData, [storeKey]: storeValue });
          }
          continue; // No browser action — purely data storage
        }

        // Interpolate context variables ({{email.otp}}, {{order_id}}, {{custom_key}}, etc.)
        const interpolatedStep = interpolateContextVariables(stepWithCachePolicy, previewSessionId);

        // V13: Peek ahead — if next step is wait_for with changedFrom, current click expects navigation.
        // This enables Promise.all([waitForNavigation(), click()]) pattern for reliable nav capture.
        const peekNext = (i < stepsToExecute.length - 1) ? stepsToExecute[i + 1] : null;
        const expectsNavigation = !!peekNext
          && peekNext.type === 'wait_for'
          && !!peekNext.options?.urlMatcher?.changedFrom;

        try {
          // V14: Record step start for telemetry
          telemetryCollector?.markStepStart(i, step.id, step.type, step.description || '', session.page.url());

          const stepStartMs = Date.now();
          let result = await raceAbort(PreviewStepApplyService.applyStep({
            previewSessionId,
            stepDraft: interpolatedStep,
            userId,
            skipPostActionWait: true, // V12: Lookahead handles inter-step timing
            expectsNavigation, // V13: Wrap click with waitForNavigation if next step expects URL change
            skipCompiled: skipCompiledForRemaining,
          }), signal);

          // If compiled plan was tried and failed, skip compiled for remaining steps
          // (plans likely stale after deploy — don't waste 3s timeout per step)
          if (result.compiledFailed && !skipCompiledForRemaining) {
            skipCompiledForRemaining = true;
            logger.info('[PreviewRun] Compiled plan failed — skipping compiled for remaining steps', {
              previewSessionId, stepIndex: originalStepIndex, stepId: step.id,
            });
          }
          let retried = false;

          // ── Step-level retry: one attempt with relaxed params on failure ──
          // V13: navigate is retryable on timeout errors (not DNS/SSL which won't improve)
          const isNonRetryable = NO_RETRY_STEP_TYPES.has(step.type)
            || (step.type === 'navigate' && !result.error?.toLowerCase().includes('timeout'));
          if (
            !result.success &&
            !isNonRetryable &&
            !runState.cancelled &&
            !(result.error?.includes('session') || result.error?.includes('expired'))
          ) {
            logger.info('[PreviewRun] Attempting retry after failure', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              stepType: step.type,
              originalError: result.error,
            });

            try {
              await raceAbort(waitForDOMStability(session.page, RETRY_SETTLE_MS, 500), signal);
              result = await raceAbort(PreviewStepApplyService.applyStep({
                previewSessionId,
                stepDraft: {
                  ...stepWithCachePolicy,
                  options: {
                    ...stepWithCachePolicy.options,
                    disableCaching: true, // Force fresh element resolution
                    timeout: Math.max(stepWithCachePolicy.options?.timeout || 10000, 15000),
                  },
                },
                userId,
                skipPostActionWait: true,
              }), signal);
              retried = true;

              if (result.success) {
                logger.info('[PreviewRun] Retry succeeded', {
                  previewSessionId,
                  stepIndex: originalStepIndex,
                  stepId: step.id,
                });
              } else if (runState.cancelled) {
                // Cancel arrived during retry — skip LLM diagnosis
              } else {
                // ── LLM Diagnosis: deterministic retry failed, ask LLM what's blocking ──
                const diagResult = await raceAbort(attemptLLMDiagnosisAndRetry({
                  page: session.page,
                  step,
                  error: result.error || 'Step failed after retry',
                  previewSessionId,
                  userId,
                  stepWithCachePolicy,
                  runStartTime: runState.startTime,
                  signal,
                }), signal);
                if (diagResult.result) {
                  result = diagResult.result;
                }
              }
            } catch (retryError) {
              // AbortError from raceAbort — propagate to trigger cancellation handling
              if (retryError instanceof DOMException && retryError.name === 'AbortError') throw retryError;
              // Retry threw — fall through to original failure handling
              retried = true;
              logger.warn('[PreviewRun] Retry threw exception, using original failure', {
                previewSessionId,
                stepIndex: originalStepIndex,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
            }
          }

          const stepDurationMs = Date.now() - stepStartMs;

          // Log slow steps for production diagnosis
          if (stepDurationMs > 3000) {
            logger.warn('[PreviewRun] Slow step execution', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              stepType: step.type,
              durationMs: stepDurationMs,
              success: result.success,
              hasCompiled: !!step.compiled,
              disableCaching,
            });
          }

          if (result.success) {
            logger.info('[PreviewRun] Step passed', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
            });

            // Diagnostic — dump visible overlay/menu/dialog elements after
            // EVERY successful step so we can pinpoint which step opens the
            // profile menu / cdk-overlay that later blocks step 8/9. Probes
            // common Angular Material / CDK / generic dropdown markers.
            // Output goes to logs/fp_audit.log so it can be grep'd post-run.
            try {
              const overlays = await session.page.evaluate(() => {
                const sels = [
                  '.cdk-overlay-pane',
                  '.cdk-overlay-backdrop-showing',
                  '[role="menu"]',
                  '[role="dialog"]',
                  '[role="listbox"]',
                  '.mat-mdc-menu-panel',
                  '.mat-menu-panel',
                  '.mat-mdc-select-panel',
                  '[aria-modal="true"]',
                  '[data-state="open"]',
                ];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const doc = (globalThis as any).document;
                const found: Array<{sel: string; visible: boolean; text: string; bbox: {x:number;y:number;w:number;h:number} | null}> = [];
                for (const sel of sels) {
                  const els = doc.querySelectorAll(sel);
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  for (const el of Array.from(els) as any[]) {
                    const r = el.getBoundingClientRect();
                    const visible = r.width > 0 && r.height > 0;
                    found.push({
                      sel,
                      visible,
                      text: (el.innerText || '').slice(0, 100),
                      bbox: visible ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
                    });
                  }
                }
                return found;
              }).catch(() => null);
              if (overlays && overlays.length > 0) {
                const fs = await import('fs');
                const path = await import('path');
                const auditPath = path.join(process.cwd(), 'logs', 'fp_audit.log');
                fs.appendFileSync(auditPath, JSON.stringify({
                  ts: new Date().toISOString(),
                  scope: 'overlay_probe_after_step',
                  intentTestCaseId,
                  stepIndex: originalStepIndex,
                  stepId: step.id?.slice(0, 8),
                  stepDesc: typeof step.description === 'string' ? step.description.slice(0, 60) : '',
                  url: session.page.url(),
                  overlayCount: overlays.filter(o => o.visible).length,
                  overlays: overlays.filter(o => o.visible).slice(0, 10),
                }) + '\n');
              }
            } catch { /* non-fatal */ }

            // Trace step_result (pass)
            // April 2026: include clickEffectSignal so audits can tell
            // strong-signal passes (url / dialog / aria / dom / detach /
            // newtab) from weak ones (focus only — likely fake-success
            // when the page isn't in the recorded state). Also include
            // chosenRef/chosenLabel/chosenBbox + fingerprintMatch so a
            // 'pass on the wrong element' is diagnosable from a single
            // log line — fingerprintMatch:'mismatch' on a passed step
            // is the canonical fake-success signature.
            traceWriter.write({
              iteration: i,
              stage: 'step_execution',
              eventType: 'step_result',
              spanId: traceWriter.generateSpanId(),
              parentSpanId: stepSpanId,
              payload: {
                stepIndex: originalStepIndex,
                stepId: step.id,
                status: 'pass',
                urlChanged: result.urlChanged,
                url: result.url,
                attempts: result.attempts,
                verified: result.verified,
                ...(result.clickEffectSignal !== undefined ? { clickEffectSignal: result.clickEffectSignal } : {}),
                ...(result.chosenRef !== undefined ? { chosenRef: result.chosenRef } : {}),
                ...(result.chosenLabel !== undefined ? { chosenLabel: result.chosenLabel.slice(0, 80) } : {}),
                ...(result.chosenBoundingBox !== undefined ? { chosenBbox: result.chosenBoundingBox } : {}),
                ...(result.fingerprintMatch !== undefined ? { fingerprintMatch: result.fingerprintMatch } : {}),
                ...(result.resolverPath !== undefined ? { resolverPath: result.resolverPath } : {}),
                // Diagnostic — wait_for branch + the URLs it compared. Lets the
                // audit log explain why a `wait_for` step returned in 1ms vs
                // really waited for the URL change.
                ...(result.waitForBranch !== undefined ? { waitForBranch: result.waitForBranch } : {}),
                ...(result.waitForChangedFrom !== undefined ? { waitForChangedFrom: result.waitForChangedFrom } : {}),
                ...(result.waitForUrlBefore !== undefined ? { waitForUrlBefore: result.waitForUrlBefore } : {}),
                ...(result.fastPathSettled !== undefined ? { fastPathSettled: result.fastPathSettled } : {}),
                // V23: Full decision trace — paths/identity/evidence/llm/chosen
                // /recorded/overlay/timing. Lets you `diff` two runs of the
                // same step to see WHY identical inputs produced different
                // outcomes (compiled stale, LLM cache hit, overlay block, ...).
                //
                // Dev-only by default. Trace is always BUILT (so apply contract
                // is the same in all envs), but only written to JSONL when
                // NODE_ENV !== 'production' OR PREVIEW_TRACE_DECISIONS=true.
                // Prod doesn't pay the JSONL size cost; local debugging keeps
                // full visibility.
                ...(result.decisionTrace !== undefined && shouldEmitDecisionTrace()
                  ? { decisionTrace: result.decisionTrace } : {}),
                retried,
              },
            });

            // Emit pass (include appliedStep so frontend can enrich the UI step).
            // `url` is included so the editor's preview URL bar tracks the live
            // page during a run — the regular `preview:page` snapshot pipeline
            // is gated off while a run is in flight (see preview.handler.ts —
            // skipped to avoid page.evaluate() contention with readiness/apply),
            // so without this field the URL bar stays frozen on the pre-run URL.
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              status: 'pass',
              action: step.type,
              description: step.description,
              timestamp: new Date().toISOString(),
              ...(result.url ? { url: result.url } : {}),
              ...(result.appliedStep ? { appliedStep: result.appliedStep } : {}),
              ...(retried ? { retried: true } : {}),
            });
            passedSteps++;

            // V14: Record step telemetry (pass)
            telemetryCollector?.markStepEnd('pass', session.page.url(), {
              retried,
              attempts: result.attempts,
            });

            // Update tracked URL after successful step execution
            trackedUrl = session.page.url();
            trackedUrls.set(session.activeTabIndex, trackedUrl);

            // V15.4: Hover cleanup — move cursor away after hover when next step
            // doesn't need the hover-triggered UI (tooltip/popover/menu). Without
            // this, the cursor stays on the hovered element, causing:
            //   • Visible flicker as snapshot polling re-renders popovers
            //   • Last-hover-step leaves UI dirty for the user post-run
            //   • Subsequent type/scroll/navigate fights the popover overlay
            //
            // We KEEP the cursor on the element when next step is click/hover/
            // dblclick — that preserves the "hover menu → click item" pattern
            // where the item only exists while the menu is held open by hover.
            if (step.type === 'hover') {
              const nextStepForHover = stepsToExecute[i + 1];
              const HOVER_DEPENDENT_NEXT: ReadonlySet<IntentActionType> = new Set([
                'click', 'dblclick', 'contextmenu', 'hover',
              ]);
              const shouldResetMouse = !nextStepForHover
                || !HOVER_DEPENDENT_NEXT.has(nextStepForHover.type);
              if (shouldResetMouse) {
                try {
                  // Move to (0, 0) — top-left corner. This is OUTSIDE any interactive
                  // element on every normal layout, so no spurious :hover state is
                  // triggered elsewhere.
                  await session.page.mouse.move(0, 0);
                  logger.debug('[PreviewRun] Hover cursor reset', {
                    previewSessionId,
                    stepId: step.id,
                    nextStepType: nextStepForHover?.type ?? 'none',
                  });
                } catch (err) {
                  // Non-fatal — worst case the cursor stays put and the user
                  // sees a lingering tooltip. No step failure from this.
                  logger.debug('[PreviewRun] Hover cursor reset failed (non-fatal)', {
                    previewSessionId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }

            // Collect page summary after navigation for better error context on subsequent failures
            if (step.type === 'navigate' || result.urlChanged) {
              try {
                lastNavigationSummary = await collectLightPageSummary(session.page);
                logger.debug('[PreviewRun] Post-navigation page summary collected', {
                  previewSessionId,
                  url: lastNavigationSummary.url,
                  title: lastNavigationSummary.title,
                  headingCount: lastNavigationSummary.headings.length,
                });
              } catch {
                // Non-fatal — continue without summary
              }
            }

            // ─────────────────────────────────────────────────────────────────
            // Lookahead wait: check next step readiness before executing it
            // Uses fast Playwright checks only (no AI/LLM)
            // V15: Don't skip lookahead after wait_for that resolved via fast-path
            // (URL already changed before wait_for ran). The fast-path does its own
            // DOM settle, but lookahead provides extra safety for SPA hydration.
            // ─────────────────────────────────────────────────────────────────
            const skipLookahead = shouldSkipLookaheadAfter(step.type) && !result.fastPathSettled;
            if (i < stepsToExecute.length - 1 && !skipLookahead && !runState.cancelled) {
              const nextStep = stepsToExecute[i + 1];
              try {
                const adaptiveSettle = getAdaptiveSettleMs(step.type);
                // V15: Route lookahead phase events into the editor trace so the
                // inter-step gap is observable in the JSONL trace file instead of stdout only.
                // V15: Get editor trace safely — a failed import must not kill the lookahead.
                // The tracer is advisory observability; if unavailable, we just skip trace emission.
                let lookaheadTracer: any = undefined;
                let editorTraceForGap: any = null;
                try {
                  editorTraceForGap = (await import('./editor-trace.service')).EditorTraceService.get(previewSessionId);
                  if (editorTraceForGap) {
                    lookaheadTracer = {
                      start: editorTraceForGap.writeLookaheadStart.bind(editorTraceForGap),
                      phase: editorTraceForGap.writeLookaheadPhase.bind(editorTraceForGap),
                      end: editorTraceForGap.writeLookaheadEnd.bind(editorTraceForGap),
                      // V15.1: extra methods surface what happens inside retry_loop
                      retryAttempt: editorTraceForGap.writeRetryAttempt.bind(editorTraceForGap),
                      pageSettle: editorTraceForGap.writePageSettle.bind(editorTraceForGap),
                    };
                  }
                } catch { /* non-fatal */ }

                // V15.1: Emit an inter-step-gap event BEFORE starting lookahead.
                // `stepStartMs` is when step N began; `Date.now()` is right before
                // lookahead for N+1. Subtracting gives us (step exec ms + housekeeping
                // between steps). We don't have a separate post-action timestamp yet,
                // so we use stepDurationMs which preview-run already tracks.
                try {
                  if (editorTraceForGap) {
                    editorTraceForGap.writeInterStepGap({
                      prevStepId: step.id,
                      nextStepId: nextStep.id,
                      // Rough: time from step_start to now minus the actual step duration.
                      // A positive gap = post-step housekeeping (settle, collect, trace upload).
                      gapMs: Math.max(0, (Date.now() - stepStartMs) - stepDurationMs),
                      accountedFor: [
                        result.urlChanged ? 'page_summary_collect' : undefined,
                      ].filter(Boolean) as string[],
                    });
                  }
                } catch { /* non-fatal */ }
                const lookahead = await raceAbort(waitForStepReadiness(session.page, nextStep, {
                  maxWaitMs: STEP_READINESS_CONFIG.defaults.maxWaitMs,
                  settleMs: adaptiveSettle,
                  autoWaitThresholdMs: STEP_READINESS_CONFIG.defaults.autoWaitThresholdMs,
                  prevActionType: step.type,
                  prevUrl: trackedUrl,
                  recordedDelayMs: nextStep.evidence?.interStepDelayMs,
                  tracer: lookaheadTracer,
                }), signal);

                // Track actual settle time per action category for adaptive threshold
                if (lookahead.waited > 0) {
                  recordSettleTime(step.type, lookahead.waited);
                }

                if (lookahead.autoWaitApplied) {
                  logger.info('[PreviewRun] Lookahead auto-wait applied before next step', {
                    previewSessionId,
                    currentStepIndex: i,
                    nextStepIndex: i + 1,
                    nextStepId: nextStep.id,
                    waitedMs: lookahead.waited,
                    ready: lookahead.ready,
                    navigationDetected: lookahead.navigationDetected,
                  });
                } else if (lookahead.skipReason) {
                  logger.debug('[PreviewRun] Lookahead skipped', {
                    previewSessionId,
                    nextStepIndex: i + 1,
                    reason: lookahead.skipReason,
                  });
                }
              } catch (lookaheadError) {
                // AbortError from raceAbort — propagate to trigger cancellation handling
                if (lookaheadError instanceof DOMException && lookaheadError.name === 'AbortError') throw lookaheadError;
                // Lookahead failure is non-fatal — apply condition-based DOM stability fallback
                logger.warn('[PreviewRun] Lookahead wait failed, applying fallback DOM settle', {
                  previewSessionId,
                  nextStepIndex: i + 1,
                  error: lookaheadError instanceof Error ? lookaheadError.message : String(lookaheadError),
                });
                // MutationObserver-based: resolves when DOM stops mutating for 500ms, caps at 3s
                await waitForDOMStability(session.page, STEP_READINESS_CONFIG.defaults.maxWaitMs, STEP_READINESS_CONFIG.domStableThresholdMs.default).catch(() => {});
              }
            }

            // Accumulate enriched step for batch persist at end of run
            if (result.appliedStep) {
              enrichedSteps.set(result.appliedStep.id, result.appliedStep);
            }

            // If cancellation was requested during/after this step, stop before next step.
            const cancelledAfterStep =
              runState.cancelled || activeRuns.get(previewSessionId)?.cancelled === true;
            if (cancelledAfterStep) {
              logger.info('[PreviewRun] Cancellation detected after step completion, skipping remaining steps', {
                previewSessionId,
                completedStep: i,
                remainingSteps: stepsToExecute.length - i - 1,
              });

              for (let j = i + 1; j < stepsToExecute.length; j++) {
                const remainingStep = stepsToExecute[j];
                webSocketService.emitToUser(userId, 'preview:run:step', {
                  previewSessionId,
                  stepIndex: startFromIndex + j,
                  stepId: remainingStep.id,
                  status: 'skipped',
                  action: remainingStep.type,
                  description: remainingStep.description,
                  timestamp: new Date().toISOString(),
                });
                skippedSteps++;
              }
              break;
            }
          } else {
            // Collect FRESH page context at the moment of failure — the page may
            // have changed since the last navigation (e.g. JS-rendered error page,
            // maintenance overlay, SPA route change without a full navigation).
            let failPageSummary = lastNavigationSummary;
            try {
              failPageSummary = await collectLightPageSummary(session.page);
            } catch {
              // Non-fatal — fall back to lastNavigationSummary
            }

            // Capture a screenshot at the moment of failure so the user can see
            // what the page actually looks like (e.g. maintenance page, error modal).
            let failScreenshotBase64: string | null = null;
            try {
              const buf = await session.page.screenshot({
                type: 'jpeg',
                quality: 50,
                fullPage: false,
                timeout: 3000,
              });
              if (buf.length <= 500_000) { // 500KB cap to avoid bloating WS payload
                failScreenshotBase64 = buf.toString('base64');
              }
            } catch {
              // Non-fatal — screenshot may fail if page crashed
            }

            // Augment error with page context if we navigated earlier.
            // Also include the URL-mismatch hint, but ONLY for the first few
            // steps — login flows are typically 2-4 steps, and showing the
            // "you may already be logged in" hint on step 17 would be both
            // misleading and confusing.
            const errorWithContext = augmentErrorWithPageContext(
              result.error || 'Step failed',
              failPageSummary,
              i < URL_MISMATCH_HINT_MAX_STEPS ? urlMismatchInfo : null,
            );

            logger.warn('[PreviewRun] Step failed', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              error: result.error,
              retried,
              hasPageContext: !!failPageSummary,
              hasFailScreenshot: !!failScreenshotBase64,
              hasUrlMismatchHint: i < URL_MISMATCH_HINT_MAX_STEPS && !!urlMismatchInfo,
            });

            // Trace step_result (fail)
            traceWriter.write({
              iteration: i,
              stage: 'step_execution',
              eventType: 'step_result',
              spanId: traceWriter.generateSpanId(),
              parentSpanId: stepSpanId,
              payload: {
                stepIndex: originalStepIndex,
                stepId: step.id,
                status: 'fail',
                error: result.error,
                attempts: result.attempts,
                retried,
                pageContext: failPageSummary || undefined,
                ...(result.clickEffectSignal !== undefined ? { clickEffectSignal: result.clickEffectSignal } : {}),
                ...(result.chosenRef !== undefined ? { chosenRef: result.chosenRef } : {}),
                ...(result.chosenLabel !== undefined ? { chosenLabel: result.chosenLabel.slice(0, 80) } : {}),
                ...(result.chosenBoundingBox !== undefined ? { chosenBbox: result.chosenBoundingBox } : {}),
                ...(result.fingerprintMatch !== undefined ? { fingerprintMatch: result.fingerprintMatch } : {}),
                ...(result.resolverPath !== undefined ? { resolverPath: result.resolverPath } : {}),
                ...(result.decisionTrace !== undefined && shouldEmitDecisionTrace()
                  ? { decisionTrace: result.decisionTrace } : {}),
              },
            });

            // Emit fail (with augmented error + screenshot for better UX)
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              status: 'fail',
              action: step.type,
              description: step.description,
              error: errorWithContext,
              timestamp: new Date().toISOString(),
              ...(retried ? { retried: true } : {}),
              ...(failScreenshotBase64 ? { failScreenshot: failScreenshotBase64 } : {}),
            });
            failedSteps++;
            // Capture for summary (truncate to first 5 to bound payload size)
            if (failedStepDetails.length < 5) {
              failedStepDetails.push({
                stepIndex: originalStepIndex,
                description: step.description || '',
                action: step.type,
                error: errorWithContext,
              });
            }

            // V14: Record step telemetry (fail)
            telemetryCollector?.markStepEnd('fail', session.page.url(), {
              error: result.error,
              retried,
              attempts: result.attempts,
            });

            // Stop on first failure - emit remaining steps as skipped
            logger.info('[PreviewRun] Stopping due to failure, skipping remaining steps', {
              previewSessionId,
              failedStep: i,
              remainingSteps: stepsToExecute.length - i - 1,
            });

            for (let j = i + 1; j < stepsToExecute.length; j++) {
              const remainingStep = stepsToExecute[j];
              webSocketService.emitToUser(userId, 'preview:run:step', {
                previewSessionId,
                stepIndex: startFromIndex + j,
                stepId: remainingStep.id,
                status: 'skipped',
                action: remainingStep.type,
                description: remainingStep.description,
                timestamp: new Date().toISOString(),
              });
              skippedSteps++;
            }
            break; // Stop execution
          }
        } catch (stepError) {
          // AbortError from raceAbort — run was cancelled, skip remaining steps
          if (stepError instanceof DOMException && stepError.name === 'AbortError') {
            logger.info('[PreviewRun] Step aborted by cancel signal', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
            });
            // Current step already emitted 'running' — mark as skipped
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              status: 'skipped',
              action: step.type,
              description: step.description,
              timestamp: new Date().toISOString(),
            });
            skippedSteps++;
            for (let j = i + 1; j < stepsToExecute.length; j++) {
              const remaining = stepsToExecute[j];
              webSocketService.emitToUser(userId, 'preview:run:step', {
                previewSessionId,
                stepIndex: startFromIndex + j,
                stepId: remaining.id,
                status: 'skipped',
                action: remaining.type,
                description: remaining.description,
                timestamp: new Date().toISOString(),
              });
              skippedSteps++;
            }
            break;
          }

          const originalError = stepError instanceof Error ? stepError.message : String(stepError);
          let exceptionRetried = false;

          // ── Retry on exception (same logic as result.success === false) ──
          const isExceptionNonRetryable = NO_RETRY_STEP_TYPES.has(step.type)
            || (step.type === 'navigate' && !originalError.toLowerCase().includes('timeout'));
          if (
            !isExceptionNonRetryable &&
            !runState.cancelled &&
            !originalError.includes('session') &&
            !originalError.includes('expired')
          ) {
            logger.info('[PreviewRun] Exception during step, attempting retry', {
              previewSessionId,
              stepIndex: originalStepIndex,
              stepId: step.id,
              error: originalError,
            });

            try {
              await raceAbort(waitForDOMStability(session.page, RETRY_SETTLE_MS, 500), signal);
              const retryResult = await raceAbort(PreviewStepApplyService.applyStep({
                previewSessionId,
                stepDraft: {
                  ...stepWithCachePolicy,
                  options: {
                    ...stepWithCachePolicy.options,
                    disableCaching: true,
                    timeout: Math.max(stepWithCachePolicy.options?.timeout || 10000, 15000),
                  },
                },
                userId,
                skipPostActionWait: true,
              }), signal);
              exceptionRetried = true;

              if (retryResult.success) {
                logger.info('[PreviewRun] Exception retry succeeded', {
                  previewSessionId,
                  stepIndex: originalStepIndex,
                  stepId: step.id,
                });

                // Trace step_result (pass after exception retry)
                traceWriter.write({
                  iteration: i,
                  stage: 'step_execution',
                  eventType: 'step_result',
                  spanId: traceWriter.generateSpanId(),
                  parentSpanId: stepSpanId,
                  payload: {
                    stepIndex: originalStepIndex,
                    stepId: step.id,
                    status: 'pass',
                    urlChanged: retryResult.urlChanged,
                    url: retryResult.url,
                    retried: true,
                    ...(retryResult.decisionTrace !== undefined && shouldEmitDecisionTrace()
                      ? { decisionTrace: retryResult.decisionTrace } : {}),
                  },
                });

                webSocketService.emitToUser(userId, 'preview:run:step', {
                  previewSessionId,
                  stepIndex: originalStepIndex,
                  stepId: step.id,
                  status: 'pass',
                  action: step.type,
                  description: step.description,
                  timestamp: new Date().toISOString(),
                  ...(retryResult.appliedStep ? { appliedStep: retryResult.appliedStep } : {}),
                  retried: true,
                });
                passedSteps++;

                trackedUrl = session.page.url();
                if (step.type === 'navigate' || retryResult.urlChanged) {
                  try { lastNavigationSummary = await collectLightPageSummary(session.page); } catch { /* non-fatal */ }
                }
                if (retryResult.appliedStep) {
                  enrichedSteps.set(retryResult.appliedStep.id, retryResult.appliedStep);
                }

                // Lookahead before next step (same as main success path)
                // V15: Don't skip lookahead after fast-path wait_for
                const skipLookaheadRetry = shouldSkipLookaheadAfter(step.type) && !retryResult.fastPathSettled;
                if (i < stepsToExecute.length - 1 && !skipLookaheadRetry && !runState.cancelled) {
                  const nextStep = stepsToExecute[i + 1];
                  try {
                    await raceAbort(waitForStepReadiness(session.page, nextStep, {
                      maxWaitMs: STEP_READINESS_CONFIG.defaults.maxWaitMs,
                      settleMs: STEP_READINESS_CONFIG.defaults.settleMs,
                      autoWaitThresholdMs: STEP_READINESS_CONFIG.defaults.autoWaitThresholdMs,
                      prevActionType: step.type,
                      prevUrl: trackedUrl,
                      recordedDelayMs: nextStep.evidence?.interStepDelayMs,
                    }), signal);
                  } catch (laError) {
                    if (laError instanceof DOMException && laError.name === 'AbortError') throw laError;
                    // Lookahead failure is non-fatal — apply DOM stability fallback
                    await waitForDOMStability(session.page, STEP_READINESS_CONFIG.defaults.maxWaitMs, STEP_READINESS_CONFIG.domStableThresholdMs.default).catch(() => {});
                  }
                }

                continue; // Skip to next step — recovered!
              } else if (runState.cancelled) {
                // Cancel arrived during exception retry — skip LLM diagnosis
              } else {
                // ── LLM Diagnosis on exception retry failure ──
                const diagResult = await raceAbort(attemptLLMDiagnosisAndRetry({
                  page: session.page,
                  step,
                  error: retryResult.error || originalError,
                  previewSessionId,
                  userId,
                  stepWithCachePolicy,
                  runStartTime: runState.startTime,
                  signal,
                }), signal);

                if (diagResult.result?.success) {
                  const finalResult = diagResult.result;

                  traceWriter.write({
                    iteration: i, stage: 'step_execution', eventType: 'step_result',
                    spanId: traceWriter.generateSpanId(), parentSpanId: stepSpanId,
                    payload: { stepIndex: originalStepIndex, stepId: step.id, status: 'pass',
                      urlChanged: finalResult.urlChanged, url: finalResult.url, retried: true },
                  });

                  webSocketService.emitToUser(userId, 'preview:run:step', {
                    previewSessionId, stepIndex: originalStepIndex, stepId: step.id, status: 'pass',
                    action: step.type, description: step.description,
                    timestamp: new Date().toISOString(),
                    ...(finalResult.appliedStep ? { appliedStep: finalResult.appliedStep } : {}),
                    retried: true,
                  });
                  passedSteps++;
                  trackedUrl = session.page.url();
                  if (step.type === 'navigate' || finalResult.urlChanged) {
                    try { lastNavigationSummary = await collectLightPageSummary(session.page); } catch { /* non-fatal */ }
                  }
                  if (finalResult.appliedStep) enrichedSteps.set(finalResult.appliedStep.id, finalResult.appliedStep);

                  // Lookahead before next step (same as deterministic retry success path)
                  // V15: Don't skip lookahead after fast-path wait_for
                  const skipLookaheadFinal = shouldSkipLookaheadAfter(step.type) && !finalResult.fastPathSettled;
                  if (i < stepsToExecute.length - 1 && !skipLookaheadFinal && !runState.cancelled) {
                    const nextStep = stepsToExecute[i + 1];
                    try {
                      await raceAbort(waitForStepReadiness(session.page, nextStep, {
                        maxWaitMs: STEP_READINESS_CONFIG.defaults.maxWaitMs,
                        settleMs: STEP_READINESS_CONFIG.defaults.settleMs,
                        autoWaitThresholdMs: STEP_READINESS_CONFIG.defaults.autoWaitThresholdMs,
                        prevActionType: step.type,
                        prevUrl: trackedUrl,
                        recordedDelayMs: nextStep.evidence?.interStepDelayMs,
                      }), signal);
                    } catch (laError) {
                      if (laError instanceof DOMException && laError.name === 'AbortError') throw laError;
                      await waitForDOMStability(session.page, STEP_READINESS_CONFIG.defaults.maxWaitMs, STEP_READINESS_CONFIG.domStableThresholdMs.default).catch(() => {});
                    }
                  }

                  continue; // Recovered via LLM diagnosis!
                }
              }
            } catch (exRetryError) {
              // AbortError from raceAbort — propagate to trigger cancellation handling
              if (exRetryError instanceof DOMException && exRetryError.name === 'AbortError') throw exRetryError;
              // Retry also threw — fall through to original error handling
              exceptionRetried = true;
            }
          }

          // Collect fresh page context + screenshot at moment of exception
          let exFailPageSummary = lastNavigationSummary;
          try { exFailPageSummary = await collectLightPageSummary(session.page); } catch { /* non-fatal */ }

          let exFailScreenshot: string | null = null;
          try {
            const buf = await session.page.screenshot({ type: 'jpeg', quality: 50, fullPage: false, timeout: 3000 });
            if (buf.length <= 500_000) exFailScreenshot = buf.toString('base64');
          } catch { /* non-fatal */ }

          // Same URL-mismatch hint policy as the failed-result branch above:
          // only attach the hint to the first few step failures.
          const errorWithContext = augmentErrorWithPageContext(
            originalError,
            exFailPageSummary,
            i < URL_MISMATCH_HINT_MAX_STEPS ? urlMismatchInfo : null,
          );

          logger.error('[PreviewRun] Step exception', {
            previewSessionId,
            stepIndex: originalStepIndex,
            stepId: step.id,
            error: originalError,
            retried: exceptionRetried,
            hasPageContext: !!exFailPageSummary,
            hasFailScreenshot: !!exFailScreenshot,
            hasUrlMismatchHint: i < URL_MISMATCH_HINT_MAX_STEPS && !!urlMismatchInfo,
          });

          // Trace step_result (exception)
          traceWriter.write({
            iteration: i,
            stage: 'step_execution',
            eventType: 'step_result',
            spanId: traceWriter.generateSpanId(),
            parentSpanId: stepSpanId,
            payload: {
              stepIndex: originalStepIndex,
              stepId: step.id,
              status: 'exception',
              error: originalError,
              retried: exceptionRetried,
              pageContext: exFailPageSummary || undefined,
            },
          });

          // Emit fail (with screenshot for visual debugging)
          webSocketService.emitToUser(userId, 'preview:run:step', {
            previewSessionId,
            stepIndex: originalStepIndex,
            stepId: step.id,
            status: 'fail',
            action: step.type,
            description: step.description,
            error: errorWithContext,
            timestamp: new Date().toISOString(),
            ...(exceptionRetried ? { retried: true } : {}),
            ...(exFailScreenshot ? { failScreenshot: exFailScreenshot } : {}),
          });
          failedSteps++;
          // Capture for summary (truncate to first 5)
          if (failedStepDetails.length < 5) {
            failedStepDetails.push({
              stepIndex: originalStepIndex,
              description: step.description || '',
              action: step.type,
              error: errorWithContext,
            });
          }

          // V14: Record step telemetry (exception)
          try {
            telemetryCollector?.markStepEnd('fail', session.page.url(), {
              error: originalError,
              retried: exceptionRetried,
            });
          } catch { /* page may be closed */ }

          // Stop and skip remaining
          for (let j = i + 1; j < stepsToExecute.length; j++) {
            const remainingStep = stepsToExecute[j];
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: startFromIndex + j,
              stepId: remainingStep.id,
              status: 'skipped',
              action: remainingStep.type,
              description: remainingStep.description,
              timestamp: new Date().toISOString(),
            });
            skippedSteps++;
          }
          break;
        }
      }

      // Post-final-step settle: ensure last step's API calls complete before marking run as done.
      // Lookahead only runs between steps — the last step gets skipPostActionWait=true with no next
      // step to trigger lookahead, so its network effects would otherwise be lost.
      if (passedSteps > 0 && !runState.cancelled) {
        try {
          await raceAbort(
            Promise.all([
              waitForApiIdle(session.page, 2000),
              waitForDOMStability(session.page, 2000, STEP_READINESS_CONFIG.domStableThresholdMs.default),
            ]),
            signal,
          );
        } catch {
          // Non-fatal — AbortError or timeout, proceed to completion
        }
      }
    } catch (runError) {
      // Capture so the finally block can flag the summary as failed and AI/chat
      // tools see a meaningful firstError. We do NOT re-throw — callers always
      // get a PreviewRunSummary now (success: false on error).
      caughtRunError = runError;
      logger.error('[PreviewRun] Run loop threw — recording in summary', {
        previewSessionId,
        intentTestCaseId: intentTestCaseId ?? '(ephemeral)',
        error: runError instanceof Error ? runError.message : String(runError),
      });
    } finally {
      // Clear global timeout
      clearTimeout(globalTimeout);

      // V14: Clean up telemetry collector listeners
      try { telemetryCollector?.destroy(); } catch { /* non-fatal */ }

      // V13: Reset dialog mode back to passive
      try { sessionService.setDialogMode(previewSessionId, userId, 'passive'); } catch { /* session may be gone */ }

      // 7. ALWAYS emit completed event — even if run failed before 'started' was emitted.
      //    This guarantees the frontend never stays stuck in 'running' state.
      const duration = Date.now() - runState.startTime;
      const cancelled = activeRuns.get(previewSessionId)?.cancelled || false;

      logger.info('[PreviewRun] Run completed', {
        previewSessionId,
        intentTestCaseId: intentTestCaseId ?? '(ephemeral)',
        success: failedSteps === 0 && !cancelled && !timedOut,
        passedSteps,
        failedSteps,
        skippedSteps,
        cancelled,
        timedOut,
        startedEmitted,
        duration,
      });

      // Trace error summary (for admin panel quick view)
      if (failedSteps > 0 || timedOut || cancelled) {
        traceWriter.write({
          stage: 'completion',
          eventType: 'run_error_summary',
          spanId: traceWriter.generateSpanId(),
          parentSpanId: rootSpanId,
          payload: {
            totalErrors: failedSteps,
            failedStepDetails: failedStepDetails.slice(0, 10),
            cancelled,
            timedOut,
            duration,
          },
        });
      }

      // Trace run_end
      traceWriter.write({
        stage: 'completion',
        eventType: 'run_end',
        spanId: traceWriter.generateSpanId(),
        parentSpanId: rootSpanId,
        payload: {
          success: failedSteps === 0 && !cancelled && !timedOut,
          totalSteps: steps.length,
          passedSteps,
          failedSteps,
          skippedSteps,
          cancelled,
          timedOut,
          duration,
          durationSeconds: Math.round(duration / 1000),
          endTime: new Date().toISOString(),
        },
      });

      // Emit started if we never did (so frontend can transition properly)
      if (!startedEmitted) {
        webSocketService.emitToUser(userId, 'preview:run:started', {
          previewSessionId,
          totalSteps: steps.length,
          startUrl,
          timestamp: new Date().toISOString(),
        });
      }

      const runSuccess = failedSteps === 0 && !cancelled && !timedOut;

      // 8b. Batch-persist all enriched steps BEFORE emitting completed event.
      // Frontend may fetch the test case immediately after completed — steps must be in DB by then.
      if (enrichedSteps.size > 0 && intentTestCaseId) {
        try {
          await withTimeout(
            IntentTestCaseService.batchUpdateStepsFromRun({
              intentTestCaseId,
              enrichedSteps,
            }),
            CLEANUP_TIMEOUT_MS,
            'batchUpdateStepsFromRun',
          );
          logger.info('[PreviewRun] Batch-persisted enriched steps', {
            previewSessionId,
            intentTestCaseId,
            count: enrichedSteps.size,
          });
        } catch (batchError) {
          logger.warn('[PreviewRun] Failed to batch-persist enriched steps (best-effort)', {
            previewSessionId,
            intentTestCaseId,
            error: batchError instanceof Error ? batchError.message : String(batchError),
          });
        }
      }

      // V14: Get step telemetry timeline for the completed event
      const stepTelemetry = telemetryCollector?.getTimeline() || null;

      // Release activeRuns BEFORE emitting completed — so user can immediately start a new run.
      // Trace write and email cleanup happen after, but they don't need the run lock.
      if (activeRuns.get(previewSessionId) === runState) {
        activeRuns.delete(previewSessionId);
      }

      // Re-enable the external-nav trap now that the run is done. If the
      // final step left us on a post-run URL that happens to be cross-
      // origin (e.g. OAuth callback completed on an auth provider) the
      // trap's baseline was kept fresh during suspension, so subsequent
      // USER clicks still get protected correctly.
      try {
        const { resumeTrap } = await import('./external-nav-trap');
        resumeTrap(previewSessionId);
      } catch { /* non-fatal */ }

      // Editor trace: run_summary — single event with all the counters, so a
      // reader doesn't have to grep for passes/fails. failedStepDetails carries
      // the first 5 errors (truncated at upstream) for quick triage.
      try {
        const summaryTrace = (await import('./editor-trace.service')).EditorTraceService.get(previewSessionId);
        if (summaryTrace) {
          // compiledHits / llmCalls counters are NOT emitted — they're aggregated
          // from individual `compiled_postcondition` and `llm_request_end` events
          // by the reader. Putting placeholder zeros here would mislead anyone
          // glancing at the summary.
          summaryTrace.writeRunSummary({
            previewSessionId,
            intentTestCaseId,
            totalSteps: steps.length,
            passed: passedSteps,
            failed: failedSteps,
            skipped: skippedSteps,
            cancelled,
            timedOut,
            totalDurationMs: duration,
            failedStepIds: failedStepDetails.map((d) => String(d.stepIndex)),
            failedStepReasons: failedStepDetails.map((d) => (d.error || '').slice(0, 200)),
          });
        }
      } catch { /* non-fatal */ }

      webSocketService.emitToUser(userId, 'preview:run:completed', {
        previewSessionId,
        success: runSuccess,
        totalSteps: steps.length,
        passedSteps,
        failedSteps,
        skippedSteps,
        cancelled,
        timedOut,
        duration,
        timestamp: new Date().toISOString(),
        stepTelemetry,
      });

      // Build the summary object returned to the caller (chat tools, AI agents).
      // Mirrors the WebSocket payload but adds failedStepDetails for human-readable
      // error messages without subscribing to step events.
      const runErrorMessage = caughtRunError
        ? (caughtRunError instanceof Error ? caughtRunError.message : String(caughtRunError))
        : undefined;
      const summarySuccess = runSuccess && !caughtRunError;
      runSummary = {
        success: summarySuccess,
        totalSteps: steps.length,
        passedSteps,
        failedSteps,
        skippedSteps,
        cancelled,
        timedOut,
        duration,
        ...(failedStepDetails.length > 0 ? { failedStepDetails } : {}),
        ...(runErrorMessage
          ? { firstError: runErrorMessage }
          : failedStepDetails[0]?.error ? { firstError: failedStepDetails[0].error } : {}),
      };

      // NOTE: We do NOT emit chat:processing:step on completion.
      // The progress:100 signal would trigger the frontend's "API agent finished" handler
      // (which clears processingSteps, resets isTyping, etc.) — destructive side-effect.
      // Frontend uses preview:run:completed directly via WebSocket subscription in Chat.jsx.

      // 8c. V12: Cleanup email inbox (non-blocking, best-effort)
      try {
        const sessionService = getPreviewSessionService();
        const session = sessionService.getSession(previewSessionId);
        const inboxAddress = session?.contextData?.['email._inboxAddress'] as string | undefined;
        if (inboxAddress) {
          import('@/services/testing/email-inbox/email-inbox.service').then(({ EmailInboxService }) => {
            EmailInboxService.cleanupEmails(inboxAddress).catch(err => {
              logger.warn('[PreviewRun] Email inbox cleanup failed (non-fatal)', {
                previewSessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }).catch(() => {});
        }
      } catch {
        // Silently ignore — email cleanup is best-effort
      }

      // 9. Close trace writer (flushes pending writes) — with timeout guard
      const traceFilePath = traceWriter.getFilePath();
      try {
        await withTimeout(traceWriter.close(), CLEANUP_TIMEOUT_MS, 'traceWriter.close');
      } catch (closeError) {
        logger.warn('[PreviewRun] Failed to close trace writer', {
          previewSessionId,
          error: closeError instanceof Error ? closeError.message : String(closeError),
        });
      }

      // Fire-and-forget upload to Supabase Storage (runs regardless of close() success)
      import('./editor-trace-upload').then(({ uploadEditorTrace }) => {
        uploadEditorTrace({
          filePath: traceFilePath,
          userId,
          previewSessionId,
          traceType: intentTestCaseId ? 'preview_run' : 'draft_run',
          intentTestCaseId,
        }).catch((err) => logger.error('[EDITOR_TRACE] Upload failed on preview run cleanup', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));
      }).catch((err) => logger.error('[EDITOR_TRACE] Import failed on preview run cleanup', { previewSessionId, error: err instanceof Error ? err.message : String(err) }));

      // activeRuns already released above (before completed event).
    }

    // Defensive: if we somehow exited finally without building summary
    // (e.g., very early throw before emit completed), synthesize a minimal one
    // so callers always get a non-null value.
    if (!runSummary) {
      runSummary = {
        success: false,
        totalSteps: steps.length,
        passedSteps,
        failedSteps,
        skippedSteps,
        cancelled: true,
        timedOut,
        duration: Date.now() - runState.startTime,
        ...(failedStepDetails.length > 0 ? { failedStepDetails } : {}),
        ...(failedStepDetails[0]?.error ? { firstError: failedStepDetails[0].error } : {}),
      };
    }
    return runSummary;
  }

  /**
   * Cancel active run for session
   * Sets cancellation flag, main loop will handle skipping remaining steps
   * @param previewSessionId - Preview session ID
   * @param userId - User ID for ownership verification
   */
  static cancelRun(previewSessionId: string, userId: string): void {
    const runState = activeRuns.get(previewSessionId);
    if (!runState) {
      throw new Error('No active run for this session');
    }

    const sessionService = getPreviewSessionService();
    if (!sessionService.isSessionOwned(previewSessionId, userId)) {
      throw new Error('Session not owned by user');
    }

    runState.cancelled = true;
    runState.abortController.abort();
    logger.info('[PreviewRun] Run cancelled by user', {
      previewSessionId,
      userId,
      currentStepIndex: runState.currentStepIndex,
    });
  }

  /**
   * Force-cancel any active run for this session WITHOUT owner check.
   * Called by `PreviewSessionService.stopSession` when the underlying
   * preview is being torn down (browser close, idle timeout, user clicked
   * "End preview"). Without this, an in-flight run kept executing against
   * a stale Playwright context — the loop's next `page.evaluate` would
   * throw "Target page closed" but the surrounding promise might never
   * settle, leaving `activeRuns` permanently locked and rejecting all
   * subsequent runs with "Run already in progress" until server restart.
   *
   * Safe to call when no run is active — silent no-op. Does NOT remove
   * the activeRuns entry itself (the loop's finally block does that
   * after emitting `preview:run:completed`); we only signal cancellation
   * so the loop can unwind cleanly.
   */
  static forceCancelOnSessionStop(previewSessionId: string): void {
    const runState = activeRuns.get(previewSessionId);
    if (!runState) return;
    runState.cancelled = true;
    try { runState.abortController.abort(); } catch { /* aborted twice = noop */ }
    logger.info('[PreviewRun] Run force-cancelled (session stopping)', {
      previewSessionId,
      currentStepIndex: runState.currentStepIndex,
    });

    // Safety net: if the loop's finally block fails to fire (e.g. page
    // was already closed and a sync throw bubbled past every catch), the
    // entry would stay in activeRuns forever. After a generous timeout
    // we hard-purge so the next run isn't blocked. The 30s window is
    // long enough that any healthy unwind has finished by then.
    setTimeout(() => {
      const stillThere = activeRuns.get(previewSessionId);
      if (stillThere === runState) {
        activeRuns.delete(previewSessionId);
        logger.warn('[PreviewRun] Force-purged activeRuns entry that did not unwind in time', {
          previewSessionId,
        });
      }
    }, 30000).unref();
  }

  /**
   * Check if run is active for session
   * @param previewSessionId - Preview session ID
   * @returns true if run is active and not cancelled
   */
  static isRunning(previewSessionId: string): boolean {
    const runState = activeRuns.get(previewSessionId);
    return !!(runState?.running && !runState.cancelled);
  }

  /**
   * TEST-ONLY: Clear all active run states.
   * This prevents cross-test leakage since activeRuns is module-scoped state.
   * Do NOT call this in production code.
   */
  static __dangerousClearRunsForTests(): void {
    activeRuns.clear();
  }
}
