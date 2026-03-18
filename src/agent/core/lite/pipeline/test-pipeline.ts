/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST PIPELINE — Orchestrates the Agent Team
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Modeled after: src/api/chat/general/sub-agents/pipeline.ts
 *
 * Coordinates the collaborative agent team:
 *
 *   while (!done && !timeout) {
 *     1. PLANNER  → reads Blackboard → creates/updates plan
 *     2. EXECUTOR → reads plan → executes Playwright commands → writes results
 *     3. REVIEWER → reads everything → validates → can trigger replan
 *   }
 *
 * All agents share context through the TestBlackboard:
 * - Planner knows what Executor did (rounds[]) and what Reviewer said (review)
 * - Executor knows what Planner planned (plan) and current page state
 * - Reviewer knows the goal, the plan, and all execution results
 *
 * Integrations (passed through from LiteEngine):
 * - GraphBuilder → real-time graph streaming via WebSocket
 * - TestProgressEmitter → WebSocket progress updates
 * - LiteTraceWriter → JSONL trace logging
 * - GoalDetector → progress scoring (in observe_page via CommandExecutor)
 * - NetworkTracker → network activity state
 * - ConsoleCollector → browser console errors
 * - PageWatcher → popup/multi-tab detection after click actions
 * - ErrorCollector → DOM error detection
 * - Test cancellation → checkTestCancelled / withCancellation wrappers
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import type { Page, BrowserContext } from 'playwright';
import type { GraphBuilder } from '@/agent/utils/visualization/graph-builder.service';
import type { TestProgressEmitter } from '@/agent/utils/visualization/progress-emitter';
import { ActionExecutor } from '../execution/action-executor';
import { PageWatcher } from '../execution/page-watcher';
import type { ConsoleCollector } from '../collectors/console-collector';
import { ErrorCollector } from '../collectors/error-collector';
import type { GoalDetector } from '../analysis/goal-detector';
import { GoalExpander } from '../analysis/goal-expander';
import type { NetworkTracker } from '../collectors/network-tracker';
import type { LiteTraceWriter } from '../trace/lite-trace-writer';
import { checkTestCancelled, withCancellation } from '../../../playwright/utils/test-cancellation-checker';

import { TestBlackboard } from './blackboard';
import { CommandExecutor, type CommandExecutorIntegrations } from './command-executor';
import { ExecutorAgent } from './executor-agent';
import { PlannerAgent } from './planner-agent';
import { ReviewerAgent } from './reviewer-agent';
import type { PipelineConfig, TestPipelineResult } from './types';

/** Pipeline integrations from LiteEngine */
export interface PipelineIntegrations {
  page: Page;
  actionExecutor: ActionExecutor;
  networkTracker: NetworkTracker;
  goalDetector?: GoalDetector;
  graphBuilder?: GraphBuilder;
  progressEmitter?: TestProgressEmitter;
  traceWriter?: LiteTraceWriter;
  /** Console collector for browser console errors */
  consoleCollector?: ConsoleCollector;
  /** Browser context for PageWatcher (popup/new-tab detection) */
  browserContext?: BrowserContext;
}

/** Default pipeline limits */
const PIPELINE_DEFAULTS = {
  maxRounds: 10,
  timeoutMs: 5 * 60 * 1000, // 5 minutes
} as const;

export class TestPipeline {
  private blackboard!: TestBlackboard;
  private commandExecutor!: CommandExecutor;
  private integrations: PipelineIntegrations;
  private startTime: number = 0;
  private actualTimeoutMs: number = PIPELINE_DEFAULTS.timeoutMs;
  private pageWatcher: PageWatcher | null = null;
  /** AbortController for cancelling in-flight LLM calls within executor */
  private abortController: AbortController | null = null;
  /** Track consecutive rounds where Executor produced zero commands (stuck detection) */
  private consecutiveEmptyRounds: number = 0;
  /** Max consecutive empty rounds before declaring blocked */
  private static readonly MAX_EMPTY_ROUNDS = 2;
  /** Track last error collection timestamp for per-round error collection */
  private lastErrorCollectionTime: number = 0;
  /** Track page state hash for same-state stuck detection */
  private previousSnapshotHash: string = '';
  /** Track consecutive rounds with identical page state */
  private consecutiveSameStateRounds: number = 0;
  /** Max consecutive same-state rounds before flagging stuck */
  private static readonly MAX_SAME_STATE_ROUNDS = 3;

