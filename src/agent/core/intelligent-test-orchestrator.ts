/**
 * IntelligentTestOrchestrator
 * Main orchestration loop for intelligent testing
 * Manages: analyze → understand → generate → execute → validate → decide → repeat
 */

import { dbAdminService } from '@/db/supabase';
import { SelfHealingService } from '@/services/ai-selector/self-healing.service'; // Self-healing service for automatic selector recovery
import { AICostManager, getCostManager, removeCostManager } from '@/services/ai/cost/ai-cost-manager.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getActionEmoji, getActionIcon } from '@/websocket/types/types';
import { Browser, Page } from 'playwright';
import { IntelligentPageAnalyzer } from '../analysis/intelligent-page-analyzer';
import { DOMSnapshot, PostActionAnalyzer } from '../analysis/post-action-analyzer'; // Post-action analysis service for detecting state changes and follow-up actions
import { PreActionAnalyzer } from '../analysis/pre-action-analyzer'; // Pre-action analysis service for detecting blocking factors before execution
import { ResultValidator } from '../analysis/result-validator';
import { CommandExecutor } from '../execution/command-executor';
import { ContextualActionGenerator } from '../execution/contextual-action-generator';
import { FormIntelligenceService } from '../execution/form-intelligence.service'; // Intelligent form handling service for validation error fixing
import { AdaptiveConfigService } from '../safety/adaptive-config.service'; // Adaptive configuration service for dynamic timeout and threshold management
import { SafetyGuard } from '../safety/safety-guard';
import { StateTracker } from '../safety/state-tracker';
import {
  ActionResult,
  DynamicAction,
  IntelligentTestConfig,
  IntelligentTestResult,
  PageContext,
  PageVisit,
  TestState,
} from '../types/intelligent-testing.types';
import { ErrorCollectorService } from '../utils/analysis/error-collector.service';
import { getLocator, normalizeSelector } from '../utils/selectors/selector-utils';
import { GraphBuilder } from '../utils/visualization/graph-builder.service'; // Graph builder for real-time test visualization
import { TestProgressEmitter } from '../utils/visualization/progress-emitter';
import { MainLoopService } from './main-loop.service'; // Main testing loop service (analyze → generate → execute → decide)
import { SnapshotCollector } from './lite/collectors/snapshot-collector'; // Snapshot collector for DOM analysis
import { DomAnalysisExtractorService } from '@/services/testing/ui/preview/dom-analysis-extractor.service'; // DOM analysis extractor for step editor linting

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - AI Cost Estimation
// ═══════════════════════════════════════════════════════════════════════════

// AI cost estimation (updated with accurate pricing Nov 2024)
// Based on: GPT-4o $0.005 input / $0.015 output per 1K tokens
// Vision: ~700 input + 200 output = $0.0055 per screenshot
const COST_VISION_ANALYSIS = 0.0055; // GPT-4o Vision (1 screenshot)
const COST_DOM_ANALYSIS = 0.0001; // GPT-4o-mini (400 input + 100 output)
const COST_ACTION_GENERATION = 0.0002; // GPT-4o-mini (500 input + 150 output)
// const COST_DECISION = 0.0001; // GPT-4o-mini (300 input + 100 output)

// ═══════════════════════════════════════════════════════════════════════════
// NOTE: All hardcoded values moved to AdaptiveConfigService
// Values are now determined dynamically based on context:
// - Page type (checkout, dashboard, etc.)
// - Network speed (fast, medium, slow)
// - Error rate (adaptive thresholds)
// - Test mode (fast, balanced, full)
// - Page complexity (heavy JS, many selectors, etc.)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENT TEST ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

export class IntelligentTestOrchestrator {
  private page!: Page;
  private config: IntelligentTestConfig;
  private state!: TestState;
  private userId?: string;
  private testId?: string;
  private commandExecutor!: CommandExecutor;
  private progressEmitter?: TestProgressEmitter;
  private graphBuilder!: GraphBuilder; // Graph builder for real-time test visualization
  private abortController: AbortController; // AbortController for cancelling test execution when user requests cancellation
  private costManager?: AICostManager; // AI cost manager for tracking and limiting API costs per test
  private errorCollector?: ErrorCollectorService; // Error collector service for capturing console, network, and UI errors
  private navigationListenersAttached = false;
  private navigationListenerCleanup?: () => void; // Cleanup function to remove all navigation listeners

  // Screenshot metrics for monitoring and optimization
  private screenshotMetrics = {
    totalCaptured: 0,
    beforeActions: 0,
    afterActions: 0,
    onErrors: 0,
    onNavigation: 0,
    onPageAnalysis: 0,
  };

  // Track consecutive empty pages to stop early when navigation fails repeatedly
  private consecutiveEmptyPages = 0;

  // Track selector failures to prevent infinite loops when selectors repeatedly fail
  private selectorFailures = new Map<string, number>(); // selector -> failure count

  // ✅ FIX: Track sent graph entities to prevent duplicates
  private graphSentNodeIds = new Set<string>();
  private graphSentEdgeIds = new Set<string>();

  // Flag to prevent graph updates after test completion
  private isTestCompleted = false;

  // Flag to prevent non-final graph updates during finalization (race-safe)
  private isFinalizing = false;

  private async buildCancelledResult(): Promise<IntelligentTestResult> {
    const result = await this.buildResult(false);
    result.cancelled = true; // ✅ FIX #7: Mark result as cancelled
    result.summary = 'Test was cancelled by user';
    result.errors.push({
      message: 'Test was cancelled by user',
      page: (this.state?.currentUrl) || this.config.startUrl,
    });

    logger.info('[INTELLIGENT_ORCHESTRATOR] Test cancelled', {
      pagesVisited: result.pagesVisited,
      actionsTaken: result.actionsTaken,
      duration: `${Math.round(result.duration / 1000)}s`,
    });

    this.progressEmitter?.emit({
      progress: 100,
      phase: 'finalization',
      currentStep: '❌ Test cancelled',
      status: 'cancelled',
    });

    this.emitEvent('test_cancelled', {
      message: 'Test was cancelled by user',
    });

    return result;
  }

  constructor(config: IntelligentTestConfig, userId?: string, testId?: string) {
    this.config = config;
    this.userId = userId;
    this.testId = testId;

    // Initialize AbortController for test cancellation support
    this.abortController = new AbortController();

    // Initialize AI cost manager to track and limit API costs
    if (this.testId) {
      this.costManager = getCostManager(this.testId, {
        maxCostPerTest: 1.0,      // $1 per test
        warningThreshold: 0.7,     // Warning at 70%
        adaptiveMode: true,        // Enable adaptive mode
        fallbackModel: 'gpt-4o-mini', // Fallback to mini
      });
    }

    // Initialize progress emitter if testId is provided
    if (this.testId) {
      const browser = this.config.browser || 'chrome';
      this.progressEmitter = new TestProgressEmitter(this.testId, browser, this.userId, this.config.chatSessionId);
    }
  }

