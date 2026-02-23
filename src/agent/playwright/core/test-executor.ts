import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TestJobData } from '@/types';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getActionIcon, type TestStepCompletedPayload } from '@/websocket/types/types';
import { BrowserContext, Page } from 'playwright';
import { IntelligentTestOrchestrator } from '../../core/intelligent-test-orchestrator';
import { LiteEngine, ModeRouter } from '../../core/lite';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { supabaseAdmin } from '@/db/supabase';
import { saveIntelligentTestResults, uploadArtifacts, uploadIntelligentTestScreenshots } from '../artifacts/artifacts-handler';
import { collectArtifactsAndCleanup } from '../artifacts/test-cleanup';
import { formatTestResult } from '../artifacts/test-result-formatter';
import { VideoStreamRegistry } from '../artifacts/video-stream-registry';
import { VideoStreamService, createVideoStreamService } from '../artifacts/video-stream.service';
import { navigateToUrl } from '../execution/navigation-handler';
import { RequestTracker } from '../execution/request-tracker';
import { getBrowserWithProgress, setupBrowserContext } from '../setup/browser-setup';
import { buildAllHintsWithMetadata } from '../setup/hints-builder';
import { buildIntelligentTestConfig } from '../setup/test-config-builder';
import { checkTestCancelled } from '../utils/test-cancellation-checker';
import { createRunKey, TestRunRegistry } from './test-run-registry';
import { TestExecutedStepsRedisService } from '@/services/testing/results/test-executed-steps-redis.service';
import { waitForStepReadiness, shouldSkipLookaheadAfter } from '@/services/testing/ui/preview/step-readiness.service';
import type { IntentStep, StepRuntimeMeta } from '@/services/testing/ui/preview/preview.types';

/**
 * Resolve workspaceId from projectId (for AI usage tracking).
 */
async function resolveWorkspaceFromProject(projectId: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('workspace_id')
      .eq('id', projectId)
      .single();
    return data?.workspace_id || 'unknown';
  } catch (error) {
    logger.warn('[PLAYWRIGHT] Failed to resolve workspace from project', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}

/**
 * Parse URL safely (never throws).
 */
function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Best-effort same-origin check for network correlation.
 * We intentionally bias toward safety (avoid false FAIL on 3rd-party / analytics errors).
 */
function isSameOriginUrl(requestUrl: string, baseUrl: string): boolean {
  const base = safeParseUrl(baseUrl);
  if (!base) return false;
  // Handle relative URLs (e.g. "/api/save") by resolving against baseUrl
  let req = safeParseUrl(requestUrl);
  if (!req) {
    try { req = new URL(requestUrl, baseUrl); } catch { return false; }
  }
  return req.protocol === base.protocol && req.host === base.host;
}

/**
 * Decide whether we should FAIL the step on critical network errors.
 *
 * Why not only description-keywords?
 * - Words are a weak signal and vary by language.
 * - We already scope to the step time-window, and we only look at mutating HTTP methods.
 * - We additionally require same-origin (reduces noise from 3rd-party/analytics).
 *
 * Final heuristic (safe + additive):
 * - FAIL if we see same-origin critical errors AND actionType is likely to trigger mutations.
 * - For `type`, we default to WARNING unless step text strongly suggests submit/save.
 */
function shouldFailOnCriticalNetworkErrors(params: {
  actionType: string | undefined;
  stepDescription: string;
  baseUrl: string;
  criticalErrors: Array<{ method: string; url: string; status?: number; error: string }>;
}): { shouldFail: boolean; fatalErrors: Array<{ method: string; url: string; status?: number; error: string }> } {
  const { actionType, stepDescription, baseUrl, criticalErrors } = params;

  const fatalErrors = criticalErrors.filter((e) => isSameOriginUrl(e.url, baseUrl));
  if (fatalErrors.length === 0) return { shouldFail: false, fatalErrors: [] };

  const likelyMutatingActionTypes = new Set([
    'click',
    'press',
    'check',
    'uncheck',
    'select',
    'navigate',
    'wait_for',
  ]);

  if (actionType && likelyMutatingActionTypes.has(actionType)) {
    return { shouldFail: true, fatalErrors };
  }

  // For `type` (and unknown actionTypes), only fail when text strongly indicates a submit/save intent.
  const desc = stepDescription.toLowerCase();
  const strongKeywords = ['save', 'submit', 'confirm', 'checkout', 'pay', 'login', 'sign in', 'register', 'create', 'update', 'delete', 'remove'];
  const looksLikeSubmit = strongKeywords.some((kw) => desc.includes(kw));
  return { shouldFail: looksLikeSubmit, fatalErrors };
}

/**
 * Capture a screenshot when a bug is detected during test execution.
 * Non-fatal: returns undefined on any failure.
 */
async function captureBugScreenshot(
  page: Page,
  testData: TestJobData,
  stepIndex: number,
  reason: string,
): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    const path = `bug-screenshots/${testData.testId}/${testData.browser}/step-${stepIndex}-${reason}.png`;
    const { data } = await supabaseAdmin.storage
      .from('test-artifacts')
      .upload(path, buf, { contentType: 'image/png', upsert: true });
    if (data?.path) {
      const { data: urlData } = supabaseAdmin.storage.from('test-artifacts').getPublicUrl(data.path);
      return urlData?.publicUrl;
    }
  } catch {
    // Non-fatal — continue without screenshot
  }
  return undefined;
}

/**
 * Execute Playwright test
 */
