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
  NextStepDecision,
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
  config: IntelligentTestConfig;
  getState: () => TestState;
  setState: (next: TestState) => void;

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
      config,
      getState,
      setState,
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

    const isAboutUrl = (url: string): boolean => url === 'about:blank' || url.startsWith('about:');

    let continueLoop = true;
    let iteration = 0;

    logger.info('[MAIN_LOOP] Starting main test loop', {
      testId,
      goal: config.goal,
      mode: config.mode,
    });

    while (continueLoop) {
      iteration++;
      const state = getState();

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
          pagesVisited: getState().pagesAnalyzed,
          actionsCompleted: getState().completedActions.length,
        });
        return true; // Return true to indicate cancellation
      }

      // Check limits before each iteration
      const limitsCheck = SafetyGuard.checkLimits(getState(), config.safety);
      if (!limitsCheck.safe) {
        const currentState = getState();
        logger.warn('[MAIN_LOOP] Limits exceeded', {
          testId,
          iteration,
          reason: limitsCheck.reason,
          stats: {
            pagesVisited: currentState.pagesAnalyzed,
            actionsCompleted: currentState.completedActions.length,
            duration: Date.now() - currentState.startTime,
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

        // Safety guard: analyzePage() tries to recover from about: URLs, but if it didn't,
        // we should not continue with action generation on an invalid page.
        if (isAboutUrl(context.url)) {
          logger.error('[MAIN_LOOP] Page is still on about:* after analysis recovery', {
            testId,
            iteration,
            url: context.url,
            startUrl: config.startUrl,
          });
          emitEvent('test_warning', {
            message: `Navigation issue: page is at "${context.url}". Stopping run.`,
          });
          break;
        }

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

        // STEP 1.5: Detect truly empty pages BEFORE spending tokens on action generation
        const hasNoInteractiveElements =
          context.vision.elements.length === 0 &&
          (context.dom.forms?.length || 0) === 0 &&
          (context.dom.buttons?.length || 0) === 0 &&
          (context.dom.links?.length || 0) === 0 &&
          (context.dom.inputs?.length || 0) === 0;

        if (hasNoInteractiveElements) {
          consecutiveEmptyPages.value++;

          logger.warn('[MAIN_LOOP] Page has no detectable interactive elements', {
            testId,
            iteration,
            url: context.url,
            pageType: context.pageType,
            consecutiveCount: consecutiveEmptyPages.value,
          });

          const pageContext = AdaptiveConfigService.analyzePageContext(getState(), context.pageType);
          const emptyPagesThreshold = AdaptiveConfigService.getThreshold('CONSECUTIVE_EMPTY_PAGES_THRESHOLD', {
            testMode: config.mode,
            isComplexPage: pageContext.isComplexPage,
          });

          if (consecutiveEmptyPages.value >= emptyPagesThreshold) {
            emitEvent('test_warning', {
              message: `Stopped: ${consecutiveEmptyPages.value} consecutive pages with no interactive elements detected.`,
            });
            break;
          }

          // If page is empty but threshold not reached, ask the decision engine what to do next.
          const decision = await ContextualActionGenerator.decideNextStep(
            getState(),
            context,
            costManager
          );

          logger.info('[MAIN_LOOP] Decision on empty page', {
            testId,
            iteration,
            action: decision.action,
            reason: decision.reason,
          });

          if (decision.action === 'stop') {
            continueLoop = false;
            break;
          }

          if (decision.action === 'skip') {
            const skipResult = await MainLoopService.handleSkipNavigation(page, config, getState);
            if (!skipResult.shouldContinue) {
              continueLoop = false;
            }
          }

          // retry/continue -> move to next iteration
          continue;
        } else {
          // Reset counter if page has elements
          consecutiveEmptyPages.value = 0;
        }

        // STEP 2: Check for cycles (URL-based)
        const cycleCheck = StateTracker.detectCycle(getState(), context.url);
        if (cycleCheck.cycleDetected) {
          logger.warn('[MAIN_LOOP] URL cycle detected', {
            suggestion: cycleCheck.suggestion,
            visitCount: cycleCheck.visitCount,
          });

          emitEvent('test_warning', {
            message: cycleCheck.suggestion,
          });

          // More aggressive stopping - if cycle detected, stop immediately
          const pageContext = AdaptiveConfigService.analyzePageContext(getState(), context.pageType);
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
            getState(),
            context,
            costManager
          );

          if (decision.action === 'stop' || decision.action === 'skip') {
            break;
          }
        }

        // STEP 2.5: Check for action patterns (repeated actions, failed chains, etc.)
        const patternCheck = ActionPatternDetector.detectPatterns(getState());
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

        if (actions.length === 0) {
          logger.warn('[MAIN_LOOP] No actions generated', {
            url: context.url,
            reason: reasoning,
            pageType: context.pageType,
            elementsCount: context.vision.elements.length,
          });

          // Decide next step
          const decision = await ContextualActionGenerator.decideNextStep(
            getState(),
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
        const currentStateAfterActions = getState();
        const urlChanged = currentStateAfterActions.currentUrl !== context.url;
        const hasSuccessfulActions = pageVisit.actionResults?.some(r => r.success) || false;
        const shouldRecordVisit = urlChanged || hasSuccessfulActions;

        if (shouldRecordVisit) {
          // STEP 5: Record visit
          const newState = StateTracker.recordPageVisit(getState(), pageVisit);
          setState(newState);
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

        // ✅ FIX: If actions caused navigation, don't decide next step using stale pre-navigation context.
        // Next iteration will analyze the new page and make a correct decision with fresh context.
        if (urlChanged) {
          logger.info('[MAIN_LOOP] URL changed during actions, continuing to next iteration for fresh analysis', {
            testId,
            iteration,
            fromUrl: context.url,
            toUrl: currentStateAfterActions.currentUrl,
          });

          // Check cancellation after navigation-triggering iteration
          if (await checkTestCancelled()) {
            logger.info('[MAIN_LOOP] Test was cancelled after navigation-triggering iteration', {
              testId,
              iteration,
            });
            return true;
          }

          continue;
        }

        // STEP 6: Decide next step
        const decision = await ContextualActionGenerator.decideNextStep(
          getState(),
          context,
          costManager
        );

        logger.info('[MAIN_LOOP] Next step decision', {
          action: decision.action,
          reason: decision.reason,
          confidence: decision.confidence,
          progress: decision.metadata?.progress,
          riskLevel: decision.metadata?.riskLevel,
        });

        emitEvent('test_progress', {
          action: decision.action,
          reason: decision.reason,
          confidence: decision.confidence,
          progress: decision.metadata?.progress,
          riskLevel: decision.metadata?.riskLevel,
          pagesVisited: getState().pagesAnalyzed,
          actionsCompleted: getState().completedActions.length,
        });

        // Handle decision
        const decisionResult = await MainLoopService.handleDecision({
          decision,
          context,
          page,
          config,
          getState,
          testId,
          userId,
          emitEvent,
        });

        if (!decisionResult.shouldContinue) {
          continueLoop = false;
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
        const currentState = getState();

        // Enhanced error logging with iteration context
        logger.error('[MAIN_LOOP] Loop iteration failed', {
          testId,
          iteration,
          currentUrl: page.url(),
          pagesVisited: currentState.pagesAnalyzed,
          actionsCompleted: currentState.completedActions.length,
          errorCount: currentState.errors.length,
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
          } : String(error),
        });

        setState({
          ...currentState,
          errors: [
            ...currentState.errors,
            {
              message: error instanceof Error ? error.message : 'Iteration failed',
              timestamp: Date.now(),
            },
          ],
        });

        // Check for repeated selector errors (infinite loop detection)
        const errorState = getState();
        const errorPageContext = AdaptiveConfigService.analyzePageContext(errorState);
        const recentErrorsCheckCount = AdaptiveConfigService.getThreshold('RECENT_ERRORS_CHECK_COUNT', {
          errorRate: errorPageContext.errorRate,
        });
        const recentSelectorErrors = errorState.errors
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
            totalErrors: errorState.errors.length,
            recentErrors: errorState.errors.slice(-3).map(e => e.message),
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
        if (errorState.errors.length > maxErrors) {
          logger.error('[MAIN_LOOP] Too many errors, stopping', {
            testId,
            totalErrors: errorState.errors.length,
            recentErrors: errorState.errors.slice(-3).map(e => e.message),
          });
          break;
        }

        // Continue despite error
        logger.info('[MAIN_LOOP] Continuing despite error', {
          testId,
          iteration,
          errorCount: errorState.errors.length,
        });
        continue;
      }
    }

    logger.info('[MAIN_LOOP] Main loop ended', {
      testId,
      stats: StateTracker.formatStatistics(getState()),
    });

    return false; // Return false to indicate normal completion (not cancelled)
  }

  /**
   * Handle next step decision
   * Returns whether the loop should continue
   */
  private static async handleDecision(params: {
    decision: NextStepDecision;
    context: PageContext;
    page: Page;
    config: IntelligentTestConfig;
    getState: () => TestState;
    testId?: string;
    userId?: string;
    emitEvent: (event: string, data: any) => void;
  }): Promise<{ shouldContinue: boolean }> {
    // Validate inputs
    if (!params || !params.decision) {
      logger.error('[MAIN_LOOP] Invalid decision parameter');
      return { shouldContinue: false };
    }

    if (!params.context || !params.page || !params.config || !params.getState) {
      logger.error('[MAIN_LOOP] Missing required parameters in handleDecision', {
        hasContext: !!params?.context,
        hasPage: !!params?.page,
        hasConfig: !!params?.config,
        hasGetState: !!params?.getState,
      });
      return { shouldContinue: false };
    }

    const { decision, context, page, config, getState, testId, userId, emitEvent } = params;

    // Validate decision.action
    const validActions = ['continue', 'stop', 'wait_for_user', 'retry', 'skip'] as const;
    if (!validActions.includes(decision.action as any)) {
      logger.warn('[MAIN_LOOP] Unknown decision action', {
        action: decision.action,
        reason: decision.reason,
      });
      // Fail-safe: continue loop for unknown actions
      return { shouldContinue: true };
    }

    switch (decision.action) {
      case 'stop':
        logger.info('[MAIN_LOOP] Stopping: ' + decision.reason);
        return { shouldContinue: false };

      case 'wait_for_user': {
        // Validate reason
        const reason = decision.reason || 'Unknown reason';

        logger.warn('[MAIN_LOOP] Waiting for user input', {
          testId,
          reason,
        });

        // Validate testId and userId
        if (!testId || !userId) {
          logger.warn('[MAIN_LOOP] Cannot request clarification - missing testId or userId', {
            testId: !!testId,
            userId: !!userId,
          });
          emitEvent('test_warning', {
            message: `Waiting for user: ${reason}`,
          });
          return { shouldContinue: false };
        }

        // Detect what data is missing and request clarification
        let clarificationType: 'url' | 'credentials' | 'test_data' | 'payment_approval' | null = null;
        try {
          clarificationType = MainLoopService.detectMissingDataType(reason, context);
        } catch (error) {
          logger.error('[MAIN_LOOP] Failed to detect missing data type', {
            error: error instanceof Error ? error.message : String(error),
            reason,
          });
          // Continue without clarification type - will use generic message
        }

        // If we can request clarification (have testId, userId, and detected type)
        if (clarificationType) {
          // Safely load ClarificationService
          let ClarificationService;
          try {
            ClarificationService = require('./utils/clarification.service').ClarificationService;
            if (!ClarificationService || typeof ClarificationService.requestClarification !== 'function') {
              throw new Error('ClarificationService.requestClarification is not a function');
            }
          } catch (requireError) {
            logger.error('[MAIN_LOOP] Failed to load ClarificationService', {
              error: requireError instanceof Error ? requireError.message : String(requireError),
            });
            emitEvent('test_warning', {
              message: `Waiting for user: ${reason} (service unavailable)`,
            });
            return { shouldContinue: false };
          }

          let question: string;
          try {
            question = MainLoopService.buildClarificationQuestion(clarificationType, reason, context);
          } catch (error) {
            logger.error('[MAIN_LOOP] Failed to build clarification question', {
              error: error instanceof Error ? error.message : String(error),
              clarificationType,
            });
            emitEvent('test_warning', {
              message: `Waiting for user: ${reason}`,
            });
            return { shouldContinue: false };
          }

          try {
            const answer = await ClarificationService.requestClarification({
              testId,
              userId,
              question,
              type: clarificationType,
              required: true,
            });

            // Validate answer (check for empty string, null, undefined)
            if (answer && typeof answer === 'string' && answer.trim().length > 0) {
              logger.info('[MAIN_LOOP] Received clarification response', {
                testId,
                type: clarificationType,
                answerLength: answer.length,
              });

              // Store clarification for use in next iteration
              emitEvent('test_info', {
                message: `User provided ${clarificationType}: ${answer.substring(0, 50)}...`,
              });

              // Continue to next iteration with clarification data
              return { shouldContinue: true };
            } else {
              logger.warn('[MAIN_LOOP] Empty or invalid response to clarification, stopping test', {
                testId,
                type: clarificationType,
                answerType: typeof answer,
                answerLength: answer ? String(answer).length : 0,
              });
              emitEvent('test_warning', {
                message: `No response from user. Stopping test.`,
              });
              return { shouldContinue: false };
            }
          } catch (clarificationError) {
            logger.error('[MAIN_LOOP] Clarification failed', {
              testId,
              error: clarificationError instanceof Error ? clarificationError.message : String(clarificationError),
              stack: clarificationError instanceof Error ? clarificationError.stack : undefined,
            });
            emitEvent('test_warning', {
              message: `Failed to request clarification: ${clarificationError instanceof Error ? clarificationError.message : 'Unknown error'}`,
            });
            return { shouldContinue: false };
          }
        } else {
          // Generic wait_for_user without specific clarification type
          emitEvent('test_warning', {
            message: `Waiting for user: ${reason}`,
          });
          logger.warn('[MAIN_LOOP] Cannot request clarification - missing clarification type', {
            testId: !!testId,
            userId: !!userId,
            clarificationType,
            reason,
          });
          return { shouldContinue: false };
        }
      }

      case 'skip': {
        const reason = decision.reason || 'Unknown reason';
        logger.info('[MAIN_LOOP] Skipping: ' + reason);

        // Validate startUrl
        if (!config.startUrl || typeof config.startUrl !== 'string' || !config.startUrl.trim()) {
          logger.error('[MAIN_LOOP] Invalid startUrl in config, cannot navigate after skip', {
            startUrl: config.startUrl,
            startUrlType: typeof config.startUrl,
          });
          return { shouldContinue: false };
        }

        // Use shared navigation method
        return await MainLoopService.handleSkipNavigation(page, config, getState);
      }

      case 'retry': {
        const retryStrategy = decision.metadata?.retryStrategy;
        logger.info('[MAIN_LOOP] Retrying...', {
          strategy: retryStrategy || 'default',
        });

        // ✅ NEW: Apply retry strategy if provided
        if (retryStrategy) {
          try {
            switch (retryStrategy) {
              case 'wait':
                logger.info('[MAIN_LOOP] Applying wait strategy');
                await page.waitForTimeout(2000);
                break;
              case 'reload':
                logger.info('[MAIN_LOOP] Applying reload strategy');
                await page.reload({ waitUntil: 'domcontentloaded' });
                break;
              case 'navigate_back':
                logger.info('[MAIN_LOOP] Applying navigate_back strategy');
                await page.goBack({ waitUntil: 'domcontentloaded' });
                break;
              case 'choose_alternative_target':
                logger.info('[MAIN_LOOP] Applying choose_alternative_target strategy - will try different selectors in next iteration');
                // Strategy will be applied in action generation phase
                break;
              case 'reduce_scope':
                logger.info('[MAIN_LOOP] Applying reduce_scope strategy - will simplify actions in next iteration');
                // Strategy will be applied in action generation phase
                break;
              default:
                logger.debug('[MAIN_LOOP] Unknown retry strategy, using default');
            }
          } catch (retryError) {
            logger.warn('[MAIN_LOOP] Retry strategy failed', {
              strategy: retryStrategy,
              error: retryError instanceof Error ? retryError.message : String(retryError),
            });
            // Continue anyway
          }
        }

        // Continue with retry
        return { shouldContinue: true };
      }

      case 'continue':
      default:
        // Continue loop
        return { shouldContinue: true };
    }
  }

  /**
   * Handle skip navigation (goBack or goto startUrl)
   * Shared method to avoid code duplication
   */
  private static async handleSkipNavigation(
    page: Page,
    config: IntelligentTestConfig,
    getState: () => TestState
  ): Promise<{ shouldContinue: boolean }> {
    // Validate inputs
    if (!page || !config || !getState) {
      logger.error('[MAIN_LOOP] Invalid parameters for handleSkipNavigation');
      return { shouldContinue: false };
    }

    // Validate startUrl
    if (!config.startUrl || typeof config.startUrl !== 'string' || !config.startUrl.trim()) {
      logger.error('[MAIN_LOOP] Invalid startUrl in config');
      return { shouldContinue: false };
    }

    // Try to go back if possible
    try {
      const pageContext = AdaptiveConfigService.analyzePageContext(getState());
      await page.goBack({
        timeout: AdaptiveConfigService.getTimeout('GO_BACK', {
          networkSpeed: pageContext.networkSpeed,
        }),
      });
      logger.info('[MAIN_LOOP] Successfully went back after skip');
      return { shouldContinue: true };
    } catch (goBackError) {
      logger.warn('[MAIN_LOOP] Failed to go back, trying to navigate to start URL', {
        error: goBackError instanceof Error ? goBackError.message : String(goBackError),
      });

      // Fallback: attempt to return to start URL
      try {
        const pageContext = AdaptiveConfigService.analyzePageContext(getState());
        await page.goto(config.startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: AdaptiveConfigService.getTimeout('NAVIGATION', {
            networkSpeed: pageContext.networkSpeed,
            hasHeavyJS: pageContext.hasHeavyJS,
          }),
        });
        logger.info('[MAIN_LOOP] Successfully navigated to start URL after skip');
        return { shouldContinue: true };
      } catch (gotoError) {
        logger.error('[MAIN_LOOP] Failed to navigate to start URL after skip, stopping test', {
          error: gotoError instanceof Error ? gotoError.message : String(gotoError),
          startUrl: config.startUrl,
        });
        // Both navigation attempts failed - stop the test
        return { shouldContinue: false };
      }
    }
  }

  /**
   * Detect what type of data is missing from wait_for_user reason
   */
  private static detectMissingDataType(
    reason: string,
    context: PageContext
  ): 'url' | 'credentials' | 'test_data' | 'payment_approval' | null {
    const reasonLower = reason.toLowerCase();

    // Payment approval
    if (reasonLower.includes('payment') || reasonLower.includes('checkout') || reasonLower.includes('billing')) {
      return 'payment_approval';
    }

    // Credentials
    if (reasonLower.includes('login') || reasonLower.includes('credential') || reasonLower.includes('password') || reasonLower.includes('username')) {
      return 'credentials';
    }

    // Test data
    if (reasonLower.includes('test data') || reasonLower.includes('form data') || reasonLower.includes('test card') || reasonLower.includes('test information')) {
      return 'test_data';
    }

    // URL
    if (reasonLower.includes('url') || reasonLower.includes('navigate') || reasonLower.includes('unclear what to do')) {
      return 'url';
    }

    // Check context for hints
    if (context.pageType === 'payment') {
      return 'payment_approval';
    }

    if (context.pageType === 'login' || context.pageType === 'register') {
      return 'credentials';
    }

    return null;
  }

  /**
   * Build clarification question based on type
   */
  private static buildClarificationQuestion(
    type: 'url' | 'credentials' | 'test_data' | 'payment_approval',
    reason: string,
    context: PageContext
  ): string {
    switch (type) {
      case 'url':
        return `The test needs a specific URL to continue. Current page: ${context.url}. Reason: ${reason}. Please provide the URL where the test should navigate.`;

      case 'credentials':
        return `The test needs login credentials to continue. Page: ${context.pageType}. Reason: ${reason}. Please provide credentials in format: email/username:password`;

      case 'test_data':
        return `The test needs data to fill a form. Page: ${context.pageType}. Reason: ${reason}. Please provide the test data.`;

      case 'payment_approval':
        return `The test reached a payment page. Reason: ${reason}. Options: (1) Provide test card data, (2) Approve to stop test here, or (3) Cancel test. Please respond with your choice.`;

      default:
        return `The test needs your input. Reason: ${reason}. Please provide the required information.`;
    }
  }
}