  /**
   * Abort test execution
   * Called when user cancels the test via cancellation endpoint
   */
  abort(): void {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Aborting test execution', {
      testId: this.testId,
    });

    this.abortController.abort();

    // Abort command executor if initialized
    if (this.commandExecutor) {
      this.commandExecutor.abort();
    }
  }

  /**
   * Execute intelligent test
   * Main entry point
   */
  async execute(browser: Browser, page: Page): Promise<IntelligentTestResult> {
    this.page = page;

    const isAboutUrl = (url: string): boolean => url === 'about:blank' || url.startsWith('about:');
    const isCancelledOrAborted = async (): Promise<boolean> => {
      if (this.abortController.signal.aborted) return true;
      return await this.checkTestCancelled();
    };

    const raceWithAbort = async <T>(promise: Promise<T>): Promise<T> => {
      if (this.abortController.signal.aborted) {
        throw new Error('cancelled');
      }

      // ✅ FIX: Avoid listener leaks on long runs (remove listener when race finishes)
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('cancelled'));
        this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      });

      try {
      return await Promise.race([promise, abortPromise]);
      } finally {
        if (onAbort) {
          this.abortController.signal.removeEventListener('abort', onAbort);
        }
      }
    };

    const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // Pass AbortSignal to CommandExecutor for cancellation support
    // Pass cost manager to CommandExecutor for cost tracking
    this.commandExecutor = new CommandExecutor(page, {
      abortSignal: this.abortController.signal,
      costManager: this.costManager, // Cost manager for tracking API usage
      metadata: {
        url: this.config.startUrl,
        projectId: this.config.userContext?.projectId as string | undefined,
        userId: this.userId,
      },
    });

    // Setup navigation listeners to track all URL changes and detect about:blank redirects
    this.setupNavigationListeners();

    // Verify we're on the correct URL before starting test execution
    const initialUrl = page.url();
    if (!initialUrl || isAboutUrl(initialUrl)) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Page is on about:blank - navigation failed', {
        testId: this.testId,
        expectedUrl: this.config.startUrl,
        actualUrl: initialUrl,
      });

      // Try to navigate again
      try {
        if (this.abortController.signal.aborted) {
          throw new Error('cancelled');
        }

        logger.info('[INTELLIGENT_ORCHESTRATOR] Attempting to navigate to start URL', {
          testId: this.testId,
          startUrl: this.config.startUrl,
        });
        // Note: this.state is not initialized yet, use default timeout
        await page.goto(this.config.startUrl, {
          // More reliable for SPAs and heavy pages than waiting for full 'load'
          waitUntil: 'domcontentloaded',
          timeout: AdaptiveConfigService.getTimeout('NAVIGATION', {}), // Default timeout before state init
        });

        const newUrl = page.url();
        if (!newUrl || isAboutUrl(newUrl)) {
          throw new Error(`Navigation failed: page is at "${newUrl}"`);
        }

        logger.info('[INTELLIGENT_ORCHESTRATOR] Navigation retry successful', {
          testId: this.testId,
          url: newUrl,
        });
      } catch (navError) {
        const errorMsg = `Cannot start test: page is at "${initialUrl}" instead of "${this.config.startUrl}". Navigation error: ${navError instanceof Error ? navError.message : 'Unknown'}`;
        logger.error('[INTELLIGENT_ORCHESTRATOR] ' + errorMsg, {
          testId: this.testId,
          startUrl: this.config.startUrl,
          currentUrl: page.url(),
        });

        // Return failed result immediately
        return {
          success: false,
          goal: this.config.goal,
          startUrl: this.config.startUrl,
          pagesVisited: 0,
          actionsTaken: 0,
          duration: 0,
          cost: 0,
          errors: [{
            message: errorMsg,
            page: initialUrl,
          }],
          warnings: ['Navigation failed - test cannot proceed'],
          summary: `❌ Test failed: Could not navigate to ${this.config.startUrl}`,
          pageVisits: [],
          screenshots: [],
        };
      }
    }

    // Initialize state
    this.state = StateTracker.createInitialState(
      this.config.goal,
      this.config.startUrl,
      this.config.safety.maxPages,
      this.config.safety.maxDuration
    );

    // Initialize error collector to capture console, network, and UI errors
    this.errorCollector = new ErrorCollectorService(this.page);
    this.errorCollector.startCollecting();

    // Initialize graph builder for real-time test visualization
    this.graphBuilder = new GraphBuilder();

    // ✅ FIX: Clear graph tracking sets for new test to prevent false duplicates
    this.graphSentNodeIds.clear();
    this.graphSentEdgeIds.clear();

    logger.info('[INTELLIGENT_ORCHESTRATOR] Starting intelligent test', {
      goal: this.config.goal,
      startUrl: this.config.startUrl,
      actualUrl: page.url(),
      mode: this.config.mode,
      userId: this.userId,
      testId: this.testId,
    });

    this.emitEvent('test_started', {
      goal: this.config.goal,
      mode: this.config.mode,
    });

    // Add start node to graph and emit initial graph state to frontend
    if (this.testId && this.userId) {
      const startUpdate = this.graphBuilder.addStartNode();
      this.emitGraphUpdate(startUpdate);
    }


    // Execute custom scripts if provided (from Standard Mode)
    if (this.config.customScripts && this.config.customScripts.length > 0) {
      logger.info('[INTELLIGENT_ORCHESTRATOR] Executing custom scripts', {
        testId: this.testId,
        scriptsCount: this.config.customScripts.length,
      });

      for (const script of this.config.customScripts) {
        try {
          if (await isCancelledOrAborted()) {
            return await this.buildCancelledResult();
          }

          // Best-effort: don't let a bad script hang the whole run.
          // Also respects abort signal.
          const SCRIPT_TIMEOUT_MS = 10000;
          await raceWithAbort(withTimeout(this.page.evaluate(script), SCRIPT_TIMEOUT_MS, 'customScript'));
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Custom script executed successfully');
        } catch (scriptError) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Custom script failed', {
            error: scriptError instanceof Error ? scriptError.message : String(scriptError),
          });
          // Don't fail test - just warn
        }
      }
    }

    // Wait for specific selector if provided (from Standard Mode)
    if (this.config.waitForSelector) {
      logger.info('[INTELLIGENT_ORCHESTRATOR] Waiting for selector before starting', {
        testId: this.testId,
        selector: this.config.waitForSelector,
      });

      try {
        if (await isCancelledOrAborted()) {
          return await this.buildCancelledResult();
        }

        const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
        const totalTimeout = AdaptiveConfigService.getTimeout('SELECTOR_WAIT', {
          networkSpeed: pageContext.networkSpeed,
          isSlowPage: pageContext.isSlowPage,
        });

        // Prefer visible (stable UX), fallback to attached for cases where element exists
        // but becomes visible only after a user-triggered action.
        const visibleTimeout = Math.max(1000, Math.round(totalTimeout * 0.7));
        const attachedTimeout = Math.max(1000, totalTimeout - visibleTimeout);

        try {
          await raceWithAbort(this.page.waitForSelector(this.config.waitForSelector, {
            state: 'visible',
            timeout: visibleTimeout,
          }));
        } catch {
          await raceWithAbort(this.page.waitForSelector(this.config.waitForSelector, {
            state: 'attached',
            timeout: attachedTimeout,
          }));
        }
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Selector found, proceeding with test');
      } catch (waitError) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Initial selector not found, proceeding anyway', {
          selector: this.config.waitForSelector,
          error: waitError instanceof Error ? waitError.message : String(waitError),
        });
        // Don't fail - AI will adapt to actual page state
      }
    }

    // Log hints if provided (for debugging)
    if (this.config.hints && this.config.hints.length > 0) {
      logger.info('[INTELLIGENT_ORCHESTRATOR] Test hints provided', {
        testId: this.testId,
        hintsCount: this.config.hints.length,
        hints: this.config.hints.map(h => h.description),
      });
    }

    // Emit progress: Analysis phase starting
    this.progressEmitter?.emit({
      progress: 30,
      phase: 'analysis',
      currentStep: '🤖 AI analyzing page structure...',
    });

    try {
      // Main testing loop (returns true if cancelled)
      const consecutiveEmptyPagesRef = { value: this.consecutiveEmptyPages };
      const wasCancelled = await MainLoopService.execute({
        page: this.page,
        config: this.config,
        getState: () => this.state,
        setState: (next) => {
          this.state = next;
        },
        testId: this.testId,
        userId: this.userId,
        graphBuilder: this.graphBuilder,
        costManager: this.costManager,
        consecutiveEmptyPages: consecutiveEmptyPagesRef,
        checkTestCancelled: () => this.checkTestCancelled(),
        analyzePage: () => this.analyzePage(),
        generateActions: (context) => this.generateActions(context),
        executeActions: (context, actions) => this.executeActions(context, actions),
        emitEvent: (event, data) => this.emitEvent(event, data),
        emitGraphUpdate: (update) => this.emitGraphUpdate(update),
      });

      // Update consecutiveEmptyPages from the mutable object
      this.consecutiveEmptyPages = consecutiveEmptyPagesRef.value;

      // If cancelled, build result with cancellation info
      if (wasCancelled) {
        return await this.buildCancelledResult();
      }

      // Build result and validate it
      const result = await this.buildResult(true);

      // Validate test result quality to ensure test actually executed meaningful actions
      const isValidTest = this.validateTestResult(result);

      if (!isValidTest.isValid) {
        // Calculate actual success rate from action results (not from general errors)
        const allActionResults = result.pageVisits.flatMap(pv => pv.actionResults || []);
        const successfulActions = allActionResults.filter(ar => ar.success).length;
        const actualSuccessRate = allActionResults.length > 0
          ? Math.round((successfulActions / allActionResults.length) * 100)
          : 0;

        logger.warn('[INTELLIGENT_ORCHESTRATOR] Test completed but result is invalid', {
          testId: this.testId,
          reason: isValidTest.reason,
          stats: {
            pagesVisited: result.pagesVisited,
            actionsTaken: result.actionsTaken,
            successRate: `${actualSuccessRate}%`,
          },
        });

        // Mark as failed if test was invalid
        result.success = false;
        result.summary = `❌ Test failed: ${isValidTest.reason}`;
        result.errors.push({
          message: isValidTest.reason ?? "Unknown reason",
          page: this.state.currentUrl || this.config.startUrl,
        });

        logger.error('[INTELLIGENT_ORCHESTRATOR] Test failed due to invalid result', {
          testId: this.testId,
          reason: isValidTest.reason,
          pagesVisited: result.pagesVisited,
          actionsTaken: result.actionsTaken,
          errors: result.errors.length,
        });
      } else {
        // Calculate actual success rate from action results
        const allActionResults = result.pageVisits.flatMap(pv => pv.actionResults || []);
        const successfulActions = allActionResults.filter(ar => ar.success).length;
        const actualSuccessRate = allActionResults.length > 0
          ? Math.round((successfulActions / allActionResults.length) * 100)
          : 100; // If no actions, consider it 100% (nothing to fail)

        logger.info('[INTELLIGENT_ORCHESTRATOR] Test completed successfully', {
          pagesVisited: result.pagesVisited,
          actionsTaken: result.actionsTaken,
          duration: `${Math.round(result.duration / 1000)}s`,
          cost: `$${result.cost.toFixed(3)}`,
          successRate: `${actualSuccessRate}%`,
        });
      }

      // Emit progress: Test completed (with correct status based on result)
      this.progressEmitter?.emit({
        progress: 100,
        phase: 'finalization',
        currentStep: result.success
          ? '✅ Test completed successfully!'
          : '❌ Test completed with issues',
        status: result.success ? 'completed' : 'failed',
      });

      // Emit appropriate event based on result
      if (result.success) {
        this.emitEvent('test_completed', {
          success: true,
          summary: result.summary,
        });
      } else {
        // Determine failure reason: validation issue or general failure
        const failureReason = !isValidTest.isValid
          ? (isValidTest.reason || 'Test failed validation')
          : (result.errors.length > 0
              ? result.errors[0].message
              : 'Test completed with errors');

        this.emitEvent('test_failed', {
          error: failureReason,
          summary: result.summary,
        });
      }

      return result;
    } catch (error) {
      // Extract error details for debugging and logging
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.error('[INTELLIGENT_ORCHESTRATOR] Test failed', {
        testId: this.testId,
        userId: this.userId,
        goal: this.config.goal,
        error: error instanceof Error ? {
          message: errorMessage,
          name: error.name,
          stack: errorStack,
        } : String(error),
      });

      // Ensure state is initialized and error is recorded in state
      if (!this.state) {
        this.state = StateTracker.createInitialState(
          this.config.goal,
          this.config.startUrl,
          this.config.safety.maxPages,
          this.config.safety.maxDuration
        );
      }

      // Record error in state so it appears in result
      this.state.errors.push({
        message: errorMessage,
        timestamp: Date.now(),
      });

      this.emitEvent('test_failed', {
        error: errorMessage,
      });

      return await this.buildResult(false);
    } finally {
      // ✅ FIX: Cleanup navigation listeners to prevent memory leaks
      if (this.navigationListenerCleanup) {
        this.navigationListenerCleanup();
        this.navigationListenerCleanup = undefined;
        this.navigationListenersAttached = false;
      }

      // ✅ FIX: Stop error collector to prevent memory leaks
      if (this.errorCollector) {
        try {
          this.errorCollector.stopCollecting();
        } catch (error) {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Error stopping error collector', {
            testId: this.testId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Cleanup cost manager after test completion and log final stats
      if (this.testId) {
        // Log final cost stats before cleanup
        if (this.costManager) {
          const stats = this.costManager.getStats();
          logger.info('[INTELLIGENT_ORCHESTRATOR] Final AI cost stats', {
            testId: this.testId,
            ...stats,
          });
        }

        // Remove cost manager from registry
        removeCostManager(this.testId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST CANCELLATION CHECK
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if test was cancelled
   * ✅ FIX: Added timeout to prevent hanging on slow DB
   */
  private async checkTestCancelled(): Promise<boolean> {
    if (!this.testId) {
      return false;
    }

    try {
      // ✅ FIX: Add timeout to DB query (3 seconds max)
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Test status check timeout')), 3000);
      });

      const checkPromise = dbAdminService.getTest(this.testId).then((test: any) => {
      return test?.status === 'cancelled';
      });

      try {
        const result = await Promise.race([checkPromise, timeoutPromise]);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      // ✅ IMPROVED: More detailed error logging
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout')) {
        logger.warn(`[INTELLIGENT_ORCHESTRATOR] Test status check timed out: ${this.testId}`);
      } else {
        logger.warn(`[INTELLIGENT_ORCHESTRATOR] Failed to check test status: ${this.testId}`, {
          error: errorMessage,
        });
      }
      return false; // Don't block execution if check fails
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTE: mainLoop() has been extracted to MainLoopService
  // See: src/agent/main-loop.service.ts
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATION TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Setup navigation listeners to track all URL changes in real-time
   * This helps detect when and why redirects to about:blank happen
   */
  private setupNavigationListeners(): void {
    if (this.navigationListenersAttached) {
      return;
    }
    this.navigationListenersAttached = true;

    const isAboutUrl = (url: string): boolean => url === 'about:blank' || url.startsWith('about:');

    // ✅ FIX: Store listener references for cleanup
    const onFrameNavigated = (frame: any) => {
      const url = frame.url();
      const isMainFrame = frame === this.page.mainFrame();

      logger.debug('[NAVIGATION_TRACKER] Frame navigated', {
        testId: this.testId,
        url,
        isMainFrame,
        frameName: frame.name() || 'main',
      });

      // Alert on about:blank redirects
      if (isMainFrame && isAboutUrl(url)) {
        logger.warn('[NAVIGATION_TRACKER] ⚠️ Main frame redirected to about:blank', {
          testId: this.testId,
          url,
          stackTrace: new Error().stack?.split('\n').slice(0, 5).join('\n'), // Capture call stack
        });
      }
    };

    // Track failed requests (helps debug navigation stalls and blank pages)
    const onRequestFailed = (request: any) => {
      try {
        const failure = request.failure();
        const isNav = request.isNavigationRequest?.() || request.resourceType() === 'document';
        if (!isNav) return;

        logger.warn('[NAVIGATION_TRACKER] Request failed', {
          testId: this.testId,
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          failure: failure?.errorText,
        });
      } catch {
        // ignore listener errors
      }
    };

    // Track uncaught page errors (JS runtime)
    const onPageError = (error: Error) => {
      logger.warn('[NAVIGATION_TRACKER] Page error (uncaught exception)', {
        testId: this.testId,
        message: error?.message,
        stack: error?.stack,
      });
    };

    // Track and auto-dismiss dialogs (they can block automation)
    const onDialog = async (dialog: any) => {
      try {
        logger.warn('[NAVIGATION_TRACKER] Dialog appeared', {
          testId: this.testId,
          type: dialog.type(),
          message: dialog.message(),
        });

        // Strategy:
        // - beforeunload: accept to allow navigation away
        // - others: dismiss to avoid accidental destructive confirmations
        if (dialog.type() === 'beforeunload') {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }
      } catch (e) {
        logger.debug('[NAVIGATION_TRACKER] Failed to handle dialog', {
          testId: this.testId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    };

    // Track page crashes (rare but important)
    const onCrash = () => {
      logger.error('[NAVIGATION_TRACKER] Page crashed', { testId: this.testId });
    };

    // Track responses to detect redirects
    const onResponse = (response: any) => {
      const url = response.url();
      const status = response.status();
      const headers = response.headers();
      const location = headers['location'] || headers['Location'];

      // Log redirects (3xx status codes)
      const redirectRange = AdaptiveConfigService.getHttpStatusRange('redirect');
      if (status >= redirectRange.start && status < redirectRange.end && location) {
        logger.info('[NAVIGATION_TRACKER] Redirect detected', {
          testId: this.testId,
          from: url,
          to: location,
          status,
        });

        // Alert if redirecting to about:blank
        if (isAboutUrl(location)) {
          logger.error('[NAVIGATION_TRACKER] ⚠️ Redirect to about:blank detected', {
            testId: this.testId,
            from: url,
            to: location,
            status,
          });
        }
      }
    };

    // Track console errors (might indicate navigation issues)
    const onConsole = (msg: any) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('navigation') || text.includes('redirect') || text.includes('about:blank')) {
          logger.warn('[NAVIGATION_TRACKER] Console error related to navigation', {
            testId: this.testId,
            error: text,
          });
        }
      }
    };

    // ✅ FIX: Register all listeners
    this.page.on('framenavigated', onFrameNavigated);
    this.page.on('requestfailed', onRequestFailed);
    this.page.on('pageerror', onPageError);
    this.page.on('dialog', onDialog);
    this.page.on('crash', onCrash);
    this.page.on('response', onResponse);
    this.page.on('console', onConsole);

    // ✅ FIX: Store cleanup function to remove all listeners
    this.navigationListenerCleanup = () => {
      try {
        this.page.off('framenavigated', onFrameNavigated);
        this.page.off('requestfailed', onRequestFailed);
        this.page.off('pageerror', onPageError);
        this.page.off('dialog', onDialog);
        this.page.off('crash', onCrash);
        this.page.off('response', onResponse);
        this.page.off('console', onConsole);
        logger.debug('[NAVIGATION_TRACKER] Navigation listeners cleaned up', {
          testId: this.testId,
        });
      } catch (error) {
        logger.debug('[NAVIGATION_TRACKER] Error cleaning up listeners', {
          testId: this.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    logger.info('[NAVIGATION_TRACKER] Navigation listeners setup complete', {
      testId: this.testId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * STEP 1: Analyze current page
   * ✅ FIX: Added error handling, timeout, and recovery limits
   */
  private async analyzePage(): Promise<PageContext> {
    const currentUrl = this.page.url();

    logger.info('[INTELLIGENT_ORCHESTRATOR] Analyzing page', {
      url: currentUrl,
    });

    // ✅ FIX: Check for about:blank before analysis and attempt recovery if detected (with limit)
    const isAboutBlank = currentUrl === 'about:blank' || currentUrl.startsWith('about:blank');
    if (isAboutBlank) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Page is about:blank, attempting to navigate back', {
        testId: this.testId,
        currentUrl,
      });

      // ✅ FIX: Limit recovery attempts to prevent infinite loops
      const MAX_RECOVERY_ATTEMPTS = 2;
      let recoveryAttempt = 0;
      let recovered = false;

      while (recoveryAttempt < MAX_RECOVERY_ATTEMPTS && !recovered) {
        recoveryAttempt++;

      try {
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state);

          // Try goBack first
          try {
        await this.page.goBack({
          timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
            networkSpeed: pageContext.networkSpeed,
          }),
        });
        const newUrl = this.page.url();

            if (newUrl !== 'about:blank' && !newUrl.startsWith('about:blank')) {
              recovered = true;
              logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully recovered from about:blank via goBack', {
                newUrl,
              });
              break;
            }
          } catch (goBackError) {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] goBack failed, trying goto startUrl', {
              error: goBackError instanceof Error ? goBackError.message : String(goBackError),
            });
          }

          // If still on about:blank, try to go to start URL
          if (this.config.startUrl) {
          await this.page.goto(this.config.startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: AdaptiveConfigService.getTimeout('NAVIGATION', {
              networkSpeed: pageContext.networkSpeed,
              hasHeavyJS: pageContext.hasHeavyJS,
            }),
          });
            const newUrl = this.page.url();

            if (newUrl !== 'about:blank' && !newUrl.startsWith('about:blank')) {
              recovered = true;
              logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully recovered from about:blank via goto', {
                newUrl,
              });
              break;
            }
          }
      } catch (recoveryError) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Recovery attempt failed', {
            attempt: recoveryAttempt,
            maxAttempts: MAX_RECOVERY_ATTEMPTS,
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
        }
      }

      if (!recovered) {
        logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to recover from about:blank after all attempts', {
          testId: this.testId,
          attempts: recoveryAttempt,
        });
        // Continue anyway - analysis will handle about:blank page
      }
    }

    this.emitEvent('page_analyzing', {
      url: this.page.url(),
    });

    // Emit test:progress event when analyzing page
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 40,
        phase: 'analysis',
        icon: getActionIcon(undefined, 'analysis'),
        currentStep: `🔍 Analyzing page: ${this.page.url()}`,
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 40,
        phase: 'analysis',
        currentStep: `🔍 Analyzing page: ${this.page.url()}`,
        icon: getActionIcon(undefined, 'analysis'),
        status: 'running',
        timestamp: new Date().toISOString(),
        userId: this.userId, // Include userId for WebSocket user room broadcast
        sessionId: this.config.chatSessionId,
      });
    }

    const previousContext = this.state.visitedPages.length > 0
      ? `Previous page: ${this.state.visitedPages[this.state.visitedPages.length - 1].pageType}`
      : undefined;

    // ✅ FIX: Add timeout and error handling to page analysis
    let context: PageContext;
    try {
      // ✅ FIX: Wrap analysis in timeout (max 60 seconds)
      const ANALYSIS_TIMEOUT = 60000;
      const analysisPromise = IntelligentPageAnalyzer.analyzePage(
      this.page,
      this.config.goal,
      this.config.mode,
      previousContext,
      this.config.spaLoadConfig, // Configurable SPA load settings for single-page applications
      this.state, // Pass state for history context in page analysis
      this.config.hints, // Pass hints from test plan to guide AI analysis
      this.errorCollector // Pass error collector for capturing page errors
    );

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Page analysis timeout')), ANALYSIS_TIMEOUT);
      });

      context = await Promise.race([analysisPromise, timeoutPromise]);
    } catch (analysisError) {
      // ✅ FIX: Fallback to minimal context if analysis fails
      const errorMessage = analysisError instanceof Error ? analysisError.message : String(analysisError);
      logger.error('[INTELLIGENT_ORCHESTRATOR] Page analysis failed, using fallback context', {
        testId: this.testId,
        url: this.page.url(),
        error: errorMessage,
      });

      // Create minimal fallback context
      context = {
        url: this.page.url(),
        pageType: 'unknown',
        timestamp: Date.now(),
        vision: {
          pageType: 'unknown',
          description: 'Analysis failed',
          elements: [],
          suggestions: [],
          warnings: ['Page analysis failed: ' + errorMessage],
        },
        dom: {
          forms: [],
          buttons: [],
          links: [],
          inputs: [],
        },
        requiredActions: [],
        possibleActions: [],
        criticalElements: [],
        warnings: ['Page analysis failed - using fallback context'],
      };

      // Record error in state
      this.state.errors.push({
        message: `Page analysis failed: ${errorMessage}`,
        timestamp: Date.now(),
      });
    }

    // Update cost
    const analysisCost = this.config.mode === 'full'
      ? COST_VISION_ANALYSIS + COST_DOM_ANALYSIS
      : COST_DOM_ANALYSIS;

    this.state = StateTracker.updateCost(this.state, analysisCost);

    this.emitEvent('page_analyzed', {
      url: context.url,
      pageType: context.pageType,
      elementsFound: context.vision.elements.length,
    });

    // Emit test:progress event after page analysis completes
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 50,
        phase: 'analysis',
        currentStep: `✅ Page analyzed: ${context.pageType} (${context.vision.elements.length} elements found)`,
        icon: getActionIcon(undefined, 'analysis'),
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 50,
        phase: 'analysis',
        currentStep: `✅ Page analyzed: ${context.pageType} (${context.vision.elements.length} elements found)`,
        icon: getActionIcon(undefined, 'analysis'),
        status: 'running',
        timestamp: new Date().toISOString(),
        userId: this.userId, // Include userId for WebSocket user room broadcast
        sessionId: this.config.chatSessionId,
      });
    }

    return context;
  }

  /**
   * STEP 3: Generate actions
   * Uses hints from config to guide action generation
   */
  private async generateActions(context: PageContext): Promise<{
    actions: DynamicAction[];
    reasoning: string;
    confidence: number;
  }> {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Generating actions', {
      hasHints: !!(this.config.hints && this.config.hints.length > 0),
      hintsCount: this.config.hints?.length || 0,
    });

    this.emitEvent('actions_generating', {});

    // Emit test:progress event when generating actions
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 55,
        phase: 'generation',
        currentStep: '🤖 Generating actions with AI...',
        icon: getActionIcon(undefined, 'generation'),
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 55,
        phase: 'generation',
        currentStep: '🤖 Generating actions with AI...',
        icon: getActionIcon(undefined, 'generation'),
        status: 'running',
        timestamp: new Date().toISOString(),
        userId: this.userId, // Include userId for WebSocket user room broadcast
        sessionId: this.config.chatSessionId,
      });
    }

    // Pass TestHint[] directly to ContextualActionGenerator (full context preserved)
    const hints = this.config.hints;

    // ✅ FIX: Add timeout and error handling to action generation
    let result: { actions: DynamicAction[]; reasoning: string; confidence: number };
    try {
      // ✅ FIX: Wrap generation in timeout (max 45 seconds)
      const GENERATION_TIMEOUT = 45000;
      const generationPromise = ContextualActionGenerator.generateActions(
      context,
      this.state,
      this.page,
      this.costManager,
      hints,  // Pass hints for AI guidance during action generation
    );

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Action generation timeout')), GENERATION_TIMEOUT);
      });

      result = await Promise.race([generationPromise, timeoutPromise]);

      // ✅ FIX: Validate result
      if (!result || typeof result !== 'object') {
        throw new Error('Invalid result from action generator');
      }
      if (!Array.isArray(result.actions)) {
        throw new Error('Actions is not an array');
      }
    } catch (generationError) {
      // ✅ FIX: Fallback to empty actions if generation fails
      const errorMessage = generationError instanceof Error ? generationError.message : String(generationError);
      logger.error('[INTELLIGENT_ORCHESTRATOR] Action generation failed, using empty actions', {
        testId: this.testId,
        url: context.url,
        error: errorMessage,
      });

      result = {
        actions: [],
        reasoning: `Action generation failed: ${errorMessage}`,
        confidence: 0,
      };

      // Record error in state
      this.state.errors.push({
        message: `Action generation failed: ${errorMessage}`,
        timestamp: Date.now(),
      });
    }

    // Update cost
    this.state = StateTracker.updateCost(this.state, COST_ACTION_GENERATION);

    // Filter safe actions
    const safeActions: DynamicAction[] = [];

    for (const action of result.actions) {
      // ✅ FIX: Validate action before safety check
      if (!action || typeof action !== 'object') {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Invalid action skipped', {
          action: String(action),
        });
        continue;
      }

      try {
      const safetyCheck = SafetyGuard.checkAction(
        action,
        context,
        this.config.safety
      );

      if (!safetyCheck.safe) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Unsafe action filtered', {
          action: action.description,
          reason: safetyCheck.reason,
        });

        if (safetyCheck.requiresApproval) {
          this.emitEvent('test_warning', {
            message: `Action requires approval: ${action.description}`,
          });
        }

        continue;
      }

      safeActions.push(action);
      } catch (safetyError) {
        // ✅ FIX: Handle safety check errors
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Safety check failed for action', {
          action: action.description,
          error: safetyError instanceof Error ? safetyError.message : String(safetyError),
        });
        continue;
      }
    }

    // Emit test:progress event after actions are generated
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 60,
        phase: 'generation',
        currentStep: `✅ Generated ${safeActions.length} action(s)`,
        icon: getActionIcon(undefined, 'generation'),
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 60,
        phase: 'generation',
        currentStep: `✅ Generated ${safeActions.length} action(s)`,
        icon: getActionIcon(undefined, 'generation'),
        status: 'running',
        timestamp: new Date().toISOString(),
        userId: this.userId, // Include userId for WebSocket user room broadcast
        sessionId: this.config.chatSessionId,
      });
    }

    return {
      ...result,
      actions: safeActions,
    };
  }

  /**
   * STEP 4: Execute actions
   */
  private async executeActions(
    context: PageContext,
    actions: DynamicAction[]
  ): Promise<PageVisit> {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Executing actions (single lifecycle)', {
      count: actions.length,
    });

    if (this.progressEmitter) {
      this.progressEmitter.setTotalActions(actions.length);
    }

    const completedActions: ActionResult[] = [];
    let success = true;

    const isBase64Like = (str: string | undefined): boolean => {
      if (!str || typeof str !== 'string') return false;
      return str.startsWith('data:image/') || (str.length > 100 && /^[A-Za-z0-9+/=]+$/.test(str));
    };

    const sanitizeNodeScreenshots = (
      node: import('@/types').GraphNode | undefined
    ): import('@/types').GraphNode | undefined => {
      if (!node) return undefined;
      const meta = node.meta ?? {};
      return {
        ...node,
        meta: {
          ...meta,
          screenshotBefore: isBase64Like(meta.screenshotBefore) ? undefined : meta.screenshotBefore,
          screenshotAfter: isBase64Like(meta.screenshotAfter) ? undefined : meta.screenshotAfter,
        },
      };
    };

    for (let i = 0; i < actions.length; i++) {
      const plannedAction = actions[i];

      // Emit progress (60-90%)
      const progress = 60 + Math.round((i / Math.max(actions.length, 1)) * 30);
        this.progressEmitter?.emit({
          progress,
          phase: 'execution',
        currentStep: `${getActionEmoji(plannedAction.action)} ${plannedAction.description}...`,
        icon: getActionIcon(plannedAction.action, 'execution'),
          action: {
          type: plannedAction.action,
          description: plannedAction.description,
          target: plannedAction.selector,
          },
          completedSteps: i,
        });

      logger.info('[INTELLIGENT_ORCHESTRATOR] Executing action (SINGLE LIFECYCLE)', {
          testId: this.testId,
          actionIndex: i + 1,
          totalActions: actions.length,
          action: {
          type: plannedAction.action,
          selector: plannedAction.selector,
          normalizedSelector: plannedAction.selector ? normalizeSelector(plannedAction.selector) : undefined,
          value: plannedAction.value,
          description: plannedAction.description,
          expectedResult: plannedAction.expectedResult,
          optional: plannedAction.optional,
          timeout: plannedAction.timeout,
          retry: plannedAction.retry,
          },
          progress: `${i + 1}/${actions.length}`,
        });

      this.emitEvent('action_executing', { action: plannedAction.description });

      // Deduct 1 credit for action execution
      if (this.userId && this.testId) {
        const creditResult = await CreditCostTrackerService.deductStepCredit(
          this.userId,
          this.testId,
          `Action ${i + 1}/${actions.length}: ${plannedAction.description}`
        );
        if (!creditResult.success) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Stopping execution: insufficient credits', {
            testId: this.testId,
            actionIndex: i + 1,
          });
          break;
        }
      }

      const shouldSnapshotBefore = ['fill', 'type', 'click', 'select', 'check', 'uncheck'].includes(plannedAction.action);
      const snapshotBefore: DOMSnapshot = shouldSnapshotBefore
        ? await PostActionAnalyzer.captureSnapshot(this.page).catch(() => ({
            visibleElements: [],
            modals: [],
            errors: [],
            buttonStates: [],
          } as any))
        : ({
            visibleElements: [],
            modals: [],
            errors: [],
            buttonStates: [],
          } as any);

      const actionExecution = await this.executeSingleAction(plannedAction, context, snapshotBefore, 0);
      // Push prerequisite + main + follow-up results into pageVisit (and graph)
      completedActions.push(...actionExecution.all);

      const completedProgress = 60 + Math.round(((i + 1) / Math.max(actions.length, 1)) * 30);
      this.progressEmitter?.emit({
        progress: completedProgress,
            phase: 'execution',
        currentStep: actionExecution.main.success
          ? `✅ ${getActionEmoji(plannedAction.action)} ${plannedAction.description}`
          : `❌ ${getActionEmoji(plannedAction.action)} ${plannedAction.description} (failed)`,
        icon: getActionIcon(plannedAction.action, 'execution'),
            action: {
          type: plannedAction.action,
          description: plannedAction.description,
          target: plannedAction.selector,
            },
            completedSteps: i + 1,
        status: actionExecution.main.success ? 'running' : 'failed',
          });

        if (this.testId) {
          webSocketService.emitTestProgress(this.testId, {
            testId: this.testId,
            browser: this.config.browser || 'chrome',
          progress: completedProgress,
            phase: 'execution',
          currentStep: actionExecution.main.success
            ? `✅ ${plannedAction.description}`
            : `❌ ${plannedAction.description} (failed)`,
          icon: getActionIcon(plannedAction.action, 'execution'),
            action: {
            type: plannedAction.action,
            description: plannedAction.description,
            target: plannedAction.selector,
            },
            totalSteps: actions.length,
            completedSteps: i + 1,
          status: actionExecution.main.success ? 'running' : 'failed',
            timestamp: new Date().toISOString(),
          userId: this.userId,
          sessionId: this.config.chatSessionId,
          });
        }

        if (this.testId && this.userId && this.graphBuilder) {
        // Add graph nodes for every executed result (prereq + main + follow-ups)
        for (const result of actionExecution.all) {
          const graphUpdate = this.graphBuilder.addActionNode(result.action, {
            success: result.success,
            error: result.error,
            durationMs: result.durationMs,
            urlChanged: result.urlChanged,
            urlBefore: result.urlBefore,
            urlAfter: result.urlAfter,
            retryCount: result.retryCount,
            isTimeout: (result.error?.toLowerCase() ?? '').includes('timeout'),
            screenshotBefore: result.screenshotBefore,
            screenshotAfter: result.screenshotAfter,
          });

          this.emitGraphUpdate({
            ...graphUpdate,
            newNode: sanitizeNodeScreenshots(graphUpdate.newNode),
          });

          const nodeId = graphUpdate.newNode?.id;
          if (nodeId && (result.screenshotBefore || result.screenshotAfter)) {
            const testId = this.testId;
            const userId = this.userId;
            const beforeBase64 = result.screenshotBefore;
            const afterBase64 = result.screenshotAfter;
            const beforeIdx = result.screenshotBeforeIndex;
            const afterIdx = result.screenshotAfterIndex;

            void (async () => {
              // ✅ FIX: Skip if test is already completed (prevents late events from async operations)
              if (this.isTestCompleted || this.isFinalizing) {
                logger.debug('[INTELLIGENT_ORCHESTRATOR] Skipping screenshot upload - test already completed', {
                  testId,
                  nodeId,
                });
                return;
              }

              const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

              if (beforeBase64 && beforeIdx !== undefined) {
                try {
                  // ✅ FIX: Check again after async operation (test might have completed during upload)
                  if (this.isTestCompleted || this.isFinalizing) {
                    return;
                  }

                  const beforeUrl = await uploadScreenshotToStorage(beforeBase64, testId, userId, beforeIdx);
                  const update = this.graphBuilder?.updateNodeMeta(nodeId, { screenshotBefore: beforeUrl });
                  if (update) {
                    this.emitGraphUpdate({
                      ...update,
                      updatedNode: sanitizeNodeScreenshots(update.updatedNode),
                    });
                  }
                } catch (e) {
                  logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to upload screenshotBefore', {
                    testId,
                    nodeId,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }

              if (afterBase64 && afterIdx !== undefined) {
                try {
                  // ✅ FIX: Check again after async operation (test might have completed during upload)
                  if (this.isTestCompleted || this.isFinalizing) {
                    return;
                  }

                  const afterUrl = await uploadScreenshotToStorage(afterBase64, testId, userId, afterIdx);
                  const update = this.graphBuilder?.updateNodeMeta(nodeId, { screenshotAfter: afterUrl });
                  if (update) {
                    this.emitGraphUpdate({
                      ...update,
                      updatedNode: sanitizeNodeScreenshots(update.updatedNode),
                    });
                  }
                } catch (e) {
                  logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to upload screenshotAfter', {
                    testId,
                    nodeId,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            })();
          }
          }
        }

      if (!actionExecution.main.success) {
          success = false;
        this.emitEvent('action_failed', { action: plannedAction.description, error: actionExecution.main.error });

        if (!plannedAction.optional) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Required action failed, stopping', {
              testId: this.testId,
            action: plannedAction.description,
            error: actionExecution.main.error,
            });
            break;
          }
        } else {
        this.emitEvent('action_completed', { action: plannedAction.description });
      }

      // ✅ FIX: Break the batch if ANY executed action changed the URL (prerequisite/main/follow-up)
      const urlChangedResult = actionExecution.all.find(r => r.urlChanged);
      if (urlChangedResult) {
        logger.info('[INTELLIGENT_ORCHESTRATOR] Page changed, ending action batch', {
              testId: this.testId,
          triggeringAction: urlChangedResult.action,
          urlBefore: urlChangedResult.urlBefore,
          urlAfter: urlChangedResult.urlAfter,
        });
          break;
      }
    }

    // ✅ NEW: Capture DOM analysis for step editor linting
    let domAnalysis;
    try {
      const snapshot = await SnapshotCollector.collect(this.page);
      domAnalysis = DomAnalysisExtractorService.extract(snapshot);
      logger.debug('[INTELLIGENT_ORCHESTRATOR] DOM analysis captured for step editor', {
        nodeCount: domAnalysis.interactiveNodes.length,
        url: context.url,
      });
    } catch (error) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to capture DOM analysis', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      url: context.url,
      pageType: context.pageType,
      timestamp: context.timestamp,
      actions,
      actionResults: completedActions,
      success,
      domAnalysis,
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert DynamicAction to PlaywrightCommand for execution
   * ✅ FIX: Added complete assertion mapping, validation, and better timeout logic
   */
  private convertActionToCommand(action: DynamicAction): import('@/types').PlaywrightCommand {
    // ✅ FIX: Validate action
    if (!action || typeof action !== 'object') {
      throw new Error('Invalid action: action is null or not an object');
    }

    if (!action.action || typeof action.action !== 'string') {
      throw new Error('Invalid action: action.action is missing or not a string');
    }

    // Don't normalize selector here - CommandExecutor.prepareSelector() will do it ONCE to avoid double-processing
    // Keep assertion mapping centralized to avoid drift across different execution paths

    // ✅ IMPROVED: Complete assertion type mapping (only for types supported by DynamicAction)
    let assertionType: 'visible' | 'hidden' | 'text' | 'value' | 'count' | 'url' | 'enabled' | 'disabled' = 'text';

    switch (action.action) {
      case 'assertVisible':
        assertionType = 'visible';
        break;
      case 'assertText':
        assertionType = 'text';
        break;
      case 'assertValue':
        assertionType = 'value';
        break;
      case 'assertUrl':
        assertionType = 'url';
        break;
      case 'assertCount':
        assertionType = 'count';
        break;
      default:
        // For non-assertion actions, default to 'text'
        assertionType = 'text';
    }

    // ✅ IMPROVED: Better timeout logic based on action type
    const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
    let defaultTimeout: number;

    // ✅ FIX: Only check action types that exist in DynamicAction
    if (action.action === 'goto' || action.action === 'waitForNavigation') {
      // Navigation actions need longer timeout
      defaultTimeout = AdaptiveConfigService.getTimeout('NAVIGATION', {
        networkSpeed: pageContext.networkSpeed,
        hasHeavyJS: pageContext.hasHeavyJS,
      });
    } else if (action.action === 'waitForSelector') {
      // Wait actions need medium timeout
      defaultTimeout = AdaptiveConfigService.getTimeout('SELECTOR_WAIT', {
        networkSpeed: pageContext.networkSpeed,
        isSlowPage: pageContext.isSlowPage,
      });
    } else if (action.action === 'scroll') {
      // Scroll actions are fast
      defaultTimeout = 5000;
    } else {
      // Default for interactions (click, fill, type, etc.)
      defaultTimeout = AdaptiveConfigService.getTimeout('SELECTOR_WAIT', {
        networkSpeed: pageContext.networkSpeed,
        isSlowPage: pageContext.isSlowPage,
      });
    }

    return {
      action: action.action as import('@/types').PlaywrightActionType,
      selector: action.selector,
      value: action.value,
      url: action.url,
      description: action.description,
      extract: action.extract,
      assertion: action.assertion ? {
        type: assertionType,
        expected: action.assertion.expected,
        operator: action.assertion.operator,
      } : undefined,
      timeout: action.timeout || defaultTimeout,
      continueOnError: action.optional || false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: FORM INTELLIGENCE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Try to fix validation errors using Form Intelligence
   * ✅ FIX: Added validation, limits, and proper logging
   */
  private async tryFixValidationErrors(
    action: DynamicAction,
    errors: string[]
  ): Promise<void> {
    // ✅ FIX: Validate inputs
    if (!errors || !Array.isArray(errors) || errors.length === 0) {
      return;
    }

    if (!action || !action.selector) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] Cannot fix validation errors without selector', {
        testId: this.testId,
      });
      return;
    }

    try {
      // ✅ FIX: Add timeout to form analysis
      const FORM_ANALYSIS_TIMEOUT = 5000;
      const analysisPromise = PreActionAnalyzer.analyzeFormBeforeSubmit(this.page, action.selector, {
            useIntelligence: false,
            url: this.page.url(),
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Form analysis timeout')), FORM_ANALYSIS_TIMEOUT);
      });

      const formAnalysis = await Promise.race([analysisPromise, timeoutPromise]);

      // ✅ FIX: Validate form analysis result
      if (!formAnalysis || typeof formAnalysis !== 'object') {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Invalid form analysis result', {
          testId: this.testId,
        });
        return;
      }

      if (!Array.isArray(formAnalysis.fields) || formAnalysis.fields.length === 0) {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] No fields found in form analysis', {
          testId: this.testId,
        });
        return;
      }

      // Try to fix each error
      const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
      const maxErrorsToFix = AdaptiveConfigService.getThreshold('MAX_VALIDATION_ERRORS_TO_FIX', {
        errorRate: pageContext.errorRate,
      });

      // ✅ NEW: Track fixed fields to prevent infinite loops
      const fixedFields = new Set<string>();
      let successfulFixes = 0;

      for (const error of errors.slice(0, maxErrorsToFix)) {
        // ✅ FIX: Validate error
        if (!error || typeof error !== 'string') continue;

        // Find the field that might be causing this error
        const relatedField = formAnalysis.fields.find(f =>
          f && f.selector && (f.hasError || error.toLowerCase().includes(f.label?.toLowerCase() || ''))
        );

        if (!relatedField || !relatedField.selector) {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] No related field found for error', {
            testId: this.testId,
            error: error.substring(0, 50),
          });
          continue;
        }

        // ✅ NEW: Skip if already fixed this field
        if (fixedFields.has(relatedField.selector)) {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Field already fixed, skipping', {
            testId: this.testId,
            field: relatedField.label,
          });
          continue;
        }

        try {
          // ✅ FIX: Validate FormIntelligenceService exists
          if (!FormIntelligenceService || typeof FormIntelligenceService.fixValidationError !== 'function') {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] FormIntelligenceService not available', {
              testId: this.testId,
            });
            break;
          }

          const fix = await FormIntelligenceService.fixValidationError(
            error,
            relatedField,
            formAnalysis.fields
          );

          // ✅ FIX: Validate fix result
          if (!fix || typeof fix !== 'object' || !fix.value) {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] No fix suggested for error', {
              testId: this.testId,
              error: error.substring(0, 50),
            });
            continue;
          }

          // Reuse pageContext from above
          const confidenceThreshold = AdaptiveConfigService.getThreshold('VALIDATION_FIX_CONFIDENCE_THRESHOLD', {
            errorRate: pageContext.errorRate,
          });

          if (fix.confidence >= confidenceThreshold) {
            logger.info('[INTELLIGENT_ORCHESTRATOR] Attempting to fix validation error', {
              testId: this.testId,
              error: error.substring(0, 50),
              field: relatedField.label,
              newValue: String(fix.value).substring(0, 20) + '...', // Log partial value for privacy
              confidence: fix.confidence,
            });

            // ✅ IMPROVED: Add fix action to graph (not just execute silently)
            try {
              const fixCommand = this.convertActionToCommand({
                action: 'fill',
                selector: relatedField.selector,
                value: fix.value,
                description: `Fix validation: ${relatedField.label}`,
              });

              const fixResult = await this.commandExecutor.executeCommand(fixCommand);

              if (fixResult.success) {
                fixedFields.add(relatedField.selector);
                successfulFixes++;

                logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully fixed validation error', {
                  testId: this.testId,
                  field: relatedField.label,
                  totalFixed: successfulFixes,
                });

                // Small delay for validation to run (reuse pageContext)
                await this.page.waitForTimeout(
                  AdaptiveConfigService.getTimeout('VALIDATION_DELAY', {
                    isSlowPage: pageContext.isSlowPage,
                  })
                );
              } else {
                logger.debug('[INTELLIGENT_ORCHESTRATOR] Fix command failed', {
                  testId: this.testId,
                  field: relatedField.label,
                  error: fixResult.error,
                });
              }
            } catch (fixError) {
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to apply fix', {
                testId: this.testId,
                field: relatedField.label,
                error: fixError instanceof Error ? fixError.message : String(fixError),
              });
            }
          } else {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] Fix confidence too low', {
              testId: this.testId,
              field: relatedField.label,
              confidence: fix.confidence,
              threshold: confidenceThreshold,
            });
          }
        } catch (fixGenerationError) {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Error generating fix', {
            testId: this.testId,
            error: fixGenerationError instanceof Error ? fixGenerationError.message : String(fixGenerationError),
          });
        }
      }

      if (successfulFixes > 0) {
        logger.info('[INTELLIGENT_ORCHESTRATOR] Validation fix summary', {
          testId: this.testId,
          totalErrors: errors.length,
          successfulFixes,
        });
      }
    } catch (error) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] tryFixValidationErrors failed', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle conditional fields that may appear after fill/select actions
   * ✅ FIX: Replaced waitForTimeout with waitForFunction, added Shadow DOM support
   */
  private async handleConditionalFieldsAfterAction(action: DynamicAction): Promise<void> {
    if (!action.selector) return;

    try {
      // ✅ FIX: Skip form analysis if not needed (performance optimization)
      // We can detect new fields without analyzing the form structure first

      const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
      const maxWaitTime = AdaptiveConfigService.getTimeout('CONDITIONAL_FIELD_WAIT', {
          isSlowPage: pageContext.isSlowPage,
          hasHeavyJS: pageContext.hasHeavyJS,
      });

      // ✅ IMPROVED: Use waitForFunction instead of waitForTimeout
      // This detects new fields immediately, not after fixed delay
      try {
        await this.page.waitForFunction(
          () => {
            // Helper to get all inputs including Shadow DOM
            const getAllInputs = (root: any): any[] => {
              // ✅ FIX: Add limits to prevent deep/large Shadow DOM from causing excessive work or stack overflow
              const MAX_DEPTH = 5;
              const MAX_HOSTS = 500;
              const MAX_INPUTS = 500;

              const inputs: any[] = [];
              const visitedRoots = new Set<any>();

              // Get direct inputs
              const directInputs = Array.from(
                root.querySelectorAll('input:not([type="hidden"]), select, textarea')
              );
              inputs.push(...directInputs.slice(0, MAX_INPUTS));

              // ✅ FIX: Iterative traversal of Shadow DOM with depth/host limits
              const stack: Array<{ root: any; depth: number }> = [{ root, depth: 0 }];
              visitedRoots.add(root);

              let hostsVisited = 0;
              while (stack.length > 0) {
                const item = stack.pop();
                if (!item) break;
                if (item.depth >= MAX_DEPTH) continue;

                let hosts: any[] = [];
                try {
                  hosts = Array.from(item.root.querySelectorAll('*'));
                } catch {
                  continue;
                }

                for (const host of hosts) {
                  hostsVisited++;
                  if (hostsVisited > MAX_HOSTS) break;

                  const shadowRoot = (host as any).shadowRoot;
                  if (!shadowRoot) continue;
                  if (visitedRoots.has(shadowRoot)) continue;
                  visitedRoots.add(shadowRoot);

                  try {
                    const shadowInputs = Array.from(
                      shadowRoot.querySelectorAll('input:not([type="hidden"]), select, textarea')
                    );
                    if (shadowInputs.length > 0) {
                      inputs.push(...shadowInputs);
                      if (inputs.length >= MAX_INPUTS) {
                        return inputs.slice(0, MAX_INPUTS);
                      }
                    }
                  } catch {
                    // ignore shadowRoot access/query errors
                  }

                  stack.push({ root: shadowRoot, depth: item.depth + 1 });
                }

                if (hostsVisited > MAX_HOSTS || inputs.length >= MAX_INPUTS) {
                  break;
                }
              }

              return inputs.slice(0, MAX_INPUTS);
            };

        // @ts-expect-error - browser context
            const allInputs = getAllInputs(document);

            // Count visible empty fields
            let visibleEmptyCount = 0;
        for (const input of allInputs) {
          const rect = input.getBoundingClientRect();
          // @ts-expect-error - browser context
              const style = window.getComputedStyle(input);

              if (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0'
              ) {
                if (!input.value || input.value === '') {
                  visibleEmptyCount++;
                }
              }
            }

            // Return true if we have at least one visible empty field
            // This allows waitForFunction to resolve as soon as fields appear
            return visibleEmptyCount > 0;
          },
          { timeout: maxWaitTime }
        ).catch(() => {
          // Timeout is OK - means no new fields appeared
          logger.debug('[INTELLIGENT_ORCHESTRATOR] No new conditional fields detected', {
            testId: this.testId,
          });
        });
      } catch (waitError) {
        // Ignore timeout errors
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Conditional field wait completed', {
          testId: this.testId,
        });
      }

      // ✅ IMPROVED: Check for new visible fields with Shadow DOM support
      const newVisibleFields = await this.page.evaluate(() => {
        // Helper to get all inputs including Shadow DOM
        const getAllInputs = (root: any): any[] => {
          // ✅ FIX: Add limits to prevent deep/large Shadow DOM from causing excessive work or stack overflow
          const MAX_DEPTH = 5;
          const MAX_HOSTS = 500;
          const MAX_INPUTS = 500;

          const inputs: any[] = [];
          const visitedRoots = new Set<any>();

          // Get direct inputs
          const directInputs = Array.from(
            root.querySelectorAll('input:not([type="hidden"]), select, textarea')
          );
          inputs.push(...directInputs.slice(0, MAX_INPUTS));

          // ✅ FIX: Iterative traversal of Shadow DOM with depth/host limits
          const stack: Array<{ root: any; depth: number }> = [{ root, depth: 0 }];
          visitedRoots.add(root);

          let hostsVisited = 0;
          while (stack.length > 0) {
            const item = stack.pop();
            if (!item) break;
            if (item.depth >= MAX_DEPTH) continue;

            let hosts: any[] = [];
            try {
              hosts = Array.from(item.root.querySelectorAll('*'));
            } catch {
              continue;
            }

            for (const host of hosts) {
              hostsVisited++;
              if (hostsVisited > MAX_HOSTS) break;

              const shadowRoot = (host as any).shadowRoot;
              if (!shadowRoot) continue;
              if (visitedRoots.has(shadowRoot)) continue;
              visitedRoots.add(shadowRoot);

              try {
                const shadowInputs = Array.from(
                  shadowRoot.querySelectorAll('input:not([type="hidden"]), select, textarea')
                );
                if (shadowInputs.length > 0) {
                  inputs.push(...shadowInputs);
                  if (inputs.length >= MAX_INPUTS) {
                    return inputs.slice(0, MAX_INPUTS);
                  }
                }
              } catch {
                // ignore shadowRoot access/query errors
              }

              stack.push({ root: shadowRoot, depth: item.depth + 1 });
            }

            if (hostsVisited > MAX_HOSTS || inputs.length >= MAX_INPUTS) {
              break;
            }
          }

          return inputs.slice(0, MAX_INPUTS);
        };

        // @ts-expect-error - browser context
        const allInputs = getAllInputs(document);
        const visibleNew: string[] = [];

        for (const input of allInputs) {
          const rect = input.getBoundingClientRect();
          // @ts-expect-error - browser context
          const style = window.getComputedStyle(input);

          // Check if element is newly visible (appeared recently, not hidden)
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          ) {
            // Check if it's empty (likely new)
            if (!input.value || input.value === '') {
              // ✅ IMPROVED: Better selector generation
              const id = input.id;
              const name = input.getAttribute('name');
              const ariaLabel = input.getAttribute('aria-label');

              const selector = id
                ? `#${id}`
                : name
                  ? `[name="${name}"]`
                  : ariaLabel
                    ? `[aria-label="${ariaLabel}"]`
                  : null;

              if (selector) {
                visibleNew.push(selector);
              }
            }
          }
        }

        return visibleNew;
      });

      if (newVisibleFields.length > 0) {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Detected new visible fields after action', {
          testId: this.testId,
          triggerAction: action.description,
          newFieldsCount: newVisibleFields.length,
          fields: newVisibleFields.slice(0, 5), // Log first 5 for debugging
        });
      }
    } catch (error) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] handleConditionalFieldsAfterAction failed', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULT BUILDING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate test result quality
   * Returns false if test didn't actually test anything meaningful
   */
  private validateTestResult(result: IntelligentTestResult): { isValid: boolean; reason?: string } {
    // ✅ FIX: Validate input
    if (!result) {
      return { isValid: false, reason: 'Result is null or undefined' };
    }

    // ✅ FIX: Check for data inconsistency
    if (!result.pageVisits || !Array.isArray(result.pageVisits)) {
      return { isValid: false, reason: 'Page visits data is missing or invalid' };
    }

    if (result.pageVisits.length === 0 && result.pagesVisited > 0) {
      return { isValid: false, reason: 'Data inconsistency: pagesVisited count does not match pageVisits array' };
    }

    // ✅ IMPROVED: More precise about:blank detection (only about:blank, not about:srcdoc etc)
    const isAboutBlankUrl = (url: string | undefined): boolean => {
      if (!url || url === '') return true;
      return url === 'about:blank' || url.startsWith('about:blank');
    };

    const aboutBlankPages = result.pageVisits.filter(p => isAboutBlankUrl(p.url)).length;

    if (aboutBlankPages === result.pagesVisited && result.pagesVisited > 0) {
      return {
        isValid: false,
        reason: 'All pages were about:blank - navigation failed, no pages were actually tested',
      };
    }

    // ✅ FIX: Validate startUrl before processing
    if (!this.config.startUrl || typeof this.config.startUrl !== 'string' || this.config.startUrl.trim() === '') {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Invalid startUrl in config', {
        startUrl: this.config.startUrl,
      });
      // Skip start URL validation if config is invalid
      return { isValid: true };
    }

    // Check if we visited the start URL (with normalization and redirect handling)
    // Many sites redirect (e.g., https://repetino.kz → https://repetino.kz/onboarding)
    // We should check if we visited the base domain, not just the exact URL
    const normalizeUrl = (url: string): string => {
      // ✅ FIX: Validate input
      if (!url || typeof url !== 'string') return '';

      try {
        const urlObj = new URL(url);
        urlObj.search = '';
        urlObj.hash = '';
        let hostname = urlObj.hostname;
        if (hostname.startsWith('www.')) {
          hostname = hostname.substring(4);
        }
        urlObj.hostname = hostname;
        urlObj.protocol = 'https:';
        return urlObj.toString().replace(/\/$/, '');
      } catch {
        // ✅ IMPROVED: More robust fallback
        try {
          return url.split('?')[0].split('#')[0].replace(/\/$/, '').trim();
        } catch {
          return '';
        }
      }
    };

    // Extract base domain from start URL (e.g., "repetino.kz" from "https://repetino.kz")
    const getBaseDomain = (url: string): string => {
      // ✅ FIX: Validate input
      if (!url || typeof url !== 'string') return '';

      try {
        const urlObj = new URL(url);
        let hostname = urlObj.hostname;
        if (hostname.startsWith('www.')) {
          hostname = hostname.substring(4);
        }
        return hostname;
      } catch {
        // Fallback: extract domain from URL string
        try {
        const match = url.match(/https?:\/\/(?:www\.)?([^/]+)/);
        return match ? match[1] : '';
        } catch {
          return '';
        }
      }
    };

    const normalizedStartUrl = normalizeUrl(this.config.startUrl);
    const startBaseDomain = getBaseDomain(this.config.startUrl);

    // ✅ FIX: Skip validation if we couldn't extract domain
    if (!startBaseDomain) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Could not extract base domain from startUrl', {
        startUrl: this.config.startUrl,
      });
      return { isValid: true };
    }

    // Check if we visited the start URL (exact match) OR any page on the same domain (redirect handling)
    const visitedStartUrl = result.pageVisits.some(p => {
      if (!p.url) return false;

      // ✅ FIX: Skip about:blank URLs
      if (isAboutBlankUrl(p.url)) return false;

      const normalizedPageUrl = normalizeUrl(p.url);
      const pageBaseDomain = getBaseDomain(p.url);

      // ✅ FIX: Handle empty results from normalization
      if (!normalizedPageUrl && !pageBaseDomain) return false;

      // Exact match OR same base domain (handles redirects)
      return normalizedPageUrl === normalizedStartUrl || pageBaseDomain === startBaseDomain;
    });

    if (!visitedStartUrl && result.pagesVisited > 0) {
      return {
        isValid: false,
        reason: `Start URL "${this.config.startUrl}" (domain: ${startBaseDomain}) was never visited - navigation may have failed`,
      };
    }

    // Check success rate
    if (result.actionsTaken > 0) {
      // Count successful actions from actual action results (not loop-level errors)
      // Loop-level errors (result.errors) are for validation/analysis failures, not action failures
      const allActionResults = result.pageVisits
        .flatMap(pageVisit => pageVisit.actionResults || []);

      // Use actual action results if available, otherwise fallback (shouldn't happen in normal flow)
      if (allActionResults.length > 0) {
        const successCount = allActionResults.filter(ar => ar.success).length;
        const successRate = successCount / allActionResults.length;

        if (successRate === 0) {
          return {
            isValid: false,
            reason: 'All actions failed (0% success rate) - test did not successfully interact with the page',
          };
        }

        // Warn if success rate is very low
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
        const lowSuccessRateThreshold = AdaptiveConfigService.getThreshold('LOW_SUCCESS_RATE_THRESHOLD', {
          testMode: this.config.mode,
          errorRate: pageContext.errorRate,
        });
        const minActionsForRate = AdaptiveConfigService.getThreshold('MIN_ACTIONS_FOR_SUCCESS_RATE', {
          testMode: this.config.mode,
        });
        if (successRate < lowSuccessRateThreshold && allActionResults.length >= minActionsForRate) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Very low success rate', {
            testId: this.testId,
            successRate: `${Math.round(successRate * 100)}%`,
            actionsTaken: allActionResults.length,
            successfulActions: successCount,
            failedActions: allActionResults.length - successCount,
          });
        }
      } else {
        // Fallback: if no action results available, use old logic (shouldn't happen normally)
        logger.warn('[INTELLIGENT_ORCHESTRATOR] No action results found for success rate calculation', {
          testId: this.testId,
          actionsTaken: result.actionsTaken,
          pagesVisited: result.pagesVisited,
        });
      }
    }

    // Check if we have meaningful page visits
    if (result.pagesVisited === 0) {
      return {
        isValid: false,
        reason: 'No pages were visited - test did not execute properly',
      };
    }

    return { isValid: true };
  }

  private async buildResult(success: boolean): Promise<IntelligentTestResult> {
      // Handle case where state might not be initialized (early errors before state creation)
      if (!this.state) {
        this.state = StateTracker.createInitialState(
          this.config.goal,
          this.config.startUrl,
          this.config.safety.maxPages,
          this.config.safety.maxDuration
        );
      }

    // ✅ FIX: Collect errors from ErrorCollector before building result
    if (this.errorCollector) {
      try {
        const collectedErrors = this.errorCollector.getErrors();
        // Add collected errors to state if not already present
        const allErrors = [
          ...collectedErrors.consoleErrors.map(e => ({ message: e.message, timestamp: e.timestamp })),
          ...collectedErrors.networkErrors.map(e => ({ message: `${e.method} ${e.url}: ${e.error}`, timestamp: e.timestamp })),
          ...collectedErrors.uiErrors.map(e => ({ message: e.text, timestamp: e.timestamp })),
        ];

        for (const error of allErrors) {
          const isDuplicate = this.state.errors.some(e => e.message === error.message);
          if (!isDuplicate) {
            this.state.errors.push(error);
          }
        }

        logger.debug('[INTELLIGENT_ORCHESTRATOR] Collected errors from ErrorCollector', {
          testId: this.testId,
          collectedCount: allErrors.length,
          totalErrors: this.state.errors.length,
        });
      } catch (error) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to collect errors from ErrorCollector', {
          testId: this.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      }

    const stats = StateTracker.getStatistics(this.state);

    const summary = this.buildSummary(success, stats);

    // Collect screenshots from page visits for result storage
    const screenshots = this.state.visitedPages
      .filter(pageVisit => pageVisit.screenshot)
      .map((pageVisit) => ({
        url: pageVisit.url,
        screenshot: pageVisit.screenshot!,
      }));

    // Log screenshot metrics for monitoring and optimization analysis
    logger.info('[INTELLIGENT_ORCHESTRATOR] Screenshot optimization metrics', {
      totalCaptured: this.screenshotMetrics.totalCaptured,
      breakdown: {
        pageAnalysis: this.screenshotMetrics.onPageAnalysis,
        beforeActions: this.screenshotMetrics.beforeActions,
        afterActions: this.screenshotMetrics.afterActions,
        onErrors: this.screenshotMetrics.onErrors,
        onNavigation: this.screenshotMetrics.onNavigation,
      },
      uploadedToStorage: screenshots.length,
      averageSize: screenshots.length > 0
        ? `${Math.round(screenshots.reduce((sum, s) => sum + s.screenshot.length, 0) / screenshots.length / 1024)}KB`
        : '0KB',
      totalSize: `${Math.round(screenshots.reduce((sum, s) => sum + s.screenshot.length, 0) / 1024)}KB`,
    });

    // ✅ FIX: Calculate accurate success rate from action results
    const allActionResults = this.state.visitedPages.flatMap(pv => pv.actionResults || []);
    const successfulActions = allActionResults.filter(ar => ar.success).length;
    const actualSuccessRate = allActionResults.length > 0
      ? Math.round((successfulActions / allActionResults.length) * 100)
      : 100; // If no actions, consider it 100% (nothing to fail)

    // Add end node to graph and emit final graph state to frontend
    if (this.testId && this.userId && this.graphBuilder) {
      // ✅ FIX: Start finalization BEFORE emitting endUpdate to prevent late async updates (e.g. screenshot uploads).
      // We still force-emit the final endUpdate so frontend always receives the final full graph.
      this.isFinalizing = true;

      const endUpdate = this.graphBuilder.addEndNode(
        success,
        summary,
        {
          pagesVisited: stats.pagesVisited,
          actionsTaken: stats.actionsTaken,
          successRate: `${actualSuccessRate}%`, // ✅ FIX: Use accurate success rate
          duration: `${Math.round(stats.duration / 1000)}s`,
          cost: `$${stats.estimatedCost.toFixed(3)}`,
          finalScreenshot: screenshots[screenshots.length - 1]?.screenshot,
        }
      );
      this.emitGraphUpdate(endUpdate, { force: true });

      // ✅ FIX: Mark test as completed AFTER emitting endUpdate (so endUpdate isn't blocked)
      this.isTestCompleted = true;
    }

    // Get final graph data for storage in database
    let graphData = this.graphBuilder ? this.graphBuilder.getFullGraph() : undefined;

    // Log graph data for debugging and verification
    if (graphData) {
      logger.info('[INTELLIGENT_ORCHESTRATOR] Graph data prepared for storage', {
        testId: this.testId,
        nodesCount: graphData.nodes?.length || 0,
        edgesCount: graphData.edges?.length || 0,
        hasMetadata: !!graphData.metadata,
      });
    } else {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] No graph data available for storage', {
        testId: this.testId,
        hasGraphBuilder: !!this.graphBuilder,
      });
    }

    // Upload screenshots from graph to storage and replace base64 with public URLs to reduce data size
    if (graphData && this.testId && this.userId) {
      try {
        graphData = await this.uploadGraphScreenshotsToStorage(graphData);
      } catch (uploadError) {
        logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to upload graph screenshots', {
          testId: this.testId,
          error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        });
        // Continue without screenshots - graph will still work
      }
    }

    return {
      success,
      goal: this.config.goal,
      startUrl: this.config.startUrl,
      pagesVisited: stats.pagesVisited,
      actionsTaken: stats.actionsTaken,
      duration: stats.duration,
      cost: stats.estimatedCost,
      errors: this.state.errors.map(e => ({
        message: e.message,
        page: this.state.currentUrl,
      })),
      warnings: [],
      summary,
      pageVisits: this.state.visitedPages,
      screenshots,
      graphData, // Include complete graph with public URLs for frontend visualization
    };
  }

  /**
   * Upload all screenshots from graph to storage and replace base64 with public URLs
   * This reduces graph_data size and makes screenshots accessible via public URLs
   * ✅ FIX: Added timeout, limits, and retry logic
   */
  private async uploadGraphScreenshotsToStorage(graphData: any): Promise<any> {
    if (!this.testId || !this.userId) {
      return graphData; // Can't upload without testId/userId
    }

    // ✅ FIX: Add overall timeout (max 2 minutes for all uploads)
    const UPLOAD_TIMEOUT = 120000;
    const startTime = Date.now();

    try {
      const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');
      let screenshotIndex = 0;
      let uploadedCount = 0;
      let failedCount = 0;

      // ✅ FIX: Limit max screenshots to prevent excessive uploads
      const MAX_SCREENSHOTS = 200;

      // Helper to check if string is base64 image
      const isBase64Image = (str: string | undefined): boolean => {
        if (!str || typeof str !== 'string') return false;
        // Check if it's base64 (starts with data:image or is long base64 string)
        return str.startsWith('data:image/') || (str.length > 100 && /^[A-Za-z0-9+/=]+$/.test(str));
      };

      // Helper to extract base64 data
      const extractBase64 = (str: string): string => {
        if (str.startsWith('data:image/')) {
          return str.split(',')[1] || str;
        }
        return str;
      };

      // ✅ FIX: Helper to upload with retry
      const uploadWithRetry = async (base64Data: string, index: number, maxRetries = 2): Promise<string | null> => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const url = await uploadScreenshotToStorage(
              base64Data,
              this.testId!,
              this.userId!,
              index
            );
            return url;
          } catch (error) {
            if (attempt === maxRetries) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Screenshot upload failed after retries', {
                index,
                attempts: maxRetries + 1,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            }
            // Wait before retry (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
          }
        }
        return null;
      };

      // Process all nodes
      if (graphData.nodes && Array.isArray(graphData.nodes)) {
        for (const node of graphData.nodes) {
          // ✅ FIX: Check timeout
          if (Date.now() - startTime > UPLOAD_TIMEOUT) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Upload timeout reached, stopping uploads', {
              testId: this.testId,
              uploadedCount,
              failedCount,
              totalNodes: graphData.nodes.length,
            });
            break;
          }

          // ✅ FIX: Check screenshot limit
          if (screenshotIndex >= MAX_SCREENSHOTS) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Max screenshots limit reached', {
              testId: this.testId,
              limit: MAX_SCREENSHOTS,
              uploadedCount,
            });
            break;
          }

          if (!node.meta) continue;

          // ✅ FIX: Upload page screenshot with retry
          if (isBase64Image(node.meta.screenshot)) {
              const base64Data = extractBase64(node.meta.screenshot);
            const publicUrl = await uploadWithRetry(base64Data, screenshotIndex++);

            if (publicUrl) {
              node.meta.screenshot = publicUrl;
              uploadedCount++;
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Uploaded page screenshot', {
                nodeId: node.id,
                url: publicUrl,
              });
            } else {
              // Remove base64 to save space, keep empty string
              node.meta.screenshot = '';
              failedCount++;
            }
          }

          // ✅ FIX: Upload before/after action screenshots with retry
          if (isBase64Image(node.meta.screenshotBefore)) {
              const base64Data = extractBase64(node.meta.screenshotBefore);
            const publicUrl = await uploadWithRetry(base64Data, screenshotIndex++);

            if (publicUrl) {
              node.meta.screenshotBefore = publicUrl;
              uploadedCount++;
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Uploaded before screenshot', {
                nodeId: node.id,
                url: publicUrl,
              });
            } else {
              node.meta.screenshotBefore = '';
              failedCount++;
            }
          }

          if (isBase64Image(node.meta.screenshotAfter)) {
              const base64Data = extractBase64(node.meta.screenshotAfter);
            const publicUrl = await uploadWithRetry(base64Data, screenshotIndex++);

            if (publicUrl) {
              node.meta.screenshotAfter = publicUrl;
              uploadedCount++;
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Uploaded after screenshot', {
                nodeId: node.id,
                url: publicUrl,
              });
            } else {
              node.meta.screenshotAfter = '';
              failedCount++;
            }
          }
        }
      }

      logger.info('[INTELLIGENT_ORCHESTRATOR] Graph screenshots uploaded to storage', {
        testId: this.testId,
        totalScreenshots: screenshotIndex,
        uploadedCount,
        failedCount,
        duration: `${Date.now() - startTime}ms`,
      });

      return graphData;
    } catch (error) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Error uploading graph screenshots', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return original graph if upload fails
      return graphData;
    }
  }

  /**
   * Build test summary with proper validation and escaping
   * ✅ FIX: Added markdown escaping, validation, and error details
   */
  private buildSummary(success: boolean, stats: any): string {
    // ✅ FIX: Validate stats object
    if (!stats || typeof stats !== 'object') {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Invalid stats object in buildSummary', {
        testId: this.testId,
        stats: String(stats),
      });
      return '❌ **Test completed with errors** - Unable to generate summary (invalid stats)';
    }

    // ✅ FIX: Helper to escape markdown special characters
    const escapeMarkdown = (text: string | undefined | null): string => {
      if (!text || typeof text !== 'string') return '';
      // Escape markdown special characters: * _ [ ] ( ) # + - . ! ` |
      return text.replace(/([*_()[\]#+\-.!`|\\])/g, '\\$1');
    };

    const lines: string[] = [];

    if (success) {
      lines.push(`✅ **Test completed successfully**`);
    } else {
      lines.push(`❌ **Test completed with issues**`);
    }

    lines.push('');

    // ✅ FIX: Escape goal to prevent markdown injection
    const safeGoal = escapeMarkdown(this.config.goal);
    lines.push(`**Goal:** ${safeGoal || 'N/A'}`);

    // ✅ FIX: Safe access to stats properties with fallbacks
    const duration = typeof stats.duration === 'number' ? Math.round(stats.duration / 1000) : 0;
    const pagesVisited = typeof stats.pagesVisited === 'number' ? stats.pagesVisited : 0;
    const actionsTaken = typeof stats.actionsTaken === 'number' ? stats.actionsTaken : 0;
    const successRate = typeof stats.successRate === 'number' ? Math.round(stats.successRate * 100) : 0;
    const estimatedCost = typeof stats.estimatedCost === 'number' ? stats.estimatedCost.toFixed(3) : '0.000';
    const errorCount = typeof stats.errorCount === 'number' ? stats.errorCount : 0;

    lines.push(`**Duration:** ${duration}s`);
    lines.push(`**Pages Visited:** ${pagesVisited}`);
    lines.push(`**Actions Taken:** ${actionsTaken}`);
    lines.push(`**Success Rate:** ${successRate}%`);
    lines.push(`**Cost:** $${estimatedCost}`);

    // ✅ IMPROVED: Show error details, not just count
    if (errorCount > 0 && this.state && Array.isArray(this.state.errors)) {
      lines.push('');
      lines.push(`⚠️ **Errors:** ${errorCount}`);

      // ✅ NEW: Show top 3 errors for context
      const topErrors = this.state.errors.slice(0, 3);
      if (topErrors.length > 0) {
        lines.push('');
        lines.push('**Recent Errors:**');
        topErrors.forEach((error, index) => {
          const errorMsg = escapeMarkdown(error.message);
          // Truncate long error messages
          const truncated = errorMsg.length > 100 ? errorMsg.substring(0, 97) + '...' : errorMsg;
          lines.push(`${index + 1}. ${truncated}`);
        });

        if (this.state.errors.length > 3) {
          lines.push(`... and ${this.state.errors.length - 3} more`);
        }
      }
    }

    // ✅ FIX: Safe access to pageTypes
    if (stats.pageTypes && Array.isArray(stats.pageTypes) && stats.pageTypes.length > 0) {
    lines.push('');
      // ✅ FIX: Escape page types and limit length
      const safePageTypes = stats.pageTypes
        .map((pt: any) => escapeMarkdown(String(pt)))
        .slice(0, 10) // Limit to 10 page types
        .join(', ');
      lines.push(`**Page Types Visited:** ${safePageTypes}`);

      if (stats.pageTypes.length > 10) {
        lines.push(`... and ${stats.pageTypes.length - 10} more`);
      }
    }

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create action with context for AI analysis
   */
  private createActionWithContext(action: DynamicAction, metadata?: Partial<import('../types/intelligent-testing.types').ActionMetadata>): DynamicAction {
    return {
      ...action,
      description: action.description || `${action.action} on ${action.selector}`,
      metadata: {
        testGoal: metadata?.testGoal || this.state.goal,
        pageType: metadata?.pageType,
        pageUrl: metadata?.pageUrl,
        previousActions: metadata?.previousActions || this.state.completedActions.slice(-3).map(a => a.action.description),
      },
    };
  }

  /**
   * Get current action context
   */
  private getActionContext(context?: PageContext): {
    testGoal: string;
    pageType: string;
    pageUrl: string;
    previousActions: string[];
  } {
    return {
      testGoal: this.state.goal,
      pageType: context?.pageType || 'unknown',
      pageUrl: context?.url || this.state.currentUrl,
      previousActions: this.state.completedActions.slice(-3).map(a => a.action.description),
    };
  }

  /**
   * Enrich action for AI with additional context
   */
  private enrichActionForAI(action: DynamicAction, context: PageContext): {
    action: DynamicAction;
    goal: string;
  } {
    return {
      action: {
        ...action,
        description: `${action.description} [Page: ${context.pageType}, Goal: ${this.state.goal}]`,
      },
      goal: `${this.state.goal} | Current page: ${context.pageType} | URL: ${context.url}`,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTE ACTIONS SUB-METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute a single action with full lifecycle (pre-analysis, execution, post-analysis)
   * @param depth - Recursion depth for follow-up actions (prevents infinite recursion)
   */
  private async executeSingleAction(
    action: DynamicAction,
    context: PageContext,
    snapshotBefore: DOMSnapshot,
    depth: number = 0
  ): Promise<{ main: ActionResult; all: ActionResult[] }> {
    try {
      // Step 1 & 2: Run pre-action analysis and selector validation in parallel (if selector exists)
      const [preAnalysisResult, selectorValidation] = await Promise.all([
        this.handlePreActionAnalysis(action, context),
        action.selector
          ? this.validateAndPrepareSelector(action)
          : Promise.resolve({ isValid: true, healedAction: undefined, error: undefined } as const),
      ]);

      const allResults: ActionResult[] = [];

      if (preAnalysisResult.shouldSkip) {
        const failure = await this.handleActionFailure(action, 'Action blocked by prerequisite conditions', {
          pageType: context.pageType,
          pageUrl: context.url,
          preAnalysis: preAnalysisResult.preAnalysis,
        });
        return { main: failure, all: [failure] };
      }

      // Record prerequisite results (if any) for visibility in stats/loop logic
      if (preAnalysisResult.prerequisiteResults && preAnalysisResult.prerequisiteResults.length > 0) {
        for (const prereqResult of preAnalysisResult.prerequisiteResults) {
          this.state = StateTracker.recordActionResult(this.state, prereqResult);
          allResults.push(prereqResult);
        }
      }

      // Check selector validation
      if (!selectorValidation.isValid) {
        const failure = await this.handleActionFailure(action, selectorValidation.error || 'Selector validation failed', {
          pageType: context.pageType,
          pageUrl: context.url,
        });
        return { main: failure, all: [...allResults, failure] };
      }

      // Use healed action if available
      if (selectorValidation.healedAction) {
        action = selectorValidation.healedAction;
      }

      // Step 3: Capture before screenshot
      const screenshots = await this.captureActionScreenshots(action, { isBeforeAction: true });

      // Step 4: Execute action command
      const executionResult = await this.executeActionCommand(action, context);

      // Step 5: Capture after screenshot
      const afterScreenshots = await this.captureActionScreenshots(action, {
        isAfterAction: true,
        isError: !executionResult.success,
      });

      // Step 6: Create action result
      const actionResult: ActionResult = {
        action,
        success: executionResult.success,
        error: executionResult.error,
        urlChanged: executionResult.urlChanged,
        urlBefore: executionResult.urlBefore,
        urlAfter: executionResult.urlAfter,
        screenshot: afterScreenshots.after || screenshots.before,
        screenshotBefore: screenshots.before,
        screenshotAfter: afterScreenshots.after,
        screenshotBeforeIndex: screenshots.beforeIndex,
        screenshotAfterIndex: afterScreenshots.afterIndex,
        timestamp: Date.now(),
        durationMs: executionResult.durationMs,
      };

      // Step 7: Validate result
      const validation = await ResultValidator.validateResult(action, actionResult, this.page);

      if (!validation.passed) {
        actionResult.success = false;
        actionResult.error = validation.message || 'Validation failed';
      }

      // Step 7.5: Post-action validation error detection + conditional fields (legacy behavior)
      const isSubmitAction = action.action === 'click' && action.description?.toLowerCase().includes('submit');
      if (AdaptiveConfigService.requiresPostActionAnalysis(action, {
        pageType: context.pageType,
        hasForm: (context.dom?.forms?.length || 0) > 0,
        isSubmitAction,
      })) {
        try {
          const actionWithContextForPost = {
            ...action,
            metadata: {
              testGoal: this.state.goal,
              pageType: context.pageType,
              pageUrl: context.url,
              actionSucceeded: actionResult.success,
            },
          } as DynamicAction & { metadata?: any };

          const postAnalysis = await PreActionAnalyzer.analyzeAfterAction(
            this.page,
            actionWithContextForPost,
            actionResult.success
          );

          if (postAnalysis.hasNewErrors) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Post-action analysis detected errors', {
              testId: this.testId,
              action: action.description,
              testGoal: this.state.goal,
              pageType: context.pageType,
              pageUrl: context.url,
              actionSucceeded: actionResult.success,
              errors: postAnalysis.errors,
              suggestions: postAnalysis.suggestions,
              errorCount: postAnalysis.errors.length,
            });

            // Try to fix validation errors
            if (action.selector && postAnalysis.errors.length > 0) {
              await this.tryFixValidationErrors(action, postAnalysis.errors);
            }

            // If action seemed successful but page shows errors, mark it as failed
            if (actionResult.success) {
              actionResult.success = false;
              actionResult.error = `Validation error after action: ${postAnalysis.errors.join(', ')}`;
            }
          }

          // Conditional fields after fill/select
          const formAnalysis = await PreActionAnalyzer.analyzeFormBeforeSubmit(
            this.page,
            action.selector || '',
            { useIntelligence: true, url: this.page.url() }
          ).catch(() => null);

          if (AdaptiveConfigService.triggersConditionalFields(action, {
            pageType: context.pageType,
            hasForm: (context.dom?.forms?.length || 0) > 0,
            formType: formAnalysis ? 'unknown' : undefined,
          }) && actionResult.success) {
            await this.handleConditionalFieldsAfterAction(action);
          }
        } catch (postCheckError) {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Post-action checks failed (continuing)', {
            testId: this.testId,
            error: postCheckError instanceof Error ? postCheckError.message : String(postCheckError),
          });
        }
      }

      // Step 8: Update state
      this.state = StateTracker.recordActionResult(this.state, actionResult);
      allResults.push(actionResult);

      // Step 9: Post-action analysis (if needed)
      // Limit recursion depth to prevent infinite loops (max 2 levels: original action -> follow-up -> no more)
      const MAX_FOLLOW_UP_DEPTH = 2;
      let followUpActions: DynamicAction[] = [];
      if (depth < MAX_FOLLOW_UP_DEPTH && this.shouldPerformPostAnalysis(action, {
        urlChanged: actionResult.urlChanged,
        actionSucceeded: actionResult.success,
      })) {
        const postAnalysisResult = await this.handlePostActionAnalysisMethod(action, actionResult, context, snapshotBefore);

        // Step 10: Execute follow-up actions if AI decided they're needed
        if (postAnalysisResult.followUpActions && postAnalysisResult.followUpActions.length > 0) {
          followUpActions = postAnalysisResult.followUpActions;

          logger.info('[INTELLIGENT_ORCHESTRATOR] Executing follow-up actions from post-analysis', {
            testId: this.testId,
            originalAction: action.description,
            followUpCount: followUpActions.length,
            depth,
          });

          for (const followUpAction of followUpActions) {
            try {
              // Capture snapshot before follow-up action
              const followUpSnapshotBefore = await PostActionAnalyzer.captureSnapshot(this.page);

              // Execute follow-up action using the same lifecycle (with increased depth)
              const followUp = await this.executeSingleAction(
                followUpAction,
                context,
                followUpSnapshotBefore,
                depth + 1
              );
              allResults.push(...followUp.all);

              // Log follow-up action result
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Follow-up action completed', {
                testId: this.testId,
                description: followUpAction.description,
                success: followUp.main.success,
              });

              // ✅ FIX: If ANY follow-up execution changed URL (prereq/main/follow-up), update context and stop
              const followUpUrlChanged = followUp.all.find(r => r.urlChanged);
              if (followUpUrlChanged) {
                context.url = followUpUrlChanged.urlAfter || this.page.url();
                logger.info('[INTELLIGENT_ORCHESTRATOR] Follow-up action caused navigation', {
                  testId: this.testId,
                  triggeringAction: followUpUrlChanged.action,
                  newUrl: context.url,
                });
                // Break if URL changed significantly (new page)
                break;
              }
            } catch (followUpError) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Follow-up action failed', {
                testId: this.testId,
                description: followUpAction.description,
                error: followUpError instanceof Error ? followUpError.message : String(followUpError),
              });
              // Continue with next follow-up action even if one fails
            }
          }
        }
      }

      return { main: actionResult, all: allResults };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failure = await this.handleActionFailure(action, errorMessage, {
        pageType: context.pageType,
        pageUrl: context.url,
      });
      return { main: failure, all: [failure] };
    }
  }

  /**
   * Handle pre-action analysis and execute prerequisite actions
   */
  private async handlePreActionAnalysis(
    action: DynamicAction,
    context: PageContext
  ): Promise<{
    shouldSkip: boolean;
    preAnalysis?: any;
    prerequisiteResults?: ActionResult[];
  }> {
    const actionContext = this.getActionContext(context);
    const actionWithContext = this.createActionWithContext(action, actionContext);

    // Perform pre-action analysis
    let preAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, actionWithContext);

    // Log blocking factors if any
    if (preAnalysis.blockingFactors.length > 0) {
      logger.info('[INTELLIGENT_ORCHESTRATOR] Pre-action analysis found blocking factors', {
        testId: this.testId,
        action: action.description,
        testGoal: actionContext.testGoal,
        pageType: actionContext.pageType,
        pageUrl: actionContext.pageUrl,
        blockingFactors: preAnalysis.blockingFactors.map((bf: any) => ({
          type: bf.type,
          description: bf.description,
          priority: bf.priority || 'medium',
          hasSuggestedActions: (bf.suggestedActions?.length || 0) > 0,
        })),
        suggestedActionsCount: preAnalysis.suggestedActions.length,
        context: preAnalysis.context,
      });

      // Execute prerequisite actions if suggested
      const prerequisiteResults: ActionResult[] = [];
      if (preAnalysis.suggestedActions.length > 0) {
        const sortedPrereqActions = [...preAnalysis.suggestedActions].sort((a: any, b: any) => {
          const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
          const aPriority = a.priority || 'medium';
          const bPriority = b.priority || 'medium';
          return (priorityOrder[aPriority as keyof typeof priorityOrder] || 2) -
                 (priorityOrder[bPriority as keyof typeof priorityOrder] || 2);
        });

        for (const prereqAction of sortedPrereqActions) {
          this.logPrerequisiteAction(prereqAction, {
            testGoal: actionContext.testGoal,
            pageType: actionContext.pageType,
            pageUrl: actionContext.pageUrl,
            blockingFactor: preAnalysis.blockingFactors[0]?.description || 'Unknown',
            priority: (prereqAction as any).priority,
          });

          try {
            const prereqCommand = this.convertActionToCommand(prereqAction);
            const urlBefore = this.page.url();
            const result = await this.commandExecutor.executeCommand(prereqCommand);
            const urlAfter = this.page.url();
            prerequisiteResults.push({
              action: prereqAction,
              success: result.success,
              error: result.error,
              urlChanged: urlBefore !== urlAfter,
              urlBefore,
              urlAfter,
              timestamp: Date.now(),
            });

            if (!result.success) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Prerequisite action failed', {
                testId: this.testId,
                action: prereqAction.description,
                error: result.error,
              });
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            prerequisiteResults.push({
              action: prereqAction,
              success: false,
              error: errorMessage,
              urlChanged: false,
              urlBefore: context.url,
              urlAfter: context.url,
              timestamp: Date.now(),
            });
          }
        }
      }

      // Re-analyze after prerequisites (critical to avoid stale blocker state)
      try {
        preAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, actionWithContext);
      } catch (reAnalysisError) {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Pre-action re-analysis failed (continuing with previous analysis)', {
          testId: this.testId,
          error: reAnalysisError instanceof Error ? reAnalysisError.message : String(reAnalysisError),
        });
      }

      // Check if still blocked after prerequisites
      if (this.isActionBlocked(preAnalysis)) {
        return { shouldSkip: true, preAnalysis, prerequisiteResults };
      }

      return { shouldSkip: false, preAnalysis, prerequisiteResults };
    }

    return { shouldSkip: false, preAnalysis };
  }

  /**
   * Validate and prepare selector with self-healing
   */
  private async validateAndPrepareSelector(
    action: DynamicAction
  ): Promise<{
    isValid: boolean;
    healedAction?: DynamicAction;
    error?: string;
  }> {
    if (!action.selector) {
      return { isValid: true };
    }

    const normalizedSelector = normalizeSelector(action.selector);
    const locator = this.getLocatorWrapper(normalizedSelector);
    const elementCount = await locator.count();

    if (elementCount === 0) {
      // Track selector failures
      const failureCount = (this.selectorFailures.get(normalizedSelector) || 0) + 1;
      this.selectorFailures.set(normalizedSelector, failureCount);

      // Try self-healing on first failure
      if (failureCount === 1) {
        try {
          logger.info('[INTELLIGENT_ORCHESTRATOR] Selector not found, attempting self-healing', {
            testId: this.testId,
            action: action.description,
            selector: normalizedSelector,
          });

          const healingResult = await SelfHealingService.healSelector({
            oldSelector: normalizedSelector,
            intent: action.description || `${action.action} element`,
            page: this.page,
            errorMessage: `Selector not found: ${normalizedSelector}`,
            metadata: {
              url: this.page.url(),
              projectId: this.config.userContext?.projectId as string | undefined,
              userId: this.userId,
            },
            mode: 'fast',
          });

          if (healingResult.success && healingResult.newSelector && healingResult.autoApplied) {
            const healedNormalized = normalizeSelector(healingResult.newSelector);
            const healedLocator = getLocator(this.page, healedNormalized);
            const healedCount = await healedLocator.count();

            if (healedCount > 0) {
              logger.info('[INTELLIGENT_ORCHESTRATOR] Self-healing successful', {
                testId: this.testId,
                oldSelector: normalizedSelector,
                newSelector: healingResult.newSelector,
                confidence: healingResult.diff.confidence,
              });

              // Reset failure count
              this.selectorFailures.delete(normalizedSelector);

              return {
                isValid: true,
                healedAction: { ...action, selector: healingResult.newSelector },
              };
            }
          }
        } catch (healingError) {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Self-healing failed', {
            testId: this.testId,
            error: healingError instanceof Error ? healingError.message : String(healingError),
          });
        }
      }

      return {
        isValid: false,
        error: `Selector not found: ${normalizedSelector} (failed ${failureCount} times)`,
      };
    }

    // Reset failure count if selector works
    this.selectorFailures.delete(normalizedSelector);
    return { isValid: true };
  }

  /**
   * Capture screenshots for action
   */
  private async captureActionScreenshots(
    action: DynamicAction,
    context: { isBeforeAction?: boolean; isAfterAction?: boolean; isError?: boolean }
  ): Promise<{ before?: string; after?: string; beforeIndex?: number; afterIndex?: number }> {
    const screenshots: { before?: string; after?: string; beforeIndex?: number; afterIndex?: number } = {};

    if (context.isBeforeAction && this.shouldCaptureScreenshot(action, { isBeforeAction: true })) {
      try {
        const buffer = await this.page.screenshot({ fullPage: false });
        screenshots.before = buffer.toString('base64');
        this.screenshotMetrics.beforeActions++;
        this.screenshotMetrics.totalCaptured++;
        screenshots.beforeIndex = this.screenshotMetrics.totalCaptured;
      } catch (error) {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to capture before screenshot', {
          testId: this.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (context.isAfterAction && this.shouldCaptureScreenshot(action, { isAfterAction: true })) {
      try {
        const buffer = await this.page.screenshot({ fullPage: false });
        screenshots.after = buffer.toString('base64');
        this.screenshotMetrics.afterActions++;
        this.screenshotMetrics.totalCaptured++;
        screenshots.afterIndex = this.screenshotMetrics.totalCaptured;
      } catch (error) {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to capture after screenshot', {
          testId: this.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (context.isError) {
      try {
        const buffer = await this.page.screenshot({ fullPage: false });
        screenshots.after = buffer.toString('base64');
        this.screenshotMetrics.onErrors++;
        this.screenshotMetrics.totalCaptured++;
        screenshots.afterIndex = this.screenshotMetrics.totalCaptured;
      } catch (error) {
        logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to capture error screenshot', {
          testId: this.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return screenshots;
  }

  /**
   * Execute action command through CommandExecutor
   */
  private async executeActionCommand(
    action: DynamicAction,
    context: PageContext
  ): Promise<{
    success: boolean;
    error?: string;
    urlChanged: boolean;
    urlBefore: string;
    urlAfter: string;
    durationMs: number;
  }> {
    const actionContext = this.getActionContext(context);

    this.logActionExecution(action, {
      testGoal: actionContext.testGoal,
      pageType: actionContext.pageType,
      pageUrl: actionContext.pageUrl,
      actionIndex: this.state.completedActions.length,
      totalActions: this.state.completedActions.length + 1,
      previousActions: actionContext.previousActions,
    });

    const urlBefore = this.page.url();

    // Wait for action effect
    await this.handleAsyncOperations(action);

    // Execute through CommandExecutor (shared command conversion)
    const finalCommand = this.convertActionToCommand(action);
    const actionStartTime = Date.now();
    const executionResult = await this.commandExecutor.executeCommand(finalCommand);
    const durationMs = Date.now() - actionStartTime;

    // Wait for action to complete
    await this.ensureActionCompleted();

    let urlAfter = this.page.url();
    let urlChanged = urlBefore !== urlAfter;

    // Recovery: action redirected to about:blank -> try to go back and mark failure
    if (urlAfter === 'about:blank' || urlAfter.startsWith('about:')) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Action redirected to about:blank', {
        testId: this.testId,
        action: action.description,
        urlBefore,
        urlAfter,
      });

      try {
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state, context.pageType);
        await this.page.goBack({
          timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
            networkSpeed: pageContext.networkSpeed,
          }),
        });
        urlAfter = this.page.url();
        urlChanged = urlBefore !== urlAfter;
        logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully navigated back from about:blank', {
          testId: this.testId,
          recoveredUrl: urlAfter,
        });
      } catch (backError) {
        logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to navigate back from about:blank', {
          testId: this.testId,
          error: backError instanceof Error ? backError.message : String(backError),
        });
      }
    }

    // Verify action success
    const aboutBlankError = (urlAfter === 'about:blank' || urlAfter.startsWith('about:'))
      ? `Action redirected to empty page (${urlAfter})`
      : undefined;
    const verification = await this.verifyActionSuccess(action, executionResult.success && !aboutBlankError);

    return {
      success: verification.success,
      error: aboutBlankError || verification.reason || executionResult.error,
      urlChanged,
      urlBefore,
      urlAfter,
      durationMs,
    };
  }

  /**
   * Handle post-action analysis
   */
  private async handlePostActionAnalysisMethod(
    action: DynamicAction,
    actionResult: ActionResult,
    context: PageContext,
    snapshotBefore: DOMSnapshot
  ): Promise<{
    shouldContinue: boolean;
    followUpActions?: DynamicAction[];
  }> {
    if (!this.shouldPerformPostAnalysis(action, {
      urlChanged: actionResult.urlChanged,
      actionSucceeded: actionResult.success,
    })) {
      return { shouldContinue: true };
    }

    const enriched = this.enrichActionForAI(action, context);

    const postActionDecision = await PostActionAnalyzer.analyze(
      this.page,
      {
        action: enriched.action,
        actionResult,
        inputValue: action.value?.toString(),
        goal: enriched.goal,
      },
      snapshotBefore,
      this.costManager
    );

    this.logPostActionAnalysis(action, {
      shouldContinue: !postActionDecision.needsFollowUp,
      reason: postActionDecision.reason,
      suggestedActions: postActionDecision.followUpActions,
      detectedChanges: postActionDecision.stateChange ? [postActionDecision.stateChange] : [],
      errorsDetected: [],
    }, this.getActionContext(context));

    return {
      shouldContinue: !postActionDecision.needsFollowUp,
      followUpActions: postActionDecision.followUpActions,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION QUALITY AND VERIFICATION METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify that action actually succeeded (not just no error)
   */
  private async verifyActionSuccess(action: DynamicAction, executionSuccess: boolean): Promise<{ success: boolean; reason?: string }> {
    if (!executionSuccess) {
      return { success: false, reason: 'Execution failed' };
    }

    // For fill/type actions, verify input value
    if ((action.action === 'fill' || action.action === 'type') && action.selector && action.value) {
      try {
        const element = getLocator(this.page, action.selector).first();
        const actualValue = await element.inputValue({ timeout: 2000 }).catch(() => '');
        const expectedValue = String(action.value);

        if (!actualValue.includes(expectedValue)) {
          return { success: false, reason: `Input value mismatch. Expected: "${expectedValue}", Got: "${actualValue}"` };
        }
      } catch (error) {
        // If inputValue fails, try textContent for contenteditable
        try {
          const textContent = await getLocator(this.page, action.selector).first().textContent({ timeout: 2000 });
          const expectedValue = String(action.value);
          if (!textContent?.includes(expectedValue)) {
            return { success: false, reason: `Text content mismatch. Expected: "${expectedValue}", Got: "${textContent || ''}"` };
          }
        } catch {
          // If both fail, assume success (element might not be an input)
        }
      }
    }

    // For select actions, verify selected value
    if (action.action === 'select' && action.selector && action.value) {
      try {
        const element = getLocator(this.page, action.selector).first();
        const selectedValue = await element.inputValue({ timeout: 2000 }).catch(() => '');
        const expectedValue = String(action.value);

        if (selectedValue !== expectedValue && !selectedValue.includes(expectedValue)) {
          return { success: false, reason: `Select value mismatch. Expected: "${expectedValue}", Got: "${selectedValue}"` };
        }
      } catch {
        // Assume success if verification fails
      }
    }

    // For check/uncheck actions, verify checkbox state
    if ((action.action === 'check' || action.action === 'uncheck') && action.selector) {
      try {
        const element = getLocator(this.page, action.selector).first();
        const isChecked = await element.isChecked({ timeout: 2000 }).catch(() => false);
        const expectedChecked = action.action === 'check';

        if (isChecked !== expectedChecked) {
          return { success: false, reason: `Checkbox state mismatch. Expected: ${expectedChecked}, Got: ${isChecked}` };
        }
      } catch {
        // Assume success if verification fails
      }
    }

    return { success: true };
  }

  /**
   * Wait for action effect to appear on page
   */
  private async waitForActionEffect(action: DynamicAction, timeout: number = 3000): Promise<void> {
    try {
      // For click actions, wait for potential navigation or state change
      if (action.action === 'click') {
        await this.page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
        await this.page.waitForTimeout(500); // Small delay for JS to execute
      }

      // For fill/type actions, wait for validation or dependent fields
      if (action.action === 'fill' || action.action === 'type') {
        await this.page.waitForTimeout(300); // Wait for validation
      }

      // For select actions, wait for dependent fields to update
      if (action.action === 'select') {
        await this.page.waitForTimeout(500); // Wait for dependent updates
      }
    } catch {
      // Ignore timeout errors
    }
  }

  /**
   * Check element state after action
   */
  private async checkElementStateAfterAction(action: DynamicAction): Promise<{
    exists: boolean;
    visible: boolean;
    enabled: boolean;
    value?: string;
  }> {
    if (!action.selector) {
      return { exists: false, visible: false, enabled: false };
    }

    try {
      const element = getLocator(this.page, action.selector).first();
      const count = await element.count();

      if (count === 0) {
        return { exists: false, visible: false, enabled: false };
      }

      const visible = await element.isVisible({ timeout: 1000 }).catch(() => false);
      const enabled = await element.isEnabled({ timeout: 1000 }).catch(() => true);

      let value: string | undefined;
      if (action.action === 'fill' || action.action === 'type' || action.action === 'select') {
        value = await element.inputValue({ timeout: 1000 }).catch(() => undefined);
      }

      return { exists: true, visible, enabled, value };
    } catch {
      return { exists: false, visible: false, enabled: false };
    }
  }

  /**
   * Ensure action completed before proceeding
   */
  private async ensureActionCompleted(): Promise<void> {
    // Wait for page to stabilize
    await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});

    // Wait for network to be idle (no pending requests)
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    // Small delay for animations/transitions
    await this.page.waitForTimeout(200);
  }

  /**
   * Handle async operations (SPA, lazy loading)
   */
  private async handleAsyncOperations(action: DynamicAction): Promise<void> {
    // For navigation-like actions, wait longer
    if (action.action === 'click' || action.action === 'goto') {
      await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    // For form actions, wait for validation
    if (action.action === 'fill' || action.action === 'type' || action.action === 'select') {
      await this.page.waitForTimeout(500); // Wait for validation/dependent fields
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ERROR HANDLING METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create error context for AI analysis
   */
  private createActionErrorContext(action: DynamicAction, error: string, context: {
    pageType: string;
    pageUrl: string;
    preAnalysis?: any;
    validation?: any;
  }): {
    action: DynamicAction;
    error: string;
    context: {
      pageType: string;
      pageUrl: string;
      testGoal: string;
      blockingFactors?: string[];
      validationMessage?: string;
      previousActions: string[];
    };
  } {
    return {
      action,
      error,
      context: {
        pageType: context.pageType,
        pageUrl: context.pageUrl,
        testGoal: this.state.goal,
        blockingFactors: context.preAnalysis?.blockingFactors?.map((bf: any) => bf.description),
        validationMessage: context.validation?.message,
        previousActions: this.state.completedActions.slice(-3).map(a => a.action.description),
      },
    };
  }

  /**
   * Determine if action should be retried
   */
  /**
   * Handle action failure with structured error reporting
   */
  private async handleActionFailure(action: DynamicAction, error: string, context: {
    pageType: string;
    pageUrl: string;
    preAnalysis?: any;
    validation?: any;
    screenshot?: string;
  }): Promise<ActionResult> {
    const errorContext = this.createActionErrorContext(action, error, context);

    // Log structured error
    this.logActionError(action, error, {
      testGoal: errorContext.context.testGoal,
      pageType: errorContext.context.pageType,
      pageUrl: errorContext.context.pageUrl,
      validationMessage: errorContext.context.validationMessage,
      blockingFactors: errorContext.context.blockingFactors,
    });

    // Create action result
    const actionResult: ActionResult = {
      action,
      success: false,
      error,
      urlChanged: false,
      urlBefore: context.pageUrl,
      urlAfter: context.pageUrl,
      screenshot: context.screenshot,
      timestamp: Date.now(),
    };

    // Update state
    this.state = StateTracker.recordActionResult(this.state, actionResult);

    return actionResult;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION AND CHECK METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Determine if screenshot should be captured for this action
   */
  private shouldCaptureScreenshot(action: DynamicAction, context: {
    isError?: boolean;
    isNavigation?: boolean;
    isBeforeAction?: boolean;
    isAfterAction?: boolean;
  }): boolean {
    // Always capture on errors
    if (context.isError) {
      return true;
    }

    // Always capture on navigation
    if (context.isNavigation) {
      return true;
    }

    // Capture before critical actions
    if (context.isBeforeAction && (action.action === 'click' || action.action === 'fill' || action.action === 'select')) {
      return true;
    }

    // Capture after actions that might change UI state
    if (context.isAfterAction && (action.action === 'click' || action.action === 'fill' || action.action === 'check' || action.action === 'uncheck')) {
      return true;
    }

    return false;
  }

  /**
   * Determine if post-action analysis should be performed
   */
  private shouldPerformPostAnalysis(action: DynamicAction, context: {
    urlChanged: boolean;
    actionSucceeded: boolean;
    isLastAction?: boolean;
  }): boolean {
    // Skip if URL changed (page navigation)
    if (context.urlChanged) {
      return false;
    }

    // Skip if action failed
    if (!context.actionSucceeded) {
      return false;
    }

    // Always analyze last action
    if (context.isLastAction) {
      return true;
    }

    // Analyze after critical actions
    const criticalActions = ['click', 'fill', 'select', 'check', 'uncheck'];
    if (criticalActions.includes(action.action)) {
      return true;
    }

    return false;
  }

  /**
   * Check if action is blocked by prerequisite conditions
   */
  private isActionBlocked(preAnalysis: {
    blockingFactors: Array<{ type: string; description: string; priority?: string }>;
    suggestedActions: DynamicAction[];
  }): boolean {
    // Check if there are any blocking factors
    if (!preAnalysis.blockingFactors || preAnalysis.blockingFactors.length === 0) {
      return false;
    }

    // Check if there are critical or high priority blocking factors
    const hasCriticalBlocking = preAnalysis.blockingFactors.some(
      bf => bf.priority === 'critical' || bf.priority === 'high'
    );

    return hasCriticalBlocking;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRUCTURED LOGGING HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Log action execution with full context
   */
  private logActionExecution(action: DynamicAction, context: {
    testGoal: string;
    pageType: string;
    pageUrl: string;
    actionIndex: number;
    totalActions: number;
    previousActions?: string[];
  }): void {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Executing action', {
      testId: this.testId,
      action: action.action,
      description: action.description,
      selector: action.selector,
      value: action.value,
      optional: action.optional,
      testGoal: context.testGoal,
      pageType: context.pageType,
      pageUrl: context.pageUrl,
      progress: `${context.actionIndex + 1}/${context.totalActions}`,
      previousActions: context.previousActions,
    });
  }

  /**
   * Log action error with full context
   */
  private logActionError(action: DynamicAction, error: string, context: {
    testGoal: string;
    pageType: string;
    pageUrl: string;
    validationPassed?: boolean;
    validationMessage?: string;
    attemptedPrerequisites?: number;
    blockingFactors?: string[];
    urlChanged?: boolean;
  }): void {
    logger.warn('[INTELLIGENT_ORCHESTRATOR] Action failed', {
      testId: this.testId,
      action: action.action,
      description: action.description,
      selector: action.selector,
      testGoal: context.testGoal,
      pageType: context.pageType,
      pageUrl: context.pageUrl,
      error,
      optional: action.optional,
      urlChanged: context.urlChanged,
      validationPassed: context.validationPassed,
      validationMessage: context.validationMessage,
      attemptedPrerequisites: context.attemptedPrerequisites,
      blockingFactors: context.blockingFactors,
    });
  }

  /**
   * Log prerequisite action execution
   */
  private logPrerequisiteAction(action: DynamicAction, context: {
    testGoal: string;
    pageType: string;
    pageUrl: string;
    blockingFactor: string;
    priority?: string;
  }): void {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Executing prerequisite action', {
      testId: this.testId,
      action: action.action,
      description: action.description,
      selector: action.selector,
      testGoal: context.testGoal,
      pageType: context.pageType,
      pageUrl: context.pageUrl,
      blockingFactor: context.blockingFactor,
      priority: context.priority || 'medium',
    });
  }

  /**
   * Log post-action analysis results
   */
  private logPostActionAnalysis(action: DynamicAction, analysis: {
    shouldContinue: boolean;
    reason?: string;
    suggestedActions?: DynamicAction[];
    detectedChanges?: string[];
    errorsDetected?: string[];
  }, context: {
    testGoal: string;
    pageType: string;
    pageUrl: string;
  }): void {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Post-action analysis', {
      testId: this.testId,
      action: action.description,
      testGoal: context.testGoal,
      pageType: context.pageType,
      pageUrl: context.pageUrl,
      shouldContinue: analysis.shouldContinue,
      reason: analysis.reason,
      suggestedActionsCount: analysis.suggestedActions?.length || 0,
      detectedChanges: analysis.detectedChanges,
      errorsDetected: analysis.errorsDetected,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Emit event via WebSocket
   * Deduplicates redundant events and only emits on state changes to reduce traffic
   */
  private lastEmittedEvent: { event: string; timestamp: number } | null = null;

  private emitEvent(event: string, data: any): void {
    if (!this.userId || !this.testId) {
      return;
    }

    // Deduplicate rapid-fire identical events to reduce WebSocket traffic
    // Skip if same event was emitted less than threshold ago
    const now = Date.now();
    const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
    const dedupWindow = AdaptiveConfigService.getThreshold('EVENT_DEDUPLICATION_WINDOW', {
      errorRate: pageContext.errorRate,
    });
    if (this.lastEmittedEvent &&
        this.lastEmittedEvent.event === event &&
        now - this.lastEmittedEvent.timestamp < dedupWindow) {
      return; // Skip duplicate
    }

    // Filter out noisy events to reduce unnecessary WebSocket messages
    // These are redundant as graph updates already show action progress
    const isCritical = this.state.completedActions.length > 0 &&
                       !this.state.completedActions[this.state.completedActions.length - 1].success;
    if (AdaptiveConfigService.isNoisyEvent(event, { isCritical })) {
      // Only emit on failures or every N actions
      const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
      const emitInterval = AdaptiveConfigService.getThreshold('NOISY_EVENT_EMIT_INTERVAL', {
        errorRate: pageContext.errorRate,
      });
      if (!event.includes('failed') && this.state.completedActions.length % emitInterval !== 0) {
        return; // Skip
      }
    }

    try {
      webSocketService.emitToUser(this.userId, 'test:progress', {
        testId: this.testId,
        event,
        data,
        timestamp: now,
      });

      this.lastEmittedEvent = { event, timestamp: now };
    } catch (error) {
      // Silent fail - don't log WebSocket errors
    }
  }

  // Emit graph update via WebSocket for real-time visualization
  // ✅ FIX: Prevents emitting after test completion
  private emitGraphUpdate(
    update: import('../utils/visualization/graph-builder.service').GraphUpdate,
    options?: { force?: boolean }
  ): void {
    // ✅ FIX: Skip if test is already completed (prevents late events from async operations)
    if (this.isTestCompleted) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] Skipping graph emit - test already completed', {
        testId: this.testId,
      });
      return;
    }

    // ✅ FIX: During finalization, block all non-forced graph updates (prevents spam from async uploads)
    if (this.isFinalizing && !options?.force) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] Skipping graph emit - finalizing', {
        testId: this.testId,
      });
      return;
    }

    if (!this.userId || !this.testId) {
      return;
    }

    // Validate update structure
    if (!update || typeof update !== 'object') {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Invalid graph update structure', {
        testId: this.testId,
      });
      return;
    }

    if (!update.type || !['full', 'incremental'].includes(update.type)) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Invalid graph update type', {
        testId: this.testId,
        type: update.type,
      });
      return;
    }

    // ✅ FIX: Strict graph update handling to prevent duplicates and syncing issues
    let normalized = { ...update };

    // 1. If type is 'full', send ONLY fullGraph to prevent duplicate processing on frontend
    if (update.type === 'full') {
      if (update.fullGraph) {
        normalized = {
          type: 'full',
          fullGraph: update.fullGraph,
          // Explicitly remove incremental data to avoid confusion/duplication
          newNode: undefined,
          newEdge: undefined,
          updatedNode: undefined,
        };

        // Sync sent sets with full graph to prevent re-sending existing nodes if we switch back to incremental
        // ✅ FIX: Use normalized.fullGraph instead of update.fullGraph for consistency
        if (normalized.fullGraph?.nodes) {
          normalized.fullGraph.nodes.forEach(n => {
            if (n?.id) {
              this.graphSentNodeIds.add(n.id);
            }
          });
        }
        if (normalized.fullGraph?.edges) {
          normalized.fullGraph.edges.forEach(e => {
            if (e?.id) {
              this.graphSentEdgeIds.add(e.id);
            }
          });
        }
      }
    } else {
      // 2. If type is 'incremental', perform deduplication

      // Check newNode duplication
      if (normalized.newNode?.id) {
        if (this.graphSentNodeIds.has(normalized.newNode.id)) {
          // Check if it's really the same node (prevent false positives if IDs are reused erroneously, though they shouldn't be)
          // For safety, we assume ID uniqueness is strict.
          normalized.newNode = undefined;
        } else {
          this.graphSentNodeIds.add(normalized.newNode.id);
        }
      }

      // Check newEdge duplication
      if (normalized.newEdge?.id) {
        if (this.graphSentEdgeIds.has(normalized.newEdge.id)) {
          normalized.newEdge = undefined;
        } else {
          this.graphSentEdgeIds.add(normalized.newEdge.id);
        }
      }
    }

    // Validate that update has at least one data field after normalization
    const hasIncrementalData = normalized.newNode || normalized.newEdge || normalized.updatedNode;
    const hasFullData = normalized.fullGraph;

    if (!hasIncrementalData && !hasFullData) {
      // Silent return if everything was filtered out (duplicate or empty)
      return;
    }

    try {
      const payload = {
        testId: this.testId,
        type: normalized.type,
        mode: 'pro' as const, // ✅ Indicate Pro mode (has screenshots)
        data: {
          newNode: normalized.newNode,
          newEdge: normalized.newEdge,
          updatedNode: normalized.updatedNode,
          fullGraph: normalized.fullGraph,
        },
        timestamp: new Date().toISOString(),
        sessionId: this.config.chatSessionId,
      };

      // ✅ Use centralized emitter for proper routing (test room + chat room)
      webSocketService.emitTestGraphUpdate(this.testId, payload as any);

      // Backward compatibility: if no chat session, still emit to user room
      if (!this.config.chatSessionId) {
        webSocketService.emitToUser(this.userId, 'test:graph-update', payload);
      }
    } catch (error) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to emit graph update', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }


  /**
   * Use centralized selector normalization from utils/selector-utils.ts (removed duplicate implementation)
   */
  // Removed: normalizeSelector() - now using utils/selector-utils.ts

  /**
   * Use centralized locator creation from utils/selector-utils.ts
   * (removed duplicate implementation)
   */
  private getLocatorWrapper(selector: string): import('playwright').Locator {
    return getLocator(this.page, selector);
  }

  // Old selector utility implementations removed - now using centralized selector-utils.ts
}
