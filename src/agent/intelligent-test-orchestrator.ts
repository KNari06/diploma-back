/**
 * IntelligentTestOrchestrator
 * Main orchestration loop for intelligent testing
 * Manages: analyze → understand → generate → execute → validate → decide → repeat
 */

import { dbAdminService } from '@/db/supabase';
import { AICostManager, getCostManager, removeCostManager } from '@/services/ai-cost-manager.service';
import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import { Browser, Page } from 'playwright';
import { AdaptiveConfigService } from './adaptive-config.service'; // ✅ NEW: Adaptive configuration
import { CommandExecutor } from './command-executor';
import { ContextualActionGenerator } from './contextual-action-generator';
import { FormIntelligenceService } from './form-intelligence.service'; // ✅ NEW: Smart form handling
import { IntelligentPageAnalyzer } from './intelligent-page-analyzer';
import { PostActionAnalyzer, DOMSnapshot } from './post-action-analyzer'; // ✅ NEW: AI-driven post-action analysis
import { PreActionAnalyzer } from './pre-action-analyzer'; // ✅ NEW: Pre-action analysis for smart action execution
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
import { ActionPattern, ActionPatternDetector } from './utils/action-pattern-detector'; // ✅ NEW
import { GraphBuilder } from './utils/graph-builder.service'; // ✅ NEW
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
const COST_DECISION = 0.0001; // GPT-4o-mini (300 input + 100 output)

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
  private browser!: Browser;
  private page!: Page;
  private config: IntelligentTestConfig;
  private state!: TestState;
  private userId?: string;
  private testId?: string;
  private commandExecutor!: CommandExecutor;
  private progressEmitter?: TestProgressEmitter;
  private graphBuilder!: GraphBuilder; // ✅ NEW: Graph builder for real-time visualization
  private abortController: AbortController; // ✅ FIX 7: AbortController for cancellation
  private costManager?: AICostManager; // ✅ FIX 9: AI cost manager for budget control

  // ✅ OPTIMIZED: Screenshot metrics for monitoring
  private screenshotMetrics = {
    totalCaptured: 0,
    beforeActions: 0,
    afterActions: 0,
    onErrors: 0,
    onNavigation: 0,
    onPageAnalysis: 0,
  };

  // ✅ NEW: Track consecutive empty pages to stop early
  private consecutiveEmptyPages = 0;

  // ✅ NEW: Track selector failures to prevent infinite loops
  private selectorFailures = new Map<string, number>(); // selector -> failure count

  constructor(config: IntelligentTestConfig, userId?: string, testId?: string) {
    this.config = config;
    this.userId = userId;
    this.testId = testId;

    // ✅ FIX 7: Initialize AbortController
    this.abortController = new AbortController();

    // ✅ FIX 9: Initialize AI cost manager
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
      this.progressEmitter = new TestProgressEmitter(this.testId, browser);
    }
  }

  /**
   * ✅ FIX 7: Abort test execution
   * Called when user cancels the test
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
    this.browser = browser;
    this.page = page;

    // ✅ FIX 7: Pass AbortSignal to CommandExecutor
    // ✅ FIX 9: Pass cost manager to CommandExecutor
    this.commandExecutor = new CommandExecutor(page, {
      abortSignal: this.abortController.signal,
      costManager: this.costManager, // ✅ FIX 9: Pass cost manager
      metadata: {
        url: this.config.startUrl,
        projectId: this.testId,
        userId: this.userId,
      },
    });

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
        // Note: this.state is not initialized yet, use default timeout
        await page.goto(this.config.startUrl, {
          waitUntil: 'load',
          timeout: AdaptiveConfigService.getTimeout('NAVIGATION', {}), // Default timeout before state init
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

    // ✅ NEW: Initialize graph builder
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

    // ✅ NEW: Add start node and emit initial graph
    if (this.testId && this.userId) {
      const startUpdate = this.graphBuilder.addStartNode();
      this.emitGraphUpdate(startUpdate);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ✅ NEW: Execute pre-test setup (migrated from Standard Mode)
    // ═══════════════════════════════════════════════════════════════════════════

    // Execute custom scripts if provided (from Standard Mode)
    if (this.config.customScripts && this.config.customScripts.length > 0) {
      logger.info('[INTELLIGENT_ORCHESTRATOR] Executing custom scripts', {
        testId: this.testId,
        scriptsCount: this.config.customScripts.length,
      });

      for (const script of this.config.customScripts) {
        try {
          await this.page.evaluate(script);
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
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
        await this.page.waitForSelector(this.config.waitForSelector, {
          state: 'visible',
          timeout: AdaptiveConfigService.getTimeout('SELECTOR_WAIT', {
            networkSpeed: pageContext.networkSpeed,
            isSlowPage: pageContext.isSlowPage,
          }),
        });
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
      const wasCancelled = await this.mainLoop();

      // If cancelled, build result with cancellation info
      if (wasCancelled) {
        const result = await this.buildResult(false);
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
      const result = await this.buildResult(true);

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

      return await this.buildResult(false);
    } finally {
      // ✅ FIX 9: Cleanup cost manager after test completion
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

        // ✅ NEW: Add page node to graph when analyzing new page
        if (this.testId && this.userId && this.graphBuilder) {
          // Get page title and metadata from page
          let pageTitle: string | undefined;
          let metaDescription: string | undefined;
          try {
            pageTitle = await this.page.title();
            metaDescription = await this.page.$eval('meta[name="description"]', (el) => el.getAttribute('content') || '').catch(() => undefined);
          } catch (error) {
            logger.debug('[INTELLIGENT_ORCHESTRATOR] Failed to get page metadata', { error });
          }

          const pageUpdate = this.graphBuilder.addPageNode(
            context.url,
            context.pageType,
            {
              screenshot: context.screenshot, // Base64 screenshot
              title: pageTitle,
              metaDescription: metaDescription,
              dom: {
                formsCount: context.dom.forms?.length || 0,
                buttonsCount: context.dom.buttons?.length || 0,
                linksCount: context.dom.links?.length || 0,
                inputsCount: context.dom.inputs?.length || 0,
              },
              // Network requests count not available in PageContext, skip for now
            }
          );
          this.emitGraphUpdate(pageUpdate);
        }

        // Check if test was cancelled after analysis (before expensive operations)
        if (await this.checkTestCancelled()) {
          logger.info('[INTELLIGENT_ORCHESTRATOR] Test was cancelled after page analysis', {
            testId: this.testId,
            iteration,
          });
          return true; // Return true to indicate cancellation
        }

        // STEP 2: Check for cycles (URL-based)
        const cycleCheck = StateTracker.detectCycle(this.state, context.url);
        if (cycleCheck.cycleDetected) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] URL cycle detected', {
            suggestion: cycleCheck.suggestion,
            visitCount: cycleCheck.visitCount,
          });

          this.emitEvent('test_warning', {
            message: cycleCheck.suggestion,
          });

          // ✅ FIX: More aggressive stopping - if cycle detected, stop immediately
          const pageContext = AdaptiveConfigService.analyzePageContext(this.state, context.pageType);
          const cycleThreshold = AdaptiveConfigService.getThreshold('CYCLE_DETECTION_THRESHOLD', {
            testMode: this.config.mode,
            errorRate: pageContext.errorRate,
          });
          if (cycleCheck.visitCount && cycleCheck.visitCount >= cycleThreshold) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Stopping due to excessive URL cycles', {
              visitCount: cycleCheck.visitCount,
              url: context.url,
            });
            break;
          }

          // Try to decide next step despite cycle
          const decision = await ContextualActionGenerator.decideNextStep(
            this.state,
            context,
            this.costManager  // ✅ FIX 9: Pass cost manager
          );

          if (decision.action === 'stop' || decision.action === 'skip') {
            break;
          }
        }

        // ✅ NEW: STEP 2.5: Check for action patterns (repeated actions, failed chains, etc.)
        const patternCheck = ActionPatternDetector.detectPatterns(this.state);
        if (patternCheck.hasPattern) {
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Problematic action patterns detected', {
            patternsCount: patternCheck.patterns.length,
            shouldStop: patternCheck.shouldStop,
            patterns: patternCheck.patterns.map((p: ActionPattern) => ({
              type: p.type,
              severity: p.severity,
              description: p.description,
            })),
          });

          // Emit warnings for each pattern
          patternCheck.patterns.forEach((pattern: ActionPattern) => {
            this.emitEvent('test_warning', {
              message: `⚠️ ${pattern.type}: ${pattern.description}`,
              severity: pattern.severity,
            });
          });

          // If critical pattern detected → stop test
          if (patternCheck.shouldStop) {
            logger.error('[INTELLIGENT_ORCHESTRATOR] Critical pattern detected - stopping test', {
              reason: patternCheck.reason,
            });

            this.emitEvent('test_stopped', {
              reason: patternCheck.reason,
            });

            break; // Stop test execution
          }
        }

        // STEP 3: Generate actions
        const { actions, reasoning, confidence } = await this.generateActions(context);

        // ✅ NEW: Track empty pages and stop if 2+ consecutive empty pages
        const isEmptyPage = actions.length === 0 && (
          (context.vision.elements.length === 0 &&
           (context.dom.forms?.length || 0) === 0 &&
           (context.dom.buttons?.length || 0) === 0 &&
           (context.dom.links?.length || 0) === 0 &&
           (context.dom.inputs?.length || 0) === 0)
        );

        if (isEmptyPage) {
          this.consecutiveEmptyPages++;
          logger.warn('[INTELLIGENT_ORCHESTRATOR] Empty page detected', {
            url: context.url,
            consecutiveCount: this.consecutiveEmptyPages,
            pageType: context.pageType,
            elementsCount: context.vision.elements.length,
          });

          // Stop if threshold reached
          const pageContext = AdaptiveConfigService.analyzePageContext(this.state, context.pageType);
          const emptyPagesThreshold = AdaptiveConfigService.getThreshold('CONSECUTIVE_EMPTY_PAGES_THRESHOLD', {
            testMode: this.config.mode,
            isComplexPage: pageContext.isComplexPage,
          });
          if (this.consecutiveEmptyPages >= emptyPagesThreshold) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Stopping due to consecutive empty pages', {
              consecutiveCount: this.consecutiveEmptyPages,
              url: context.url,
            });
            this.emitEvent('test_warning', {
              message: `Stopped: ${this.consecutiveEmptyPages} consecutive empty pages detected. No interactive elements found.`,
            });
            break;
          }
        } else {
          // Reset counter if page has elements
          this.consecutiveEmptyPages = 0;
        }

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
            context,
            this.costManager  // ✅ FIX 9: Pass cost manager
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

        // ✅ OPTIMIZED: Track page analysis screenshots
        if (context.screenshot) {
          this.screenshotMetrics.onPageAnalysis++;
          this.screenshotMetrics.totalCaptured++;
        }

        logger.debug('[INTELLIGENT_ORCHESTRATOR] Page screenshot captured during analysis', {
          testId: this.testId,
          url: context.url,
          hasScreenshot: !!context.screenshot,
          screenshotSize: context.screenshot ? `${Math.round(context.screenshot.length / 1024)}KB` : 'none',
          totalScreenshots: this.screenshotMetrics.totalCaptured
        });

        // ✅ FIX: Only record visit if URL changed OR actions were successful
        // This prevents counting failed attempts on same page as new visits
        const urlChanged = this.state.currentUrl !== context.url;
        const hasSuccessfulActions = pageVisit.actionResults?.some(r => r.success) || false;
        const shouldRecordVisit = urlChanged || hasSuccessfulActions;

        if (shouldRecordVisit) {
          // STEP 5: Record visit
          this.state = StateTracker.recordPageVisit(this.state, pageVisit);
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Page visit recorded', {
            url: context.url,
            urlChanged,
            hasSuccessfulActions,
            actionsCount: pageVisit.actionResults?.length || 0,
          });
        } else {
          logger.debug('[INTELLIGENT_ORCHESTRATOR] Skipping visit record - same URL and no successful actions', {
            url: context.url,
            failedActions: pageVisit.actionResults?.filter(r => !r.success).length || 0,
          });
        }

        // STEP 6: Decide next step
        const decision = await ContextualActionGenerator.decideNextStep(
          this.state,
          context,
          this.costManager  // ✅ FIX 9: Pass cost manager
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
              const pageContext = AdaptiveConfigService.analyzePageContext(this.state);
              await this.page.goBack({
                timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
                  networkSpeed: pageContext.networkSpeed,
                }),
              });
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

        // ✅ OPTIMIZED: No delay between iterations - not needed
        // Previous: await this.page.waitForTimeout(1000); // Removed - saves 1 second per iteration

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

        // ✅ IMPROVED: Check for repeated selector errors (infinite loop detection)
        const errorPageContext = AdaptiveConfigService.analyzePageContext(this.state);
        const recentErrorsCheckCount = AdaptiveConfigService.getThreshold('RECENT_ERRORS_CHECK_COUNT', {
          errorRate: errorPageContext.errorRate,
        });
        const recentSelectorErrors = this.state.errors
          .slice(-recentErrorsCheckCount)
          .filter(e => e.message.includes('Selector not found') || e.message.includes('not found'))
          .length;

        const selectorErrorsThreshold = AdaptiveConfigService.getThreshold('RECENT_SELECTOR_ERRORS_THRESHOLD', {
          errorRate: errorPageContext.errorRate,
        });
        if (recentSelectorErrors >= selectorErrorsThreshold) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Too many selector errors in a row, possible infinite loop', {
            testId: this.testId,
            recentSelectorErrors,
            totalErrors: this.state.errors.length,
            recentErrors: this.state.errors.slice(-3).map(e => e.message),
          });
          this.emitEvent('test_warning', {
            message: 'Too many selector errors detected. Test may be stuck in a loop.',
          });
          // Don't break immediately - try one more iteration with different approach
        }

        // Too many errors? Stop
        const maxErrors = AdaptiveConfigService.getThreshold('MAX_ERRORS_BEFORE_STOP', {
          testMode: this.config.mode,
          errorRate: errorPageContext.errorRate,
          isComplexPage: errorPageContext.isComplexPage,
        });
        if (this.state.errors.length > maxErrors) {
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
      const redirectRange = AdaptiveConfigService.getHttpStatusRange('redirect');
      if (status >= redirectRange.start && status < redirectRange.end && location) {
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

    // ✅ FIX: Emit test:progress when analyzing page
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 40,
        phase: 'analysis',
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
        status: 'running',
        timestamp: new Date().toISOString(),
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
      this.config.spaLoadConfig // ✅ FIX 7: Pass configurable SPA load settings
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

    // ✅ FIX: Emit test:progress after page analysis
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 50,
        phase: 'analysis',
        currentStep: `✅ Page analyzed: ${context.pageType} (${context.vision.elements.length} elements found)`,
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 50,
        phase: 'analysis',
        currentStep: `✅ Page analyzed: ${context.pageType} (${context.vision.elements.length} elements found)`,
        status: 'running',
        timestamp: new Date().toISOString(),
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

    // ✅ FIX: Emit test:progress when generating actions
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 55,
        phase: 'generation',
        currentStep: '🤖 Generating actions with AI...',
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 55,
        phase: 'generation',
        currentStep: '🤖 Generating actions with AI...',
        status: 'running',
        timestamp: new Date().toISOString(),
      });
    }

    // ✅ NEW: Convert TestHint[] to simpler format for ContextualActionGenerator
    const hints = this.config.hints?.map(h => ({
      description: h.description,
      action: h.action,
      target: h.target,
      value: h.value,
      priority: h.priority,
    }));

    // ✅ FIX 9: Pass cost manager and hints to action generator
    const result = await ContextualActionGenerator.generateActions(
      context,
      this.state,
      this.page,
      this.costManager,
      hints  // ✅ NEW: Pass hints for AI guidance
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

    // ✅ FIX: Emit test:progress after actions generated
    if (this.progressEmitter) {
      this.progressEmitter.emit({
        progress: 60,
        phase: 'generation',
        currentStep: `✅ Generated ${safeActions.length} action(s)`,
      });
    }
    if (this.testId) {
      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.config.browser || 'chrome',
        progress: 60,
        phase: 'generation',
        currentStep: `✅ Generated ${safeActions.length} action(s)`,
        status: 'running',
        timestamp: new Date().toISOString(),
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

        // ═══════════════════════════════════════════════════════════════════════════
        // ✅ NEW: PRE-ACTION ANALYSIS (Phase 1 - UI Tester Intelligence)
        // Analyzes page state BEFORE action to prevent failures
        // ═══════════════════════════════════════════════════════════════════════════
        const pageContext = AdaptiveConfigService.analyzePageContext(this.state, context.pageType);
        if (action.selector && AdaptiveConfigService.requiresPreActionAnalysis(action, {
          pageType: context.pageType,
          hasForm: (context.dom?.forms?.length || 0) > 0,
          isSlowPage: pageContext.isSlowPage,
        })) {
          const preAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, action);

          // If there are blocking factors, try to resolve them first
          if (!preAnalysis.canProceed && preAnalysis.suggestedActions.length > 0) {
            logger.info('[INTELLIGENT_ORCHESTRATOR] Pre-action analysis found blocking factors', {
              testId: this.testId,
              action: action.description,
              blockingFactors: preAnalysis.blockingFactors.map(bf => bf.description),
              suggestedActionsCount: preAnalysis.suggestedActions.length,
            });

            // Execute suggested prerequisite actions (e.g., fill required fields)
            for (const prereqAction of preAnalysis.suggestedActions) {
              try {
                logger.info('[INTELLIGENT_ORCHESTRATOR] Executing prerequisite action', {
                  testId: this.testId,
                  prereqAction: prereqAction.description,
                  forAction: action.description,
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
            const reAnalysis = await PreActionAnalyzer.analyzeBeforeAction(this.page, action);
            if (!reAnalysis.canProceed) {
              logger.warn('[INTELLIGENT_ORCHESTRATOR] Still cannot proceed after prerequisites', {
                testId: this.testId,
                action: action.description,
                remainingBlockers: reAnalysis.blockingFactors.map(bf => bf.description),
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

          // Log validation errors if any
          if (preAnalysis.validationErrors.length > 0) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Validation errors detected before action', {
              testId: this.testId,
              action: action.description,
              errors: preAnalysis.validationErrors,
            });
          }
        }

        // ✅ IMPROVED: Validate selector exists AND is visible/actionable before execution
        const normalizedSelectorForReliability = action.selector ? normalizeSelector(action.selector) : '';
        const selectorReliability = normalizedSelectorForReliability && this.selectorFailures.has(normalizedSelectorForReliability)
          ? 'low' as const
          : 'high' as const;
        if (action.selector && AdaptiveConfigService.requiresSelectorValidation(action, {
          pageType: context.pageType,
          selectorReliability,
        })) {
          try {
            // ✅ FIX: Normalize selector format before using (convert getByText('text') → text="text")
            const normalizedSelector = normalizeSelector(action.selector);
            // ✅ CRITICAL FIX: Use getLocator() helper to support text=, role=, label= formats
            const locator = this.getLocatorWrapper(normalizedSelector);
            const elementCount = await locator.count();

            if (elementCount === 0) {
              // ✅ NEW: Track selector failures to prevent infinite loops
              const failureCount = (this.selectorFailures.get(normalizedSelector) || 0) + 1;
              this.selectorFailures.set(normalizedSelector, failureCount);

              logger.warn('[INTELLIGENT_ORCHESTRATOR] Selector not found, marking action as optional', {
                testId: this.testId,
                action: action.description,
                selector: action.selector,
                normalizedSelector,
                failureCount,
                maxFailures: AdaptiveConfigService.getThreshold('MAX_SELECTOR_FAILURES', {
                  testMode: this.config.mode,
                  hasManySelectors: AdaptiveConfigService.analyzePageContext(this.state).hasManySelectors,
                }),
              });

              // If selector failed too many times, skip permanently (reuse outer pageContext)
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
              }

              // Mark as optional and skip
              const actionResult: ActionResult = {
                action: { ...action, selector: normalizedSelector }, // Update with normalized selector
                success: false,
                error: `Selector not found: ${normalizedSelector} (failed ${failureCount} times)`,
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
            } else {
              // ✅ NEW: Reset failure count if selector works
              this.selectorFailures.delete(normalizedSelector);
            }

            // ✅ NEW: For click actions, also check if element is visible and actionable
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
                // ✅ FIX: Use first() to get single element for evaluate
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

        // ✅ OPTIMIZED: Smart screenshot capture - only when necessary
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

        // ✅ NEW: Check if element is disabled BEFORE attempting action
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

            // ✅ STRATEGY: Instead of generating new actions mid-execution,
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

        // ✅ NEW: Capture DOM snapshot BEFORE action for post-action analysis
        let snapshotBefore: DOMSnapshot | undefined;
        const shouldDoPostAnalysis = ['fill', 'type', 'click', 'select'].includes(action.action);
        if (shouldDoPostAnalysis) {
          snapshotBefore = await PostActionAnalyzer.captureSnapshot(this.page).catch(() => undefined);
        }

        // Execute action using CommandExecutor
        // ✅ FIX: Normalize selector before passing to CommandExecutor (it will normalize again, but this ensures consistency)
        const selectorForExecution = action.selector ? normalizeSelector(action.selector) : action.selector;
        const executionResult = await this.commandExecutor.executeCommand({
          action: action.action as any,
          selector: selectorForExecution,
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

        // ✅ OPTIMIZED: Smart waiting - only wait if URL changed (page navigation)
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
        // ✅ REMOVED: No delay needed for same-page actions (most actions don't need delay)

        // ✅ OPTIMIZED: Capture AFTER screenshot only in critical cases:
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

        // ✅ FIX: Emit test:progress update after each action completion
        if (this.progressEmitter) {
          const progress = 60 + Math.round(((i + 1) / actions.length) * 30);
          this.progressEmitter.emit({
            progress,
            phase: 'execution',
            currentStep: actionResult.success
              ? `✅ ${this.getActionEmoji(action.action)} ${action.description}`
              : `❌ ${this.getActionEmoji(action.action)} ${action.description} (failed)`,
            action: {
              type: action.action,
              description: action.description,
              target: action.selector,
            },
            completedSteps: i + 1,
            status: actionResult.success ? 'running' : 'error',
          });
        }

        // ✅ FIX: Also emit via WebSocket for test:update compatibility
        if (this.testId) {
          webSocketService.emitTestProgress(this.testId, {
            testId: this.testId,
            browser: this.config.browser || 'chrome',
            progress: 60 + Math.round(((i + 1) / actions.length) * 30),
            phase: 'execution',
            currentStep: actionResult.success
              ? `✅ ${action.description}`
              : `❌ ${action.description} (failed)`,
            action: {
              type: action.action,
              description: action.description,
              target: action.selector,
            },
            totalSteps: actions.length,
            completedSteps: i + 1,
            status: actionResult.success ? 'running' : 'error',
            timestamp: new Date().toISOString(),
          });
        }

        // ✅ NEW: Add action to graph and emit real-time update
        if (this.testId && this.userId && this.graphBuilder) {
          const graphUpdate = this.graphBuilder.addActionNode(action, {
            success: actionResult.success,
            error: actionResult.error,
            durationMs: undefined, // Duration not available in executionResult
            urlChanged: actionResult.urlChanged,
            urlBefore: actionResult.urlBefore,
            urlAfter: actionResult.urlAfter,
            retryCount: actionResult.retryCount,
            isTimeout: (actionResult.error?.toLowerCase() ?? '').includes('timeout'),
            // ✅ NEW: Include screenshots
            screenshotBefore,
            screenshotAfter,
            screenshot: executionResult.screenshot, // From command executor if available
          });
          this.emitGraphUpdate(graphUpdate);
        }

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

        // ═══════════════════════════════════════════════════════════════════════════
        // ✅ NEW: POST-ACTION ANALYSIS - Check for errors after action
        // ═══════════════════════════════════════════════════════════════════════════
        const isSubmitAction = action.action === 'click' && action.description?.toLowerCase().includes('submit');
        if (AdaptiveConfigService.requiresPostActionAnalysis(action, {
          pageType: context.pageType,
          hasForm: (context.dom?.forms?.length || 0) > 0,
          isSubmitAction,
        })) {
          const postAnalysis = await PreActionAnalyzer.analyzeAfterAction(
            this.page,
            action,
            actionResult.success
          );

          if (postAnalysis.hasNewErrors) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Post-action analysis detected errors', {
              testId: this.testId,
              action: action.description,
              errors: postAnalysis.errors,
              suggestions: postAnalysis.suggestions,
            });

            // ═══════════════════════════════════════════════════════════════════════════
            // ✅ PHASE 2: FORM INTELLIGENCE - Try to fix validation errors
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
          // ✅ NEW: AI-DRIVEN POST-ACTION ANALYSIS
          // Analyzes what changed and decides if follow-up actions are needed
          // ═══════════════════════════════════════════════════════════════════════════
          if (shouldDoPostAnalysis && actionResult.success && !urlChanged) {
            try {
              const postActionDecision = await PostActionAnalyzer.analyze(
                this.page,
                {
                  action,
                  actionResult,
                  inputValue: action.value?.toString(),
                  goal: this.state.goal,
                },
                snapshotBefore,
                this.costManager
              );

              // Execute follow-up actions if AI decided they're needed
              if (postActionDecision.needsFollowUp && postActionDecision.followUpActions.length > 0) {
                logger.info('[INTELLIGENT_ORCHESTRATOR] Executing AI-decided follow-up actions', {
                  testId: this.testId,
                  reason: postActionDecision.reason,
                  stateChange: postActionDecision.stateChange,
                  followUpCount: postActionDecision.followUpActions.length,
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
          // ✅ PHASE 2: FORM INTELLIGENCE - Wait for conditional fields after fill/select
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
  // HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert DynamicAction to PlaywrightCommand for execution
   */
  private convertActionToCommand(action: DynamicAction): import('@/types').PlaywrightCommand {
    return {
      action: action.action as import('@/types').PlaywrightActionType,
      selector: action.selector ? normalizeSelector(action.selector) : undefined,
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

    // ✅ IMPROVED: Check if we visited the start URL (with normalization and redirect handling)
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
    const stats = StateTracker.getStatistics(this.state);

    const summary = this.buildSummary(success, stats);

    // ✅ NEW: Collect screenshots from page visits
    const screenshots = this.state.visitedPages
      .filter(pageVisit => pageVisit.screenshot)
      .map((pageVisit, index) => ({
        url: pageVisit.url,
        screenshot: pageVisit.screenshot!,
      }));

    // ✅ OPTIMIZED: Log screenshot metrics
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

    // ✅ NEW: Add end node and emit final graph
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

    // ✅ NEW: Get final graph for storage
    let graphData = this.graphBuilder ? this.graphBuilder.getFullGraph() : undefined;

    // ✅ NEW: Log graph data for debugging
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

    // ✅ NEW: Upload screenshots from graph to storage and replace base64 with public URLs
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
      graphData, // ✅ NEW: Include complete graph with public URLs
    };
  }

  /**
   * ✅ NEW: Upload all screenshots from graph to storage and replace base64 with public URLs
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
  // WEBSOCKET EVENTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Emit event via WebSocket
   * ✅ OPTIMIZED: Deduplicates redundant events, only emits on state changes
   */
  private lastEmittedEvent: { event: string; timestamp: number } | null = null;

  private emitEvent(event: string, data: any): void {
    if (!this.userId || !this.testId) {
      return;
    }

    // ✅ OPTIMIZATION: Deduplicate rapid-fire identical events
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

    // ✅ OPTIMIZATION: Filter out noisy events
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

  // ✅ NEW: Emit graph update via WebSocket
  private emitGraphUpdate(update: import('./utils/graph-builder.service').GraphUpdate): void {
    if (!this.userId || !this.testId) {
      return;
    }

    try {
      webSocketService.emitToUser(this.userId, 'test:graph-update', {
        testId: this.testId,
        type: update.type,
        data: {
          newNode: update.newNode,
          newEdge: update.newEdge,
          updatedNode: update.updatedNode,
          fullGraph: update.fullGraph,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Silent fail - don't log WebSocket errors
      logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to emit graph update', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
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

  /**
   * ✅ FIX 2: Use centralized selector normalization (removed duplication)
   */
  // Removed: normalizeSelector() - now using utils/selector-utils.ts

  /**
   * ✅ FIX 2: Use centralized locator creation (removed duplication)
   */
  private getLocatorWrapper(selector: string): import('playwright').Locator {
    return getLocator(this.page, selector);
  }

  // ✅ FIX 2: Old implementations removed - now using centralized selector-utils.ts
}
