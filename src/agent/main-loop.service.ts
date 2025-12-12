/**
 * MainLoopService
 * Handles the main testing loop: analyze → generate → execute → decide → repeat
 * Extracted from IntelligentTestOrchestrator for better focus and maintainability
 */

import { AICostManager } from '@/services/ai-cost-manager.service';
import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import { AdaptiveConfigService } from './adaptive-config.service';
import { ContextualActionGenerator } from './contextual-action-generator';
import { SafetyGuard } from './safety-guard';
import { StateTracker } from './state-tracker';
import {
  DynamicAction,
  IntelligentTestConfig,
  PageContext,
  PageVisit,
  TestState,
} from './types/intelligent-testing.types';
import { ActionPattern, ActionPatternDetector } from './utils/action-pattern-detector';
import { GraphBuilder } from './utils/graph-builder.service';

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP DEPENDENCIES INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

export interface MainLoopDependencies {
  // Core dependencies
  page: Page;
  state: TestState;
  config: IntelligentTestConfig;

  // Optional identifiers
  testId?: string;
  userId?: string;

  // Optional services
  graphBuilder?: GraphBuilder;
  costManager?: AICostManager;

  // Mutable counters (will be updated)
  consecutiveEmptyPages: { value: number };

  // Methods to call
  checkTestCancelled: () => Promise<boolean>;
  analyzePage: () => Promise<PageContext>;
  generateActions: (context: PageContext) => Promise<{
    actions: DynamicAction[];
    reasoning: string;
    confidence: number;
  }>;
  executeActions: (context: PageContext, actions: DynamicAction[]) => Promise<PageVisit>;
  emitEvent: (event: string, data: any) => void;
  emitGraphUpdate: (update: any) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN LOOP SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class MainLoopService {
  /**
   * Execute main testing loop
   * Returns: true if cancelled, false if completed normally
   */
  static async execute(deps: MainLoopDependencies): Promise<boolean> {
    const {
      page,
      state,
      config,
      testId,
      userId,
      graphBuilder,
      costManager,
      consecutiveEmptyPages,
      checkTestCancelled,
      analyzePage,
      generateActions,
      executeActions,
      emitEvent,
      emitGraphUpdate,
    } = deps;

    let continueLoop = true;
    let iteration = 0;

    logger.info('[MAIN_LOOP] Starting main test loop', {
      testId,
      goal: config.goal,
      mode: config.mode,
    });

    while (continueLoop) {
      iteration++;
      logger.info(`[MAIN_LOOP] Loop iteration ${iteration}`, {
        testId,
        pagesVisited: state.pagesAnalyzed,
        actionsCompleted: state.completedActions.length,
        currentUrl: page.url(),
      });

      // Check if test was cancelled before each iteration
      if (await checkTestCancelled()) {
        logger.info('[MAIN_LOOP] Test was cancelled, stopping execution', {
          testId,
          iteration,
          pagesVisited: state.pagesAnalyzed,
          actionsCompleted: state.completedActions.length,
        });
        return true; // Return true to indicate cancellation
      }

      // Check limits before each iteration
      const limitsCheck = SafetyGuard.checkLimits(state, config.safety);
      if (!limitsCheck.safe) {
        logger.warn('[MAIN_LOOP] Limits exceeded', {
          testId,
          iteration,
          reason: limitsCheck.reason,
          stats: {
            pagesVisited: state.pagesAnalyzed,
            actionsCompleted: state.completedActions.length,
            duration: Date.now() - state.startTime,
          },
        });

        emitEvent('test_warning', {
          message: limitsCheck.reason || 'Limits exceeded',
        });

        break;
      }

      try {
        // STEP 1: Analyze current page
        const context = await analyzePage();

        // Add page node to graph when analyzing new page
        if (testId && userId && graphBuilder) {
          // Get page title and metadata from page
          let pageTitle: string | undefined;
          let metaDescription: string | undefined;
          try {
            pageTitle = await page.title();
            metaDescription = await page.$eval('meta[name="description"]', (el) => el.getAttribute('content') || '').catch(() => undefined);
          } catch (error) {
            logger.debug('[MAIN_LOOP] Failed to get page metadata', { error });
          }

          const pageUpdate = graphBuilder.addPageNode(
            context.url,
            context.pageType,
            {
              screenshot: context.screenshot,
              title: pageTitle,
              metaDescription: metaDescription,
              dom: {
                formsCount: context.dom.forms?.length || 0,
                buttonsCount: context.dom.buttons?.length || 0,
                linksCount: context.dom.links?.length || 0,
                inputsCount: context.dom.inputs?.length || 0,
              },
            }
          );
          emitGraphUpdate(pageUpdate);
        }

        // Check if test was cancelled after analysis (before expensive operations)
        if (await checkTestCancelled()) {
          logger.info('[MAIN_LOOP] Test was cancelled after page analysis', {
            testId,
            iteration,
          });
          return true;
        }

        // STEP 2: Check for cycles (URL-based)
        const cycleCheck = StateTracker.detectCycle(state, context.url);
        if (cycleCheck.cycleDetected) {
          logger.warn('[MAIN_LOOP] URL cycle detected', {
            suggestion: cycleCheck.suggestion,
            visitCount: cycleCheck.visitCount,
          });

          emitEvent('test_warning', {
            message: cycleCheck.suggestion,
          });

          // More aggressive stopping - if cycle detected, stop immediately
          const pageContext = AdaptiveConfigService.analyzePageContext(state, context.pageType);
          const cycleThreshold = AdaptiveConfigService.getThreshold('CYCLE_DETECTION_THRESHOLD', {
            testMode: config.mode,
            errorRate: pageContext.errorRate,
          });
          if (cycleCheck.visitCount && cycleCheck.visitCount >= cycleThreshold) {
            logger.warn('[MAIN_LOOP] Stopping due to excessive URL cycles', {
              visitCount: cycleCheck.visitCount,
              url: context.url,
            });
            break;
          }

          // Try to decide next step despite cycle
          const decision = await ContextualActionGenerator.decideNextStep(
            state,
            context,
            costManager
          );

          if (decision.action === 'stop' || decision.action === 'skip') {
            break;
          }
        }

        // STEP 2.5: Check for action patterns (repeated actions, failed chains, etc.)
        const patternCheck = ActionPatternDetector.detectPatterns(state);
        if (patternCheck.hasPattern) {
          logger.warn('[MAIN_LOOP] Problematic action patterns detected', {
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
            emitEvent('test_warning', {
              message: `⚠️ ${pattern.type}: ${pattern.description}`,
              severity: pattern.severity,
            });
          });

          // If critical pattern detected → stop test
          if (patternCheck.shouldStop) {
            logger.error('[MAIN_LOOP] Critical pattern detected - stopping test', {
              reason: patternCheck.reason,
            });

            emitEvent('test_stopped', {
              reason: patternCheck.reason,
            });

            break;
          }
        }

        // STEP 3: Generate actions
        const { actions, reasoning, confidence } = await generateActions(context);

        // Track empty pages and stop if 2+ consecutive empty pages
        const isEmptyPage = actions.length === 0 && (
          (context.vision.elements.length === 0 &&
           (context.dom.forms?.length || 0) === 0 &&
           (context.dom.buttons?.length || 0) === 0 &&
           (context.dom.links?.length || 0) === 0 &&
           (context.dom.inputs?.length || 0) === 0)
        );

        if (isEmptyPage) {
          consecutiveEmptyPages.value++;
          logger.warn('[MAIN_LOOP] Empty page detected', {
            url: context.url,
            consecutiveCount: consecutiveEmptyPages.value,
            pageType: context.pageType,
            elementsCount: context.vision.elements.length,
          });

          // Stop if threshold reached
          const pageContext = AdaptiveConfigService.analyzePageContext(state, context.pageType);
          const emptyPagesThreshold = AdaptiveConfigService.getThreshold('CONSECUTIVE_EMPTY_PAGES_THRESHOLD', {
            testMode: config.mode,
            isComplexPage: pageContext.isComplexPage,
          });
          if (consecutiveEmptyPages.value >= emptyPagesThreshold) {
            logger.warn('[MAIN_LOOP] Stopping due to consecutive empty pages', {
              consecutiveCount: consecutiveEmptyPages.value,
              url: context.url,
            });
            emitEvent('test_warning', {
              message: `Stopped: ${consecutiveEmptyPages.value} consecutive empty pages detected. No interactive elements found.`,
            });
            break;
          }
        } else {
          // Reset counter if page has elements
          consecutiveEmptyPages.value = 0;
        }

        if (actions.length === 0) {
          logger.warn('[MAIN_LOOP] No actions generated', {
            url: context.url,
            reason: reasoning,
            pageType: context.pageType,
            elementsCount: context.vision.elements.length,
          });

          // Decide next step
          const decision = await ContextualActionGenerator.decideNextStep(
            state,
            context,
            costManager
          );

          if (decision.action !== 'continue') {
            break;
          }

          continue;
        }

        logger.info('[MAIN_LOOP] Generated actions', {
          count: actions.length,
          reasoning,
          confidence,
        });

        // STEP 4: Execute actions
        const pageVisit = await executeActions(context, actions);

        // Add screenshot from context to page visit
        pageVisit.screenshot = context.screenshot;

        // Only record visit if URL changed OR actions were successful
        const urlChanged = state.currentUrl !== context.url;
        const hasSuccessfulActions = pageVisit.actionResults?.some(r => r.success) || false;
        const shouldRecordVisit = urlChanged || hasSuccessfulActions;

        if (shouldRecordVisit) {
          // STEP 5: Record visit
          // Note: StateTracker.recordPageVisit returns a new state object
          const newState = StateTracker.recordPageVisit(state, pageVisit);
          // Update state properties (state is passed by reference, but we need to update it)
          Object.assign(state, newState);
          logger.debug('[MAIN_LOOP] Page visit recorded', {
            url: context.url,
            urlChanged,
            hasSuccessfulActions,
            actionsCount: pageVisit.actionResults?.length || 0,
          });
        } else {
          logger.debug('[MAIN_LOOP] Skipping visit record - same URL and no successful actions', {
            url: context.url,
            failedActions: pageVisit.actionResults?.filter(r => !r.success).length || 0,
          });
        }

        // STEP 6: Decide next step
        const decision = await ContextualActionGenerator.decideNextStep(
          state,
          context,
          costManager
        );

        logger.info('[MAIN_LOOP] Next step decision', {
          action: decision.action,
          reason: decision.reason,
        });

        emitEvent('test_progress', {
          action: decision.action,
          reason: decision.reason,
          pagesVisited: state.pagesAnalyzed,
          actionsCompleted: state.completedActions.length,
        });

        // Handle decision
        switch (decision.action) {
          case 'stop':
            logger.info('[MAIN_LOOP] Stopping: ' + decision.reason);
            continueLoop = false;
            break;

          case 'wait_for_user':
            logger.info('[MAIN_LOOP] Waiting for user approval');
            emitEvent('test_waiting', {
              reason: decision.reason,
            });
            continueLoop = false;
            break;

          case 'skip':
            logger.info('[MAIN_LOOP] Skipping: ' + decision.reason);
            // Go back if possible
            try {
              const pageContext = AdaptiveConfigService.analyzePageContext(state);
              await page.goBack({
                timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
                  networkSpeed: pageContext.networkSpeed,
                }),
              });
            } catch {
              continueLoop = false;
            }
            break;

          case 'retry':
            logger.info('[MAIN_LOOP] Retrying...');
            // Continue with retry
            break;

          case 'continue':
          default:
            // Continue loop
            break;
        }

        // Check cancellation after iteration
        if (await checkTestCancelled()) {
          logger.info('[MAIN_LOOP] Test was cancelled after iteration', {
            testId,
            iteration,
          });
          return true;
        }
      } catch (error) {
        // Enhanced error logging with iteration context
        logger.error('[MAIN_LOOP] Loop iteration failed', {
          testId,
          iteration,
          currentUrl: page.url(),
          pagesVisited: state.pagesAnalyzed,
          actionsCompleted: state.completedActions.length,
          errorCount: state.errors.length,
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
          } : String(error),
        });

        state.errors.push({
          message: error instanceof Error ? error.message : 'Iteration failed',
          timestamp: Date.now(),
        });

        // Check for repeated selector errors (infinite loop detection)
        const errorPageContext = AdaptiveConfigService.analyzePageContext(state);
        const recentErrorsCheckCount = AdaptiveConfigService.getThreshold('RECENT_ERRORS_CHECK_COUNT', {
          errorRate: errorPageContext.errorRate,
        });
        const recentSelectorErrors = state.errors
          .slice(-recentErrorsCheckCount)
          .filter(e => e.message.includes('Selector not found') || e.message.includes('not found'))
          .length;

        const selectorErrorsThreshold = AdaptiveConfigService.getThreshold('RECENT_SELECTOR_ERRORS_THRESHOLD', {
          errorRate: errorPageContext.errorRate,
        });
        if (recentSelectorErrors >= selectorErrorsThreshold) {
          logger.error('[MAIN_LOOP] Too many selector errors in a row, possible infinite loop', {
            testId,
            recentSelectorErrors,
            totalErrors: state.errors.length,
            recentErrors: state.errors.slice(-3).map(e => e.message),
          });
          emitEvent('test_warning', {
            message: 'Too many selector errors detected. Test may be stuck in a loop.',
          });
        }

        // Too many errors? Stop
        const maxErrors = AdaptiveConfigService.getThreshold('MAX_ERRORS_BEFORE_STOP', {
          testMode: config.mode,
          errorRate: errorPageContext.errorRate,
          isComplexPage: errorPageContext.isComplexPage,
        });
        if (state.errors.length > maxErrors) {
          logger.error('[MAIN_LOOP] Too many errors, stopping', {
            testId,
            totalErrors: state.errors.length,
            recentErrors: state.errors.slice(-3).map(e => e.message),
          });
          break;
        }

        // Continue despite error
        logger.info('[MAIN_LOOP] Continuing despite error', {
          testId,
          iteration,
          errorCount: state.errors.length,
        });
        continue;
      }
    }

    logger.info('[MAIN_LOOP] Main loop ended', {
      testId,
      stats: StateTracker.formatStatistics(state),
    });

    return false; // Return false to indicate normal completion (not cancelled)
  }
}
