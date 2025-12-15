/**
 * IntelligentTestOrchestrator
 * Main orchestration loop for intelligent testing
 * Manages: analyze → understand → generate → execute → validate → decide → repeat
 */

import { dbAdminService } from '@/db/supabase';
import { AICostManager, getCostManager, removeCostManager } from '@/services/ai-cost-manager.service';
import { SelfHealingService } from '@/services/ai-selector/self-healing.service'; // Self-healing service for automatic selector recovery
import { logger } from '@/utils/logger';
import { getActionEmoji, getActionIcon } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { Browser, Page } from 'playwright';
import { AdaptiveConfigService } from './adaptive-config.service'; // Adaptive configuration service for dynamic timeout and threshold management
import { CommandExecutor } from './command-executor';
import { ContextualActionGenerator } from './contextual-action-generator';
import { FormIntelligenceService } from './form-intelligence.service'; // Intelligent form handling service for validation error fixing
import { IntelligentPageAnalyzer } from './intelligent-page-analyzer';
import { MainLoopService } from './main-loop.service'; // Main testing loop service (analyze → generate → execute → decide)
import { DOMSnapshot, PostActionAnalyzer } from './post-action-analyzer'; // Post-action analysis service for detecting state changes and follow-up actions
import { PreActionAnalyzer } from './pre-action-analyzer'; // Pre-action analysis service for detecting blocking factors before execution
import { ResultValidator } from './result-validator';
import { SafetyGuard } from './safety-guard';
import { StateTracker } from './state-tracker';
import {
  ActionResult,
  DynamicAction,
  IntelligentTestConfig,
  IntelligentTestResult,
  PageContext,
  PageVisit,
  TestState,
} from './types/intelligent-testing.types';
import { ErrorCollectorService } from './utils/error-collector.service';
import { GraphBuilder } from './utils/graph-builder.service'; // Graph builder for real-time test visualization
import { TestProgressEmitter } from './utils/progress-emitter';
import { getElementDisabledContext, getLocator, normalizeSelector } from './utils/selector-utils';

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

  private async buildCancelledResult(): Promise<IntelligentTestResult> {
    const result = await this.buildResult(false);
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
      this.progressEmitter = new TestProgressEmitter(this.testId, browser, this.userId);
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

      const abortPromise = new Promise<never>((_, reject) => {
        this.abortController.signal.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true }
        );
      });

      return await Promise.race([promise, abortPromise]);
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
   */
  private async checkTestCancelled(): Promise<boolean> {
    if (!this.testId) {
      return false;
    }

    try {
      const test = await dbAdminService.getTest(this.testId) as any;
      return test?.status === 'cancelled';
    } catch (error) {
      logger.warn(`[INTELLIGENT_ORCHESTRATOR] Failed to check test status: ${this.testId}`, error);
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

    // Track all frame navigations (main frame + iframes)
    this.page.on('framenavigated', (frame) => {
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
    });

    // Track failed requests (helps debug navigation stalls and blank pages)
    this.page.on('requestfailed', (request) => {
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
    });

    // Track uncaught page errors (JS runtime)
    this.page.on('pageerror', (error) => {
      logger.warn('[NAVIGATION_TRACKER] Page error (uncaught exception)', {
        testId: this.testId,
        message: error?.message,
        stack: error?.stack,
      });
    });

    // Track and auto-dismiss dialogs (they can block automation)
    this.page.on('dialog', async (dialog) => {
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
    });

    // Track page crashes (rare but important)
    this.page.on('crash', () => {
      logger.error('[NAVIGATION_TRACKER] Page crashed', { testId: this.testId });
    });

    // Track responses to detect redirects
    this.page.on('response', (response) => {
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
    });

    // Track console errors (might indicate navigation issues)
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('navigation') || text.includes('redirect') || text.includes('about:blank')) {
          logger.warn('[NAVIGATION_TRACKER] Console error related to navigation', {
            testId: this.testId,
            error: text,
          });
        }
      }
    });

    logger.info('[NAVIGATION_TRACKER] Navigation listeners setup complete', {
      testId: this.testId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * STEP 1: Analyze current page
   */
  private async analyzePage(): Promise<PageContext> {
    const currentUrl = this.page.url();

    logger.info('[INTELLIGENT_ORCHESTRATOR] Analyzing page', {
      url: currentUrl,
    });

    // Check for about:blank before analysis and attempt recovery if detected
    if (currentUrl === 'about:blank' || currentUrl.startsWith('about:')) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Page is about:blank, attempting to navigate back', {
        testId: this.testId,
        currentUrl,
      });

      // Try to go back to previous page
      try {
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
        await this.page.goBack({
          timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
            networkSpeed: pageContext.networkSpeed,
          }),
        });
        const newUrl = this.page.url();

        if (newUrl === 'about:blank' || newUrl.startsWith('about:')) {
          // Still on about:blank, try to go to start URL
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Still on about:blank after goBack, navigating to start URL', {
            startUrl: this.config.startUrl,
          });
          const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
          await this.page.goto(this.config.startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: AdaptiveConfigService.getTimeout('NAVIGATION', {
              networkSpeed: pageContext.networkSpeed,
              hasHeavyJS: pageContext.hasHeavyJS,
            }),
          });
        }

        logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully recovered from about:blank', {
          newUrl: this.page.url(),
        });
      } catch (recoveryError) {
        logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to recover from about:blank', {
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          currentUrl,
        });
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
      });
    }

    const previousContext = this.state.visitedPages.length > 0
      ? `Previous page: ${this.state.visitedPages[this.state.visitedPages.length - 1].pageType}`
      : undefined;

    const context = await IntelligentPageAnalyzer.analyzePage(
      this.page,
      this.config.goal,
      this.config.mode,
      previousContext,
      this.config.spaLoadConfig, // Configurable SPA load settings for single-page applications
      this.state, // Pass state for history context in page analysis
      this.config.hints, // Pass hints from test plan to guide AI analysis
      this.errorCollector // Pass error collector for capturing page errors
    );

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
      });
    }

    // Convert TestHint[] to simpler format for ContextualActionGenerator
    const hints = this.config.hints?.map(h => ({
      description: h.description,
      action: h.action,
      target: h.target,
      value: h.value,
      priority: h.priority,
    }));

    // Pass cost manager and hints to action generator for cost tracking and AI guidance
    const result = await ContextualActionGenerator.generateActions(
      context,
      this.state,
      this.page,
      this.costManager,
      hints  // Pass hints for AI guidance during action generation
    );

    // Update cost
    this.state = StateTracker.updateCost(this.state, COST_ACTION_GENERATION);

    // Filter safe actions
    const safeActions: DynamicAction[] = [];

    for (const action of result.actions) {
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
    logger.info('[INTELLIGENT_ORCHESTRATOR] Executing actions', {
      count: actions.length,
    });

    // Set total actions for progress tracking
    if (this.progressEmitter) {
      this.progressEmitter.setTotalActions(actions.length);
    }

    const completedActions: ActionResult[] = [];
    let success = true;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      try {
        // Emit progress: Action execution (60-90%)
        const progress = 60 + Math.round((i / actions.length) * 30);
        this.progressEmitter?.emit({
          progress,
          phase: 'execution',
          currentStep: `${getActionEmoji(action.action)} ${action.description}...`,
          icon: getActionIcon(action.action, 'execution'),
          action: {
            type: action.action,
            description: action.description,
            target: action.selector,
          },
          completedSteps: i,
        });

        // Log detailed action information before execution for debugging
        logger.info('[INTELLIGENT_ORCHESTRATOR] Executing action (FINAL COMMAND)', {
          testId: this.testId,
          actionIndex: i + 1,
          totalActions: actions.length,
          action: {
            type: action.action,
            selector: action.selector,
            normalizedSelector: action.selector ? normalizeSelector(action.selector) : undefined,
            value: action.value,
            description: action.description,
            expectedResult: action.expectedResult,
            optional: action.optional,
            timeout: action.timeout,
            retry: action.retry,
          },
          progress: `${i + 1}/${actions.length}`,
        });

        this.emitEvent('action_executing', {
          action: action.description,
        });

        const urlBefore = this.page.url();

        logger.debug('[INTELLIGENT_ORCHESTRATOR] Before action execution', {
          testId: this.testId,
          action: action.description,
          urlBefore,
          actionType: action.action,
        });

        // ═══════════════════════════════════════════════════════════════════════════
        // PRE-ACTION ANALYSIS: Analyzes page state BEFORE action to prevent failures
        // Detects blocking factors (disabled elements, missing fields) and suggests fixes
        // ═══════════════════════════════════════════════════════════════════════════
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state, context.pageType);
        let preAnalysis: import('./pre-action-analyzer').PreActionAnalysis | undefined;

        if (action.selector && AdaptiveConfigService.requiresPreActionAnalysis(action, {
          pageType: context.pageType,
          hasForm: (context.dom?.forms?.length || 0) > 0,
          isSlowPage: pageContext.isSlowPage,
        })) {
          // Enhance action with test context for better AI understanding
          const actionWithContext = {
            ...action,
            // Add test goal context to action description for AI analysis
            description: action.description || `${action.action} on ${action.selector}`,
            // Store context in action metadata (if supported by type)
            metadata: {
              testGoal: this.state.goal,
              pageType: context.pageType,
              pageUrl: context.url,
              previousActions: this.state.completedActions.slice(-3).map(a => a.action.description),
            },
          } as DynamicAction & { metadata?: any };

          preAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, actionWithContext);

          // If there are blocking factors, try to resolve them first
          if (!preAnalysis.canProceed && preAnalysis.suggestedActions.length > 0) {
            // Enhanced logging with context for AI understanding
            logger.info('[INTELLIGENT_ORCHESTRATOR] Pre-action analysis found blocking factors', {
              testId: this.testId,
              action: action.description,
              testGoal: this.state.goal,
              pageType: context.pageType,
              pageUrl: context.url,
              blockingFactors: preAnalysis.blockingFactors.map(bf => ({
                type: bf.type,
                description: bf.description,
                priority: bf.priority || 'medium',
                hasSuggestedActions: (bf.suggestedActions?.length || 0) > 0,
              })),
              suggestedActionsCount: preAnalysis.suggestedActions.length,
              context: preAnalysis.context,
            });

            // Execute suggested prerequisite actions (e.g., fill required fields)
            // Sort by priority if available (critical first)
            const sortedPrereqActions = [...preAnalysis.suggestedActions].sort((a, b) => {
              const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
              const aPriority = (a as any).priority || 'medium';
              const bPriority = (b as any).priority || 'medium';
              return (priorityOrder[aPriority as keyof typeof priorityOrder] || 2) -
                     (priorityOrder[bPriority as keyof typeof priorityOrder] || 2);
            });

            for (let prereqIdx = 0; prereqIdx < sortedPrereqActions.length; prereqIdx++) {
              const prereqAction = sortedPrereqActions[prereqIdx];
              try {
                // Enhanced logging with context for AI understanding
                logger.info('[INTELLIGENT_ORCHESTRATOR] Executing prerequisite action', {
                  testId: this.testId,
                  prereqAction: prereqAction.description,
                  forAction: action.description,
                  testGoal: this.state.goal,
                  priority: (prereqAction as any).priority || 'medium',
                  progress: `${prereqIdx + 1}/${sortedPrereqActions.length}`,
                  pageType: context.pageType,
                });

                // Convert to PlaywrightCommand and execute
                const prereqCommand = this.convertActionToCommand(prereqAction);
                const prereqResult = await this.commandExecutor.executeCommand(prereqCommand);

                if (prereqResult.success) {
                  logger.info('[INTELLIGENT_ORCHESTRATOR] Prerequisite action succeeded', {
                    prereqAction: prereqAction.description,
                  });

                  // Record prerequisite action
                  completedActions.push({
                    action: prereqAction,
                    success: true,
                    urlChanged: false,
                    urlBefore,
                    urlAfter: this.page.url(),
                    timestamp: Date.now(),
                  });
                } else {
                  logger.warn('[INTELLIGENT_ORCHESTRATOR] Prerequisite action failed', {
                    prereqAction: prereqAction.description,
                    error: prereqResult.error,
                  });
                }

                // Small delay between prerequisite actions (reuse outer pageContext)
                await this.page.waitForTimeout(
                  AdaptiveConfigService.getTimeout('PREREQUISITE_ACTION_DELAY', {
                    isSlowPage: pageContext.isSlowPage,
                  })
                );
              } catch (prereqError) {
                logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to execute prerequisite action', {
                  prereqAction: prereqAction.description,
                  error: prereqError instanceof Error ? prereqError.message : String(prereqError),
                });
              }
            }

            // Re-analyze after prerequisite actions
            const reAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, actionWithContext);
            if (!reAnalysis.canProceed) {
              // Enhanced logging with context for AI understanding
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Still cannot proceed after prerequisites', {
                testId: this.testId,
                action: action.description,
                testGoal: this.state.goal,
                pageType: context.pageType,
                prerequisitesExecuted: sortedPrereqActions.length,
                remainingBlockers: reAnalysis.blockingFactors.map(bf => ({
                  type: bf.type,
                  description: bf.description,
                  priority: bf.priority || 'medium',
                  context: bf.context,
                })),
                context: reAnalysis.context,
              });

              // If still blocked and action is not optional, skip it
              if (!action.optional) {
                completedActions.push({
                  action,
                  success: false,
                  error: `Blocked: ${reAnalysis.blockingFactors.map(bf => bf.description).join(', ')}`,
                  urlChanged: false,
                  urlBefore,
                  urlAfter: urlBefore,
                  timestamp: Date.now(),
                });
                continue; // Skip to next action
              }
            }
          }

          // Log validation errors if any with enhanced context
          if (preAnalysis.validationErrors.length > 0) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Validation errors detected before action', {
              testId: this.testId,
              action: action.description,
              testGoal: this.state.goal,
              pageType: context.pageType,
              pageUrl: context.url,
              errors: preAnalysis.validationErrors,
              requiredFields: preAnalysis.requiredFields.map(f => ({
                selector: f.selector,
                label: f.label,
                isEmpty: f.isEmpty,
              })),
            });
          }
        }

        // Validate selector exists AND is visible/actionable before execution
        const normalizedSelectorForReliability = action.selector ? normalizeSelector(action.selector) : '';
        const selectorReliability = normalizedSelectorForReliability && this.selectorFailures.has(normalizedSelectorForReliability)
          ? 'low' as const
          : 'high' as const;
        if (action.selector && AdaptiveConfigService.requiresSelectorValidation(action, {
          pageType: context.pageType,
          selectorReliability,
        })) {
          try {
            // Normalize selector format before using (convert getByText('text') → text="text")
            const normalizedSelector = normalizeSelector(action.selector);
            // Use getLocator() helper to support text=, role=, label= formats
            const locator = this.getLocatorWrapper(normalizedSelector);
            const elementCount = await locator.count();

            if (elementCount === 0) {
              // Track selector failures to prevent infinite loops
              const failureCount = (this.selectorFailures.get(normalizedSelector) || 0) + 1;
              this.selectorFailures.set(normalizedSelector, failureCount);

              let healingSuccessful = false;

              // Try self-healing before giving up (only on first failure)
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
                    // Try with healed selector
                    const healedNormalized = normalizeSelector(healingResult.newSelector);
                    const healedLocator = getLocator(this.page, healedNormalized);
                    const healedCount = await healedLocator.count();

                    if (healedCount > 0) {
                      logger.info('[INTELLIGENT_ORCHESTRATOR] Self-healing successful, using healed selector', {
                        testId: this.testId,
                        oldSelector: normalizedSelector,
                        newSelector: healingResult.newSelector,
                        normalizedNewSelector: healedNormalized,
                        confidence: healingResult.diff.confidence,
                      });

                      // Update action with healed selector
                      action.selector = healingResult.newSelector;
                      // Reset failure count for healed selector
                      this.selectorFailures.delete(normalizedSelector);
                      healingSuccessful = true;
                      // Continue with execution using healed selector
                    } else {
                      logger.warn('[INTELLIGENT_ORCHESTRATOR] Healed selector also not found', {
                        testId: this.testId,
                        healedSelector: healingResult.newSelector,
                      });
                    }
                  }
                } catch (healingError) {
                  logger.debug('[INTELLIGENT_ORCHESTRATOR] Self-healing failed', {
                    testId: this.testId,
                    error: healingError instanceof Error ? healingError.message : String(healingError),
                  });
                }
              }

              // If healing was successful, continue with execution (skip error handling)
              if (healingSuccessful) {
                // Action selector has been updated, continue to execution
              } else {
                // If still not found (or healing failed), check failure threshold
                const maxFailures = AdaptiveConfigService.getThreshold('MAX_SELECTOR_FAILURES', {
                  testMode: this.config.mode,
                  hasManySelectors: pageContext.hasManySelectors,
                  errorRate: pageContext.errorRate,
                });

                if (failureCount >= maxFailures) {
                  logger.error('[INTELLIGENT_ORCHESTRATOR] Selector failed too many times, skipping permanently', {
                    testId: this.testId,
                    selector: normalizedSelector,
                    failureCount,
                  });

                  // Mark as optional and skip
                  const actionResult: ActionResult = {
                    action: { ...action, selector: normalizedSelector },
                    success: false,
                    error: `Selector not found: ${normalizedSelector} (failed ${failureCount} times)`,
                    urlChanged: false,
                    urlBefore,
                    urlAfter: urlBefore,
                    timestamp: Date.now(),
                  };

                  completedActions.push(actionResult);
                  this.state = StateTracker.recordActionResult(this.state, actionResult);
                  action.optional = true;
                  continue;
                }

                // First failure and healing didn't work - mark as optional and skip
                logger.warn('[INTELLIGENT_ORCHESTRATOR] Selector not found, marking action as optional', {
                  testId: this.testId,
                  action: action.description,
                  selector: action.selector,
                  normalizedSelector,
                  failureCount,
                  maxFailures,
                });

                const actionResult: ActionResult = {
                  action: { ...action, selector: normalizedSelector },
                  success: false,
                  error: `Selector not found: ${normalizedSelector} (failed ${failureCount} times)`,
                  urlChanged: false,
                  urlBefore,
                  urlAfter: urlBefore,
                  timestamp: Date.now(),
                };

                completedActions.push(actionResult);
                this.state = StateTracker.recordActionResult(this.state, actionResult);
                action.optional = true;
                continue; // Skip this action
              }
            } else {
              // Reset failure count if selector works
              this.selectorFailures.delete(normalizedSelector);
            }

            // For click actions, also check if element is visible and actionable
            if (action.action === 'click') {
              try {
                // Wait for element to be visible and actionable (reuse outer pageContext)
                await locator.waitFor({
                  state: 'visible',
                  timeout: AdaptiveConfigService.getTimeout('ELEMENT_VISIBILITY', {
                    isSlowPage: pageContext.isSlowPage,
                    networkSpeed: pageContext.networkSpeed,
                  }),
                }).catch(() => {
                  throw new Error('Element not visible');
                });

                // Check if element is actionable (not covered by other elements)
                // Use first() to get single element for evaluate
                const firstLocator = locator.first();
                const isActionable = await firstLocator.evaluate((el) => {
                  // @ts-ignore - browser context
                  const rect = el.getBoundingClientRect();
                  const centerX = rect.left + rect.width / 2;
                  const centerY = rect.top + rect.height / 2;
                  // @ts-ignore - browser context
                  const topElement = document.elementFromPoint(centerX, centerY);
                  return topElement === el || el.contains(topElement);
                }).catch(() => false);

                if (!isActionable) {
                  logger.warn('[INTELLIGENT_ORCHESTRATOR] Element found but not actionable (covered by another element)', {
                    testId: this.testId,
                    action: action.description,
                    selector: normalizedSelector,
                  });
                  // Don't skip - try to click anyway, might work
                }
              } catch (visibilityError) {
                logger.warn('[INTELLIGENT_ORCHESTRATOR] Element not visible or actionable', {
                  testId: this.testId,
                  selector: normalizedSelector,
                  error: visibilityError instanceof Error ? visibilityError.message : String(visibilityError),
                });
                // Continue anyway - might become visible during click
              }
            }
          } catch (selectorError) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Selector validation failed', {
              testId: this.testId,
              selector: action.selector,
              normalizedSelector: normalizeSelector(action.selector),
              error: selectorError instanceof Error ? selectorError.message : String(selectorError),
            });
            // Continue anyway - might be a valid selector that just needs more time
          }
        }

        // Smart screenshot capture - only when necessary to reduce storage and processing overhead
        // BEFORE optimization: 2-3 screenshots per action (before + after + page analysis)
        // AFTER optimization: 0-1 screenshots per action (only when needed)
        //
        // Strategy:
        // - Before: Only for navigation actions (to show state before page change)
        // - After: Only on errors OR page navigation OR button interactions (to show what went wrong/changed)
        // - Page analysis: Already captured once per page (in analyzePage)
        //
        // Expected reduction: ~60-70% fewer screenshots
        let screenshotBefore: string | undefined;
        let screenshotAfter: string | undefined;
        let screenshotBeforeIndex: number | undefined;
        let screenshotAfterIndex: number | undefined;

        // Capture BEFORE screenshot only for navigation actions
        const isNavigationAction = action.action === 'click' && action.description?.toLowerCase().includes('link');
        if (isNavigationAction) {
          try {
            const screenshotBuffer = await this.page.screenshot({
              fullPage: false,
              type: 'png',
            });
            screenshotBefore = screenshotBuffer.toString('base64');
            this.screenshotMetrics.beforeActions++;
            this.screenshotMetrics.totalCaptured++;
            screenshotBeforeIndex = this.screenshotMetrics.totalCaptured;
            logger.debug('[INTELLIGENT_ORCHESTRATOR] Captured before screenshot for navigation', {
              action: action.description,
              totalScreenshots: this.screenshotMetrics.totalCaptured
            });
          } catch (error) {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to capture before screenshot', {
              action: action.description
            });
          }
        }

        // Check if element is disabled BEFORE attempting action to provide better error context
        // If disabled, log detailed context for debugging
        if (action.selector && (action.action === 'click' || action.action === 'fill')) {
          const disabledContext = await getElementDisabledContext(this.page, action.selector);

          if (disabledContext.isDisabled) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Element is DISABLED', {
              testId: this.testId,
              action: action.description,
              selector: action.selector,
              reason: disabledContext.reason,
              formValidation: disabledContext.context?.formValidation,
              authRequired: disabledContext.context?.authRequired,
              dependsOn: disabledContext.context?.dependsOn,
              alternatives: disabledContext.alternatives,
            });

            // Strategy: Instead of generating new actions mid-execution,
            // let the action fail naturally and let the AI decide next steps
            // in the next iteration (via decideNextStep)

            // Add detailed context to action for better error reporting
            action.description = `${action.description} [DISABLED: ${disabledContext.reason}]`;

            // Log suggestions for next AI iteration
            if (disabledContext.context?.dependsOn && disabledContext.context.dependsOn.length > 0) {
              logger.info('[INTELLIGENT_ORCHESTRATOR] Suggestion: Fill these fields first', {
                testId: this.testId,
                dependsOn: disabledContext.context.dependsOn,
              });
            }

            if (disabledContext.alternatives && disabledContext.alternatives.length > 0) {
              logger.info('[INTELLIGENT_ORCHESTRATOR] Suggestion: Try alternative selectors', {
                testId: this.testId,
                alternatives: disabledContext.alternatives,
              });
            }

            // Continue with execution - it will fail, and AI will adapt in next iteration
          }
        }

        // Capture DOM snapshot BEFORE action for post-action analysis
        let snapshotBefore: DOMSnapshot | undefined;
        const shouldDoPostAnalysis = ['fill', 'type', 'click', 'select'].includes(action.action);
        if (shouldDoPostAnalysis) {
          snapshotBefore = await PostActionAnalyzer.captureSnapshot(this.page).catch(() => undefined);
        }

        // Execute action using CommandExecutor
        // Pass original selector - CommandExecutor will normalize it ONCE via prepareSelector()
        // DON'T normalize here to avoid double-processing!
        // Determine assertion type based on action type
        let assertionType: 'visible' | 'hidden' | 'text' | 'value' | 'count' | 'url' | 'enabled' | 'disabled' = 'text';
        if (action.action === 'assertVisible') assertionType = 'visible';
        else if (action.action === 'assertText') assertionType = 'text';
        else if (action.action === 'assertValue') assertionType = 'value';
        else if (action.action === 'assertUrl') assertionType = 'url';
        else if (action.action === 'assertCount') assertionType = 'count';

        const finalCommand: import('@/types').PlaywrightCommand = {
          action: action.action as any,
          selector: action.selector,
          value: action.value,
          url: action.url,
          timeout: action.timeout,
          description: action.description,
          extract: action.extract,
          assertion: action.assertion ? {
            type: assertionType,
            expected: action.assertion.expected,
            operator: action.assertion.operator,
          } : undefined,
        };

        // Log final command before execution for debugging
        logger.info('[INTELLIGENT_ORCHESTRATOR] Final Playwright command to execute', {
          testId: this.testId,
          command: {
            action: finalCommand.action,
            selector: {
              original: finalCommand.selector,
              normalized: finalCommand.selector ? normalizeSelector(finalCommand.selector) : undefined,
            },
            value: finalCommand.value,
            url: finalCommand.url,
            timeout: finalCommand.timeout,
            description: finalCommand.description,
            extract: finalCommand.extract,
            assertion: finalCommand.assertion,
          },
        });

        // Measure action execution duration for performance tracking
        const actionStartTime = Date.now();
        const executionResult = await this.commandExecutor.executeCommand(finalCommand);
        const actionDurationMs = Date.now() - actionStartTime;

        // Smart waiting - only wait if URL changed (page navigation) to reduce unnecessary delays
        const urlAfter = this.page.url();
        const urlChanged = urlBefore !== urlAfter;

        // Wait only if page navigation occurred (new page needs to stabilize)
        if (urlChanged) {
          // Wait for new page to stabilize
          const stabilizeTimeout = AdaptiveConfigService.getTimeout('ELEMENT_VISIBILITY', {
            isSlowPage: pageContext.isSlowPage,
            networkSpeed: pageContext.networkSpeed,
          });
          await this.page.waitForLoadState('domcontentloaded', { timeout: stabilizeTimeout }).catch(() => {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] DOM not fully loaded after navigation, continuing anyway');
          });
        }
        // No delay needed for same-page actions (most actions don't need delay)

        // Capture AFTER screenshot only in critical cases to reduce storage usage:
        // 1. Action failed (to debug what went wrong)
        // 2. URL changed (new page loaded, need to capture it)
        // 3. Action was a click on a button (might show modal/message)
        const shouldCaptureAfter = !executionResult.success ||
                                    urlChanged ||
                                    (action.action === 'click' && !isNavigationAction);

        if (shouldCaptureAfter) {
          try {
            const screenshotBuffer = await this.page.screenshot({
              fullPage: false,
              type: 'png',
            });
            screenshotAfter = screenshotBuffer.toString('base64');

            // Track metrics
            this.screenshotMetrics.afterActions++;
            this.screenshotMetrics.totalCaptured++;
            screenshotAfterIndex = this.screenshotMetrics.totalCaptured;
            if (!executionResult.success) {
              this.screenshotMetrics.onErrors++;
            }
            if (urlChanged) {
              this.screenshotMetrics.onNavigation++;
            }

            const reason = !executionResult.success ? 'error' :
                          urlChanged ? 'navigation' : 'interaction';
            logger.debug('[INTELLIGENT_ORCHESTRATOR] Captured after screenshot', {
              action: action.description,
              reason,
              totalScreenshots: this.screenshotMetrics.totalCaptured
            });
          } catch (error) {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to capture after screenshot', {
              action: action.description
            });
          }
        }

        logger.debug('[INTELLIGENT_ORCHESTRATOR] After action execution', {
          testId: this.testId,
          action: action.description,
          urlBefore,
          urlAfter,
          urlChanged,
          executionSuccess: executionResult.success,
        });

        // Check if action redirected to about:blank and attempt recovery
        if (urlAfter === 'about:blank' || urlAfter.startsWith('about:')) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Action redirected to about:blank', {
            testId: this.testId,
            action: action.description,
            urlBefore,
            urlAfter,
          });

          // Try to go back
          try {
            await this.page.goBack({
              timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
                networkSpeed: pageContext.networkSpeed,
              }),
            });
            logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully navigated back from about:blank');
          } catch (backError) {
            logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to navigate back from about:blank', {
              error: backError instanceof Error ? backError.message : String(backError),
            });
          }

          // Mark action as failed
          const actionResult: ActionResult = {
            action,
            success: false,
            error: `Action redirected to empty page (${urlAfter})`,
            urlChanged: true,
            urlBefore,
            urlAfter,
            timestamp: Date.now(),
          };

          completedActions.push(actionResult);
          this.state = StateTracker.recordActionResult(this.state, actionResult);

          this.emitEvent('action_failed', {
            action: action.description,
            error: `Redirected to empty page: ${urlAfter}`,
          });

          // Stop executing remaining actions - we're on invalid page
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Stopping action execution due to about:blank redirect');
          break;
        }

        // Create preliminary action result
        const preliminaryResult: ActionResult = {
          action,
          success: executionResult.success,
          error: executionResult.error,
          urlChanged,
          urlBefore,
          urlAfter,
          timestamp: Date.now(),
        };

        // Validate result
        const validation = await ResultValidator.validateResult(
          action,
          preliminaryResult,
          this.page
        );

        // Log validation details for debugging
        logger.info('[INTELLIGENT_ORCHESTRATOR] Validation result', {
          testId: this.testId,
          action: action.description,
          validation: {
            passed: validation.passed,
            valid: validation.valid,
            expected: validation.expected,
            actual: validation.actual,
            message: validation.message,
          },
          actionExpectedResult: action.expectedResult,
        });

        const validationPassed = validation.passed;
        const validationMessage = validation.message || (!validation.passed ? 'Validation failed' : undefined);

        const actionResult: ActionResult = {
          action,
          success: executionResult.success && (validationPassed || false),
          error: executionResult.success ? (validationPassed ? undefined : validationMessage) : (executionResult.error || 'Execution failed'),
          urlChanged,
          urlBefore,
          urlAfter,
          timestamp: Date.now(),
        };

        completedActions.push(actionResult);
        this.state = StateTracker.recordActionResult(this.state, actionResult);

        // Emit test:progress update after each action completion
        if (this.progressEmitter) {
          const progress = 60 + Math.round(((i + 1) / actions.length) * 30);
          this.progressEmitter.emit({
            progress,
            phase: 'execution',
            currentStep: actionResult.success
              ? `✅ ${getActionEmoji(action.action)} ${action.description}`
              : `❌ ${getActionEmoji(action.action)} ${action.description} (failed)`,
            icon: getActionIcon(action.action, 'execution'),
            action: {
              type: action.action,
              description: action.description,
              target: action.selector,
            },
            completedSteps: i + 1,
            status: actionResult.success ? 'running' : 'failed',
          });
        }

        // Also emit via WebSocket for test:update compatibility
        if (this.testId) {
          webSocketService.emitTestProgress(this.testId, {
            testId: this.testId,
            browser: this.config.browser || 'chrome',
            progress: 60 + Math.round(((i + 1) / actions.length) * 30),
            phase: 'execution',
            currentStep: actionResult.success
              ? `✅ ${action.description}`
              : `❌ ${action.description} (failed)`,
            icon: getActionIcon(action.action, 'execution'),
            action: {
              type: action.action,
              description: action.description,
              target: action.selector,
            },
            totalSteps: actions.length,
            completedSteps: i + 1,
            status: actionResult.success ? 'running' : 'failed',
            timestamp: new Date().toISOString(),
            userId: this.userId, // Include userId for WebSocket user room broadcast
          });
        }

        // Add action to graph and emit real-time update to frontend
        if (this.testId && this.userId && this.graphBuilder) {
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

          const graphUpdate = this.graphBuilder.addActionNode(action, {
            success: actionResult.success,
            error: actionResult.error,
            durationMs: actionDurationMs, // Include actual execution duration in graph node
            urlChanged: actionResult.urlChanged,
            urlBefore: actionResult.urlBefore,
            urlAfter: actionResult.urlAfter,
            retryCount: actionResult.retryCount,
            isTimeout: (actionResult.error?.toLowerCase() ?? '').includes('timeout'),
            // Include validation data in graph node metadata
            validation: {
              expected: validation.expected,
              actual: validation.actual,
              passed: validation.passed,
              message: validation.message,
            },
            // Keep screenshots in graph builder for final graph persistence (base64),
            // but sanitize them out of WebSocket payloads (we will stream URLs later).
            screenshotBefore,
            screenshotAfter,
          });
          this.emitGraphUpdate({
            ...graphUpdate,
            newNode: sanitizeNodeScreenshots(graphUpdate.newNode),
          });

          // Upload screenshots immediately and emit URL updates via WebSocket (small payload).
          // We keep real-time graph updates fast by sending screenshots later as `updatedNode`.
          const nodeId = graphUpdate.newNode?.id;
          if (nodeId && (screenshotBefore || screenshotAfter)) {
            const testId = this.testId;
            const userId = this.userId;
            const beforeBase64 = screenshotBefore;
            const afterBase64 = screenshotAfter;
            const beforeIdx = screenshotBeforeIndex;
            const afterIdx = screenshotAfterIndex;

            void (async () => {
              const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

              if (beforeBase64 && beforeIdx !== undefined) {
                try {
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

        // Log action result (success/failure) with enhanced context for AI understanding
        if (!actionResult.success) {
          success = false;
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Action failed', {
            testId: this.testId,
            action: action.action,
            description: action.description,
            testGoal: this.state.goal,
            pageType: context.pageType,
            pageUrl: context.url,
            error: actionResult.error,
            optional: action.optional,
            urlChanged: actionResult.urlChanged,
            validationPassed: validation.passed,
            validationMessage: validation.message,
            // Include context about what was tried
            attemptedPrerequisites: preAnalysis?.suggestedActions.length || 0,
            blockingFactors: preAnalysis?.blockingFactors.map((bf: any) => bf.description) || [],
          });

          // If action is not optional, consider stopping
          if (!action.optional) {
            logger.error('[INTELLIGENT_ORCHESTRATOR] Critical action failed', {
              testId: this.testId,
              action: action.description,
              error: actionResult.error,
            });

            this.emitEvent('action_failed', {
              action: action.description,
              error: actionResult.error,
            });

            break;
          }
        } else {
          this.emitEvent('action_completed', {
            action: action.description,
          });
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // POST-ACTION ANALYSIS: Check for errors after action execution
        // ═══════════════════════════════════════════════════════════════════════════
        const isSubmitAction = action.action === 'click' && action.description?.toLowerCase().includes('submit');
        if (AdaptiveConfigService.requiresPostActionAnalysis(action, {
          pageType: context.pageType,
          hasForm: (context.dom?.forms?.length || 0) > 0,
          isSubmitAction,
        })) {
          // Enhance action with context for post-action analysis
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
            // Enhanced logging with context for AI understanding
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

            // ═══════════════════════════════════════════════════════════════════════════
            // FORM INTELLIGENCE: Try to fix validation errors using AI
            // ═══════════════════════════════════════════════════════════════════════════
            if (action.selector && postAnalysis.errors.length > 0) {
              await this.tryFixValidationErrors(action, postAnalysis.errors);
            }

            // If action seemed successful but page shows errors, mark it as failed
            if (actionResult.success) {
              actionResult.success = false;
              actionResult.error = `Validation error after action: ${postAnalysis.errors.join(', ')}`;

              // Update state
              this.state = StateTracker.recordActionResult(this.state, actionResult);

              this.emitEvent('action_failed', {
                action: action.description,
                error: actionResult.error,
              });
            }
          }

          // ═══════════════════════════════════════════════════════════════════════════
          // AI-DRIVEN POST-ACTION ANALYSIS: Analyzes state changes and suggests follow-up actions
          // Analyzes what changed and decides if follow-up actions are needed
          // ═══════════════════════════════════════════════════════════════════════════
          if (shouldDoPostAnalysis && actionResult.success && !urlChanged) {
            try {
              // Enhanced context for post-action analysis
              // Note: PostActionContext doesn't support pageContext, but goal and action context are sufficient
              const postActionDecision = await PostActionAnalyzer.analyze(
                this.page,
                {
                  action: {
                    ...action,
                    // Enhance action description with context for AI
                    description: `${action.description} [Page: ${context.pageType}, Goal: ${this.state.goal}]`,
                  },
                  actionResult,
                  inputValue: action.value?.toString(),
                  goal: `${this.state.goal} | Current page: ${context.pageType} | URL: ${context.url}`,
                },
                snapshotBefore,
                this.costManager
              );

              // Execute follow-up actions if AI decided they're needed
              if (postActionDecision.needsFollowUp && postActionDecision.followUpActions.length > 0) {
                // Enhanced logging with context for AI understanding
                logger.info('[INTELLIGENT_ORCHESTRATOR] Executing AI-decided follow-up actions', {
                  testId: this.testId,
                  testGoal: this.state.goal,
                  pageType: context.pageType,
                  originalAction: action.description,
                  reason: postActionDecision.reason,
                  stateChange: postActionDecision.stateChange,
                  followUpCount: postActionDecision.followUpActions.length,
                  confidence: postActionDecision.confidence,
                });

                for (const followUpAction of postActionDecision.followUpActions) {
                  try {
                    const followUpResult = await this.commandExecutor.executeCommand({
                      action: followUpAction.action as any,
                      selector: followUpAction.selector,
                      value: followUpAction.value,
                      timeout: followUpAction.timeout || 3000,
                      description: followUpAction.description,
                    });

                    logger.debug('[INTELLIGENT_ORCHESTRATOR] Follow-up action result', {
                      description: followUpAction.description,
                      success: followUpResult.success,
                    });

                    // Record follow-up action
                    const followUpUrlAfter = this.page.url();
                    completedActions.push({
                      action: followUpAction,
                      success: followUpResult.success,
                      error: followUpResult.error,
                      urlChanged: false, // Follow-up actions don't cause navigation
                      urlBefore: followUpUrlAfter,
                      urlAfter: followUpUrlAfter,
                      timestamp: Date.now(),
                    });
                  } catch (followUpError) {
                    logger.debug('[INTELLIGENT_ORCHESTRATOR] Follow-up action failed', {
                      description: followUpAction.description,
                      error: followUpError instanceof Error ? followUpError.message : String(followUpError),
                    });
                  }
                }
              }
            } catch (postAnalysisError) {
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Post-action analysis failed', {
                error: postAnalysisError instanceof Error ? postAnalysisError.message : String(postAnalysisError),
              });
            }
          }

          // ═══════════════════════════════════════════════════════════════════════════
          // FORM INTELLIGENCE: Wait for conditional fields after fill/select actions
          // ═══════════════════════════════════════════════════════════════════════════
          const formAnalysis = await PreActionAnalyzer.analyzeFormBeforeSubmit(
            this.page,
            action.selector || '',
            { useIntelligence: true, url: this.page.url() }
          ).catch(() => null);
          if (AdaptiveConfigService.triggersConditionalFields(action, {
            pageType: context.pageType,
            hasForm: (context.dom?.forms?.length || 0) > 0,
            formType: formAnalysis ? 'unknown' : undefined, // Could be enhanced with FormIntelligence
          }) && actionResult.success) {
            await this.handleConditionalFieldsAfterAction(action);
          }
        }

        // If URL changed significantly, we're on a new page - stop current batch
        if (urlChanged) {
          logger.info('[INTELLIGENT_ORCHESTRATOR] Page changed, ending action batch');
          break;
        }
      } catch (error) {
        // Enhanced error logging for action execution failures
        logger.error('[INTELLIGENT_ORCHESTRATOR] Action execution error', {
          testId: this.testId,
          action: {
            type: action.action,
            description: action.description,
            selector: action.selector,
            optional: action.optional,
          },
          currentUrl: this.page.url(),
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
          } : String(error),
        });

        success = false;

        if (!action.optional) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Required action failed, stopping', {
            testId: this.testId,
            action: action.description,
          });
          break;
        } else {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Optional action failed, continuing', {
            testId: this.testId,
            action: action.description,
          });
        }
      }
    }

    return {
      url: context.url,
      pageType: context.pageType,
      timestamp: context.timestamp,
      actions, // Planned actions
      actionResults: completedActions, // Actual execution results
      success,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert DynamicAction to PlaywrightCommand for execution
   */
  private convertActionToCommand(action: DynamicAction): import('@/types').PlaywrightCommand {
    // Don't normalize selector here - CommandExecutor.prepareSelector() will do it ONCE to avoid double-processing
    return {
      action: action.action as import('@/types').PlaywrightActionType,
      selector: action.selector,
      value: action.value,
      url: action.url,
      description: action.description,
      timeout: action.timeout || AdaptiveConfigService.getTimeout('NAVIGATION', {
        networkSpeed: AdaptiveConfigService.analyzePageContext(this.state).networkSpeed,
      }),
      continueOnError: action.optional || false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: FORM INTELLIGENCE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Try to fix validation errors using Form Intelligence
   */
  private async tryFixValidationErrors(
    action: DynamicAction,
    errors: string[]
  ): Promise<void> {
    try {
      // Get the form analysis
      const formAnalysis = action.selector
        ? await PreActionAnalyzer.analyzeFormBeforeSubmit(this.page, action.selector, {
            useIntelligence: false,
            url: this.page.url(),
          })
        : null;

      if (!formAnalysis || formAnalysis.fields.length === 0) {
        return;
      }

      // Try to fix each error
      const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
      const maxErrorsToFix = AdaptiveConfigService.getThreshold('MAX_VALIDATION_ERRORS_TO_FIX', {
        errorRate: pageContext.errorRate,
      });
      for (const error of errors.slice(0, maxErrorsToFix)) {
        // Find the field that might be causing this error
        const relatedField = formAnalysis.fields.find(f =>
          f.hasError || error.toLowerCase().includes(f.label.toLowerCase())
        );

        if (relatedField) {
          const fix = await FormIntelligenceService.fixValidationError(
            error,
            relatedField,
            formAnalysis.fields
          );

          // Reuse pageContext from above
          const confidenceThreshold = AdaptiveConfigService.getThreshold('VALIDATION_FIX_CONFIDENCE_THRESHOLD', {
            errorRate: pageContext.errorRate,
          });
          if (fix && fix.confidence >= confidenceThreshold) {
            logger.info('[INTELLIGENT_ORCHESTRATOR] Attempting to fix validation error', {
              testId: this.testId,
              error,
              field: relatedField.label,
              newValue: fix.value.substring(0, 20) + '...', // Log partial value for privacy
              confidence: fix.confidence,
            });

            // Apply the fix
            try {
              const fixCommand = this.convertActionToCommand({
                action: 'fill',
                selector: relatedField.selector,
                value: fix.value,
                description: `Fix: ${relatedField.label}`,
              });

              const fixResult = await this.commandExecutor.executeCommand(fixCommand);

              if (fixResult.success) {
                logger.info('[INTELLIGENT_ORCHESTRATOR] Successfully fixed validation error', {
                  testId: this.testId,
                  field: relatedField.label,
                });

                // Small delay for validation to run (reuse pageContext)
                await this.page.waitForTimeout(
                  AdaptiveConfigService.getTimeout('VALIDATION_DELAY', {
                    isSlowPage: pageContext.isSlowPage,
                  })
                );
              }
            } catch (fixError) {
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to apply fix', {
                error: fixError instanceof Error ? fixError.message : String(fixError),
              });
            }
          }
        }
      }
    } catch (error) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] tryFixValidationErrors failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle conditional fields that may appear after fill/select actions
   */
  private async handleConditionalFieldsAfterAction(action: DynamicAction): Promise<void> {
    if (!action.selector) return;

    try {
      // Get form analysis to find dependencies
      const formAnalysis = await PreActionAnalyzer.analyzeFormBeforeSubmit(
        this.page,
        action.selector,
        { useIntelligence: true, url: this.page.url() }
      );

      if (!formAnalysis || formAnalysis.fields.length === 0) {
        return;
      }

      // Wait a bit for any conditional fields to appear
      const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
      await this.page.waitForTimeout(
        AdaptiveConfigService.getTimeout('CONDITIONAL_FIELD_WAIT', {
          isSlowPage: pageContext.isSlowPage,
          hasHeavyJS: pageContext.hasHeavyJS,
        })
      );

      // Check for new visible fields
      const newVisibleFields = await this.page.evaluate(() => {
        // @ts-expect-error - browser context
        const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea')) as any[];
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
              const selector = input.id
                ? `#${input.id}`
                : input.getAttribute('name')
                  ? `[name="${input.getAttribute('name')}"]`
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
        });
      }
    } catch (error) {
      logger.debug('[INTELLIGENT_ORCHESTRATOR] handleConditionalFieldsAfterAction failed', {
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
    // Check if all pages were about:blank
    const aboutBlankPages = result.pageVisits.filter(p =>
      p.url === 'about:blank' ||
      p.url.includes('about:') ||
      !p.url ||
      p.url === ''
    ).length;

    if (aboutBlankPages === result.pagesVisited && result.pagesVisited > 0) {
      return {
        isValid: false,
        reason: 'All pages were about:blank - navigation failed, no pages were actually tested',
      };
    }

    // Check if we visited the start URL (with normalization and redirect handling)
    // Many sites redirect (e.g., https://repetino.kz → https://repetino.kz/onboarding)
    // We should check if we visited the base domain, not just the exact URL
    const normalizeUrl = (url: string): string => {
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
        return url.split('?')[0].split('#')[0].replace(/\/$/, '');
      }
    };

    // Extract base domain from start URL (e.g., "repetino.kz" from "https://repetino.kz")
    const getBaseDomain = (url: string): string => {
      try {
        const urlObj = new URL(url);
        let hostname = urlObj.hostname;
        if (hostname.startsWith('www.')) {
          hostname = hostname.substring(4);
        }
        return hostname;
      } catch {
        // Fallback: extract domain from URL string
        const match = url.match(/https?:\/\/(?:www\.)?([^\/]+)/);
        return match ? match[1] : '';
      }
    };

    const normalizedStartUrl = normalizeUrl(this.config.startUrl);
    const startBaseDomain = getBaseDomain(this.config.startUrl);

    // Check if we visited the start URL (exact match) OR any page on the same domain (redirect handling)
    const visitedStartUrl = result.pageVisits.some(p => {
      if (!p.url) return false;
      const normalizedPageUrl = normalizeUrl(p.url);
      const pageBaseDomain = getBaseDomain(p.url);

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

    const stats = StateTracker.getStatistics(this.state);

    const summary = this.buildSummary(success, stats);

    // Collect screenshots from page visits for result storage
    const screenshots = this.state.visitedPages
      .filter(pageVisit => pageVisit.screenshot)
      .map((pageVisit, index) => ({
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

    // Add end node to graph and emit final graph state to frontend
    if (this.testId && this.userId && this.graphBuilder) {
      const endUpdate = this.graphBuilder.addEndNode(
        success,
        summary,
        {
          pagesVisited: stats.pagesVisited,
          actionsTaken: stats.actionsTaken,
          successRate: `${Math.round((stats.actionsTaken - this.state.errors.length) / Math.max(stats.actionsTaken, 1) * 100)}%`,
          duration: `${Math.round(stats.duration / 1000)}s`,
          cost: `$${stats.estimatedCost.toFixed(3)}`,
          finalScreenshot: screenshots[screenshots.length - 1]?.screenshot,
        }
      );
      this.emitGraphUpdate(endUpdate);
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
   */
  private async uploadGraphScreenshotsToStorage(graphData: any): Promise<any> {
    if (!this.testId || !this.userId) {
      return graphData; // Can't upload without testId/userId
    }

    try {
      const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');
      let screenshotIndex = 0;

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

      // Process all nodes
      if (graphData.nodes && Array.isArray(graphData.nodes)) {
        for (const node of graphData.nodes) {
          if (!node.meta) continue;

          // Upload page screenshot
          if (isBase64Image(node.meta.screenshot)) {
            try {
              const base64Data = extractBase64(node.meta.screenshot);
              const publicUrl = await uploadScreenshotToStorage(
                base64Data,
                this.testId!,
                this.userId!,
                screenshotIndex++
              );
              node.meta.screenshot = publicUrl;
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Uploaded page screenshot', {
                nodeId: node.id,
                url: publicUrl,
              });
            } catch (error) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to upload page screenshot', {
                nodeId: node.id,
                error: error instanceof Error ? error.message : String(error),
              });
              // Remove base64 to save space, keep empty string
              node.meta.screenshot = '';
            }
          }

          // Upload before/after action screenshots
          if (isBase64Image(node.meta.screenshotBefore)) {
            try {
              const base64Data = extractBase64(node.meta.screenshotBefore);
              const publicUrl = await uploadScreenshotToStorage(
                base64Data,
                this.testId!,
                this.userId!,
                screenshotIndex++
              );
              node.meta.screenshotBefore = publicUrl;
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Uploaded before screenshot', {
                nodeId: node.id,
                url: publicUrl,
              });
            } catch (error) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to upload before screenshot', {
                nodeId: node.id,
                error: error instanceof Error ? error.message : String(error),
              });
              node.meta.screenshotBefore = '';
            }
          }

          if (isBase64Image(node.meta.screenshotAfter)) {
            try {
              const base64Data = extractBase64(node.meta.screenshotAfter);
              const publicUrl = await uploadScreenshotToStorage(
                base64Data,
                this.testId!,
                this.userId!,
                screenshotIndex++
              );
              node.meta.screenshotAfter = publicUrl;
              logger.debug('[INTELLIGENT_ORCHESTRATOR] Uploaded after screenshot', {
                nodeId: node.id,
                url: publicUrl,
              });
            } catch (error) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Failed to upload after screenshot', {
                nodeId: node.id,
                error: error instanceof Error ? error.message : String(error),
              });
              node.meta.screenshotAfter = '';
            }
          }
        }
      }

      logger.info('[INTELLIGENT_ORCHESTRATOR] Graph screenshots uploaded to storage', {
        testId: this.testId,
        totalScreenshots: screenshotIndex,
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

  private buildSummary(success: boolean, stats: any): string {
    const lines: string[] = [];

    if (success) {
      lines.push(`✅ **Test completed successfully**`);
    } else {
      lines.push(`❌ **Test completed with issues**`);
    }

    lines.push('');
    lines.push(`**Goal:** ${this.config.goal}`);
    lines.push(`**Duration:** ${Math.round(stats.duration / 1000)}s`);
    lines.push(`**Pages Visited:** ${stats.pagesVisited}`);
    lines.push(`**Actions Taken:** ${stats.actionsTaken}`);
    lines.push(`**Success Rate:** ${Math.round(stats.successRate * 100)}%`);
    lines.push(`**Cost:** $${stats.estimatedCost.toFixed(3)}`);

    if (stats.errorCount > 0) {
      lines.push('');
      lines.push(`⚠️ **Errors:** ${stats.errorCount}`);
    }

    lines.push('');
    lines.push(`**Page Types Visited:** ${stats.pageTypes.join(', ')}`);

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create action with context for AI analysis
   */
  private createActionWithContext(action: DynamicAction, metadata?: Partial<import('./types/intelligent-testing.types').ActionMetadata>): DynamicAction {
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
   */
  private async executeSingleAction(
    action: DynamicAction,
    context: PageContext,
    snapshotBefore: DOMSnapshot
  ): Promise<ActionResult> {
    try {
      // Step 1 & 2: Run pre-action analysis and selector validation in parallel (if selector exists)
      const [preAnalysisResult, selectorValidation] = await Promise.all([
        this.handlePreActionAnalysis(action, context),
        action.selector
          ? this.validateAndPrepareSelector(action, context)
          : Promise.resolve({ isValid: true, healedAction: undefined, error: undefined } as const),
      ]);

      if (preAnalysisResult.shouldSkip) {
        return await this.handleActionFailure(action, 'Action blocked by prerequisite conditions', {
          pageType: context.pageType,
          pageUrl: context.url,
          preAnalysis: preAnalysisResult.preAnalysis,
        });
      }

      // Check selector validation
      if (!selectorValidation.isValid) {
        return await this.handleActionFailure(action, selectorValidation.error || 'Selector validation failed', {
          pageType: context.pageType,
          pageUrl: context.url,
        });
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
        isAfterAction: !executionResult.success,
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
        timestamp: Date.now(),
      };

      // Step 7: Validate result
      const validation = await ResultValidator.validateResult(action, actionResult, this.page);

      if (!validation.passed) {
        actionResult.success = false;
        actionResult.error = validation.message || 'Validation failed';
      }

      // Step 8: Update state
      this.state = StateTracker.recordActionResult(this.state, actionResult);

      // Step 9: Post-action analysis (if needed)
      if (this.shouldPerformPostAnalysis(action, {
        urlChanged: actionResult.urlChanged,
        actionSucceeded: actionResult.success,
      })) {
        await this.handlePostActionAnalysisMethod(action, actionResult, context, snapshotBefore);
      }

      return actionResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return await this.handleActionFailure(action, errorMessage, {
        pageType: context.pageType,
        pageUrl: context.url,
      });
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
    const preAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, actionWithContext);

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
            const result = await this.commandExecutor.executeCommand(prereqAction as any);
            prerequisiteResults.push({
              action: prereqAction,
              success: result.success,
              error: result.error,
              urlChanged: false,
              urlBefore: context.url,
              urlAfter: context.url,
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
    action: DynamicAction,
    context: PageContext
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
  ): Promise<{ before?: string; after?: string }> {
    const screenshots: { before?: string; after?: string } = {};

    if (context.isBeforeAction && this.shouldCaptureScreenshot(action, { isBeforeAction: true })) {
      try {
        const buffer = await this.page.screenshot({ fullPage: false });
        screenshots.before = buffer.toString('base64');
        this.screenshotMetrics.beforeActions++;
        this.screenshotMetrics.totalCaptured++;
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

    // Execute through CommandExecutor
    const executionResult = await this.commandExecutor.executeCommand(action as any);

    // Wait for action to complete
    await this.ensureActionCompleted(action);

    const urlAfter = this.page.url();
    const urlChanged = urlBefore !== urlAfter;

    // Verify action success
    const verification = await this.verifyActionSuccess(action, executionResult.success);

    return {
      success: verification.success,
      error: verification.reason || executionResult.error,
      urlChanged,
      urlBefore,
      urlAfter,
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
   * Detect page changes after action
   */
  private async detectPageChanges(beforeSnapshot: DOMSnapshot, afterSnapshot: DOMSnapshot): Promise<{
    hasChanges: boolean;
    changes: string[];
  }> {
    const changes: string[] = [];

    // Compare visible elements count
    if (beforeSnapshot.visibleElements.length !== afterSnapshot.visibleElements.length) {
      changes.push(`Visible elements changed: ${beforeSnapshot.visibleElements.length} → ${afterSnapshot.visibleElements.length}`);
    }

    // Compare modals
    if (beforeSnapshot.modals.length !== afterSnapshot.modals.length) {
      changes.push(`Modals changed: ${beforeSnapshot.modals.length} → ${afterSnapshot.modals.length}`);
    }

    // Compare errors
    if (beforeSnapshot.errors.length !== afterSnapshot.errors.length) {
      changes.push(`Errors changed: ${beforeSnapshot.errors.length} → ${afterSnapshot.errors.length}`);
    }

    // Compare button states
    if (beforeSnapshot.buttonStates.length !== afterSnapshot.buttonStates.length) {
      changes.push(`Button states changed: ${beforeSnapshot.buttonStates.length} → ${afterSnapshot.buttonStates.length}`);
    }

    // Check for new elements
    const beforeSelectors = new Set(beforeSnapshot.visibleElements.map(el => el.selector));
    const newElements = afterSnapshot.visibleElements.filter(el => !beforeSelectors.has(el.selector));

    if (newElements.length > 0) {
      changes.push(`New elements appeared: ${newElements.slice(0, 3).map(el => el.text || el.selector).join(', ')}${newElements.length > 3 ? '...' : ''}`);
    }

    return {
      hasChanges: changes.length > 0,
      changes,
    };
  }

  /**
   * Ensure action completed before proceeding
   */
  private async ensureActionCompleted(action: DynamicAction): Promise<void> {
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
  private shouldRetryAction(action: DynamicAction, error: string, attemptCount: number): boolean {
    const maxRetries = action.retry || 2;

    // Don't retry if max attempts reached
    if (attemptCount >= maxRetries) {
      return false;
    }

    // Retry on timeout errors
    if (error.includes('timeout') || error.includes('Timeout')) {
      return true;
    }

    // Retry on selector not found errors
    if (error.includes('not found') || error.includes('not visible')) {
      return true;
    }

    // Retry on network errors
    if (error.includes('net::') || error.includes('ERR_')) {
      return true;
    }

    return false;
  }

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
  private emitGraphUpdate(update: import('./utils/graph-builder.service').GraphUpdate): void {
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

    // Validate that update has at least one data field
    const hasIncrementalData = update.newNode || update.newEdge || update.updatedNode;
    const hasFullData = update.fullGraph;

    if (!hasIncrementalData && !hasFullData) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Graph update missing data', {
        testId: this.testId,
        type: update.type,
      });
      return;
    }

    try {
      const payload = {
        testId: this.testId,
        type: update.type,
        data: {
          newNode: update.newNode,
          newEdge: update.newEdge,
          updatedNode: update.updatedNode,
          fullGraph: update.fullGraph,
        },
        timestamp: new Date().toISOString(),
      };

      webSocketService.emitToUser(this.userId, 'test:graph-update', payload);
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
