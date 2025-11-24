/**
 * IntelligentTestOrchestrator
 * Main orchestration loop for intelligent testing
 * Manages: analyze → understand → generate → execute → validate → decide → repeat
 */

import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import { Browser, Page } from 'playwright';
import { CommandExecutor } from './command-executor';
import { ContextualActionGenerator } from './contextual-action-generator';
import { IntelligentPageAnalyzer } from './intelligent-page-analyzer';
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
import { TestProgressEmitter } from './utils/progress-emitter';
import { dbAdminService } from '@/db/supabase';

// AI cost estimation (updated with accurate pricing Nov 2024)
// Based on: GPT-4o $0.005 input / $0.015 output per 1K tokens
// Vision: ~700 input + 200 output = $0.0055 per screenshot
const COST_VISION_ANALYSIS = 0.0055; // GPT-4o Vision (1 screenshot)
const COST_DOM_ANALYSIS = 0.0001; // GPT-4o-mini (400 input + 100 output)
const COST_ACTION_GENERATION = 0.0002; // GPT-4o-mini (500 input + 150 output)
const COST_DECISION = 0.0001; // GPT-4o-mini (300 input + 100 output)

// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENT TEST ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

export class IntelligentTestOrchestrator {
  private browser!: Browser;
  private page!: Page;
  private config: IntelligentTestConfig;
  private state!: TestState;
  private userId?: string;
  private testId?: string;
  private commandExecutor!: CommandExecutor;
  private progressEmitter?: TestProgressEmitter;

  constructor(config: IntelligentTestConfig, userId?: string, testId?: string) {
    this.config = config;
    this.userId = userId;
    this.testId = testId;

    // Initialize progress emitter if testId is provided
    if (this.testId) {
      const browser = this.config.browser || 'chrome';
      this.progressEmitter = new TestProgressEmitter(this.testId, browser);
    }
  }

