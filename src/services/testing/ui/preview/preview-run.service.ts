/**
 * Preview Run Service V10
 * Orchestrates "Run from start" feature in AI editor
 * Executes steps sequentially in existing preview browser session
 * Features: cancel support, per-step progress tracking, stop-on-fail, best-effort persistence
 *
 * V9: Extracted runStepsOnPreview() for ephemeral (DB-free) draft step execution.
 *     runSavedSteps() is now a thin wrapper that resolves steps from DB then delegates.
 * V10: Global run timeout (5 min), always emit completion (even pre-started failures),
 *      timeout guards on finally-block cleanup to prevent hanging.
 */

import { LiteTraceWriter } from '@/agent/core/lite/trace/lite-trace-writer';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { IntentTestCaseService } from './intent-test-case.service';
import { PreviewStepApplyService } from './preview-step-apply.service';
import { getPreviewSessionService } from './preview-session.service';
import type { IntentStep } from './preview.types';
import { shouldSkipLookaheadAfter, waitForStepReadiness } from './step-readiness.service';

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
 * Internal state for active runs
 */
interface RunState {
  running: boolean;
  cancelled: boolean;
  startTime: number;
  currentStepIndex: number;
}

/**
 * Per-session run registry to prevent concurrent runs
 * Key: previewSessionId
 */
const activeRuns = new Map<string, RunState>();

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
   */
  static async runStepsOnPreview(
    previewSessionId: string,
    steps: IntentStep[],
    startUrl: string,
    userId: string,
    options?: {
      intentTestCaseId?: string;
      persistAppliedSteps?: boolean;
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
    };
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
        timestamp: new Date().toISOString(),
      });
      startedEmitted = true;

      // 6. Navigate to startUrl before executing steps
      logger.info('[PreviewRun] Navigating to startUrl', {
        previewSessionId,
        startUrl,
      });

      try {
        await session.page.goto(startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        // Wait for network idle after initial navigation (5s is sufficient — lookahead handles step readiness)
        await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
          logger.debug('[PreviewRun] Network idle timeout after initial navigation, continuing');
        });

        logger.info('[PreviewRun] Navigation to startUrl complete', {
          previewSessionId,
          currentUrl: session.page.url(),
        });
      } catch (navError) {
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
      logger.debug('[PreviewRun] Starting run with URL tracking', {
        previewSessionId,
        initialUrl: trackedUrl,
      });

      // ─── Step execution loop ───────────────────────────────────────────
      for (let i = 0; i < steps.length; i++) {
        // Check cancellation
        const currentRunState = activeRuns.get(previewSessionId);
        if (!currentRunState || runState.cancelled || currentRunState.cancelled) {
          logger.info('[PreviewRun] Run cancelled, skipping remaining steps', {
            previewSessionId,
            currentStep: i,
            remainingSteps: steps.length - i,
          });

          // Emit remaining steps as skipped
          for (let j = i; j < steps.length; j++) {
            const step = steps[j];
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
        const step = steps[i];

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

        // Give a chance for a cancellation request to land before executing the step.
        await new Promise<void>((resolve) => setImmediate(resolve));

        const stateBeforeExecute = activeRuns.get(previewSessionId);
        if (!stateBeforeExecute || runState.cancelled || stateBeforeExecute.cancelled) {
          logger.info('[PreviewRun] Cancel detected before step execute, skipping remaining steps', {
            previewSessionId,
            currentStep: i,
            remainingSteps: steps.length - i,
          });

          // Mark this step and remaining as skipped
          for (let j = i; j < steps.length; j++) {
            const remaining = steps[j];
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

        try {
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

          const stepStartMs = Date.now();
          const result = await PreviewStepApplyService.applyStep({
            previewSessionId,
            stepDraft: stepWithCachePolicy,
            userId,
            skipPostActionWait: true, // V12: Lookahead handles inter-step timing
          });
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
            });
            passedSteps++;

            // Update tracked URL after successful step execution
            trackedUrl = session.page.url();

            // ─────────────────────────────────────────────────────────────────
            // Lookahead wait: check next step readiness before executing it
            // Uses fast Playwright checks only (no AI/LLM)
            // ─────────────────────────────────────────────────────────────────
            if (i < steps.length - 1 && !shouldSkipLookaheadAfter(step.type)) {
              const nextStep = steps[i + 1];
              try {
                const lookahead = await waitForStepReadiness(session.page, nextStep, {
                  maxWaitMs: 5000,
                  settleMs: 1500,
                  autoWaitThresholdMs: 1000,
                });

                if (lookahead.autoWaitApplied) {
                  logger.info('[PreviewRun] Lookahead auto-wait applied before next step', {
                    previewSessionId,
                    currentStepIndex: i,
                    nextStepIndex: i + 1,
                    nextStepId: nextStep.id,
                    waitedMs: lookahead.waited,
                    ready: lookahead.ready,
                  });
                } else if (lookahead.skipReason) {
                  logger.debug('[PreviewRun] Lookahead skipped', {
                    previewSessionId,
                    nextStepIndex: i + 1,
                    reason: lookahead.skipReason,
                  });
                }
              } catch (lookaheadError) {
                // Lookahead failure is non-fatal, log and continue
                logger.warn('[PreviewRun] Lookahead wait failed, continuing', {
                  previewSessionId,
                  nextStepIndex: i + 1,
                  error: lookaheadError instanceof Error ? lookaheadError.message : String(lookaheadError),
                });
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
                remainingSteps: steps.length - i - 1,
              });

              for (let j = i + 1; j < steps.length; j++) {
                const remainingStep = steps[j];
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
            logger.warn('[PreviewRun] Step failed', {
              previewSessionId,
              stepIndex: i,
              stepId: step.id,
              error: result.error,
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
              error: result.error,
              timestamp: new Date().toISOString(),
            });
            failedSteps++;

            // Stop on first failure - emit remaining steps as skipped
            logger.info('[PreviewRun] Stopping due to failure, skipping remaining steps', {
              previewSessionId,
              failedStep: i,
              remainingSteps: steps.length - i - 1,
            });

            for (let j = i + 1; j < steps.length; j++) {
              const remainingStep = steps[j];
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
          logger.error('[PreviewRun] Step exception', {
            previewSessionId,
            stepIndex: i,
            stepId: step.id,
            error: stepError instanceof Error ? stepError.message : String(stepError),
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
              error: stepError instanceof Error ? stepError.message : String(stepError),
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
            error: stepError instanceof Error ? stepError.message : 'Unexpected error',
            timestamp: new Date().toISOString(),
          });
          failedSteps++;

          // Stop and skip remaining
          for (let j = i + 1; j < steps.length; j++) {
            const remainingStep = steps[j];
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

      webSocketService.emitToUser(userId, 'preview:run:completed', {
        previewSessionId,
        success: failedSteps === 0 && !cancelled && !timedOut,
        totalSteps: steps.length,
        passedSteps,
        failedSteps,
        skippedSteps,
        cancelled,
        timedOut,
        duration,
        timestamp: new Date().toISOString(),
      });

      // 8b. Batch-persist all enriched steps (single DB round-trip) — with timeout guard
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
        }).catch(() => {});
      }).catch(() => {});

      // 10. Cleanup run state
      activeRuns.delete(previewSessionId);
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