export async function executePlaywrightTest(testData: TestJobData): Promise<{
  success: boolean;
  status: string;
  screenshot?: string;
  dom?: string;
  logs: string[];
  networkLogs: any[];
  errors: any[];
  performance?: any;
  videoUrl?: string;
  videoPath?: string;
  traceUrl?: string;
  tracePath?: string;
  error?: string;
  /** Step-level runtime metadata for reporting (keyed by stepId) */
  stepRuntimeMeta?: Record<string, any>;
  /** Non-UI quality checks: performance, broken resources, a11y, slow APIs */
  qualityChecks?: any;
}> {
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  let tracePath: string | undefined;
  let videoStreamService: VideoStreamService | null = null;

  // Create runKey for isolation of parallel browser runs (defined here for access in catch block)
  const runKey = createRunKey(testData.testId, testData.browser);

  try {
    // Pre-flight checks
    await checkTestCancelled(testData.testId);
    const retryCount = testData.retryCount ?? 0;

    logger.info('[PLAYWRIGHT] Starting test', {
      testId: testData.testId,
      url: testData.url,
      browser: testData.browser,
      intelligentMode: testData.intelligentMode || false,
      projectId: testData.projectId,
      userId: testData.userId,
      retryCount,
      runKey,
    });

    // Setup browser and page
    const browser = await getBrowserWithProgress(testData);
    const setupResult = await setupBrowserContext(testData, browser);
    context = setupResult.context;
    tracePath = setupResult.tracePath;

    page = await context.newPage();
    if (!page) {
      throw new Error('Failed to create page');
    }

    // Register test run in global registry for abort capability
    TestRunRegistry.register(runKey, testData.testId, testData.browser, {
      context,
      page,
    });

    // Enable Performance Observers for Web Vitals collection (must run before navigation)
    try {
      await page.evaluate(`
        if (typeof PerformanceObserver !== 'undefined') {
          try { new PerformanceObserver(function(){}).observe({ type: 'longtask', buffered: true }); } catch(e) {}
          try { new PerformanceObserver(function(){}).observe({ type: 'largest-contentful-paint', buffered: true }); } catch(e) {}
          try { new PerformanceObserver(function(){}).observe({ type: 'layout-shift', buffered: true }); } catch(e) {}
        }
      `);
    } catch {
      // Non-fatal: observer types may not be supported
    }

    // Start video streaming for Chrome (CDP screencast)
    // Skip for Background Replay (regression runs) — no one watches the live stream
    const isBackgroundReplay = !testData.intelligentMode && testData.commands && testData.commands.length > 0;
    if (!isBackgroundReplay && (testData.browser.toLowerCase().includes('chrome') || testData.browser.toLowerCase().includes('chromium'))) {
      try {
        videoStreamService = createVideoStreamService();
        await videoStreamService.start(
          page,
          testData.testId,
          testData.browser,
          testData.userId,
          testData.url,
          testData.chatSessionId
        );

        if (videoStreamService.isActive()) {
          VideoStreamRegistry.register(runKey, videoStreamService);
          // Also update TestRunRegistry with video stream reference
          TestRunRegistry.update(runKey, { videoStreamService });
          logger.info('[PLAYWRIGHT] Video streaming started', {
            testId: testData.testId,
            browser: testData.browser,
            runKey,
          });
        }
      } catch (videoError) {
        // Video streaming is optional - don't fail the test
        logger.warn('[PLAYWRIGHT] Failed to start video streaming', {
          testId: testData.testId,
          error: videoError instanceof Error ? videoError.message : String(videoError),
        });
        videoStreamService = null;
      }
    }

    // Build hints (commands + feedback from previous runs)
    const goal = testData.testGoal || testData.intent || 'Test the application';
    const { hints, hintsFromCommandsCount, feedbackHintsCount } = await buildAllHintsWithMetadata(testData, retryCount);

    logger.info('[PLAYWRIGHT] Unified Intelligent Mode activated', {
      testId: testData.testId,
      goal,
      hasCommands: !!(testData.commands && testData.commands.length > 0),
      hintsCount: hints.length,
      hintsFromCommandsCount,
      feedbackHintsCount,
      mode: 'balanced',
      retryCount,
    });

    // Navigate to URL
    webSocketService.emitTestProgress(testData.testId, {
      testId: testData.testId,
      browser: testData.browser,
      progress: 20,
      phase: 'initialization',
      currentStep: `📄 Navigating to ${testData.url}...`,
      icon: getActionIcon('goto', 'initialization'),
      status: 'running',
      timestamp: new Date().toISOString(),
      userId: testData.userId,
      sessionId: testData.chatSessionId, // Chat session for routing isolation
    });

    const requestTracker = new RequestTracker(page);
    await navigateToUrl(page, testData, requestTracker);
    await checkTestCancelled(testData.testId);

    // ═══════════════════════════════════════════════════════════════════════════
    // V8: Background Replay Mode (for "Run from start" in CI/CD)
    // If intelligentMode is false AND commands are present, execute them step-by-step
    // This ensures preview-saved steps are executed deterministically without AI agents
    // NO Lite/Pro engine fallback - pure command replay
    // ═══════════════════════════════════════════════════════════════════════════
    if (!testData.intelligentMode && testData.commands && testData.commands.length > 0) {
      logger.info('[PLAYWRIGHT] Entering Background Replay Mode', {
        testId: testData.testId,
        commandsCount: testData.commands.length,
        intelligentMode: false,
      });

      // Import CommandExecutor
      const { CommandExecutor } = await import('@/agent/execution/command-executor');

      // Import ErrorCollectorService for background monitoring
      const { ErrorCollectorService } = await import('@/agent/utils/analysis/error-collector.service');

      // Create executor with self-healing enabled (for AI fallback without clarification)
      const executor = new CommandExecutor(page, {
        selfHealingEnabled: true,
        metadata: {
          url: testData.url,
          projectId: testData.projectId,
          userId: testData.userId,
        },
      });

      // Start error collection for background monitoring
      const errorCollector = new ErrorCollectorService(page);
      errorCollector.startCollecting();

      logger.info('[PLAYWRIGHT] Started error collection for background replay', {
        testId: testData.testId,
      });

      // Execute commands step-by-step
      let currentStepIndex = 0;
      const totalSteps = testData.commands.length;
      let allSuccess = true;
      let finalError: string | undefined;

      try {
        for (const command of testData.commands) {
          currentStepIndex++;
          const action = (command as any).action ?? (command as any).type ?? 'action';
          const intentMeta = (command as any).intentMeta as undefined | { elementDescription?: string; stepId?: string };

          // Capture URL before step — used by lookahead to detect SPA navigation
          const urlBeforeStep = page.url();

          // Check cancellation
          await checkTestCancelled(testData.testId);

          // Emit test:progress (non-fatal — WS failure must not kill replay)
          try {
            webSocketService.emitTestProgress(testData.testId, {
              testId: testData.testId,
              browser: testData.browser,
              progress: Math.round((currentStepIndex / totalSteps) * 80) + 10, // 10-90%
              phase: 'execution',
              currentStep: `Step ${currentStepIndex}/${totalSteps}: ${action}`,
              icon: getActionIcon(action, 'execution'),
              status: 'running',
              timestamp: new Date().toISOString(),
              userId: testData.userId,
              sessionId: testData.chatSessionId,
            });
          } catch (wsError) {
            logger.warn('[PLAYWRIGHT] WebSocket emit failed (test:progress)', {
              testId: testData.testId, step: currentStepIndex,
              error: wsError instanceof Error ? wsError.message : String(wsError),
            });
          }

          logger.info('[PLAYWRIGHT] Replay mode executing step', {
            testId: testData.testId,
            stepIndex: currentStepIndex,
            commandType: action,
            description: intentMeta?.elementDescription,
          });

          // Deduct 1 credit for step execution
          if (testData.userId) {
            const stepCreditResult = await CreditCostTrackerService.deductStepCredit(
              testData.userId,
              testData.testId,
              `Step ${currentStepIndex}/${totalSteps}: ${action}`
            );
            if (!stepCreditResult.success) {
              allSuccess = false;
              finalError = 'Insufficient credits to continue test execution';
              logger.warn('[PLAYWRIGHT] Stopping replay: insufficient credits', {
                testId: testData.testId,
                stepIndex: currentStepIndex,
              });
              break;
            }
          }

          // Capture step start time for error correlation
          const stepStartedAt = Date.now();

          try {
            // Execute command via CommandExecutor
            // This supports compiled plans, self-healing, AI fallback (no clarification in background)
            const stepResult = await executor.executeCommand(command);

            // Get errors that occurred during this step's execution window
            const stepErrors = errorCollector.getErrorsSince(stepStartedAt);

            // Check for critical network errors (Case C: silent backend failure)
            const criticalNetworkErrors = stepErrors.networkErrors.filter(e => {
              // Only count errors on mutating HTTP methods
              const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(e.method);
              // status === undefined → requestfailed (no HTTP response at all)
              // status >= 500 → server error
              const isServerError = typeof e.status === 'number' && e.status >= 500;
              const isRequestFailed = e.status === undefined;
              return isMutating && (isServerError || isRequestFailed);
            });

            const stepDescription = intentMeta?.elementDescription || action;
            const actionType = (command as any).intentMeta?.actionType as string | undefined;
            const networkVerdict = shouldFailOnCriticalNetworkErrors({
              actionType,
              stepDescription,
              baseUrl: testData.url,
              criticalErrors: criticalNetworkErrors.map((e) => ({
                method: e.method,
                url: e.url,
                status: e.status,
                error: e.error,
              })),
            });

            if (networkVerdict.shouldFail && networkVerdict.fatalErrors.length > 0) {
              // Case C: UI passed but network failed = SILENT BACKEND FAILURE
              const firstFatal = networkVerdict.fatalErrors[0];

              logger.warn('[PLAYWRIGHT] Silent backend failure detected', {
                testId: testData.testId,
                stepIndex: currentStepIndex,
                stepDescription,
                actionType,
                criticalErrors: networkVerdict.fatalErrors,
              });

              // Collect UI errors before breaking — DOM may show error banners
              try { await errorCollector.collectUIErrors(); } catch { /* non-fatal */ }

              // Re-fetch step errors after UI collection
              const updatedStepErrors = errorCollector.getErrorsSince(stepStartedAt);

              // Mark as failed despite UI success
              allSuccess = false;
              finalError = `Silent backend failure: ${firstFatal.method} ${firstFatal.url} → ${firstFatal.error}`;

              // Capture bug screenshot before emitting failure
              const bugScreenshotUrl = await captureBugScreenshot(page, testData, currentStepIndex, 'backend-failure');

              // Enrich runtimeMeta with network evidence
              const enrichedMeta: NonNullable<TestStepCompletedPayload['runtimeMeta']> = {
                stepId: intentMeta?.stepId,
                ...(stepResult.runtimeMeta || {}),
                runtimeStatus: 'failed' as const,
                failedReason: 'silent_backend_failure' as const,
                failureExplanation: `Step "${stepDescription}" appeared to succeed in UI, but critical network error detected: ${firstFatal.method} ${firstFatal.url} → ${firstFatal.error}. This indicates a backend bug.`,
                rootCause: 'backend' as const,
                networkVerdict: 'backend_error' as const,
                networkEvidence: networkVerdict.fatalErrors,
                stepErrors: {
                  console: updatedStepErrors.consoleErrors.length,
                  network: updatedStepErrors.networkErrors.length,
                  ui: updatedStepErrors.uiErrors.length,
                },
                bugScreenshotUrl,
              };

              try {
                webSocketService.emitTestStepCompleted(testData.testId, {
                  testId: testData.testId,
                  browser: testData.browser,
                  step: currentStepIndex,
                  stepDescription,
                  success: false,
                  timestamp: new Date().toISOString(),
                  runtimeMeta: enrichedMeta,
                });
              } catch (wsError) {
                logger.warn('[PLAYWRIGHT] WebSocket emit failed (step:completed/network-fail)', {
                  testId: testData.testId, step: currentStepIndex,
                  error: wsError instanceof Error ? wsError.message : String(wsError),
                });
              }

              // Stop on first failure
              break;
            }

            const stepDurationMs = Date.now() - stepStartedAt;
            const meta = stepResult.runtimeMeta;
            logger.info('[PLAYWRIGHT] Replay step completed', {
              testId: testData.testId,
              step: `${currentStepIndex}/${totalSteps}`,
              action,
              description: intentMeta?.elementDescription,
              durationMs: stepDurationMs,
              source: meta?.source,
              resolutionPath: meta?.resolutionPath,
              confidence: meta?.confidenceTier,
              healed: meta?.source === 'self_heal',
              healConfidence: meta?.healConfidence,
              usedStrategy: meta?.usedLocatorStrategy,
              autoWait: meta?.autoWaitApplied ? `${meta.autoWaitMs}ms` : undefined,
              errors: {
                console: stepErrors.consoleErrors.length,
                network: stepErrors.networkErrors.length,
                ui: stepErrors.uiErrors.length,
              },
            });

            // Emit test:step:completed with success (non-fatal)
            try {
              webSocketService.emitTestStepCompleted(testData.testId, {
                testId: testData.testId,
                browser: testData.browser,
                step: currentStepIndex,
                stepDescription,
                success: true,
                timestamp: new Date().toISOString(),
                runtimeMeta: stepResult.runtimeMeta,
              });
            } catch (wsError) {
              logger.warn('[PLAYWRIGHT] WebSocket emit failed (step:completed/success)', {
                testId: testData.testId, step: currentStepIndex,
                error: wsError instanceof Error ? wsError.message : String(wsError),
              });
            }

            // Collect UI errors after successful step execution
            try {
              await errorCollector.collectUIErrors();
              // Capture screenshot if UI errors were detected during this step
              const uiErrorsSinceStep = errorCollector.getErrorsSince(stepStartedAt).uiErrors;
              if (uiErrorsSinceStep.length > 0) {
                await captureBugScreenshot(page, testData, currentStepIndex, 'ui-error');
              }
            } catch (uiErrorCollectionError) {
              // Non-fatal - log and continue
              logger.debug('[PLAYWRIGHT] Failed to collect UI errors', {
                testId: testData.testId,
                stepIndex: currentStepIndex,
                error: uiErrorCollectionError instanceof Error ? uiErrorCollectionError.message : String(uiErrorCollectionError),
              });
            }

            // Auto-waiting (lookahead) for next step's readiness
            const nextCommand = testData.commands[currentStepIndex]; // currentStepIndex is 1-based, array is 0-based
            if (nextCommand) {
              const prevActionType = (command as any).intentMeta?.actionType;
              const nextIntentMeta = (nextCommand as any).intentMeta;

              if (prevActionType && nextIntentMeta && !shouldSkipLookaheadAfter(prevActionType)) {
                try {
                  const nextStepForLookahead: IntentStep = {
                    id: nextIntentMeta.stepId || `cmd-${currentStepIndex}`,
                    type: nextIntentMeta.actionType,
                    description: nextIntentMeta.elementDescription || '',
                    compiled: nextIntentMeta.compiled,
                    evidence: nextIntentMeta.evidence,
                    options: {
                      disableLookaheadWait: nextIntentMeta.disableLookaheadWait,
                    },
                  };

                  const lookahead = await waitForStepReadiness(page, nextStepForLookahead, {
                    maxWaitMs: 10000,
                    settleMs: 3000,
                    autoWaitThresholdMs: 2000,
                    // Pass context for SPA navigation detection + dynamic DOM stability threshold
                    prevActionType,
                    prevUrl: urlBeforeStep,
                  });

                  if (lookahead.autoWaitApplied) {
                    logger.info('[PLAYWRIGHT] Lookahead auto-wait applied', {
                      testId: testData.testId,
                      currentStep: currentStepIndex,
                      nextStep: currentStepIndex + 1,
                      waitedMs: lookahead.waited,
                    });
                  } else if (lookahead.skipReason) {
                    logger.debug('[PLAYWRIGHT] Lookahead skipped', {
                      testId: testData.testId,
                      nextStep: currentStepIndex + 1,
                      reason: lookahead.skipReason,
                    });
                  }
                } catch (lookaheadError) {
                  // Lookahead failure is non-fatal, log and continue
                  logger.warn('[PLAYWRIGHT] Lookahead wait failed, continuing', {
                    testId: testData.testId,
                    nextStep: currentStepIndex + 1,
                    error: lookaheadError instanceof Error ? lookaheadError.message : String(lookaheadError),
                  });
                }
              }
            }
          } catch (stepError) {
            allSuccess = false;
            finalError = stepError instanceof Error ? stepError.message : 'Unexpected error';

            // Collect UI errors at the moment of failure (DOM may show error banners)
            try { await errorCollector.collectUIErrors(); } catch { /* non-fatal */ }

            // Get errors that occurred during this step's execution window
            const stepErrors = errorCollector.getErrorsSince(stepStartedAt);

            // Get detailed runtimeMeta from executor (Case A or B)
            const stepId = intentMeta?.stepId;
            const detailedMeta = stepId ? executor.getStepRuntimeMetaById(stepId) : undefined;

            // Check if step failure was accompanied by network errors (Case A: backend)
            // status === undefined means requestfailed (no HTTP response at all)
            // status >= 500 means server error
            const hasNetworkErrors = stepErrors.networkErrors.some(e => 
              (typeof e.status === 'number' && e.status >= 500) || e.status === undefined
            );

            const baseMeta: StepRuntimeMeta = detailedMeta || {
              runtimeStatus: 'failed' as const,
              failedReason: 'unknown' as const,
              failureExplanation: finalError,
              source: 'resolver' as const,
              confidenceTier: 'low' as const,
            };

            const finalMeta: NonNullable<TestStepCompletedPayload['runtimeMeta']> = {
              stepId,
              ...baseMeta,
            };

            // Enrich with rootCause from correlation (Case A vs Case B)
            if (hasNetworkErrors) {
              // Case A: UI failed + network failed = backend bug
              finalMeta.rootCause = 'backend';
              finalMeta.networkEvidence = stepErrors.networkErrors
                .filter(e => (e.status && e.status >= 500) || !e.status)
                .map(e => ({ method: e.method, url: e.url, status: e.status, error: e.error }));
            } else if (detailedMeta) {
              // Case B: UI failed + network OK = UI bug (self-heal OK)
              finalMeta.rootCause = 'ui';
            }

            // Add step-scoped error counts
            finalMeta.stepErrors = {
              console: stepErrors.consoleErrors.length,
              network: stepErrors.networkErrors.length,
              ui: stepErrors.uiErrors.length,
            };

            // Capture bug screenshot at moment of failure
            const bugScreenshotUrl = await captureBugScreenshot(page, testData, currentStepIndex, 'step-failure');
            finalMeta.bugScreenshotUrl = bugScreenshotUrl;

            const failDurationMs = Date.now() - stepStartedAt;
            logger.error('[PLAYWRIGHT] Replay step failed', {
              testId: testData.testId,
              step: `${currentStepIndex}/${totalSteps}`,
              action,
              description: intentMeta?.elementDescription,
              durationMs: failDurationMs,
              error: finalError,
              rootCause: finalMeta.rootCause,
              failedReason: finalMeta.failedReason,
              source: baseMeta.source,
              resolutionPath: baseMeta.resolutionPath,
              healed: baseMeta.source === 'self_heal',
              healConfidence: baseMeta.healConfidence,
              errors: {
                console: stepErrors.consoleErrors.length,
                network: stepErrors.networkErrors.length,
                ui: stepErrors.uiErrors.length,
              },
            });

            // Emit test:step:completed with failure (non-fatal)
            try {
              webSocketService.emitTestStepCompleted(testData.testId, {
                testId: testData.testId,
                browser: testData.browser,
                step: currentStepIndex,
                stepDescription: intentMeta?.elementDescription || action,
                success: false,
                timestamp: new Date().toISOString(),
                runtimeMeta: finalMeta,
              });
            } catch (wsError) {
              logger.warn('[PLAYWRIGHT] WebSocket emit failed (step:completed/failure)', {
                testId: testData.testId, step: currentStepIndex,
                error: wsError instanceof Error ? wsError.message : String(wsError),
              });
            }

            // Stop on first failure
            break;
          }
        }
      } finally {
        // Stop error collection
        errorCollector.stopCollecting();
        logger.info('[PLAYWRIGHT] Stopped error collection', {
          testId: testData.testId,
          summary: errorCollector.getSummary(),
        });

        // Cleanup executor
        executor.dispose();

        // Clean up temporary bg-X refs from background DOM collection
        try {
          const { cleanupTemporaryRefs } = await import('@/agent/execution/background-dom-collector');
          await cleanupTemporaryRefs(page);
        } catch {
          // Non-fatal: page may already be closed
        }
      }

      // Collect artifacts and return
      const finalScreenshot = await page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => null);
      
      // ═══════════════════════════════════════════════════════════════════════
      // Quality Checks: Run final non-UI checks before collecting results
      // These are non-fatal and enrich the test result for user visibility
      // ═══════════════════════════════════════════════════════════════════════

      // Emit finalization progress so frontend doesn't hang at 90%
      try {
        webSocketService.emitTestProgress(testData.testId, {
          testId: testData.testId,
          browser: testData.browser,
          progress: 92,
          phase: 'quality_checks',
          currentStep: 'Running quality checks: broken resources...',
          icon: '🔍',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId: testData.userId,
          sessionId: testData.chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Run broken resource detection (adds findings to uiErrors)
      try {
        await errorCollector.collectBrokenResources();
      } catch { /* non-fatal */ }

      // Emit accessibility check progress
      try {
        webSocketService.emitTestProgress(testData.testId, {
          testId: testData.testId,
          browser: testData.browser,
          progress: 94,
          phase: 'quality_checks',
          currentStep: 'Running quality checks: accessibility scan...',
          icon: '♿',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId: testData.userId,
          sessionId: testData.chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Run enhanced accessibility scan (11 WCAG checks, once at end)
      try {
        await errorCollector.collectAccessibilityWarnings();
      } catch { /* non-fatal */ }

      // Emit performance metrics progress
      try {
        webSocketService.emitTestProgress(testData.testId, {
          testId: testData.testId,
          browser: testData.browser,
          progress: 96,
          phase: 'quality_checks',
          currentStep: 'Collecting performance metrics...',
          icon: '📊',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId: testData.userId,
          sessionId: testData.chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Collect Web Vitals performance metrics
      let performanceMetrics: any = null;
      try {
        performanceMetrics = await page.evaluate(`
          (function() {
            var entries = performance.getEntries();
            var navEntry = entries.find(function(e) { return e.entryType === 'navigation'; });
            var paintEntries = entries.filter(function(e) { return e.entryType === 'paint'; });
            var fcp = paintEntries.find(function(e) { return e.name === 'first-contentful-paint'; });
            var lcpEntries = []; try { lcpEntries = performance.getEntriesByType('largest-contentful-paint'); } catch(e) {}
            var lcp = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : null;
            var lsEntries = []; try { lsEntries = performance.getEntriesByType('layout-shift'); } catch(e) {}
            var cls = 0;
            for (var i = 0; i < lsEntries.length; i++) { if (!lsEntries[i].hadRecentInput) cls += lsEntries[i].value; }
            var ltEntries = []; try { ltEntries = performance.getEntriesByType('longtask'); } catch(e) {}
            var tbt = 0;
            for (var j = 0; j < ltEntries.length; j++) { tbt += Math.max(0, ltEntries[j].duration - 50); }
            var loadTime = 0;
            var domContentLoaded = 0;
            if (navEntry && navEntry.loadEventEnd > 0 && navEntry.fetchStart > 0) {
              var calcLoad = Math.round(navEntry.loadEventEnd - navEntry.fetchStart);
              loadTime = calcLoad > 0 ? calcLoad : 0;
            }
            if (navEntry && navEntry.domContentLoadedEventEnd > 0 && navEntry.fetchStart > 0) {
              var calcDCL = Math.round(navEntry.domContentLoadedEventEnd - navEntry.fetchStart);
              domContentLoaded = calcDCL > 0 ? calcDCL : 0;
            }
            return {
              loadTime: loadTime,
              domContentLoaded: domContentLoaded,
              firstContentfulPaint: fcp ? Math.round(fcp.startTime) : 0,
              largestContentfulPaint: lcp ? Math.round(lcp.startTime) : 0,
              firstInputDelay: 0,
              cumulativeLayoutShift: Math.round(cls * 1000) / 1000,
              totalBlockingTime: Math.round(tbt),
            };
          })()
        `);
      } catch {
        // Non-fatal: performance API may not be available
      }

      // Get collected errors from ErrorCollectorService
      const collectedErrors = errorCollector.getErrors();

      // Build QualityCheckReport (persisted in test_results for user viewing)
      const brokenResources = errorCollector.getBrokenResources();
      const slowApiCalls = errorCollector.getSlowApiCalls();
      const allApiCalls = errorCollector.getAllApiCalls();

      // Calculate API performance metrics
      let averageResponseTime = 0;
      let p95ResponseTime = 0;
      if (allApiCalls.length > 0) {
        const responseTimes = allApiCalls.map(c => c.responseTime).sort((a, b) => a - b);
        const sum = responseTimes.reduce((acc, val) => acc + val, 0);
        averageResponseTime = Math.round(sum / responseTimes.length);
        const p95Index = Math.floor(responseTimes.length * 0.95);
        p95ResponseTime = responseTimes[p95Index] || responseTimes[responseTimes.length - 1] || 0;
      }

      const qualityChecks = {
        performance: performanceMetrics || {
          loadTime: 0, domContentLoaded: 0, firstContentfulPaint: 0,
          largestContentfulPaint: 0, firstInputDelay: 0, cumulativeLayoutShift: 0, totalBlockingTime: 0,
        },
        brokenResources: brokenResources.map(r => ({ type: r.type, url: r.url, element: r.element })),
        accessibility: {
          warnings: collectedErrors.accessibilityWarnings.map(w => ({ message: w.message, selector: w.selector, wcag: (w as any).wcag })),
          totalWarnings: collectedErrors.accessibilityWarnings.length,
        },
        apiPerformance: {
          totalRequests: allApiCalls.length,
          averageResponseTime,
          p95ResponseTime,
          slowCalls: slowApiCalls.map(c => ({ url: c.url, method: c.method, status: c.status, responseTime: c.responseTime })),
        },
      };
      const logs = collectedErrors.consoleErrors.map(e => `[${e.timestamp}] ${e.message}`);
      const networkLogs = collectedErrors.networkErrors;
      const errors: any[] = [
        ...collectedErrors.consoleErrors.map(e => ({ type: 'console', message: e.message, timestamp: e.timestamp, source: e.source, line: e.line })),
        ...collectedErrors.networkErrors.map(e => ({ type: 'network', message: `${e.method} ${e.url}: ${e.error}`, timestamp: e.timestamp, url: e.url, method: e.method, status: e.status })),
        ...collectedErrors.uiErrors.map(e => ({ type: 'ui', message: e.text, timestamp: e.timestamp, selector: e.selector })),
        // Include accessibility warnings as errors for AI analysis visibility
        ...collectedErrors.accessibilityWarnings.map(w => ({ type: 'accessibility', message: w.message, timestamp: w.timestamp, selector: w.selector, wcag: (w as any).wcag })),
      ];

      logger.info('[PLAYWRIGHT] Collected errors and quality checks for reporting', {
        testId: testData.testId,
        consoleErrors: collectedErrors.consoleErrors.length,
        networkErrors: collectedErrors.networkErrors.length,
        uiErrors: collectedErrors.uiErrors.length,
        accessibilityWarnings: collectedErrors.accessibilityWarnings.length,
        brokenResources: brokenResources.length,
        slowApiCalls: slowApiCalls.length,
        performanceLCP: performanceMetrics?.largestContentfulPaint || 0,
      });

      // Emit final cleanup progress
      try {
        webSocketService.emitTestProgress(testData.testId, {
          testId: testData.testId,
          browser: testData.browser,
          progress: 98,
          phase: 'finalizing',
          currentStep: 'Saving artifacts and cleaning up...',
          icon: '💾',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId: testData.userId,
          sessionId: testData.chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Cleanup
      // Stop video streaming (best-effort) before closing context/page
      if (videoStreamService?.isActive()) {
        try {
          await videoStreamService.stop(allSuccess ? 'completed' : 'error');
        } catch (videoError) {
          logger.debug('[PLAYWRIGHT] Failed to stop video streaming in replay mode', {
            testId: testData.testId,
            error: videoError instanceof Error ? videoError.message : String(videoError),
          });
        } finally {
          VideoStreamRegistry.unregister(runKey);
        }
      }

      // Collect artifacts (video/trace) and cleanup browser resources
      const artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);

      logger.info('[PLAYWRIGHT] Background Replay Mode completed', {
        testId: testData.testId,
        success: allSuccess,
        totalSteps,
        executedSteps: currentStepIndex,
      });

      // Mark as completed and unregister from run registry
      TestRunRegistry.setCompleted(runKey);
      TestRunRegistry.unregister(runKey);

      // Aggregate step-level runtime metadata for reporting
      const stepRuntimeMeta = Object.fromEntries(executor.getStepRuntimeMeta());

      return {
        success: allSuccess,
        status: allSuccess ? 'completed' : 'failed',
        screenshot: finalScreenshot ? `data:image/jpeg;base64,${finalScreenshot.toString('base64')}` : undefined,
        logs,
        networkLogs,
        errors,
        performance: performanceMetrics, // Web Vitals — stored in test_results.performance
        error: allSuccess ? undefined : finalError,
        videoPath: artifacts.videoPath,
        tracePath: artifacts.tracePath,
        stepRuntimeMeta, // Step-level execution intelligence for reporting
        qualityChecks, // Non-UI quality checks — stored in test_results for user viewing
      };
    }

    // Safety guard: if intelligentMode is false (regression/replay), commands MUST be present
    // Prevents silent fallthrough to Lite Engine for regression tests
    if (!testData.intelligentMode) {
      logger.error('[PLAYWRIGHT] Regression test has no commands — cannot fall through to Lite Engine', {
        testId: testData.testId,
        commandsLength: testData.commands?.length ?? 0,
      });
      throw new Error('Regression test requires commands for replay. Record test steps before running.');
    }

    // Continue with existing Lite/Pro mode selection...
    // Determine which mode to use (Lite vs Pro)
    const modeSelection = ModeRouter.selectMode({
      goal,
      url: testData.url,
      userId: testData.userId,
      userMode: testData.mode || 'lite', // Pass user-selected mode from frontend
    });

    logger.info('[PLAYWRIGHT] Selected test mode', {
      testId: testData.testId,
      mode: modeSelection.mode,
      reason: modeSelection.reason,
    });

    let intelligentResult: any;

    if (modeSelection.mode === 'lite') {
      // Use Lite Engine
      logger.info('[PLAYWRIGHT] Starting Lite Engine execution', {
        testId: testData.testId,
        goal,
      });

      // Resolve workspaceId for AI usage tracking
      const workspaceId = await resolveWorkspaceFromProject(testData.projectId);

      // Wrap execution with AI tracking context
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let usageStats: any = null;
      const liteResult = await withAIContext(
        {
          workspaceId,
          testId: testData.testId,
          userId: testData.userId,
          operationType: 'lite-test',
        },
        async () => {
          AIUsageTracker.beginSession(testData.testId, {
            workspaceId,
            testId: testData.testId,
            userId: testData.userId,
            operationType: 'lite-test',
          });

          try {
            const engine = new LiteEngine(page!, {
              testId: testData.testId,
              userId: testData.userId,
              browser: testData.browser,
              goal,
              url: testData.url,
              timeout: 5 * 60 * 1000, // 5 minutes
              // Pass credentials for secure fill (never sent to LLM)
              credentials: testData.options?.credentials,
              chatSessionId: testData.chatSessionId, // Chat session for routing isolation
              prefilledSteps: testData.prefilledSteps, // Smart Resolver: prefilled steps for fast replay
            });

            return engine.execute();
          } finally {
            // Always end AI usage tracking session (even on error)
            usageStats = await AIUsageTracker.endSession(testData.testId);
          }
        },
      );

      if (usageStats) {
        logger.info('[PLAYWRIGHT] AI usage stats', {
          testId: testData.testId,
          aiCallCount: usageStats.aiCallCount,
          totalTokens: usageStats.totalTokens,
          totalCostUSD: usageStats.totalCostUSD.toFixed(6),
        });
      }

      logger.info('[PLAYWRIGHT] Lite Engine completed', {
        testId: testData.testId,
        success: liteResult.success,
        iterations: liteResult.iterations,
        reason: liteResult.reason,
        screenshotsCount: liteResult.screenshots.length,
      });

      // Lite screenshots are uploaded during execution in LiteEngine (for real-time graph updates).
      // IMPORTANT: Do NOT upload again here — avoids duplicates and broken index mapping on partial failures.

      // Convert Lite result to format expected by rest of system (IntelligentTestResult)
      // ✅ FIXED: Now includes all required fields for Pro parity

      // Build screenshots array from graphData (source of truth for URLs + screenshot URLs)
      const screenshots: Array<{ url: string; screenshot: string }> = [];
      const seenScreenshotUrls = new Set<string>();
      if (liteResult.graphData?.nodes) {
        for (const node of liteResult.graphData.nodes as any[]) {
          if (!node?.meta) continue;

          const urlAfter: string | undefined = node.meta.urlAfter;
          const urlBefore: string | undefined = node.meta.urlBefore;
          const screenshotAfter: string | undefined = node.meta.screenshotAfter;
          const screenshotBefore: string | undefined = node.meta.screenshotBefore;
          const pageScreenshot: string | undefined = node.meta.screenshot; // page nodes

          const pushIfNew = (url: string | undefined, screenshotUrl: string | undefined) => {
            if (!screenshotUrl) return;
            if (seenScreenshotUrls.has(screenshotUrl)) return;
            seenScreenshotUrls.add(screenshotUrl);
            screenshots.push({ url: url || testData.url, screenshot: screenshotUrl });
          };

          pushIfNew(urlBefore, screenshotBefore);
          pushIfNew(urlAfter, screenshotAfter);
          pushIfNew(urlAfter, pageScreenshot);
        }
      }

      // ✅ Convert Lite errors to Pro format
      const proErrors = (liteResult.errors || []).map((e) => ({
        message: e.message,
        page: e.page,
        type: e.type,
        timestamp: e.timestamp,
        iteration: e.iteration,
      }));

      intelligentResult = {
        // Core fields
        success: liteResult.success,
        goal: goal,
        startUrl: testData.url,
        pagesVisited: liteResult.uniquePagesVisited || 1,
        actionsTaken: liteResult.iterations,
        duration: liteResult.duration || 0,
        cost: liteResult.iterations * 0.001, // Approximate cost

        // Error/warning tracking (Pro-grade from Lite)
        errors: proErrors,
        warnings: [],

        // Summary
        summary: liteResult.reason,

        // Page visits (constructed from iteration records)
        pageVisits: liteResult.pageVisits || [],

        // Screenshots: Pro format, derived from graphData (already URLs)
        screenshots,

        // ✅ NEW: Full graph data like Pro
        graphData: liteResult.graphData,

        // Internal flags
        _liteMode: true, // Flag to skip uploadIntelligentTestScreenshots
      };

      // Push executed steps to Redis for DB persistence via finalizeToDb
      if (liteResult.executedSteps && liteResult.executedSteps.length > 0) {
        for (const step of liteResult.executedSteps) {
          await TestExecutedStepsRedisService.appendStepCompleted(testData.testId, {
            testId: testData.testId,
            browser: testData.browser || 'chrome',
            step: step.data.step,
            stepDescription: step.data.description,
            success: step.data.success,
            timestamp: step.ts,
          });
        }
        logger.info('[PLAYWRIGHT] Lite mode: pushed executed steps to Redis', {
          testId: testData.testId,
          stepCount: liteResult.executedSteps.length,
        });
      }
    } else {
      // Use Pro Mode (existing IntelligentTestOrchestrator)
      logger.info('[PLAYWRIGHT] Starting Pro Mode execution', {
        testId: testData.testId,
        goal,
        hintsCount: hints.length,
      });

      const intelligentConfig = buildIntelligentTestConfig(testData, goal, hints, retryCount);
      const orchestrator = new IntelligentTestOrchestrator(
        intelligentConfig,
        testData.userId,
        testData.testId
      );

      intelligentResult = await orchestrator.execute(browser, page);

      logger.info('[PLAYWRIGHT] Pro Mode completed', {
        testId: testData.testId,
        success: intelligentResult.success,
        pagesVisited: intelligentResult.pagesVisited,
        actionsTaken: intelligentResult.actionsTaken,
        duration: `${Math.round(intelligentResult.duration / 1000)}s`,
        cost: `$${intelligentResult.cost.toFixed(3)}`,
      });
    }

    // Save results and upload artifacts
    // For Lite mode, create a minimal config for compatibility
    const finalConfig = modeSelection.mode === 'lite'
      ? { mode: 'lite', goal, startUrl: testData.url, hints: [] }
      : buildIntelligentTestConfig(testData, goal, hints, retryCount);

    await saveIntelligentTestResults(testData, intelligentResult, finalConfig);

    // Upload screenshots:
    // - Lite mode: screenshots already uploaded as URLs, just extract them
    // - Pro mode: screenshots are base64, need to upload to storage
    let screenshotUrls: string[] = [];
    if (intelligentResult._liteMode) {
      // Lite mode: screenshots are already URLs
      screenshotUrls = (intelligentResult.screenshots || [])
        .map((s: { screenshot?: string }) => s.screenshot)
        .filter((url: string | undefined): url is string => !!url);

      logger.debug('[PLAYWRIGHT] Lite mode: using pre-uploaded screenshot URLs', {
        testId: testData.testId,
        count: screenshotUrls.length,
      });
    } else {
      // Pro mode: upload base64 screenshots to storage
      screenshotUrls = await uploadIntelligentTestScreenshots(
        testData,
        intelligentResult.screenshots || []
      );
    }

    // Stop video streaming
    if (videoStreamService?.isActive()) {
      try {
        await videoStreamService.stop('completed');
        VideoStreamRegistry.unregister(runKey);
      } catch (videoError) {
        logger.warn('[PLAYWRIGHT] Failed to stop video streaming', {
          testId: testData.testId,
          error: videoError instanceof Error ? videoError.message : String(videoError),
        });
      }
    }

    // Collect artifacts and cleanup (best-effort)
    let artifacts: { videoPath?: string; tracePath?: string } = {};
    try {
      artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);
    } catch (cleanupError) {
      logger.warn('[PLAYWRIGHT] Failed to collect artifacts during cleanup', {
        testId: testData.testId,
        browser: testData.browser,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    // Upload video/trace (screenshots already uploaded separately)
    const uploadedArtifacts = await uploadArtifacts(
      testData,
      artifacts.videoPath,
      artifacts.tracePath,
      screenshotUrls
    ).catch((uploadError) => {
      logger.debug('[PLAYWRIGHT] Failed to upload artifacts', {
        testId: testData.testId,
        browser: testData.browser,
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      });
      return { videoUrl: undefined, traceUrl: undefined };
    });

    // Unregister from TestRunRegistry (successful completion)
    TestRunRegistry.setCompleted(runKey);
    TestRunRegistry.unregister(runKey);

    // Format and return result
    return formatTestResult(intelligentResult, {
      videoUrl: uploadedArtifacts.videoUrl,
      videoPath: artifacts.videoPath,
      traceUrl: uploadedArtifacts.traceUrl,
      tracePath: artifacts.tracePath,
    });

  } catch (error) {
    // Handle cancellation
    const isCancelled = error instanceof Error && error.message.includes('cancelled');
    if (isCancelled) {
      logger.info('[PLAYWRIGHT] Test was cancelled', {
        testId: testData.testId,
        browser: testData.browser,
        runKey,
      });

      // Mark as cancelled in registry (silences events)
      TestRunRegistry.setCancelled(runKey);

      // Stop video streaming on cancellation
      if (videoStreamService?.isActive()) {
        try {
          await videoStreamService.stop('cancelled');
          VideoStreamRegistry.unregister(runKey);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Collect artifacts and cleanup (best-effort)
      let artifacts: { videoPath?: string; tracePath?: string } = {};
      try {
        artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);
      } catch (cleanupError) {
        logger.warn('[PLAYWRIGHT] Failed to collect artifacts during cancellation cleanup', {
          testId: testData.testId,
          browser: testData.browser,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      // Upload artifacts (best-effort)
      const uploadedArtifacts = await uploadArtifacts(testData, artifacts.videoPath, artifacts.tracePath, [])
        .catch(() => ({ videoUrl: undefined, traceUrl: undefined }));

      // Unregister from TestRunRegistry
      TestRunRegistry.unregister(runKey);

      return {
        success: false,
        status: 'cancelled',
        logs: [],
        networkLogs: [],
        errors: [{
          type: 'cancelled',
          message: 'Test was cancelled by user',
          timestamp: new Date(),
        }],
        error: 'Test cancelled',
        videoUrl: uploadedArtifacts.videoUrl,
        videoPath: artifacts.videoPath,
        traceUrl: uploadedArtifacts.traceUrl,
        tracePath: artifacts.tracePath,
      };
    }

    // Handle failure
    logger.error('Playwright test failed', {
      testId: testData.testId,
      browser: testData.browser,
      runKey,
      error: error instanceof Error ? {
        message: error.message,
        name: error.name,
        stack: error.stack,
      } : String(error),
      url: testData.url,
      intelligentMode: testData.intelligentMode || false,
    });

    // Mark as completed in registry (silences events)
    TestRunRegistry.setCompleted(runKey);

    // Stop video streaming on error
    if (videoStreamService?.isActive()) {
      try {
        await videoStreamService.stop('error');
        VideoStreamRegistry.unregister(runKey);
      } catch {
        // Ignore cleanup errors
      }
    }

    // ✅ FIX: Collect data from page before cleanup (if page is available)
    // This ensures we save logs, screenshot, DOM even if test failed mid-execution
    const collectedData: {
      screenshot?: string;
      dom?: string;
      logs: string[];
      networkLogs: any[];
    } = {
      logs: [],
      networkLogs: [],
    };

    if (page && !page.isClosed()) {
      try {
        // Try to collect screenshot
        try {
          const screenshotBuffer = await page.screenshot({
            fullPage: false,
            type: 'png',
          }).catch(() => null);
          if (screenshotBuffer) {
            collectedData.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
            logger.debug('[PLAYWRIGHT] Captured screenshot on error', { testId: testData.testId });
          }
        } catch (screenshotError) {
          logger.debug('[PLAYWRIGHT] Failed to capture screenshot on error', {
            testId: testData.testId,
            error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
          });
        }

        // Try to collect DOM
        try {
          collectedData.dom = await page.content().catch(() => '');
          if (collectedData.dom) {
            logger.debug('[PLAYWRIGHT] Captured DOM on error', {
              testId: testData.testId,
              domLength: collectedData.dom.length,
            });
          }
        } catch (domError) {
          logger.debug('[PLAYWRIGHT] Failed to capture DOM on error', {
            testId: testData.testId,
            error: domError instanceof Error ? domError.message : String(domError),
          });
        }
      } catch (collectError) {
        logger.debug('[PLAYWRIGHT] Failed to collect data from page on error', {
          testId: testData.testId,
          error: collectError instanceof Error ? collectError.message : String(collectError),
        });
      }
    }

    // Collect artifacts and cleanup (best-effort)
    let artifacts: { videoPath?: string; tracePath?: string } = {};
    try {
      artifacts = await collectArtifactsAndCleanup(testData, context, page, tracePath);
    } catch (cleanupError) {
      logger.warn('[PLAYWRIGHT] Failed to collect artifacts during error cleanup', {
        testId: testData.testId,
        browser: testData.browser,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    // Upload artifacts (best-effort)
    const uploadedArtifacts = await uploadArtifacts(testData, artifacts.videoPath, artifacts.tracePath, [])
      .catch(() => ({ videoUrl: undefined, traceUrl: undefined }));

    // Unregister from TestRunRegistry
    TestRunRegistry.unregister(runKey);

    return {
      success: false,
      status: 'failed',
      screenshot: collectedData.screenshot,
      dom: collectedData.dom || '',
      logs: collectedData.logs,
      networkLogs: collectedData.networkLogs,
      errors: [{
        type: 'other',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date(),
      }],
      error: error instanceof Error ? error.message : 'Test execution failed',
      videoUrl: uploadedArtifacts.videoUrl,
      videoPath: artifacts.videoPath,
      traceUrl: uploadedArtifacts.traceUrl,
      tracePath: artifacts.tracePath,
    };
  }
}
