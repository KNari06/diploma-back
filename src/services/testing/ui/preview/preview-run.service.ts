/**
 * Preview Run Service V8
 * Orchestrates "Run from start" feature in AI editor
 * Executes all saved steps sequentially in existing preview browser session
 * Features: cancel support, per-step progress tracking, stop-on-fail, best-effort persistence
 */

import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { IntentTestCaseService } from './intent-test-case.service';
import { PreviewStepApplyService } from './preview-step-apply.service';
import { getPreviewSessionService } from './preview-session.service';
import type { IntentStep } from './preview.types';
import { shouldSkipLookaheadAfter, waitForStepReadiness } from './step-readiness.service';

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
 * Service for running all saved steps in preview session
 */
export class PreviewRunService {
  /**
   * Start "Run from start" - execute all saved steps sequentially
   * @param previewSessionId - Preview session ID (must be active)
   * @param intentTestCaseId - Test case ID to load steps from
   * @param userId - User ID for ownership verification
   */
  static async runSavedSteps(
    previewSessionId: string,
    intentTestCaseId: string,
    userId: string
  ): Promise<void> {
    // 1. Check if already running
    if (activeRuns.has(previewSessionId)) {
      throw new Error('Run already in progress for this session');
    }

    // 2. Verify session ownership
    const sessionService = getPreviewSessionService();
    if (!sessionService.isSessionOwned(previewSessionId, userId)) {
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

    let savedSteps: IntentStep[] | null = null;
    let startedEmitted = false;

    // 7. Execute steps sequentially
    let passedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;

    try {
      // 4. Load saved steps from DB
      const testCase = await IntentTestCaseService.getById(intentTestCaseId, userId);
      if (!testCase || !testCase.stepsJson) {
        throw new Error('Test case not found or has no saved steps');
      }

      savedSteps = testCase.stepsJson;
      if (savedSteps.length === 0) {
        throw new Error('No steps to run');
      }

      // 5. Get session page
      const session = sessionService.getSession(previewSessionId);
      if (!session?.page) {
        throw new Error('Session has no active page');
      }

      // 6. Get startUrl for initial navigation
      const startUrl = testCase.startUrl || testCase.url;
      if (!startUrl) {
        throw new Error('Test case has no startUrl or url');
      }

      logger.info('[PreviewRun] Starting run', {
        previewSessionId,
        intentTestCaseId,
        userId,
        totalSteps: savedSteps.length,
        startUrl,
      });

      // 7. Emit started event
      webSocketService.emitToUser(userId, 'preview:run:started', {
        previewSessionId,
        totalSteps: savedSteps.length,
        startUrl,
        timestamp: new Date().toISOString(),
      });
      startedEmitted = true;

      // 8. Navigate to startUrl before executing steps
      // This ensures we start from the correct page regardless of current browser state
      logger.info('[PreviewRun] Navigating to startUrl', {
        previewSessionId,
        startUrl,
      });

      try {
        await session.page.goto(startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        // Wait for network idle after initial navigation
        await session.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
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
      // This is effectively a no-op in real runs (applyStep is async anyway),
      // but makes cancellation and concurrency behavior deterministic.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Track URL for evidence shortcut policy (V7)
      let trackedUrl = session.page.url();
      logger.debug('[PreviewRun] Starting run with URL tracking', {
        previewSessionId,
        initialUrl: trackedUrl,
      });

      for (let i = 0; i < savedSteps.length; i++) {
        // Check cancellation
        const currentRunState = activeRuns.get(previewSessionId);
        if (!currentRunState || runState.cancelled || currentRunState.cancelled) {
          logger.info('[PreviewRun] Run cancelled, skipping remaining steps', {
            previewSessionId,
            currentStep: i,
            remainingSteps: savedSteps.length - i,
          });

          // Emit remaining steps as skipped
          for (let j = i; j < savedSteps.length; j++) {
            const step = savedSteps[j];
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
        const step = savedSteps[i];

        logger.info('[PreviewRun] Executing step', {
          previewSessionId,
          stepIndex: i,
          stepId: step.id,
          stepType: step.type,
          description: step.description?.slice(0, 80),
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
            remainingSteps: savedSteps.length - i,
          });

          // Mark this step and remaining as skipped
          for (let j = i; j < savedSteps.length; j++) {
            const remaining = savedSteps[j];
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

          const result = await PreviewStepApplyService.applyStep({
            previewSessionId,
            stepDraft: stepWithCachePolicy,
            userId,
          });

          if (result.success) {
            logger.info('[PreviewRun] Step passed', {
              previewSessionId,
              stepIndex: i,
              stepId: step.id,
            });

            // Emit pass
            webSocketService.emitToUser(userId, 'preview:run:step', {
              previewSessionId,
              stepIndex: i,
              stepId: step.id,
              status: 'pass',
              action: step.type,
              description: step.description,
              timestamp: new Date().toISOString(),
            });
            passedSteps++;

            // Update tracked URL after successful step execution
            trackedUrl = session.page.url();

            // ─────────────────────────────────────────────────────────────────────
            // Lookahead wait: check next step readiness before executing it
            // Uses fast Playwright checks only (no AI/embeddings)
            // ─────────────────────────────────────────────────────────────────────
            if (i < savedSteps.length - 1 && !shouldSkipLookaheadAfter(step.type)) {
              const nextStep = savedSteps[i + 1];
              try {
                const lookahead = await waitForStepReadiness(session.page, nextStep, {
                  maxWaitMs: 10000,
                  settleMs: 3000,
                  autoWaitThresholdMs: 2000,
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

            // Best-effort: persist appliedStep if result has it
            if (result.appliedStep) {
              try {
                await IntentTestCaseService.updateStepFromPreviewApply({
                  intentTestCaseId,
                  appliedStep: result.appliedStep,
                });

                logger.debug('[PreviewRun] Persisted appliedStep', {
                  previewSessionId,
                  stepId: step.id,
                });
              } catch (persistError) {
                logger.warn('[PreviewRun] Failed to persist appliedStep (best-effort)', {
                  previewSessionId,
                  stepId: step.id,
                  error: persistError instanceof Error ? persistError.message : String(persistError),
                });
                // Don't fail the run, continue
              }
            }

            // If cancellation was requested during/after this step, stop before next step.
            const cancelledAfterStep =
              runState.cancelled || activeRuns.get(previewSessionId)?.cancelled === true;
            if (cancelledAfterStep) {
              logger.info('[PreviewRun] Cancellation detected after step completion, skipping remaining steps', {
                previewSessionId,
                completedStep: i,
                remainingSteps: savedSteps.length - i - 1,
              });

              for (let j = i + 1; j < savedSteps.length; j++) {
                const remainingStep = savedSteps[j];
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
              remainingSteps: savedSteps.length - i - 1,
            });

            for (let j = i + 1; j < savedSteps.length; j++) {
              const remainingStep = savedSteps[j];
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
          for (let j = i + 1; j < savedSteps.length; j++) {
            const remainingStep = savedSteps[j];
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
      // 8. Emit completed event (only if we emitted started)
      if (startedEmitted && savedSteps) {
        const duration = Date.now() - runState.startTime;
        const cancelled = activeRuns.get(previewSessionId)?.cancelled || false;

        logger.info('[PreviewRun] Run completed', {
          previewSessionId,
          intentTestCaseId,
          success: failedSteps === 0 && !cancelled,
          passedSteps,
          failedSteps,
          skippedSteps,
          cancelled,
          duration,
        });

        webSocketService.emitToUser(userId, 'preview:run:completed', {
          previewSessionId,
          success: failedSteps === 0 && !cancelled,
          totalSteps: savedSteps.length,
          passedSteps,
          failedSteps,
          skippedSteps,
          cancelled,
          duration,
          timestamp: new Date().toISOString(),
        });
      }

      // 9. Cleanup run state
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
