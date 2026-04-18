import { isDevelopment } from '@/config/environment/env';
import { COMMAND_EXECUTOR_CONFIG } from '@/config/testing/playwright-tuning';
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
import { uploadScreenshotBufferToStorage } from '@/services/storage/test-artifacts-storage.service';
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
import { ReplayTraceWriter } from './replay-trace-writer';
import { createRunKey, TestRunRegistry } from './test-run-registry';
import { TestExecutedStepsRedisService } from '@/services/testing/results/test-executed-steps-redis.service';
import { waitForStepReadiness, shouldSkipLookaheadAfter } from '@/services/testing/ui/preview/step-readiness.service';
import type { IntentStep, StepRuntimeMeta } from '@/services/testing/ui/preview/preview.types';
import { setupThirdPartyBlocker } from '../execution/third-party-blocker';
import {
  applyBindingsToContext,
  teardownAppliedResources,
  checkAndHealIfNeeded,
  NavigationStatusTracker,
  type ApplyResult,
} from '@/services/test-resource';
import { createCommandExecutorRecipeRunner } from '@/services/test-resource/runtime/recipe-executor';

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
  /** V14: URL to replay trace JSONL in Supabase Storage */
  replayTraceUrl?: string;
  error?: string;
  /** Step-level runtime metadata for reporting (keyed by stepId) */
  stepRuntimeMeta?: Record<string, any>;
  /** Non-UI quality checks: performance, broken resources, a11y, slow APIs */
  qualityChecks?: any;
  /** Flag: self-healing was triggered during replay, enable video on next retry */
  needsVideoOnRetry?: boolean;
  /** V16: Credits ran out during execution but run was allowed to complete */
  creditsExhausted?: boolean;
  /**
   * Snapshot of test_resources applied to this run (non-sensitive).
   * Mirrors ApplyResult.applied with heal_during_run flags flipped by
   * the supervisor. Caller writes this into test_executions.executed_resources
   * + regression_runs.executed_resources for reproducibility / audit.
   * Empty array = run did not bind any resources.
   */
  executedResources?: Array<{
    kind: string;
    resource_id: string;
    name: string;
    required: boolean;
    status_at_start: string;
    healed_during_run: boolean;
    apply_error?: string;
  }>;
}> {
  let page: Page | null = null;
  let context: BrowserContext | null = null;
  let tracePath: string | undefined;
  let videoStreamService: VideoStreamService | null = null;
  /** V14: Hoisted for access in outer catch — replay trace JSONL file path */
  let replayTraceFilePath: string | undefined;
  /**
   * Test-Resources binding snapshot. Populated right after context creation,
   * mutated by the supervisor if a heal happens mid-run, and finally
   * persisted into test_executions.executed_resources by the caller.
   * Kept at the top scope so the outer finally can teardown resources
   * even when a step throws.
   */
  let resourceApply: ApplyResult | null = null;

  // Snapshot projector — shared by every return path so the caller always
  // gets the final, heal-mutated state. Returns undefined when no bindings
  // were applied (saves JSONB roundtrip for untouched tests).
  const buildExecutedResourcesSnapshot = ():
    | Array<{
        kind: string;
        resource_id: string;
        name: string;
        required: boolean;
        status_at_start: string;
        healed_during_run: boolean;
        apply_error?: string;
      }>
    | undefined => {
    if (!resourceApply || resourceApply.applied.length === 0) return undefined;
    return resourceApply.applied.map((a) => ({
      kind: a.binding.kind,
      resource_id: a.binding.resource_id,
      name: a.name,
      required: a.binding.required,
      status_at_start: a.status_at_start,
      healed_during_run: a.healed_during_run,
      apply_error: a.apply_error,
    }));
  };

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
    // For replay mode: disable video + tracing on initial attempt (save RAM).
    // Both are enabled on retry attempts (attempt 1+) — the test already failed, we need artifacts for debugging.
    const isReplayMode = !testData.intelligentMode && testData.commands && testData.commands.length > 0;
    const retryAttempt = testData._retryAttempt ?? 0;
    const disableVideo = isReplayMode && retryAttempt === 0;
    const disableTracing = isReplayMode && retryAttempt === 0;
    const browser = await getBrowserWithProgress(testData);
    const setupResult = await setupBrowserContext(testData, browser, { disableVideo, disableTracing });
    context = setupResult.context;
    tracePath = setupResult.tracePath;

    page = await context.newPage();
    if (!page) {
      throw new Error('Failed to create page');
    }

    // Auto-dismiss blocking overlays (react-joyride tours, cookie banners,
    // intro.js / shepherd / driver.js). Playwright's addLocatorHandler fires
    // before every actionability check. Zero cost on clean pages.
    try {
      const { registerOverlayAutoDismiss } = await import('@/services/testing/ui/auto-dismiss-overlays');
      await registerOverlayAutoDismiss(page);
    } catch {
      // Non-fatal
    }

    // ✅ Block third-party requests (analytics, tracking, chat widgets)
    // This prevents Playwright's waitForNavigation/networkidle from waiting
    // for slow third-party services (Intercom, Google Analytics, etc.)
    try {
      const blocker = await setupThirdPartyBlocker(page);
      // Cleanup will happen when page/context closes; log stats at the end
      page.on('close', async () => {
        const stats = blocker.getStats();
        if (stats.totalBlocked > 0) {
          logger.info('[PLAYWRIGHT] Third-party blocker stats', {
            testId: testData.testId,
            totalBlocked: stats.totalBlocked,
            topDomains: Array.from(stats.blockedByDomain.entries())
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([domain, count]) => `${domain}:${count}`),
          });
        }
      });
    } catch (blockerError) {
      // Non-fatal: test should still work without blocking
      logger.warn('[PLAYWRIGHT] Failed to setup third-party blocker', {
        testId: testData.testId,
        error: blockerError instanceof Error ? blockerError.message : String(blockerError),
      });
    }

    // Register test run in global registry for abort capability
    TestRunRegistry.register(runKey, testData.testId, testData.browser, {
      context,
      page,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Test Resources — apply bindings (Login, Environment, Secret, ...) to
    // the browser context BEFORE the first navigation. This is what makes
    // a test start already-authenticated: cookies + localStorage injected
    // here survive the upcoming page.goto().
    //
    // Order matters:
    //   1. Context created (above)   — empty session
    //   2. Resources applied (here)  — inject session/env/secrets
    //   3. navigateToUrl (below)     — first request carries cookies
    //
    // Missing/stale resources are healed under a per-resource mutex so
    // 10 parallel tests that all use "Admin login" share ONE heal. The
    // supervisor hook is wired inside LiteEngine per-step; here we only
    // do the pre-run apply.
    // ═══════════════════════════════════════════════════════════════════════
    if (testData.resourceBindings && testData.resourceBindings.length > 0) {
      try {
        resourceApply = await applyBindingsToContext({
          userId: testData.userId ?? '',
          projectId: testData.projectId,
          context,
          page,
          bindings: testData.resourceBindings,
          // Pre-run heal path: the supervisor isn't wired yet (no step
          // loop running). For the MVP we let stale auth resources fall
          // through to markBroken rather than replay a recipe with no
          // executor — the supervisor between steps will heal on the
          // first live loss anyway.
        });
        logger.info('[PLAYWRIGHT] Test resources applied', {
          testId: testData.testId,
          applied: resourceApply.applied.length,
          skipped: resourceApply.skipped.length,
        });
      } catch (resErr) {
        // Hard-fail: a `required: true` binding couldn't be applied.
        // Better to surface immediately than have a test fail
        // mysteriously on step 1.
        logger.error('[PLAYWRIGHT] Required resource binding failed', {
          testId: testData.testId,
          error: resErr instanceof Error ? resErr.message : String(resErr),
        });
        throw resErr;
      }
    }

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
      // Attempt number — frontend uses it to reset the live step list
      // when a retry starts (so retries don't look like step cycles).
      attempt: retryAttempt,
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

      // Resolve workspaceId for AI usage tracking (self-healing may use AI)
      const workspaceId = await resolveWorkspaceFromProject(testData.projectId);

      // Import CommandExecutor
      const { CommandExecutor } = await import('@/agent/execution/command-executor');

      // Import ErrorCollectorService for background monitoring
      const { ErrorCollectorService } = await import('@/agent/utils/analysis/error-collector.service');

      // Create executor with self-healing enabled (for AI fallback without clarification)
      // On retry attempts: skip compiled plan (Stage 1) and go straight to LLM resolver (Stage 2)
      const { MAX_NODES_REPLAY } = await import('@/agent/execution/background-dom-collector');
      // Initialize replay trace writer (JSONL log per run)
      const replayTrace = new ReplayTraceWriter({ testId: testData.testId });
      replayTraceFilePath = replayTrace.getFilePath();

      const executor = new CommandExecutor(page, {
        selfHealingEnabled: true,
        skipCompiledPlan: retryAttempt > 0,
        maxDomNodes: MAX_NODES_REPLAY,
        metadata: {
          url: testData.url,
          projectId: testData.projectId,
          userId: testData.userId,
        },
        replayTrace,  // V14: Pass trace writer for detailed local logging
        totalSteps: testData.commands.length,
      });

      // Start error collection for background monitoring
      const errorCollector = new ErrorCollectorService(page);
      errorCollector.startCollecting();

      // Begin AI usage tracking session for background replay
      // Self-healing may trigger AI calls (OpenAI/Gemini) that need to be tracked
      // Use testId as sessionId so AIUsageTracker.record() can match via getAIContext().testId
      const replaySessionId = testData.testId;
      AIUsageTracker.beginSession(replaySessionId, {
        workspaceId,
        testId: testData.testId,
        userId: testData.userId,
        operationType: 'regression',
      });

      logger.info('[PLAYWRIGHT] Started error collection for background replay', {
        testId: testData.testId,
      });

      // Log run_start to replay trace
      replayTrace.write({
        eventType: 'run_start', step: 0, totalSteps: testData.commands.length,
        payload: {
          url: testData.url, browser: testData.browser,
          commandsCount: testData.commands.length, intelligentMode: false,
          userId: testData.userId, projectId: testData.projectId,
          // Retry context — essential for distinguishing first attempt from
          // auto-healing re-runs when parsing a trace later.
          retryAttempt,
          isFirstAttempt: retryAttempt === 0,
          skipCompiledPlan: retryAttempt > 0,
          videoDisabled: disableVideo,
          tracingDisabled: disableTracing,
          chatSessionId: testData.chatSessionId,
        },
      });

      // Execute commands step-by-step (wrapped in AI context for self-healing token tracking)
      // Capture narrowed references before entering withAIContext callback
      const commands = testData.commands;
      let activePage = page!;
      let currentStepIndex = 0;
      let needsVideoOnRetry = false; // Set to true if self-healing triggers
      const totalSteps = commands.length;
      let allSuccess = true;
      let finalError: string | undefined;
      let creditsExhausted = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let replayUsageStats: any = null;
      await withAIContext(
        {
          workspaceId,
          testId: testData.testId,
          userId: testData.userId,
          operationType: 'regression',
        },
        async () => {

      // Cascading failure detection — stop early if N consecutive steps fail
      let consecutiveFailures = 0;

      // ═══════════════════════════════════════════════════════════════════
      // Supervisor wiring — auth-loss detection between steps.
      //
      // The tracker attaches ONE page.on('response') listener that remembers
      // the last navigation status (401/403 = strong auth-loss signal).
      // checkAndHealIfNeeded combines that with a URL pattern + password-
      // input probe, then replays the recipe under a per-resource mutex
      // if all signals agree. Healthy runs pay nothing more than a URL
      // regex test per step.
      //
      // Only auth kind can heal today; the supervisor is a no-op if no
      // auth binding was resolved. Leaves the door open for environment/
      // oauth_token heals later (same interface).
      // ═══════════════════════════════════════════════════════════════════
      // Page and context are non-null here — we're inside the
      // Background-Replay block which runs AFTER setupBrowserContext() +
      // context.newPage(). Non-null assertions match the pattern used
      // elsewhere in this function (see `let activePage = page!` below).
      const navTracker = new NavigationStatusTracker();
      navTracker.attach(page!);
      const authResource = resourceApply
        ? Array.from(resourceApply.resources.values()).find((r) => r.kind === 'auth')
        : undefined;
      const recipeRunner = createCommandExecutorRecipeRunner();

      try {
        for (const command of commands) {
          currentStepIndex++;

          // ── Check for auth loss BEFORE each step. Healthy → no-op.
          //    On heal success, retry is implicit — the same command
          //    will now run against the re-authenticated session. No
          //    explicit retry-count here: heal itself is idempotent and
          //    the per-resource mutex prevents thundering herd.
          if (authResource && resourceApply) {
            try {
              const healed = await checkAndHealIfNeeded(
                {
                  userId: testData.userId ?? '',
                  projectId: testData.projectId,
                  page: page!,
                  context: context!,
                  authResource,
                  recipeExecutor: recipeRunner,
                  appliedSnapshot: resourceApply.applied,
                },
                navTracker,
              );
              if (healed) {
                logger.info('[PLAYWRIGHT] Auth healed mid-run — continuing', {
                  testId: testData.testId,
                  stepIndex: currentStepIndex,
                  resourceId: authResource.id,
                });
              }
            } catch (healErr) {
              // Heal failure is fatal — the session is gone and we can't
              // get it back. Fail the test with a clear reason; outer
              // handler will mark the run as failed.
              const reason = healErr instanceof Error ? healErr.message : String(healErr);
              logger.error('[PLAYWRIGHT] Auth heal failed mid-run', {
                testId: testData.testId,
                stepIndex: currentStepIndex,
                error: reason,
              });
              throw new Error(`Session lost and could not be restored: ${reason}`);
            }
          }

          // Check cascading failure threshold before executing next step
          if (consecutiveFailures >= COMMAND_EXECUTOR_CONFIG.maxConsecutiveFailuresBeforeTermination) {
            logger.warn('[PLAYWRIGHT] Cascading failure detected — terminating early', {
              testId: testData.testId,
              consecutiveFailures,
              stoppedAtStep: currentStepIndex,
              remainingSteps: commands.length - currentStepIndex + 1,
            });
            // Explicit trace event — otherwise the run_end alone doesn't tell
            // you at which step the chain broke, or how many steps were left.
            replayTrace.write({
              eventType: 'cascading_failure', step: currentStepIndex, totalSteps,
              payload: {
                consecutiveFailures,
                threshold: COMMAND_EXECUTOR_CONFIG.maxConsecutiveFailuresBeforeTermination,
                stoppedAtStep: currentStepIndex,
                remainingSteps: commands.length - currentStepIndex + 1,
              },
            });
            allSuccess = false;
            finalError = `Cascading failure: ${consecutiveFailures} consecutive steps failed`;
            break;
          }

          const action = (command as any).action ?? (command as any).type ?? 'action';
          const intentMeta = (command as any).intentMeta as undefined | { elementDescription?: string; stepId?: string };

          // Capture URL before step — used by lookahead to detect SPA navigation
          const urlBeforeStep = activePage.url();

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
              attempt: retryAttempt,
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
            currentUrl: activePage.url(),
            expectedUrl: (command as any).intentMeta?.compiled?.context?.pageUrl,
            continueOnError: (command as any).continueOnError || undefined,
          });

          // Log step_start to replay trace
          replayTrace.write({
            eventType: 'step_start', step: currentStepIndex, totalSteps,
            payload: {
              action,
              selector: (command as any).selector,
              description: intentMeta?.elementDescription,
              compiledStrategies: (command as any).intentMeta?.compiled?.locatorPlan?.map((l: any) => l.strategy),
              hasBindingHints: !!(command as any).intentMeta?.bindingHints,
            },
          });

          // ── Scratchpad: store meta-step (no Playwright action, no credit cost) ──
          const intentActionType = (command as any).intentMeta?.actionType || (command as any).intentMeta?.type;
          if (intentActionType === 'store') {
            const storeKey = (command as any).intentMeta?.elementDescription || (command as any).intentMeta?.description;
            const storeValue = (command as any).value || (command as any).intentMeta?.value;
            if (storeKey && storeValue) {
              executor.setExtractedData(storeKey, storeValue);
            }
            // Emit step_completed for symmetry — otherwise scratchpad-only
            // steps would look like "step_start with no matching end" in the
            // trace. `action: 'store'` is enough to tell readers this is a
            // meta-step (no Playwright call, no credits).
            replayTrace.write({
              eventType: 'step_completed', step: currentStepIndex, totalSteps,
              payload: {
                action: 'store',
                success: true,
                durationMs: 0,
                description: intentMeta?.elementDescription,
                scratchpadKey: storeKey,
                scratchpadHasValue: !!storeValue,
              },
            });
            continue; // Skip Playwright execution and credit deduction — purely data storage
          }

          // Deduct 1 credit for step execution.
          // V16: When credits run out mid-run, log warning but continue execution.
          // Stopping mid-run wastes the work already done and confuses users.
          // The run completes, and the frontend shows a "credits exhausted" banner.
          if (testData.userId && !creditsExhausted) {
            const stepCreditResult = await CreditCostTrackerService.deductStepCredit(
              testData.userId,
              testData.testId,
              `Step ${currentStepIndex}/${totalSteps}: ${action}`
            );
            if (!stepCreditResult.success) {
              creditsExhausted = true;
              logger.warn('[PLAYWRIGHT] Credits exhausted mid-run, continuing without deduction', {
                testId: testData.testId,
                stepIndex: currentStepIndex,
                remainingSteps: totalSteps - currentStepIndex,
              });
            }
          }

          // Capture step start time for error correlation
          const stepStartedAt = Date.now();

          try {
            // ── Scratchpad: interpolate {{key}} placeholders from extractedData ──
            const scratchpadData = executor.getExtractedData();
            if (scratchpadData.size > 0) {
              const resolveVars = (s: string) => s.replace(/\{\{([\w.-]+)\}\}/g, (m, k) => {
                const v = scratchpadData.get(k);
                return typeof v === 'string' ? v : (v != null ? String(v) : m);
              });
              if ((command as any).value) (command as any).value = resolveVars((command as any).value);
              if ((command as any).assertionText) (command as any).assertionText = resolveVars((command as any).assertionText);
              if ((command as any).url) (command as any).url = resolveVars((command as any).url);
              // Also resolve in intentMeta fields (for intent-based commands)
              if ((command as any).intentMeta?.value) (command as any).intentMeta.value = resolveVars((command as any).intentMeta.value);
            }

            // Execute command via CommandExecutor
            // This supports compiled plans, self-healing, AI fallback (no clarification in background)
            const stepResult = await executor.executeCommand(command);

            // Sync activePage — CommandExecutor may have switched to a new tab after click
            const executorPage = executor.getActivePage();
            if (executorPage !== activePage) {
              logger.info('[PLAYWRIGHT] Active page changed (new tab detected)', {
                testId: testData.testId,
                oldUrl: activePage.url(),
                newUrl: executorPage.url(),
              });
              activePage = executorPage;
              // Re-attach error collector to new page
              errorCollector.switchPage(activePage);
            }

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
              const bugScreenshotUrl = await captureBugScreenshot(activePage, testData, currentStepIndex, 'backend-failure');

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

              // Write step_failed to replay trace (matches Case D + catch path).
              // Without this, silent-backend failures did not appear in the
              // JSONL trace even though they terminate the run.
              replayTrace.write({
                eventType: 'step_failed', step: currentStepIndex, totalSteps,
                payload: {
                  action, success: false, durationMs: Date.now() - stepStartedAt,
                  error: finalError,
                  rootCause: 'backend',
                  failedReason: 'silent_backend_failure',
                  networkEvidence: networkVerdict.fatalErrors,
                  description: intentMeta?.elementDescription,
                  url: activePage.url(),
                  bugScreenshotUrl,
                  errors: {
                    console: updatedStepErrors.consoleErrors.length,
                    network: updatedStepErrors.networkErrors.length,
                    ui: updatedStepErrors.uiErrors.length,
                  },
                },
              });

              try {
                webSocketService.emitTestStepCompleted(testData.testId, {
                  testId: testData.testId,
                  browser: testData.browser,
                  step: currentStepIndex,
                  // Attempt number (0 = first run, 1+ = retries). Frontend uses
                  // (attempt, step) as dedup key and resets the step list when
                  // attempt changes, so retries don't look like mysterious cycles.
                  attempt: retryAttempt,
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

            // ═══════════════════════════════════════════════════════════════
            // Case D: 4xx validation error — expected (negative test) vs unexpected (regression)
            // V11: Distinguishes intentional negative tests from real backend regressions.
            // ═══════════════════════════════════════════════════════════════
            const validation4xxErrors = stepErrors.networkErrors.filter(e => {
              const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(e.method);
              const is4xx = typeof e.status === 'number' && e.status >= 400 && e.status < 500;
              return isMutating && is4xx && isSameOriginUrl(e.url, testData.url);
            });

            if (validation4xxErrors.length > 0) {
              // V11: Await async body capture promises before reading responseBody/fieldErrors
              const bodyPromises = validation4xxErrors
                .map(e => e._bodyPromise)
                .filter((p): p is Promise<void> => !!p);
              if (bodyPromises.length > 0) {
                await Promise.race([
                  Promise.allSettled(bodyPromises),
                  new Promise(resolve => setTimeout(resolve, 2000)), // 2s timeout to avoid hanging
                ]);
              }

              // Always scan UI for error toasts/banners when 4xx detected
              try { await errorCollector.collectUIErrors(); } catch { /* non-fatal */ }
              const updatedStepErrors = errorCollector.getErrorsSince(stepStartedAt);

              const expectedOutcome = (command as any).intentMeta?.expectedOutcome || 'success';
              const first4xx = validation4xxErrors[0];

              if (expectedOutcome === 'error') {
                // ✅ Negative test passed — 4xx is expected behavior
                logger.info('[PLAYWRIGHT] Expected validation error (negative test passed)', {
                  testId: testData.testId,
                  stepIndex: currentStepIndex,
                  stepDescription: intentMeta?.elementDescription || action,
                  status: first4xx.status,
                  url: first4xx.url,
                });

                // Enrich runtimeMeta with expected_error verdict but DON'T fail
                if (stepResult.runtimeMeta) {
                  (stepResult.runtimeMeta as any).networkVerdict = 'expected_error';
                  (stepResult.runtimeMeta as any).networkEvidence = validation4xxErrors.map(e => ({
                    method: e.method, url: e.url, status: e.status, error: e.error,
                  }));
                }

                replayTrace.write({
                  eventType: 'step_note', step: currentStepIndex, totalSteps,
                  payload: {
                    note: 'negative_test_passed',
                    expectedOutcome: 'error',
                    validation4xx: validation4xxErrors.map(e => ({
                      method: e.method, url: e.url, status: e.status,
                    })),
                  },
                });
                // Continue to next step — step is a PASS
              } else {
                // 🚨 Unexpected 4xx — regression bug detected
                // (stepDescription declared in outer scope at line ~476 — same value, no shadow needed)
                logger.warn('[PLAYWRIGHT] Unexpected validation error detected (regression)', {
                  testId: testData.testId,
                  stepIndex: currentStepIndex,
                  stepDescription,
                  status: first4xx.status,
                  url: first4xx.url,
                  responseBody: first4xx.responseBody,
                  fieldErrors: first4xx.fieldErrors,
                  uiErrors: updatedStepErrors.uiErrors.length,
                });

                allSuccess = false;
                finalError = `Unexpected validation error: ${first4xx.method} ${first4xx.url} → HTTP ${first4xx.status}`;

                const bugScreenshotUrl = await captureBugScreenshot(
                  activePage, testData, currentStepIndex, 'validation-error'
                );

                const enrichedMeta: NonNullable<TestStepCompletedPayload['runtimeMeta']> = {
                  stepId: intentMeta?.stepId,
                  ...(stepResult.runtimeMeta || {}),
                  runtimeStatus: 'failed' as const,
                  failedReason: 'unexpected_validation_error' as const,
                  failureExplanation: `Step "${stepDescription}" triggered ${first4xx.status} on ${first4xx.method} ${first4xx.url}. ${
                    first4xx.fieldErrors?.length
                      ? `Field errors: ${first4xx.fieldErrors.map(fe => `${fe.field}: ${fe.message}`).join(', ').slice(0, 200)}`
                      : first4xx.responseBody
                        ? JSON.stringify(first4xx.responseBody).slice(0, 200)
                        : first4xx.error
                  }`,
                  rootCause: 'backend' as const,
                  networkVerdict: 'validation_failure' as const,
                  networkEvidence: validation4xxErrors.map(e => ({
                    method: e.method, url: e.url, status: e.status, error: e.error,
                  })),
                  stepErrors: {
                    console: updatedStepErrors.consoleErrors.length,
                    network: updatedStepErrors.networkErrors.length,
                    ui: updatedStepErrors.uiErrors.length,
                  },
                  bugScreenshotUrl,
                };

                // V11: Write step_failed to replay trace (matches Case C + element-not-found path)
                replayTrace.write({
                  eventType: 'step_failed', step: currentStepIndex, totalSteps,
                  payload: {
                    action, success: false, durationMs: Date.now() - stepStartedAt,
                    error: finalError,
                    rootCause: 'backend',
                    failedReason: 'unexpected_validation_error',
                    networkEvidence: validation4xxErrors.map(e => ({
                      method: e.method, url: e.url, status: e.status,
                    })),
                    errors: {
                      console: updatedStepErrors.consoleErrors.length,
                      network: updatedStepErrors.networkErrors.length,
                      ui: updatedStepErrors.uiErrors.length,
                    },
                  },
                });

                try {
                  webSocketService.emitTestStepCompleted(testData.testId, {
                    testId: testData.testId,
                    browser: testData.browser,
                    step: currentStepIndex,
                    attempt: retryAttempt,
                    stepDescription,
                    success: false,
                    timestamp: new Date().toISOString(),
                    runtimeMeta: enrichedMeta,
                  });
                } catch (wsError) {
                  logger.warn('[PLAYWRIGHT] WebSocket emit failed (step:completed/validation-fail)', {
                    testId: testData.testId, step: currentStepIndex,
                    error: wsError instanceof Error ? wsError.message : String(wsError),
                  });
                }

                // Stop on first failure
                break;
              }
            }

            // Soft failure: continueOnError step returned success=false without throwing
            const isSoftFailure = !stepResult.success && (command as any).continueOnError;

            const stepDurationMs = Date.now() - stepStartedAt;
            const meta = stepResult.runtimeMeta;

            // Cascading failure tracking
            if (stepResult.success || meta?.source === 'self_heal') {
              consecutiveFailures = 0; // Reset on success or healed step
            } else if (isSoftFailure) {
              consecutiveFailures++; // Soft failures count toward cascading
            }
            logger.info(`[PLAYWRIGHT] Replay step ${isSoftFailure ? 'soft-failed (continueOnError)' : 'completed'}`, {
              testId: testData.testId,
              step: `${currentStepIndex}/${totalSteps}`,
              action,
              description: intentMeta?.elementDescription,
              durationMs: stepDurationMs,
              success: stepResult.success,
              softFailure: isSoftFailure || undefined,
              softFailureError: isSoftFailure ? stepResult.error : undefined,
              source: meta?.source,
              resolutionPath: meta?.resolutionPath,
              confidence: meta?.confidenceTier,
              healed: meta?.source === 'self_heal',
              healConfidence: meta?.healConfidence,
              usedStrategy: meta?.usedLocatorStrategy,
              autoWait: meta?.autoWaitApplied ? `${meta.autoWaitMs}ms` : undefined,
              currentUrl: isSoftFailure ? activePage.url() : undefined,
              errors: {
                console: stepErrors.consoleErrors.length,
                network: stepErrors.networkErrors.length,
                ui: stepErrors.uiErrors.length,
              },
            });

            // Track if self-healing was triggered — enable video on next retry
            if (meta?.source === 'self_heal' || meta?.resolutionPath === 'self_heal') {
              needsVideoOnRetry = true;
            }

            // Log step_completed to replay trace
            replayTrace.write({
              eventType: isSoftFailure ? 'step_soft_failed' : 'step_completed', step: currentStepIndex, totalSteps,
              payload: {
                action, success: stepResult.success, durationMs: stepDurationMs,
                description: intentMeta?.elementDescription,
                url: activePage.url(),
                softFailure: isSoftFailure || undefined,
                softFailureError: isSoftFailure ? stepResult.error : undefined,
                source: meta?.source, resolutionPath: meta?.resolutionPath,
                usedStrategy: meta?.usedLocatorStrategy, confidence: meta?.confidenceTier,
                healed: meta?.source === 'self_heal', healConfidence: meta?.healConfidence,
                retryAttempts: meta?.retryAttempts,
                readinessTrace: meta?.readinessTrace,
                blockerDiagnosis: meta?.blockerDiagnosis,
                errors: {
                  console: stepErrors.consoleErrors.length,
                  network: stepErrors.networkErrors.length,
                  ui: stepErrors.uiErrors.length,
                },
              },
            });

            // Emit test:step:completed (non-fatal)
            try {
              webSocketService.emitTestStepCompleted(testData.testId, {
                testId: testData.testId,
                browser: testData.browser,
                step: currentStepIndex,
                attempt: retryAttempt,
                stepDescription,
                success: stepResult.success,
                // V16: Surface soft failure so frontend can show warning instead of error
                ...(isSoftFailure ? { softFailure: true, softFailureError: stepResult.error } : {}),
                timestamp: new Date().toISOString(),
                runtimeMeta: stepResult.runtimeMeta,
              });
            } catch (wsError) {
              logger.warn('[PLAYWRIGHT] WebSocket emit failed (step:completed)', {
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
                await captureBugScreenshot(activePage, testData, currentStepIndex, 'ui-error');
              }
            } catch (uiErrorCollectionError) {
              // Non-fatal - log and continue
              logger.debug('[PLAYWRIGHT] Failed to collect UI errors', {
                testId: testData.testId,
                stepIndex: currentStepIndex,
                error: uiErrorCollectionError instanceof Error ? uiErrorCollectionError.message : String(uiErrorCollectionError),
              });
            }

            // V15.7: Post-action 1s safety buffer moved to command-executor.ts
            // (inside executeCommand), so all consumers of CommandExecutor —
            // test-executor, lite pipeline, intelligent orchestrator — inherit
            // it automatically. No need to duplicate here.

            // Auto-waiting (lookahead) for next step's readiness
            const nextCommand = commands[currentStepIndex]; // currentStepIndex is 1-based, array is 0-based
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

                  const lookahead = await waitForStepReadiness(activePage, nextStepForLookahead, {
                    maxWaitMs: typeof nextIntentMeta.lookaheadTimeoutMs === 'number' ? nextIntentMeta.lookaheadTimeoutMs : 10000,
                    settleMs: 3000,
                    autoWaitThresholdMs: 2000,
                    // Pass context for SPA navigation detection + dynamic DOM stability threshold
                    prevActionType,
                    prevUrl: urlBeforeStep,
                    recordedDelayMs: nextIntentMeta.evidence?.interStepDelayMs,
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

                  // V14: Trace readiness check details to local JSONL
                  replayTrace.write({
                    eventType: 'step_readiness', step: currentStepIndex + 1, totalSteps,
                    payload: {
                      autoWaitApplied: lookahead.autoWaitApplied,
                      waitedMs: lookahead.waited,
                      skipReason: lookahead.skipReason,
                      readinessChecks: lookahead.readinessChecks,
                      prevAction: prevActionType,
                      urlChanged: lookahead.urlChanged,
                    },
                  });
                } catch (lookaheadError) {
                  // Lookahead failure is non-fatal, log and continue.
                  const lookaheadErrMsg =
                    lookaheadError instanceof Error ? lookaheadError.message : String(lookaheadError);
                  logger.warn('[PLAYWRIGHT] Lookahead wait failed, continuing', {
                    testId: testData.testId,
                    nextStep: currentStepIndex + 1,
                    error: lookaheadErrMsg,
                  });
                  // Still trace it — otherwise readiness failures that mask
                  // downstream step failures become invisible in the JSONL.
                  replayTrace.write({
                    eventType: 'lookahead_failed', step: currentStepIndex + 1, totalSteps,
                    payload: {
                      prevAction: prevActionType,
                      error: lookaheadErrMsg,
                    },
                  });
                }
              }
            }
          } catch (stepError) {
            allSuccess = false;
            consecutiveFailures++;
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

            // Any step failure means we need video on retry for debugging
            needsVideoOnRetry = true;

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
            const bugScreenshotUrl = await captureBugScreenshot(activePage, testData, currentStepIndex, 'step-failure');
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

            // Log step_failed to replay trace
            replayTrace.write({
              eventType: 'step_failed', step: currentStepIndex, totalSteps,
              payload: {
                action, success: false, durationMs: failDurationMs,
                error: finalError, rootCause: finalMeta.rootCause,
                failedReason: finalMeta.failedReason,
                source: baseMeta.source, resolutionPath: baseMeta.resolutionPath,
                url: activePage.url(),
                description: intentMeta?.elementDescription,
                compiledStrategies: (command as any).intentMeta?.compiled?.locatorPlan?.map((l: any) => l.strategy),
                bindingHints: (command as any).intentMeta?.bindingHints,
                networkEvidence: finalMeta.networkEvidence,
                errors: {
                  console: stepErrors.consoleErrors.length,
                  network: stepErrors.networkErrors.length,
                  ui: stepErrors.uiErrors.length,
                },
              },
            });

            // Emit test:step:completed with failure (non-fatal)
            try {
              webSocketService.emitTestStepCompleted(testData.testId, {
                testId: testData.testId,
                browser: testData.browser,
                step: currentStepIndex,
                attempt: retryAttempt,
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
        // End AI usage tracking session (even on error)
        replayUsageStats = await AIUsageTracker.endSession(replaySessionId);

        // Log run_end to replay trace
        replayTrace.write({
          eventType: 'run_end', step: currentStepIndex, totalSteps,
          payload: {
            success: allSuccess, executedSteps: currentStepIndex,
            finalError, aiUsage: replayUsageStats,
            // Retry + self-heal signals — lets a replay trace explain itself
            // without having to cross-reference the job row.
            retryAttempt,
            needsVideoOnRetry,
            consecutiveFailures,
            terminatedEarly:
              consecutiveFailures >= COMMAND_EXECUTOR_CONFIG.maxConsecutiveFailuresBeforeTermination,
          },
        });
        await replayTrace.close();

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
          await cleanupTemporaryRefs(activePage);
        } catch {
          // Non-fatal: page may already be closed
        }
      }

      }, // end withAIContext callback
      ); // end withAIContext

      if (replayUsageStats) {
        logger.info('[PLAYWRIGHT] Background Replay AI usage stats', {
          testId: testData.testId,
          aiCallCount: replayUsageStats.aiCallCount,
          totalTokens: replayUsageStats.totalTokens,
          totalCostUSD: replayUsageStats.totalCostUSD.toFixed(6),
        });
      }

      // Collect artifacts and return
      const finalScreenshotBuffer = await page.screenshot({ type: 'png', fullPage: true, timeout: 5000 }).catch(() => null);

      // Upload screenshot to storage as PNG (same as Lite/Pro modes)
      let finalScreenshotUrl: string | undefined;
      if (finalScreenshotBuffer && !isDevelopment) {
        try {
          finalScreenshotUrl = await uploadScreenshotBufferToStorage(
            finalScreenshotBuffer,
            testData.testId,
            testData.userId || 'anonymous',
            0,
          );
        } catch (screenshotUploadError) {
          logger.debug('[PLAYWRIGHT] Failed to upload final screenshot in replay mode', {
            testId: testData.testId,
            error: screenshotUploadError instanceof Error ? screenshotUploadError.message : String(screenshotUploadError),
          });
        }
      }
      
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
          attempt: retryAttempt,
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
          attempt: retryAttempt,
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
          attempt: retryAttempt,
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
      // Errors: only real errors (console, network, UI). Accessibility warnings are separate.
      const errors: any[] = [
        ...collectedErrors.consoleErrors.map(e => ({ type: 'console', message: e.message, timestamp: e.timestamp, source: e.source, line: e.line })),
        ...collectedErrors.networkErrors.map(e => ({ type: 'network', message: `${e.method} ${e.url}: ${e.error}`, timestamp: e.timestamp, url: e.url, method: e.method, status: e.status })),
        ...collectedErrors.uiErrors.map(e => ({ type: 'ui', message: e.text, timestamp: e.timestamp, selector: e.selector })),
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
          attempt: retryAttempt,
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

      // Upload video/trace to storage (same as Lite/Pro modes)
      const uploadedArtifacts = await uploadArtifacts(
        testData,
        artifacts.videoPath,
        artifacts.tracePath,
      ).catch((uploadError) => {
        logger.debug('[PLAYWRIGHT] Failed to upload artifacts in replay mode', {
          testId: testData.testId,
          browser: testData.browser,
          error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        });
        return { videoUrl: undefined, traceUrl: undefined };
      });

      // V14: Upload replay trace JSONL to Supabase Storage (non-fatal).
      // `replayTraceUrl` now carries the opaque storage_path (private bucket,
      // signed URL resolved at read time via the trace_files row).
      let replayTraceUrl: string | undefined;
      if (!isDevelopment) {
        try {
          const traceFilePath = replayTrace.getFilePath();
          const { uploadReplayTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');
          const uploadResult = await uploadReplayTraceToStorage(
            traceFilePath,
            testData.testId,
            testData.userId || 'anonymous',
          );
          replayTraceUrl = uploadResult.storagePath;
          logger.info('[PLAYWRIGHT] Replay trace JSONL uploaded to storage', {
            testId: testData.testId,
            storagePath: uploadResult.storagePath,
            traceFileId: uploadResult.traceFileId,
          });
        } catch (traceUploadError) {
          logger.debug('[PLAYWRIGHT] Failed to upload replay trace JSONL', {
            testId: testData.testId,
            error: traceUploadError instanceof Error ? traceUploadError.message : String(traceUploadError),
          });
        }
      }

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
        screenshot: finalScreenshotUrl ?? undefined,
        logs,
        networkLogs,
        errors,
        performance: performanceMetrics, // Web Vitals — stored in test_results.performance
        error: allSuccess ? undefined : finalError,
        videoUrl: uploadedArtifacts.videoUrl,
        videoPath: artifacts.videoPath,
        traceUrl: uploadedArtifacts.traceUrl,
        tracePath: artifacts.tracePath,
        replayTraceUrl, // V14: Replay trace JSONL URL for debugging
        stepRuntimeMeta, // Step-level execution intelligence for reporting
        qualityChecks, // Non-UI quality checks — stored in test_results for user viewing
        needsVideoOnRetry, // Flag: self-healing was triggered, enable video on next retry
        creditsExhausted, // V16: Credits ran out mid-run but execution continued
        executedResources: buildExecutedResourcesSnapshot(),
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

    // Teardown applied resources BEFORE context is closed by artifact
    // cleanup. Adapters that own external state (e.g. data_fixture API
    // cleanup, file download deletion) need the context live.
    if (resourceApply && context && page) {
      try {
        await teardownAppliedResources({
          userId: testData.userId ?? '',
          projectId: testData.projectId,
          page,
          context,
          resources: resourceApply.resources,
          runVariables: resourceApply.runVariables,
        });
      } catch (trErr) {
        logger.debug('[PLAYWRIGHT] Resource teardown failed (non-fatal)', {
          testId: testData.testId,
          error: trErr instanceof Error ? trErr.message : String(trErr),
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

    // Format and return result. Spread the resource snapshot on top so
    // callers (regression-run, completion-handler) can persist the
    // executed_resources column without needing to know which code path
    // produced the result.
    return {
      ...formatTestResult(intelligentResult, {
        videoUrl: uploadedArtifacts.videoUrl,
        videoPath: artifacts.videoPath,
        traceUrl: uploadedArtifacts.traceUrl,
        tracePath: artifacts.tracePath,
      }),
      executedResources: buildExecutedResourcesSnapshot(),
    };

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

      // V14: Upload replay trace JSONL (best-effort, even on cancellation).
      // Stores the opaque storage_path — readers resolve a signed URL via the
      // trace_files row created on the same call.
      let cancelledReplayTraceUrl: string | undefined;
      if (replayTraceFilePath && !isDevelopment) {
        try {
          const { uploadReplayTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');
          const uploadResult = await uploadReplayTraceToStorage(
            replayTraceFilePath, testData.testId, testData.userId || 'anonymous',
          );
          cancelledReplayTraceUrl = uploadResult.storagePath;
        } catch { /* non-fatal */ }
      }

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
        replayTraceUrl: cancelledReplayTraceUrl,
        creditsExhausted: false,
        executedResources: buildExecutedResourcesSnapshot(),
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

    // Teardown applied resources BEFORE context is closed (error path).
    if (resourceApply && context && page) {
      try {
        await teardownAppliedResources({
          userId: testData.userId ?? '',
          projectId: testData.projectId,
          page,
          context,
          resources: resourceApply.resources,
          runVariables: resourceApply.runVariables,
        });
      } catch (trErr) {
        logger.debug('[PLAYWRIGHT] Resource teardown failed during error cleanup', {
          testId: testData.testId,
          error: trErr instanceof Error ? trErr.message : String(trErr),
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

    // V14: Upload replay trace JSONL (best-effort, even on crash).
    // Stores the opaque storage_path — readers resolve a signed URL via the
    // trace_files row created on the same call.
    let failedReplayTraceUrl: string | undefined;
    if (replayTraceFilePath && !isDevelopment) {
      try {
        const { uploadReplayTraceToStorage } = await import('@/services/storage/test-artifacts-storage.service');
        const uploadResult = await uploadReplayTraceToStorage(
          replayTraceFilePath, testData.testId, testData.userId || 'anonymous',
        );
        failedReplayTraceUrl = uploadResult.storagePath;
      } catch { /* non-fatal */ }
    }

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
      replayTraceUrl: failedReplayTraceUrl,
      creditsExhausted: false,
      executedResources: buildExecutedResourcesSnapshot(),
    };
  }
}