  constructor(integrations: PipelineIntegrations) {
    this.integrations = integrations;
  }

  /**
   * Run the full pipeline: Planner → Executor → Reviewer loop.
   *
   * Creates Blackboard, coordinates agents, returns result.
   */
  async run(goal: string, config: PipelineConfig): Promise<TestPipelineResult> {
    this.startTime = Date.now();
    const maxRounds = config.maxRounds || PIPELINE_DEFAULTS.maxRounds;
    const timeoutMs = config.timeoutMs || PIPELINE_DEFAULTS.timeoutMs;
    this.actualTimeoutMs = timeoutMs;
    this.abortController = new AbortController();

    // ── Initialize Blackboard (shared state for all agents) ──
    this.blackboard = new TestBlackboard(
      goal,
      config.url,
      config.testId,
      config.hasCredentials,
    );

    // ── Initialize CommandExecutor with ALL integrations ──
    const cmdIntegrations: CommandExecutorIntegrations = {
      goalDetector: this.integrations.goalDetector,
      graphBuilder: this.integrations.graphBuilder,
      traceWriter: this.integrations.traceWriter,
      networkTracker: this.integrations.networkTracker,
      consoleCollector: this.integrations.consoleCollector,
    };

    this.commandExecutor = new CommandExecutor(
      this.integrations.page,
      this.integrations.actionExecutor,
      config,
      this.blackboard,
      cmdIntegrations,
    );

    // ── Initialize PageWatcher (popup/new-tab detection) ──
    if (this.integrations.browserContext) {
      try {
        this.pageWatcher = new PageWatcher(this.integrations.browserContext);
      } catch (error) {
        logger.warn('[PIPELINE] Failed to initialize PageWatcher', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[PIPELINE] Starting test pipeline', {
      testId: config.testId,
      goal: goal.slice(0, 80),
      maxRounds,
      hasCredentials: config.hasCredentials,
    });

    // Emit initial progress
    this.emitProgress(0, maxRounds, 'Starting test pipeline');

    // Trace pipeline start
    this.trace('pipeline_start', {
      goal,
      url: config.url,
      maxRounds,
      hasCredentials: config.hasCredentials,
    });

    // ── Emit graph start node ──
    this.emitGraphStartNode();

    // ── GoalExpander: expand goal into keywords (one-time, 3s timeout) ──
    await this.expandGoal(goal);

    let pipelineRound = 0;

    try {
      while (pipelineRound < maxRounds && !this.isTimedOut(timeoutMs)) {
        pipelineRound++;

        // ════════════════════════════════════════════════════════════
        // CANCELLATION CHECK — at the start of each pipeline round
        // ════════════════════════════════════════════════════════════
        await this.checkCancellation(config.testId, 'pipeline_round_start');

        logger.debug('[PIPELINE] Round start', {
          round: pipelineRound,
          phase: this.blackboard.getPhase(),
          progress: this.blackboard.getProgressScore(),
        });

        // ════════════════════════════════════════════════════════════
        // STEP 1: PLANNER
        // Reads: Blackboard (snapshot, rounds, review, insights)
        // Writes: Blackboard (plan)
        // ════════════════════════════════════════════════════════════

        this.blackboard.setPhase('planning');
        this.emitProgress(
          pipelineRound,
          maxRounds,
          `Planning step ${pipelineRound}...`,
        );

        this.trace('planner_start', { round: pipelineRound });
        const planStart = Date.now();

        // Wrap Planner LLM call with cancellation support
        const plan = await withCancellation(
          config.testId,
          PlannerAgent.plan(this.blackboard, this.integrations.traceWriter),
          'planner_agent',
        );
        this.blackboard.setPlan(plan);

        this.trace('planner_done', {
          round: pipelineRound,
          summary: plan.summary,
          stepCount: plan.steps.length,
          durationMs: Date.now() - planStart,
        });

        logger.debug('[PIPELINE] Planner done', {
          round: pipelineRound,
          summary: plan.summary.slice(0, 60),
          steps: plan.steps.length,
        });

        // ════════════════════════════════════════════════════════════
        // CANCELLATION CHECK — between Planner and Executor
        // ════════════════════════════════════════════════════════════
        await this.checkCancellation(config.testId, 'pre_executor');

        // ════════════════════════════════════════════════════════════
        // STEP 2: EXECUTOR
        // Reads: Blackboard (plan, snapshot)
        // Writes: Blackboard (rounds[], snapshot, insights, phase)
        // ════════════════════════════════════════════════════════════

        this.blackboard.setPhase('executing');
        this.emitProgress(
          pipelineRound,
          maxRounds,
          `Executing: ${plan.summary.slice(0, 40)}...`,
        );

        // Prepare PageWatcher for popup detection during execution
        this.pageWatcher?.prepareForPopup();

        this.trace('executor_start', { round: pipelineRound });
        const execStart = Date.now();

        const executor = new ExecutorAgent();
        // Wrap executor with cancellation support.
        // Pass abortSignal so executor can cancel in-flight LLM calls on abort.
        await withCancellation(
          config.testId,
          executor.execute(this.blackboard, this.commandExecutor, this.abortController?.signal, this.integrations.traceWriter),
          'executor_agent',
        );

        this.trace('executor_done', {
          round: pipelineRound,
          phase: this.blackboard.getPhase(),
          commandsThisRound: this.blackboard.getLastRound()?.commands.length ?? 0,
          durationMs: Date.now() - execStart,
        });

        // ════════════════════════════════════════════════════════════
        // POST-EXECUTION: Zero-progress stuck detection
        // If Executor returns no commands for consecutive rounds,
        // it's burning tokens without making progress → terminate early.
        // ════════════════════════════════════════════════════════════
        const lastRound = this.blackboard.getLastRound();
        if (!lastRound || lastRound.commands.length === 0) {
          this.consecutiveEmptyRounds++;
          if (this.consecutiveEmptyRounds >= TestPipeline.MAX_EMPTY_ROUNDS) {
            logger.warn('[PIPELINE] Stuck: executor produced no commands for consecutive rounds', {
              consecutiveEmptyRounds: this.consecutiveEmptyRounds,
              round: pipelineRound,
            });
            this.blackboard.addInsight(
              `Pipeline stuck: executor returned no commands for ${this.consecutiveEmptyRounds} consecutive rounds`,
            );
            this.blackboard.setPhase('blocked');
            break;
          }
        } else {
          this.consecutiveEmptyRounds = 0; // Reset on any round with commands
        }

        // ════════════════════════════════════════════════════════════
        // POST-EXECUTION: Same-state stuck detection
        // If page state hasn't changed for N consecutive rounds,
        // the agent is likely stuck (e.g., wrong credentials, validation loop).
        // This signals the Reviewer to skip fast-paths and use AI assessment.
        // ════════════════════════════════════════════════════════════
        const currentHash = this.computeSnapshotHash();
        if (currentHash === this.previousSnapshotHash && currentHash !== '') {
          this.consecutiveSameStateRounds++;
          if (this.consecutiveSameStateRounds >= TestPipeline.MAX_SAME_STATE_ROUNDS) {
            this.blackboard.addInsight(
              `Pipeline stuck: page state unchanged for ${this.consecutiveSameStateRounds} consecutive rounds. ` +
              'The current approach may not be working — consider wrong credentials, missing prerequisites, or blocked flow.',
            );
            logger.warn('[PIPELINE] Same-state stuck detected', {
              round: pipelineRound,
              consecutiveSameState: this.consecutiveSameStateRounds,
              hash: currentHash.slice(0, 60),
            });
          }
        } else {
          this.consecutiveSameStateRounds = 0;
        }
        this.previousSnapshotHash = currentHash;

        // ════════════════════════════════════════════════════════════
        // POST-EXECUTION: Check for new tabs/popups
        // ════════════════════════════════════════════════════════════
        await this.handlePopupDetection(config.testId);

        // ════════════════════════════════════════════════════════════
        // POST-EXECUTION: Collect page errors (console + DOM)
        // ════════════════════════════════════════════════════════════
        await this.collectPageErrors(pipelineRound);

        // ════════════════════════════════════════════════════════════
        // POST-EXECUTION: Update contextual hints from GoalDetector
        // ════════════════════════════════════════════════════════════
        this.updateContextualHints();

        // Check blocked terminal state immediately (no audit needed)
        if (this.blackboard.getPhase() === 'blocked') {
          logger.info('[PIPELINE] Blocked state reached', { round: pipelineRound });
          break;
        }

        // NOTE: "done" is NOT checked here anymore.
        // Reviewer will validate "done" claims via auditDone().
        // This prevents false completions.

        // ════════════════════════════════════════════════════════════
        // CANCELLATION CHECK — between Executor and Reviewer
        // ════════════════════════════════════════════════════════════
        await this.checkCancellation(config.testId, 'pre_reviewer');

        // ════════════════════════════════════════════════════════════
        // STEP 3: REVIEWER (with auditDone validation)
        // Reads: Blackboard (goal, plan, rounds, snapshot)
        // Writes: Blackboard (review, insights)
        // When Executor says mark_done → Reviewer calls auditDone()
        // via GoalDetector (gpt-5.4-mini) before accepting.
        // ════════════════════════════════════════════════════════════

        // IMPORTANT: Only set phase to 'reviewing' if NOT 'done'.
        // When Executor calls mark_done, phase becomes 'done'.
        // Reviewer.review() checks phase === 'done' to trigger auditDone().
        // If we overwrite 'done' → 'reviewing', auditDone never fires.
        if (this.blackboard.getPhase() !== 'done') {
          this.blackboard.setPhase('reviewing');
        }

        this.trace('reviewer_start', { round: pipelineRound });
        const reviewStart = Date.now();

        const review = await withCancellation(
          config.testId,
          ReviewerAgent.review(this.blackboard, this.integrations.goalDetector, this.integrations.traceWriter),
          'reviewer_agent',
        );
        this.blackboard.setReview(review);

        this.trace('reviewer_done', {
          round: pipelineRound,
          verdict: review.verdict,
          goalAlignment: review.goalAlignment,
          reason: review.reason.slice(0, 80),
          durationMs: Date.now() - reviewStart,
        });

        logger.debug('[PIPELINE] Reviewer done', {
          round: pipelineRound,
          verdict: review.verdict,
          goalAlignment: review.goalAlignment,
        });

        // Handle verdict
        if (review.verdict === 'done') {
          this.blackboard.setPhase('done');
          break;
        }

        if (review.verdict === 'blocked') {
          this.blackboard.setPhase('blocked');
          break;
        }

        if (review.verdict === 'replan') {
          // Reset failed steps for Planner to see
          this.blackboard.resetFailedSteps(review.failedSteps);
          if (review.guidance) {
            this.blackboard.addInsight(`Reviewer guidance: ${review.guidance}`);
          }
          logger.debug('[PIPELINE] Replanning triggered', {
            round: pipelineRound,
            failedSteps: review.failedSteps,
          });
        }

        // 'continue' → next round (Planner will see updated state)

        // Update progress (monotonic: only increase, never decrease)
        const reviewProgress = Math.round(review.goalAlignment * 100);
        if (reviewProgress > this.blackboard.getProgressScore()) {
          this.blackboard.setProgressScore(reviewProgress);
        }
        this.emitProgress(pipelineRound, maxRounds, `Round ${pipelineRound} complete (${review.verdict})`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if it's a cancellation
      if (errorMsg.includes('cancelled')) {
        logger.info('[PIPELINE] Test cancelled by user', {
          testId: config.testId,
          round: pipelineRound,
        });
        this.blackboard.addInsight('Test cancelled by user');
        this.blackboard.setPhase('blocked');
      } else {
        logger.error('[PIPELINE] Unhandled error', {
          testId: config.testId,
          round: pipelineRound,
          error: errorMsg,
        });
        this.blackboard.addInsight(`Pipeline error: ${errorMsg}`);
      }
    } finally {
      // ── Cleanup ──
      this.pageWatcher?.dispose();
      this.pageWatcher = null;
      // Ensure any in-flight LLM calls are cancelled on pipeline exit
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort();
      }
      this.abortController = null;
    }

    // ── Emit graph end node ──
    this.emitGraphEndNode(pipelineRound);

    // ── Build result ──
    const result = this.buildResult(pipelineRound);

    logger.info('[PIPELINE] Pipeline complete', {
      testId: config.testId,
      success: result.success,
      phase: result.phase,
      rounds: result.roundsExecuted,
      commands: result.commandsExecuted,
      progress: result.progressScore,
      durationMs: result.durationMs,
    });

    this.trace('pipeline_done', {
      success: result.success,
      phase: result.phase,
      roundsExecuted: result.roundsExecuted,
      commandsExecuted: result.commandsExecuted,
      progressScore: result.progressScore,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Get the Blackboard for external access (e.g., LiteEngine integration).
   */
  getBlackboard(): TestBlackboard {
    return this.blackboard;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TEST CANCELLATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Check if the test has been cancelled.
   * Uses the same checkTestCancelled() from the main LiteEngine.
   * Throws Error if cancelled (caught by the main try/catch).
   */
  private async checkCancellation(testId: string, checkpoint: string): Promise<void> {
    try {
      await checkTestCancelled(testId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('cancelled')) {
        logger.info('[PIPELINE] Test cancelled at checkpoint', {
          testId,
          checkpoint,
        });
        // Abort in-flight LLM calls in executor
        this.abortController?.abort();
        throw error; // Re-throw to exit the pipeline loop
      }
      // Other errors from checkTestCancelled are non-critical
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POPUP / NEW TAB DETECTION (via PageWatcher)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * After executor completes, check if a new tab/popup was opened.
   * If so, switch to the new page and add insight for agents.
   */
  private async handlePopupDetection(testId: string): Promise<void> {
    if (!this.pageWatcher) return;

    try {
      const newPageInfo = await this.pageWatcher.detectNewPage(1500);
      if (newPageInfo) {
        logger.info('[PIPELINE] New tab/popup detected', {
          url: newPageInfo.url,
          isPopup: newPageInfo.isPopup,
        });

        // Update the page reference for future commands
        // NOTE: The ActionExecutor and CommandExecutor use the page passed at construction.
        // For a truly new page, we'd need to update the page reference.
        // For now, record the insight so Planner/Executor can adapt.
        this.blackboard.addInsight(
          `New ${newPageInfo.isPopup ? 'popup' : 'tab'} opened: ${newPageInfo.url}. ` +
          `Content may need to be handled on the new page.`
        );

        // Emit graph page node for the new page
        if (this.integrations.graphBuilder) {
          try {
            const pageUpdate = this.integrations.graphBuilder.addPageNode(
              newPageInfo.url,
              'popup',
              { title: 'New tab/popup' },
            );
            this.emitGraphUpdateWs(pageUpdate);
          } catch {
            // Non-critical
          }
        }

        this.trace('popup_detected', {
          url: newPageInfo.url,
          isPopup: newPageInfo.isPopup,
        });
      }
    } catch (error) {
      // Popup detection failure is non-critical
      logger.debug('[PIPELINE] Popup detection error (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ERROR COLLECTION (Console + DOM errors after each execution round)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Collect page errors from both console and DOM.
   * Enriches Blackboard insights so Planner/Reviewer can see errors.
   */
  private async collectPageErrors(round: number): Promise<void> {
    try {
      // 1. Console errors (via ConsoleCollector)
      // Use lastErrorCollectionTime to only get errors from THIS round,
      // not all errors since pipeline start (which causes duplicates).
      if (this.integrations.consoleCollector) {
        const collectSince = this.lastErrorCollectionTime || this.startTime;
        const recentErrors = this.integrations.consoleCollector.getErrorsSince(
          collectSince,
        );
        this.lastErrorCollectionTime = Date.now(); // Update for next round
        if (recentErrors.length > 0) {
          const errorSummary = recentErrors.slice(-3).join('; ');
          this.blackboard.addInsight(
            `Console errors (round ${round}): ${errorSummary.slice(0, 200)}`,
          );
        }
      }

      // 2. DOM errors (via ErrorCollector — static)
      const domErrors = await ErrorCollector.collectFromPage(this.integrations.page);
      if (domErrors.length > 0) {
        const errorSummary = domErrors.slice(0, 3).join('; ');
        this.blackboard.addInsight(
          `Page errors (round ${round}): ${errorSummary.slice(0, 200)}`,
        );
      }

      // 3. Check for error page
      const isErrorPage = await ErrorCollector.isErrorPage(this.integrations.page);
      if (isErrorPage) {
        this.blackboard.addInsight(
          `Warning: Current page appears to be an error page (round ${round})`,
        );
      }
    } catch {
      // Error collection is non-critical — never break the pipeline
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GRAPH BUILDER INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Emit the start node at pipeline beginning.
   */
  private emitGraphStartNode(): void {
    if (!this.integrations.graphBuilder) return;
    try {
      const startUpdate = this.integrations.graphBuilder.addStartNode();
      this.emitGraphUpdateWs(startUpdate);
    } catch {
      // Non-critical
    }
  }

  /**
   * Emit the end node at pipeline completion.
   */
  private emitGraphEndNode(pipelineRound: number): void {
    if (!this.integrations.graphBuilder) return;
    try {
      const phase = this.blackboard.getPhase();
      const success = phase === 'done';
      const meta = this.integrations.graphBuilder.getMetadata();

      const endUpdate = this.integrations.graphBuilder.addEndNode(success, this.buildReasonString(), {
        pagesVisited: pipelineRound,
        actionsTaken: this.blackboard.getTotalCommandsExecuted(),
        successRate: `${meta.totalSteps > 0 ? Math.round((meta.completedSteps / meta.totalSteps) * 100) : 0}%`,
        duration: `${((Date.now() - this.startTime) / 1000).toFixed(1)}s`,
      });
      this.emitGraphUpdateWs(endUpdate);
    } catch {
      // Non-critical
    }
  }

  /**
   * Send graph update to WebSocket (fire-and-forget).
   * Note: The graph update is stored in GraphBuilder's internal state.
   * The final graph is retrieved at pipeline end via graphBuilder.getFullGraph().
   * We emit progress updates to keep the frontend informed.
   */
  private emitGraphUpdateWs(_update: any): void {
    // Graph updates are accumulated in GraphBuilder internally.
    // The pipeline emits progress events, and the final graph is sent at completion.
    // We don't send incremental graph updates through the progress emitter
    // because EmitParams doesn't support it — LiteEngine handles that separately.
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // GOAL EXPANSION (one-time AI call at pipeline start)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Expand user goal into structured keywords for precise element targeting.
   * Called once at pipeline start. Non-critical — failure doesn't break pipeline.
   *
   * GoalExpander.expand() returns actionTokens, objectTokens, allKeywords,
   * negativeKeywords, language — stored in Blackboard for Planner prompt.
   */
  private async expandGoal(goal: string): Promise<void> {
    try {
      const expanded = await GoalExpander.expand(goal);

      // Store all keywords as flat array in Blackboard
      // Planner will see these in its prompt to create better plans
      const keywords = [
        ...expanded.actionTokens,
        ...expanded.objectTokens,
      ];

      if (keywords.length > 0) {
        this.blackboard.setExpandedGoalKeywords(keywords);
      }

      logger.debug('[PIPELINE] Goal expanded', {
        actionTokens: expanded.actionTokens.length,
        objectTokens: expanded.objectTokens.length,
        negativeKeywords: expanded.negativeKeywords.size,
        language: expanded.language,
      });

      this.trace('goal_expanded', {
        actionTokens: expanded.actionTokens,
        objectTokens: expanded.objectTokens,
        language: expanded.language,
        keywordCount: keywords.length,
      });
    } catch (error) {
      // GoalExpander failure is non-critical — pipeline continues without it
      logger.warn('[PIPELINE] GoalExpander failed (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXTUAL HINTS (per-round from GoalDetector)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Update contextual hints from GoalDetector based on current page state.
   * Called after each execution round. Non-critical — failure doesn't break pipeline.
   *
   * GoalDetector.buildContextualHints() analyzes the current snapshot and returns
   * hints like "Registration form not visible, look for Sign Up button" or
   * "Multi-step form: currently on OTP verification step".
   *
   * These hints are stored in Blackboard and injected into Planner prompt.
   */
  private updateContextualHints(): void {
    try {
      const goalDetector = this.integrations.goalDetector;
      if (!goalDetector) return;

      const snapshot = this.blackboard.getCurrentPageSnapshot();
      if (!snapshot) return;

      const hints = goalDetector.buildContextualHints(snapshot);
      // Always update hints (even if empty) to clear stale hints from previous rounds.
      // Planner should not see outdated hints (e.g. "form not visible" when form IS visible now).
      this.blackboard.setContextualHints(hints);

      if (hints.length > 0) {
        logger.debug('[PIPELINE] Contextual hints updated', {
          hintCount: hints.length,
          firstHint: hints[0]?.slice(0, 60),
        });
      }
    } catch {
      // Hint generation is non-critical — never break the pipeline
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private isTimedOut(timeoutMs: number): boolean {
    return Date.now() - this.startTime >= timeoutMs;
  }

  /**
   * Compute a lightweight hash of the current page state for stuck detection.
   * Uses URL + title + element count + page alerts to detect when page hasn't changed.
   * Not cryptographic — just needs to detect same-state across rounds.
   */
  private computeSnapshotHash(): string {
    const snapshot = this.blackboard.getCurrentPageSnapshot();
    if (!snapshot) return '';

    const url = snapshot.url || '';
    const title = snapshot.title || '';
    const elementCount = snapshot.elements.length;
    const alerts = (snapshot.pageAlerts || []).join('|');
    // Include first 5 element refs to catch DOM changes
    const firstRefs = snapshot.elements.slice(0, 5).map(el => el.ref).join(',');

    return `${url}|${title}|${elementCount}|${firstRefs}|${alerts}`;
  }

  private buildResult(roundsExecuted: number): TestPipelineResult {
    const phase = this.blackboard.getPhase();

    return {
      success: phase === 'done',
      phase,
      reason: this.buildReasonString(),
      roundsExecuted,
      commandsExecuted: this.blackboard.getTotalCommandsExecuted(),
      progressScore: this.blackboard.getProgressScore(),
      durationMs: Date.now() - this.startTime,
      rounds: [...this.blackboard.getRounds()],
      insights: [...this.blackboard.getInsights()],
      finalSnapshot: this.blackboard.getCurrentPageSnapshot(),
      blockedReason: phase === 'blocked'
        ? this.blackboard.getReview()?.reason || 'Unknown blocker'
        : undefined,
    };
  }

  private buildReasonString(): string {
    const phase = this.blackboard.getPhase();
    const review = this.blackboard.getReview();

    switch (phase) {
      case 'done':
        return review?.reason || 'Goal achieved';
      case 'blocked':
        return review?.reason || 'Test blocked';
      default:
        if (this.isTimedOut(this.actualTimeoutMs)) {
          return 'Pipeline timeout';
        }
        return 'Maximum rounds reached';
    }
  }

  /**
   * Emit progress via WebSocket (fire-and-forget, never breaks execution).
   */
  private emitProgress(round: number, maxRounds: number, step: string): void {
    try {
      const progressPercent = Math.round((round / maxRounds) * 70) + 20;
      this.integrations.progressEmitter?.emit({
        progress: Math.min(90, progressPercent),
        phase: 'execution',
        currentStep: step,
        status: 'running',
      });
    } catch {
      // Never break pipeline for progress emission failures
    }
  }

  /**
   * Write trace entry (fire-and-forget).
   */
  private trace(eventType: string, payload: Record<string, any>): void {
    try {
      this.integrations.traceWriter?.write({
        iteration: payload.round || 0,
        stage: 'pipeline',
        eventType,
        spanId: this.integrations.traceWriter.generateSpanId(),
        payload,
      });
    } catch {
      // Never break pipeline for trace failures
    }
  }
}
