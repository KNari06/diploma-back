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
import type { IntentStep } from './preview.types';
import { shouldSkipLookaheadAfter, waitForStepReadiness } from './step-readiness.service';
import { STEP_READINESS_CONFIG } from '@/config/testing/playwright-tuning';
import { injectAutoWaitForSteps } from './auto-wait-for.utils';
import { diagnoseStepBlocker, actOnDiagnosis } from './step-blocker-diagnosis.service';

/** Maximum wall-clock time for an entire run (all steps). Prevents infinite hangs. */
const GLOBAL_RUN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
async function waitForDOMStability(page: import('playwright').Page, maxWaitMs = 3000, stabilityMs = 800): Promise<void> {
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
  if (signal.aborted || elapsedTotal >= GLOBAL_RUN_TIMEOUT_MS - 15000) {
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
 */
function augmentErrorWithPageContext(error: string, pageSummary: PageSummary | null): string {
  if (!pageSummary) return error;
  const parts = [`Page: ${pageSummary.url}`];
  if (pageSummary.title) parts.push(`Title: "${pageSummary.title}"`);
  if (pageSummary.headings.length > 0) parts.push(`Headings: ${pageSummary.headings.join(', ')}`);
  return `${error}\n\n[Page context after last navigation]\n${parts.join('\n')}`;
}

// ── Step-Level Retry ───────────────────────────────────────────────────────

/** Step types that should NOT be retried on failure — either non-recoverable or LLM-evaluated */
const NO_RETRY_STEP_TYPES = new Set(['ai_check', 'wait', 'wait_for_email', 'dialog', 'download']);

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
function interpolateEmailVariables(step: IntentStep, previewSessionId: string): IntentStep {
  if (!step.value || !step.value.includes('{{email.')) return step;

  const sessionService = getPreviewSessionService();
  const session = sessionService.getSession(previewSessionId);
  const contextData = session?.contextData;
  if (!contextData) return step;

  let value = step.value;
  value = value.replace(/\{\{email\.([\w-]+)\}\}/g, (match, key) => {
    const replacement = contextData[`email.${key}`];
    return typeof replacement === 'string' ? replacement : match;
  });

  if (value === step.value) return step; // No changes
  return { ...step, value };
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
    },
  ): Promise<void> {
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
      /** @internal Skip ownership check when caller (runSavedSteps) already verified */
      _skipOwnershipCheck?: boolean;
    },
  ): Promise<void> {
    const intentTestCaseId = options?.intentTestCaseId;
    const persistAppliedSteps = options?.persistAppliedSteps ?? false;

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
    activeRuns.set(previewSessionId, runState);

    let startedEmitted = false;
    let timedOut = false;

    let passedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;

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

    // Global run timeout — cancels run if total wall-clock exceeds limit
    const globalTimeout = setTimeout(() => {
      timedOut = true;
      runState.cancelled = true;
      runState.abortController.abort();
      logger.error('[PreviewRun] Global timeout exceeded, forcing cancellation', {
        previewSessionId,
        timeoutMs: GLOBAL_RUN_TIMEOUT_MS,
        currentStepIndex: runState.currentStepIndex,
      });
    }, GLOBAL_RUN_TIMEOUT_MS);

    try {
      // 4. Get session page
      const session = sessionService.getSession(previewSessionId);
      if (!session?.page) {
        throw new Error('Session has no active page');
      }

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
      webSocketService.emitToUser(userId, 'preview:run:started', {
        previewSessionId,
        totalSteps: steps.length,
        startUrl,
        ephemeral: !persistAppliedSteps, // true for draft runs (from chat), false for saved test runs
        timestamp: new Date().toISOString(),
      });
      startedEmitted = true;

      // 6. Navigate to startUrl before executing steps
      logger.info('[PreviewRun] Navigating to startUrl', {
        previewSessionId,
        startUrl,
      });

      try {
        await raceAbort(session.page.goto(startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        }), signal);

        // Wait for DOM to stabilize after initial navigation (SPA hydration).
        // networkidle waits for images/fonts/analytics — irrelevant for element resolution.
        // DOM stability (no mutations for 800ms) is what we actually need.
        await raceAbort(waitForDOMStability(session.page, 3000, 800), signal);

        logger.info('[PreviewRun] Navigation to startUrl complete', {
          previewSessionId,
          currentUrl: session.page.url(),
        });
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

      // Allow other events (cancel/isRunning) to observe activeRuns state.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Track URL for evidence shortcut policy (V7)
      let trackedUrl = session.page.url();
      // Track page summary after navigation for better error context
      let lastNavigationSummary: PageSummary | null = null;

      // V13: Pre-inject auto-wait steps for first-run stability.
      // On second+ runs these are already in the DB from batchUpdateStepsFromRun().
      // The injection is idempotent — it skips if the next step is already wait_for.
      // Uses evidence.pageUrl (captured during recording) as fallback when compiled plans are missing.
      const stepsToExecute = injectAutoWaitForSteps(steps);
      if (stepsToExecute.length !== steps.length) {
        logger.info('[PreviewRun] Pre-injected auto-wait steps for first-run stability', {
          previewSessionId,
          originalSteps: steps.length,
          withAutoWaits: stepsToExecute.length,
          injectedCount: stepsToExecute.length - steps.length,
        });
      }

      logger.debug('[PreviewRun] Starting run with URL tracking', {
        previewSessionId,
        initialUrl: trackedUrl,
        totalSteps: stepsToExecute.length,
      });

      // V13: Switch dialog handler to replay mode — use pre-installed actions from recorded dialog steps
      sessionService.setDialogMode(previewSessionId, userId, 'replay');

      // ─── Step execution loop ───────────────────────────────────────────
      for (let i = 0; i < stepsToExecute.length; i++) {
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
              stepIndex: j,
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
          stepIndex: i,
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
            stepIndex: i,
            stepId: step.id,
            stepType: step.type,
            description: step.description,
            hasCompiled: !!step.compiled,
            hasEvidence: !!step.evidence?.lastSuccessRef,
          },
        });

        // Emit step running
        webSocketService.emitToUser(userId, 'preview:run:step', {
          previewSessionId,
          stepIndex: i,
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
            stepIndex: i,
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
              stepIndex: j,
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

        // V7: URL-based evidence policy instead of blanket disableCaching
        // If URL hasn't changed since last step, allow evidence shortcut
        const currentUrl = session.page.url();
        const urlChanged = currentUrl !== trackedUrl;
        const disableCaching = urlChanged;

        logger.debug('[PreviewRun] Evidence policy check', {
          previewSessionId,
          stepIndex: i,
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

        // V12: Interpolate email variables ({{email.otp}}, {{email.link}}, etc.)
        const interpolatedStep = interpolateEmailVariables(stepWithCachePolicy, previewSessionId);

        // V13: Peek ahead — if next step is wait_for with changedFrom, current click expects navigation.
        // This enables Promise.all([waitForNavigation(), click()]) pattern for reliable nav capture.
        const peekNext = (i < stepsToExecute.length - 1) ? stepsToExecute[i + 1] : null;
        const expectsNavigation = !!peekNext
          && peekNext.type === 'wait_for'
          && !!peekNext.options?.urlMatcher?.changedFrom;

        try {
          const stepStartMs = Date.now();
          let result = await raceAbort(PreviewStepApplyService.applyStep({
            previewSessionId,
            stepDraft: interpolatedStep,
            userId,
            skipPostActionWait: true, // V12: Lookahead handles inter-step timing
            expectsNavigation, // V13: Wrap click with waitForNavigation if next step expects URL change
          }), signal);
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
              stepIndex: i,
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
                  stepIndex: i,
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
                stepIndex: i,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
            }
          }

          const stepDurationMs = Date.now() - stepStartMs;

          // Log slow steps for production diagnosis
          if (stepDurationMs > 3000) {
            logger.warn('[PreviewRun] Slow step execution', {
              previewSessionId,
              stepIndex: i,
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
              stepIndex: i,
              stepId: step.id,
            });

            // Trace step_result (pass)
            traceWriter.write({
              iteration: i,
              stage: 'step_execution',
              eventType: 'step_result',
              spanId: traceWriter.generateSpanId(),
              parentSpanId: stepSpanId,
              payload: {
                stepIndex: i,
                stepId: step.id,
                status: 'pass',
                urlChanged: result.urlChanged,
                url: result.url,
                attempts: result.attempts,
                verified: result.verified,
                retried,
              },
            });

            // Emit pass (include appliedStep so frontend can enrich the UI step)
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: i,
              stepId: step.id,
              status: 'pass',
              action: step.type,
              description: step.description,
              timestamp: new Date().toISOString(),
              ...(result.appliedStep ? { appliedStep: result.appliedStep } : {}),
              ...(retried ? { retried: true } : {}),
            });
            passedSteps++;

            // Update tracked URL after successful step execution
            trackedUrl = session.page.url();

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
            // ─────────────────────────────────────────────────────────────────
            if (i < stepsToExecute.length - 1 && !shouldSkipLookaheadAfter(step.type) && !runState.cancelled) {
              const nextStep = stepsToExecute[i + 1];
              try {
                const lookahead = await raceAbort(waitForStepReadiness(session.page, nextStep, {
                  maxWaitMs: STEP_READINESS_CONFIG.defaults.maxWaitMs,
                  settleMs: STEP_READINESS_CONFIG.defaults.settleMs,
                  autoWaitThresholdMs: STEP_READINESS_CONFIG.defaults.autoWaitThresholdMs,
                  prevActionType: step.type,
                  prevUrl: trackedUrl,
                  recordedDelayMs: nextStep.evidence?.interStepDelayMs,
                }), signal);

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
                await waitForDOMStability(session.page, 3000, 500).catch(() => {});
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
                  stepIndex: j,
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
            // Augment error with page context if we navigated earlier
            const errorWithContext = augmentErrorWithPageContext(
              result.error || 'Step failed',
              lastNavigationSummary,
            );

            logger.warn('[PreviewRun] Step failed', {
              previewSessionId,
              stepIndex: i,
              stepId: step.id,
              error: result.error,
              retried,
              hasPageContext: !!lastNavigationSummary,
            });

            // Trace step_result (fail)
            traceWriter.write({
              iteration: i,
              stage: 'step_execution',
              eventType: 'step_result',
              spanId: traceWriter.generateSpanId(),
              parentSpanId: stepSpanId,
              payload: {
                stepIndex: i,
                stepId: step.id,
                status: 'fail',
                error: result.error,
                attempts: result.attempts,
                retried,
                pageContext: lastNavigationSummary || undefined,
              },
            });

            // Emit fail (with augmented error for better UX)
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: i,
              stepId: step.id,
              status: 'fail',
              action: step.type,
              description: step.description,
              error: errorWithContext,
              timestamp: new Date().toISOString(),
              ...(retried ? { retried: true } : {}),
            });
            failedSteps++;

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
                stepIndex: j,
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
              stepIndex: i,
              stepId: step.id,
            });
            // Current step already emitted 'running' — mark as skipped
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: i,
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
                stepIndex: j,
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
              stepIndex: i,
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
                  stepIndex: i,
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
                    stepIndex: i,
                    stepId: step.id,
                    status: 'pass',
                    urlChanged: retryResult.urlChanged,
                    url: retryResult.url,
                    retried: true,
                  },
                });

                webSocketService.emitToUser(userId, 'preview:run:step', {
                  previewSessionId,
                  stepIndex: i,
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
                if (i < stepsToExecute.length - 1 && !shouldSkipLookaheadAfter(step.type) && !runState.cancelled) {
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
                    await waitForDOMStability(session.page, 3000, 500).catch(() => {});
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
                    payload: { stepIndex: i, stepId: step.id, status: 'pass',
                      urlChanged: finalResult.urlChanged, url: finalResult.url, retried: true },
                  });

                  webSocketService.emitToUser(userId, 'preview:run:step', {
                    previewSessionId, stepIndex: i, stepId: step.id, status: 'pass',
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
                  if (i < stepsToExecute.length - 1 && !shouldSkipLookaheadAfter(step.type) && !runState.cancelled) {
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
                      await waitForDOMStability(session.page, 3000, 500).catch(() => {});
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

          const errorWithContext = augmentErrorWithPageContext(originalError, lastNavigationSummary);

          logger.error('[PreviewRun] Step exception', {
            previewSessionId,
            stepIndex: i,
            stepId: step.id,
            error: originalError,
            retried: exceptionRetried,
          });

          // Trace step_result (exception)
          traceWriter.write({
            iteration: i,
            stage: 'step_execution',
            eventType: 'step_result',
            spanId: traceWriter.generateSpanId(),
            parentSpanId: stepSpanId,
            payload: {
              stepIndex: i,
              stepId: step.id,
              status: 'exception',
              error: originalError,
              retried: exceptionRetried,
              pageContext: lastNavigationSummary || undefined,
            },
          });

          // Emit fail
          webSocketService.emitToUser(userId, 'preview:run:step', {
            previewSessionId,
            stepIndex: i,
            stepId: step.id,
            status: 'fail',
            action: step.type,
            description: step.description,
            error: errorWithContext,
            timestamp: new Date().toISOString(),
            ...(exceptionRetried ? { retried: true } : {}),
          });
          failedSteps++;

          // Stop and skip remaining
          for (let j = i + 1; j < stepsToExecute.length; j++) {
            const remainingStep = stepsToExecute[j];
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: j,
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
    } finally {
      // Clear global timeout
      clearTimeout(globalTimeout);

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
      });

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

      // 10. Cleanup run state — only delete if it's still OUR run (prevents
      // wiping a newer run's state when user quickly starts a new run after cancel)
      if (activeRuns.get(previewSessionId) === runState) {
        activeRuns.delete(previewSessionId);
      }
    }
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
