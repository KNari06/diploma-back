/**
 * IntelligentTestOrchestrator
 * Main orchestration loop for intelligent testing
 * Manages: analyze → understand → generate → execute → validate → decide → repeat
 */

import { Page, Browser } from 'playwright';
import { logger } from '@/utils/logger';
import { webSocketService } from '@/websocket/websocket.service';
import {
  IntelligentTestConfig,
  IntelligentTestResult,
  TestState,
  PageContext,
  DynamicAction,
  ActionResult,
  PageVisit,
} from './types/intelligent-testing.types';
import { IntelligentPageAnalyzer } from './intelligent-page-analyzer';
import { ContextualActionGenerator } from './contextual-action-generator';
import { SafetyGuard, DEFAULT_SAFETY_CONFIG } from './safety-guard';
import { StateTracker } from './state-tracker';
import { ResultValidator } from './result-validator';
import { CommandExecutor } from './command-executor';

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

  constructor(config: IntelligentTestConfig, userId?: string, testId?: string) {
    this.config = config;
    this.userId = userId;
    this.testId = testId;
  }

  /**
   * Execute intelligent test
   * Main entry point
   */
  async execute(browser: Browser, page: Page): Promise<IntelligentTestResult> {
    this.browser = browser;
    this.page = page;
    this.commandExecutor = new CommandExecutor(page);

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
      mode: this.config.mode,
      userId: this.userId,
      testId: this.testId,
    });

    this.emitEvent('test_started', {
      goal: this.config.goal,
      mode: this.config.mode,
    });

    try {
      // Main testing loop
      await this.mainLoop();

      // Build result
      const result = this.buildResult(true);

      logger.info('[INTELLIGENT_ORCHESTRATOR] Test completed successfully', {
        pagesVisited: result.pagesVisited,
        actionsTaken: result.actionsTaken,
        duration: `${Math.round(result.duration / 1000)}s`,
        cost: `$${result.cost.toFixed(3)}`,
      });

      this.emitEvent('test_completed', {
        success: true,
        summary: result.summary,
      });

      return result;
    } catch (error) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Test failed', { error });

      this.emitEvent('test_failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return this.buildResult(false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN TESTING LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  private async mainLoop(): Promise<void> {
    let continueLoop = true;

    while (continueLoop) {
      // Check limits before each iteration
      const limitsCheck = SafetyGuard.checkLimits(this.state, this.config.safety);
      if (!limitsCheck.safe) {
        logger.warn('[INTELLIGENT_ORCHESTRATOR] Limits exceeded', {
          reason: limitsCheck.reason,
        });

        this.emitEvent('test_warning', {
          message: limitsCheck.reason || 'Limits exceeded',
        });

        break;
      }

      try {
        // STEP 1: Analyze current page
        const context = await this.analyzePage();

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
          logger.warn('[INTELLIGENT_ORCHESTRATOR] No actions generated');

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
      } catch (error) {
        logger.error('[INTELLIGENT_ORCHESTRATOR] Loop iteration failed', { error });

        this.state.errors.push({
          message: error instanceof Error ? error.message : 'Iteration failed',
          timestamp: Date.now(),
        });

        // Too many errors? Stop
        if (this.state.errors.length > 5) {
          logger.error('[INTELLIGENT_ORCHESTRATOR] Too many errors, stopping');
          break;
        }

        // Continue despite error
        continue;
      }
    }

    logger.info('[INTELLIGENT_ORCHESTRATOR] Main loop ended', {
      stats: StateTracker.formatStatistics(this.state),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * STEP 1: Analyze current page
   */
  private async analyzePage(): Promise<PageContext> {
    logger.info('[INTELLIGENT_ORCHESTRATOR] Analyzing page', {
      url: this.page.url(),
    });

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
      this.state
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

    const completedActions: ActionResult[] = [];
    let success = true;

    for (const action of actions) {
      try {
        logger.info('[INTELLIGENT_ORCHESTRATOR] Executing action', {
          action: action.description,
        });

        this.emitEvent('action_executing', {
          action: action.description,
        });

        const urlBefore = this.page.url();

        // Execute action using CommandExecutor
        const executionResult = await this.commandExecutor.executeCommand({
          action: action.action as any,
          selector: action.selector,
          value: action.value,
          url: action.url,
          timeout: action.timeout,
          description: action.description,
        });

        await this.page.waitForTimeout(500); // Small delay for page to settle

        const urlAfter = this.page.url();
        const urlChanged = urlBefore !== urlAfter;

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

        const validationPassed = typeof validation === 'boolean' ? validation : validation.passed;
        const validationMessage = typeof validation === 'boolean' ? undefined : (validation.message || (!validation.passed ? 'Validation failed' : undefined));

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

        if (!actionResult.success) {
          success = false;

          // If action is not optional, consider stopping
          if (!action.optional) {
            logger.warn('[INTELLIGENT_ORCHESTRATOR] Critical action failed', {
              action: action.description,
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
        logger.error('[INTELLIGENT_ORCHESTRATOR] Action execution error', {
          action: action.description,
          error,
        });

        success = false;

        if (!action.optional) {
          break;
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

  private buildResult(success: boolean): IntelligentTestResult {
    const stats = StateTracker.getStatistics(this.state);

    const summary = this.buildSummary(success, stats);

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
      screenshots: [],
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
      webSocketService.emitToUser(this.userId, 'test_progress', {
        testId: this.testId,
        event,
        data,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('[INTELLIGENT_ORCHESTRATOR] Failed to emit event', {
        event,
        error,
      });
    }
  }
}