  /**
   * Execute intelligent test
   * Main entry point
   */
  async execute(browser: Browser, page: Page): Promise<IntelligentTestResult> {
    this.browser = browser;
    this.page = page;
    this.commandExecutor = new CommandExecutor(page);

    // ✅ CRITICAL FIX: Setup navigation listeners to track all URL changes
    this.setupNavigationListeners();

    // ✅ CRITICAL FIX: Verify we're on the correct URL before starting
    const initialUrl = page.url();
    if (initialUrl === 'about:blank' || !initialUrl || initialUrl.includes('about:')) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Page is on about:blank - navigation failed', {
        testId: this.testId,
        expectedUrl: this.config.startUrl,
        actualUrl: initialUrl,
      });

      // Try to navigate again
      try {
        logger.info('[INTELLIGENT_ORCHESTRATOR] Attempting to navigate to start URL', {
          testId: this.testId,
          startUrl: this.config.startUrl,
        });
        await page.goto(this.config.startUrl, {
          waitUntil: 'load',
          timeout: 30000,
        });

        const newUrl = page.url();
        if (newUrl === 'about:blank' || !newUrl || newUrl.includes('about:')) {
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

    const safetyConfig = SafetyGuard.getConfigForLevel(this.config.safety.level);

    // Initialize state
    this.state = StateTracker.createInitialState(
      this.config.goal,
      this.config.startUrl,
      safetyConfig.maxPages,
      safetyConfig.maxDuration
    );

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

    // Emit progress: Analysis phase starting
    this.progressEmitter?.emit({
      progress: 30,
      phase: 'analysis',
      currentStep: '🤖 AI analyzing page structure...',
    });

    try {
      // Main testing loop (returns true if cancelled)
      const wasCancelled = await this.mainLoop();

      // If cancelled, build result with cancellation info
      if (wasCancelled) {
        const result = this.buildResult(false);
        result.summary = 'Test was cancelled by user';
        // Add cancellation error (errors array has { message, page } structure)
        result.errors.push({
          message: 'Test was cancelled by user',
          page: this.state.currentUrl || this.config.startUrl,
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

      // Build result and validate it
      const result = this.buildResult(true);

      // ✅ CRITICAL FIX: Validate test result quality
      const isValidTest = this.validateTestResult(result);

      if (!isValidTest.isValid) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Test completed but result is invalid', {
          testId: this.testId,
          reason: isValidTest.reason,
          stats: {
            pagesVisited: result.pagesVisited,
            actionsTaken: result.actionsTaken,
            successRate: `${Math.round((result.actionsTaken - result.errors.length) / Math.max(result.actionsTaken, 1) * 100)}%`,
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
        logger.info('[INTELLIGENT_ORCHESTRATOR] Test completed successfully', {
          pagesVisited: result.pagesVisited,
          actionsTaken: result.actionsTaken,
          duration: `${Math.round(result.duration / 1000)}s`,
          cost: `$${result.cost.toFixed(3)}`,
          successRate: `${Math.round((result.actionsTaken - result.errors.length) / Math.max(result.actionsTaken, 1) * 100)}%`,
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
        this.emitEvent('test_failed', {
          error: isValidTest.reason || 'Test failed validation',
          summary: result.summary,
        });
      }

      return result;
    } catch (error) {
      // ✅ FIX: Explicitly extract error details for debugging
      logger.error('[INTELLIGENT_ORCHESTRATOR] Test failed', {
        testId: this.testId,
        userId: this.userId,
        goal: this.config.goal,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });

      this.emitEvent('test_failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return this.buildResult(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN TESTING LOOP
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

  private async mainLoop(): Promise<boolean> {
    let continueLoop = true;
    let iteration = 0; // Track iteration count

    logger.info('[INTELLIGENT_ORCHESTRATOR] Starting main test loop', {
      testId: this.testId,
      goal: this.config.goal,
      mode: this.config.mode,
    });

    while (continueLoop) {
      iteration++;
      logger.info(`[INTELLIGENT_ORCHESTRATOR] Loop iteration ${iteration}`, {
        testId: this.testId,
        pagesVisited: this.state.pagesAnalyzed,
        actionsCompleted: this.state.completedActions.length,
        currentUrl: this.page.url(),
      });

      // Check if test was cancelled before each iteration
      if (await this.checkTestCancelled()) {
        logger.info('[INTELLIGENT_ORCHESTRATOR] Test was cancelled, stopping execution', {
          testId: this.testId,
          iteration,
          pagesVisited: this.state.pagesAnalyzed,
          actionsCompleted: this.state.completedActions.length,
        });

        // ✅ FIX: Don't emit event here - it will be emitted in execute() when handling cancellation
        // This prevents duplicate test_cancelled events

        return true; // Return true to indicate cancellation
      }

      // Check limits before each iteration
      const limitsCheck = SafetyGuard.checkLimits(this.state, this.config.safety);
      if (!limitsCheck.safe) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Limits exceeded', {
          testId: this.testId,
          iteration,
          reason: limitsCheck.reason,
          stats: {
            pagesVisited: this.state.pagesAnalyzed,
            actionsCompleted: this.state.completedActions.length,
            duration: Date.now() - this.state.startTime,
          },
        });

        this.emitEvent('test_warning', {
          message: limitsCheck.reason || 'Limits exceeded',
        });

        break;
      }

      try {
        // STEP 1: Analyze current page
        const context = await this.analyzePage();

        // Check if test was cancelled after analysis (before expensive operations)
        if (await this.checkTestCancelled()) {
          logger.info('[INTELLIGENT_ORCHESTRATOR] Test was cancelled after page analysis', {
            testId: this.testId,
            iteration,
          });
          return true; // Return true to indicate cancellation
        }

        // STEP 2: Check for cycles
        const cycleCheck = StateTracker.detectCycle(this.state, context.url);
        if (cycleCheck.cycleDetected) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Cycle detected', {
            suggestion: cycleCheck.suggestion,
          });

          this.emitEvent('test_warning', {
            message: cycleCheck.suggestion,
          });

          // Try to decide next step despite cycle
          const decision = await ContextualActionGenerator.decideNextStep(
            this.state,
            context
          );

          if (decision.action === 'stop' || decision.action === 'skip') {
            break;
          }
        }

        // STEP 3: Generate actions
        const { actions, reasoning, confidence } = await this.generateActions(context);

        if (actions.length === 0) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] No actions generated', {
            url: context.url,
            reason: reasoning,
            pageType: context.pageType,
            elementsCount: context.vision.elements.length,
          });

          // Decide next step
          const decision = await ContextualActionGenerator.decideNextStep(
            this.state,
            context
          );

          if (decision.action !== 'continue') {
            break;
          }

          continue;
        }

        logger.info('[INTELLIGENT_ORCHESTRATOR] Generated actions', {
          count: actions.length,
          reasoning,
          confidence,
        });

        // STEP 4: Execute actions
        const pageVisit = await this.executeActions(context, actions);

        // ✅ NEW: Add screenshot from context to page visit
        pageVisit.screenshot = context.screenshot;

        // STEP 5: Record visit
        this.state = StateTracker.recordPageVisit(this.state, pageVisit);

        // STEP 6: Decide next step
        const decision = await ContextualActionGenerator.decideNextStep(
          this.state,
          context
        );

        logger.info('[INTELLIGENT_ORCHESTRATOR] Next step decision', {
          action: decision.action,
          reason: decision.reason,
        });

        this.emitEvent('test_progress', {
          action: decision.action,
          reason: decision.reason,
          pagesVisited: this.state.pagesAnalyzed,
          actionsCompleted: this.state.completedActions.length,
        });

        // Handle decision
        switch (decision.action) {
          case 'stop':
            logger.info('[INTELLIGENT_ORCHESTRATOR] Stopping: ' + decision.reason);
            continueLoop = false;
            break;

          case 'wait_for_user':
            logger.info('[INTELLIGENT_ORCHESTRATOR] Waiting for user approval');
            this.emitEvent('test_waiting', {
              reason: decision.reason,
            });
            continueLoop = false;
            break;

          case 'skip':
            logger.info('[INTELLIGENT_ORCHESTRATOR] Skipping: ' + decision.reason);
            // Go back if possible
            try {
              await this.page.goBack({ timeout: 5000 });
            } catch {
              continueLoop = false;
            }
            break;

          case 'retry':
            logger.info('[INTELLIGENT_ORCHESTRATOR] Retrying...');
            // Continue with retry
            break;

          case 'continue':
          default:
            // Continue loop
            break;
        }

        // Small delay between iterations
        await this.page.waitForTimeout(1000);

        // Check cancellation after iteration
        if (await this.checkTestCancelled()) {
          logger.info('[INTELLIGENT_ORCHESTRATOR] Test was cancelled after iteration', {
            testId: this.testId,
            iteration,
          });
          return true; // Return true to indicate cancellation
        }
      } catch (error) {
        // ✅ FIX: Enhanced error logging with iteration context
        logger.error('[INTELLIGENT_ORCHESTRATOR] Loop iteration failed', {
          testId: this.testId,
          iteration,
          currentUrl: this.page.url(),
          pagesVisited: this.state.pagesAnalyzed,
          actionsCompleted: this.state.completedActions.length,
          errorCount: this.state.errors.length,
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
          } : String(error),
        });

        this.state.errors.push({
          message: error instanceof Error ? error.message : 'Iteration failed',
          timestamp: Date.now(),
        });

        // Too many errors? Stop
        if (this.state.errors.length > 5) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Too many errors, stopping', {
            testId: this.testId,
            totalErrors: this.state.errors.length,
            recentErrors: this.state.errors.slice(-3).map(e => e.message),
          });
          break;
        }

        // Continue despite error
        logger.info('[INTELLIGENT_ORCHESTRATOR] Continuing despite error', {
          testId: this.testId,
          iteration,
          errorCount: this.state.errors.length,
        });
        continue;
      }
    }

    logger.info('[INTELLIGENT_ORCHESTRATOR] Main loop ended', {
      testId: this.testId,
      stats: StateTracker.formatStatistics(this.state),
    });

    return false; // ✅ FIX: Return false to indicate normal completion (not cancelled)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATION TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Setup navigation listeners to track all URL changes in real-time
   * This helps detect when and why redirects to about:blank happen
   */
  private setupNavigationListeners(): void {
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
      if (isMainFrame && (url === 'about:blank' || url.startsWith('about:'))) {
        logger.warn('[NAVIGATION_TRACKER] ⚠️ Main frame redirected to about:blank', {
          testId: this.testId,
          url,
          stackTrace: new Error().stack?.split('\n').slice(0, 5).join('\n'), // Capture call stack
        });
      }
    });

    // Track responses to detect redirects
    this.page.on('response', (response) => {
      const url = response.url();
      const status = response.status();
      const headers = response.headers();
      const location = headers['location'] || headers['Location'];

      // Log redirects (3xx status codes)
      if (status >= 300 && status < 400 && location) {
        logger.info('[NAVIGATION_TRACKER] Redirect detected', {
          testId: this.testId,
          from: url,
          to: location,
          status,
        });

        // Alert if redirecting to about:blank
        if (location === 'about:blank' || location.startsWith('about:')) {
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

    // ✅ CRITICAL FIX: Check for about:blank before analysis
    if (currentUrl === 'about:blank' || currentUrl.startsWith('about:')) {
      logger.warn('[INTELLIGENT_ORCHESTRATOR] Page is about:blank, attempting to navigate back', {
        testId: this.testId,
        currentUrl,
      });

      // Try to go back to previous page
      try {
        await this.page.goBack({ timeout: 5000 });
        const newUrl = this.page.url();

        if (newUrl === 'about:blank' || newUrl.startsWith('about:')) {
          // Still on about:blank, try to go to start URL
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Still on about:blank after goBack, navigating to start URL', {
            startUrl: this.config.startUrl,
          });
          await this.page.goto(this.config.startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
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

    const previousContext = this.state.visitedPages.length > 0
      ? `Previous page: ${this.state.visitedPages[this.state.visitedPages.length - 1].pageType}`
      : undefined;

    const context = await IntelligentPageAnalyzer.analyzePage(
      this.page,
      this.config.goal,
      this.config.mode,
      previousContext
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

    return context;
  }

  /**
   * STEP 3: Generate actions
   */
  private async generateActions(context: PageContext): Promise<{
    actions: DynamicAction[];
    reasoning: string;
    confidence: number;
  }> {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Generating actions');

    this.emitEvent('actions_generating', {});

    const result = await ContextualActionGenerator.generateActions(
      context,
      this.state,
      this.page  // ✅ NEW: Pass page for HTML extraction
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
          currentStep: `${this.getActionEmoji(action.action)} ${action.description}...`,
          action: {
            type: action.action,
            description: action.description,
            target: action.selector,
          },
          completedSteps: i,
        });

        // Log every action execution
        logger.info('[INTELLIGENT_ORCHESTRATOR] Executing action', {
          testId: this.testId,
          action: action.action,
          description: action.description,
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

        // ✅ NEW: Validate selector exists before execution (for click/fill/type actions)
        if (action.selector && ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover'].includes(action.action)) {
          try {
            const elementExists = await this.page.locator(action.selector).count();
            if (elementExists === 0) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Selector not found, marking action as optional', {
                testId: this.testId,
                action: action.description,
                selector: action.selector,
              });

              // Mark as optional and skip
              const actionResult: ActionResult = {
                action,
                success: false,
                error: `Selector not found: ${action.selector}`,
                urlChanged: false,
                urlBefore,
                urlAfter: urlBefore,
                timestamp: Date.now(),
              };

              completedActions.push(actionResult);
              this.state = StateTracker.recordActionResult(this.state, actionResult);

              // Mark action as optional to continue
              action.optional = true;
              continue; // Skip this action
            }
          } catch (selectorError) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Selector validation failed', {
              testId: this.testId,
              selector: action.selector,
              error: selectorError instanceof Error ? selectorError.message : String(selectorError),
            });
            // Continue anyway - might be a valid selector that just needs more time
          }
        }

        // Execute action using CommandExecutor
        const executionResult = await this.commandExecutor.executeCommand({
          action: action.action as any,
          selector: action.selector,
          value: action.value,
          url: action.url,
          timeout: action.timeout,
          description: action.description,
          extract: action.extract,
          assertion: action.assertion ? {
            type: 'text', // Default type for intelligent testing assertions
            expected: action.assertion.expected,
            operator: action.assertion.operator,
          } : undefined,
        });

        await this.page.waitForTimeout(500); // Small delay for page to settle

        const urlAfter = this.page.url();
        const urlChanged = urlBefore !== urlAfter;

        logger.debug('[INTELLIGENT_ORCHESTRATOR] After action execution', {
          testId: this.testId,
          action: action.description,
          urlBefore,
          urlAfter,
          urlChanged,
          executionSuccess: executionResult.success,
        });

        // ✅ CRITICAL FIX: Check if action redirected to about:blank
        if (urlAfter === 'about:blank' || urlAfter.startsWith('about:')) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Action redirected to about:blank', {
            testId: this.testId,
            action: action.description,
            urlBefore,
            urlAfter,
          });

          // Try to go back
          try {
            await this.page.goBack({ timeout: 5000 });
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

        // Log action result (success/failure)
        if (!actionResult.success) {
          success = false;
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Action failed', {
            testId: this.testId,
            action: action.action,
            description: action.description,
            error: actionResult.error,
            optional: action.optional,
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

        // If URL changed significantly, we're on a new page - stop current batch
        if (urlChanged) {
          logger.info('[INTELLIGENT_ORCHESTRATOR] Page changed, ending action batch');
          break;
        }
      } catch (error) {
        // ✅ FIX: Enhanced error logging for action execution
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

    // Check if we visited the start URL
    const visitedStartUrl = result.pageVisits.some(p =>
      p.url && (
        p.url === this.config.startUrl ||
        p.url.startsWith(this.config.startUrl.split('?')[0]) // Ignore query params
      )
    );

    if (!visitedStartUrl && result.pagesVisited > 0) {
      return {
        isValid: false,
        reason: `Start URL "${this.config.startUrl}" was never visited - navigation may have failed`,
      };
    }

    // Check success rate
    if (result.actionsTaken > 0) {
      const successCount = result.actionsTaken - result.errors.length;
      const successRate = successCount / result.actionsTaken;

      if (successRate === 0) {
        return {
          isValid: false,
          reason: 'All actions failed (0% success rate) - test did not successfully interact with the page',
        };
      }

      // Warn if success rate is very low
      if (successRate < 0.2 && result.actionsTaken >= 3) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Very low success rate', {
          testId: this.testId,
          successRate: `${Math.round(successRate * 100)}%`,
          actionsTaken: result.actionsTaken,
          errors: result.errors.length,
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

  private buildResult(success: boolean): IntelligentTestResult {
    const stats = StateTracker.getStatistics(this.state);

    const summary = this.buildSummary(success, stats);

    // ✅ NEW: Collect screenshots from page visits
    const screenshots = this.state.visitedPages
      .filter(pageVisit => pageVisit.screenshot)
      .map((pageVisit, index) => ({
        url: pageVisit.url,
        screenshot: pageVisit.screenshot!,
      }));

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
    };
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
  // WEBSOCKET EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  private emitEvent(event: string, data: any): void {
    if (!this.userId || !this.testId) {
      return;
    }

    try {
      webSocketService.emitToUser(this.userId, 'test:progress', {
        testId: this.testId,
        event,
        data,
        timestamp: Date.now(),
      });
    } catch (error) {
      // ✅ FIX: Enhanced error logging for event emission
      logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to emit event', {
        testId: this.testId,
        event,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });
    }
  }

  /**
   * Get emoji for action type
   */
  private getActionEmoji(actionType: string): string {
    const emojiMap: Record<string, string> = {
      click: '👆',
      fill: '✍️',
      select: '📋',
      wait: '⏱️',
      scroll: '📜',
      press: '⌨️',
      hover: '🖱️',
      goto: '🌐',
    };
    return emojiMap[actionType] || '🔄';
  }
}
