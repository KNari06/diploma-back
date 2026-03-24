/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION ENGINE v2 — Autonomous Multi-Agent Orchestrator
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 4-phase exploration with specialized agents:
 *
 *   Phase 1: SURVEY
 *   - BFS traversal with Cartographer agent (per page)
 *   - Deep page understanding + entry point discovery
 *
 *   Phase 1.5: STRATEGY (NEW)
 *   - Strategist agent sees full tree + all insights
 *   - AI-driven prioritization replaces static formula
 *   - Auth strategy planning
 *
 *   Phase 2: FLOW EXECUTION
 *   - Parallel TestPipeline per flow
 *   - Scout agent discovers branches after each flow
 *   - Adaptive re-strategy every batch
 *
 *   Phase 2.5: COVERAGE EVALUATION (NEW)
 *   - Sentinel agent evaluates coverage gaps
 *   - Decides whether to continue exploring
 *
 * All agents share context through ExplorationBlackboard.
 *
 * Usage:
 *   const engine = new ExplorationEngine(browser, config);
 *   const result = await engine.run();
 */

import type { Browser } from 'playwright';
import { logger } from '@/utils/core/logger';

import type { ExplorationConfig, ExplorationResult, ExplorationProgressCallback, ExplorationCheckpoint } from './types';
import { DEFAULT_EXPLORATION_BUDGET, DEFAULT_MAX_CONCURRENCY, DESKTOP_USER_AGENT } from './types';
import { BudgetTracker } from './budget-tracker';
import { RateLimiter } from './rate-limiter';
import { ExplorationTree } from './exploration-tree';
import { SurveyAgent } from './survey-agent';
import { FlowQueue } from './flow-queue';
import { FlowRunner } from './flow-runner';
import { TestCaseBuilder } from './test-case-builder';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { ExplorationTraceService } from './exploration-trace.service';
import { createBlackboard, taskToFlowResult } from './agents/blackboard';
import { ExplorationStrategist } from './agents/strategist';
import { ExplorationSentinel } from './agents/sentinel';
import type { ExplorationBlackboard } from './agents/agent-types';

/** Save checkpoint every N completed flows */
const CHECKPOINT_EVERY_N_FLOWS = 3;

export class ExplorationEngine {
  private readonly config: ExplorationConfig;
  private readonly onProgress?: ExplorationProgressCallback;

  constructor(
    private readonly browser: Browser,
    config: ExplorationConfig,
  ) {
    // Apply defaults
    this.config = {
      ...config,
      budget: { ...DEFAULT_EXPLORATION_BUDGET, ...config.budget },
      maxConcurrency: config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    };
    this.onProgress = config.onProgress;
  }

  private emitProgress(
    phase: 'survey' | 'flow' | 'complete',
    event: 'page_discovered' | 'survey_complete' | 'flow_started' | 'flow_completed' | 'flow_failed' | 'flow_blocked' | 'branch_found',
    data: Record<string, any>,
    progressPercent: number,
  ): void {
    if (!this.onProgress) return;
    try {
      this.onProgress({
        explorationId: this.config.explorationId,
        phase,
        event,
        data,
        progressPercent: Math.min(100, Math.max(0, Math.round(progressPercent))),
        timestamp: Date.now(),
      });
    } catch { /* never let progress reporting crash exploration */ }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Run the full 4-phase exploration:
   *   Phase 1:   Survey (BFS + Cartographer per page)
   *   Phase 1.5: Strategy (Strategist plans + prioritizes)
   *   Phase 2:   Flow Execution (TestPipeline + Scout per flow)
   *   Phase 2.5: Coverage Evaluation (Sentinel assesses gaps)
   */
  async run(): Promise<ExplorationResult> {
    const startTime = Date.now();
    const budget = new BudgetTracker(this.config.budget);
    const rateLimiter = new RateLimiter(this.config.rateLimiting, budget);
    const trace = new ExplorationTraceService(this.config.explorationId);
    const emitProgress = this.onProgress || (() => {});

    // Create shared blackboard for all agents
    const bb = createBlackboard(this.config, budget, rateLimiter, trace, emitProgress);

    trace.writeExplorationStart(this.config);

    logger.info('[EXPLORATION] Starting autonomous multi-agent exploration', {
      explorationId: this.config.explorationId,
      entryUrl: this.config.entryUrl,
      maxFlows: this.config.budget.maxFlows,
      maxConcurrency: this.config.maxConcurrency,
      totalTimeoutMs: this.config.budget.totalTimeoutMs,
    });

    // ════════════════════════════════════════════════════════════════════
    // PHASE 1: SURVEY
    // BFS page discovery — Cartographer analyzes each page
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 1: Starting page survey');
    trace.writePhaseStart('survey');

    const surveyContext = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent: DESKTOP_USER_AGENT,
    });

    try {
      const surveyPage = await surveyContext.newPage();

      try {
        const { setupThirdPartyBlocker } = await import('@/agent/playwright/execution/third-party-blocker');
        await setupThirdPartyBlocker(surveyPage);
      } catch { /* non-fatal */ }

      const surveyAgent = new SurveyAgent(surveyPage, this.config, budget, rateLimiter, trace);
      bb.tree = await surveyAgent.survey();
      await surveyPage.close();
    } finally {
      await surveyContext.close();
    }

    const allEntryPoints = bb.tree.getAllEntryPoints();

    this.emitProgress('survey', 'survey_complete', {
      pagesVisited: bb.tree.getNodeCount(),
      entryPointsFound: allEntryPoints.length,
    }, 25);

    trace.writePhaseEnd('survey', {
      pagesVisited: bb.tree.getNodeCount(),
      entryPointsFound: allEntryPoints.length,
      timeUsedMs: Date.now() - startTime,
    });

    logger.info('[EXPLORATION] Phase 1 complete', {
      pagesVisited: bb.tree.getNodeCount(),
      entryPointsFound: allEntryPoints.length,
      timeUsedMs: Date.now() - startTime,
    });

    // Save checkpoint after Phase 1 (most expensive phase)
    await this.saveCheckpoint({
      version: 1,
      phase: 'survey',
      timestamp: Date.now(),
      tree: bb.tree.toCheckpoint(),
      budget: budget.toCheckpoint(),
    });

    if (allEntryPoints.length === 0) {
      logger.warn('[EXPLORATION] No entry points discovered, returning empty result');
      trace.writeExplorationEnd({
        status: 'completed',
        durationMs: Date.now() - startTime,
        testCasesCount: 0,
        summary: { reason: 'no_entry_points' },
      });
      await trace.close();
      const builder = new TestCaseBuilder();
      await ExplorationStorageService.clearCheckpoint(this.config.explorationId);
      return builder.build(bb.tree, [], budget, this.config, startTime, []);
    }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 1.5: STRATEGY (NEW)
    // Strategist sees full tree + all insights → AI-driven prioritization
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 1.5: Strategist planning');

    const strategist = new ExplorationStrategist(bb);
    bb.currentStrategy = await strategist.plan();

    // Build queue from Strategist output (AI-driven order, not static formula)
    bb.queue = FlowQueue.fromStrategyOutput(allEntryPoints, bb.currentStrategy);

    this.emitProgress('survey', 'survey_complete', {
      event: 'strategy_planned',
      totalFlowsPlanned: bb.currentStrategy.plan.length,
      focusAreas: bb.currentStrategy.focusAreas,
      loginFirst: bb.currentStrategy.authPlan.loginFirst,
      strategyReasoning: bb.currentStrategy.strategyReasoning,
    }, 30);

    logger.info('[EXPLORATION] Strategy planned', {
      plannedFlows: bb.currentStrategy.plan.length,
      skipFlows: bb.currentStrategy.skipFlows.length,
      loginFirst: bb.currentStrategy.authPlan.loginFirst,
      continueSurvey: bb.currentStrategy.continueSurvey,
      focusAreas: bb.currentStrategy.focusAreas,
    });

    // TODO: If Strategist wants more survey, run targeted survey here
    // if (bb.currentStrategy.continueSurvey && bb.currentStrategy.surveyTargets?.length) { ... }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 2: FLOW EXPLORATION
    // Parallel sub-agents, each in isolated BrowserContext
    // Scout discovers branches after each flow
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 2: Starting flow exploration');
    trace.writePhaseStart('flow');
    trace.writeQueueState({
      pendingCount: bb.queue.size(),
      completedCount: 0,
      totalEnqueued: bb.queue.size(),
    });

    const flowRunner = new FlowRunner(this.browser, this.config, budget, this.onProgress, rateLimiter, trace);

    // Periodic checkpoint callback
    let lastCheckpointFlows = 0;
    flowRunner.setCheckpointCallback(async (completedTasks) => {
      if (completedTasks.length - lastCheckpointFlows >= CHECKPOINT_EVERY_N_FLOWS) {
        lastCheckpointFlows = completedTasks.length;
        trace.writeCheckpointSaved({ phase: 'flow', flowsCompleted: completedTasks.length });
        await this.saveCheckpoint({
          version: 1,
          phase: 'flow',
          timestamp: Date.now(),
          tree: bb.tree!.toCheckpoint(),
          budget: budget.toCheckpoint(),
          queue: bb.queue!.toCheckpoint(),
          flowRunner: {
            loginCompleted: flowRunner.isLoginCompleted(),
            knownFlowNames: flowRunner.getKnownFlowNames(),
            flowsCompleted: completedTasks.length,
            completedTasks,
          },
        });
      }
    });

    let flowTasks;
    try {
      flowTasks = await flowRunner.runAll(bb.queue);
    } finally {
      await flowRunner.cleanup();
    }

    // Store completed flows in blackboard for Sentinel
    for (const task of flowTasks) {
      bb.completedFlows.push(taskToFlowResult(task));
    }

    trace.writePhaseEnd('flow', {
      flowsExplored: flowTasks.length,
      passed: flowTasks.filter((t) => t.goalAchieved).length,
      failed: flowTasks.filter((t) => t.status === 'failed').length,
      blocked: flowTasks.filter((t) => t.status === 'blocked').length,
      timeUsedMs: Date.now() - startTime,
    });

    logger.info('[EXPLORATION] Phase 2 complete', {
      flowsExplored: flowTasks.length,
      passed: flowTasks.filter((t) => t.goalAchieved).length,
      failed: flowTasks.filter((t) => t.status === 'failed').length,
      blocked: flowTasks.filter((t) => t.status === 'blocked').length,
      timeUsedMs: Date.now() - startTime,
    });

    // ════════════════════════════════════════════════════════════════════
    // PHASE 2.5: COVERAGE EVALUATION (NEW)
    // Sentinel evaluates gaps, decides if another round is needed
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 2.5: Sentinel coverage evaluation');

    const sentinel = new ExplorationSentinel(bb);
    bb.coverageAssessment = await sentinel.evaluate();

    this.emitProgress('flow', 'flow_completed', {
      event: 'coverage_evaluated',
      coverageScore: bb.coverageAssessment.coverageScore,
      gaps: bb.coverageAssessment.gaps,
      qualitySummary: bb.coverageAssessment.qualitySummary,
      continueExploring: bb.coverageAssessment.continueExploring,
    }, 90);

    logger.info('[EXPLORATION] Coverage assessment', {
      coverageScore: bb.coverageAssessment.coverageScore,
      gaps: bb.coverageAssessment.gaps.length,
      continueExploring: bb.coverageAssessment.continueExploring,
      qualitySummary: bb.coverageAssessment.qualitySummary,
    });

    // If Sentinel says continue and budget allows → run extra round
    if (bb.coverageAssessment.continueExploring && !budget.isExhausted() && budget.canExploreMoreFlows()) {
      logger.info('[EXPLORATION] Sentinel requested extra round', {
        focusNext: bb.coverageAssessment.focusNext,
      });

      const focused = await strategist.planFocused(bb.coverageAssessment.focusNext);
      if (bb.queue) {
        bb.queue.reorder(focused.plan, focused.skipFlows.map((s) => s.id));
      }

      if (bb.queue && !bb.queue.isEmpty()) {
        const extraFlowRunner = new FlowRunner(this.browser, this.config, budget, this.onProgress, rateLimiter, trace);
        try {
          const extraTasks = await extraFlowRunner.runAll(bb.queue);
          flowTasks = [...flowTasks, ...extraTasks];

          for (const task of extraTasks) {
            bb.completedFlows.push(taskToFlowResult(task));
          }
        } finally {
          await extraFlowRunner.cleanup();
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // BUILD RESULT
    // ════════════════════════════════════════════════════════════════════

    const skippedEntryPoints = bb.queue.remaining();

    const builder = new TestCaseBuilder();
    const result = builder.build(bb.tree, flowTasks, budget, this.config, startTime, skippedEntryPoints);

    // Attach Sentinel assessment to result
    if (bb.coverageAssessment) {
      result.summary.coverageScore = bb.coverageAssessment.coverageScore;
      result.summary.qualitySummary = bb.coverageAssessment.qualitySummary;
      result.summary.gaps = bb.coverageAssessment.gaps;
      result.summary.recommendations = bb.coverageAssessment.recommendations;
      result.summary.riskAreas = bb.coverageAssessment.riskAreas;
    }

    await ExplorationStorageService.clearCheckpoint(this.config.explorationId);

    this.emitProgress('complete', 'survey_complete', {
      testCases: result.testCases.length,
      flowsPassed: result.summary.flowsPassed,
      flowsFailed: result.summary.flowsFailed,
      flowsBlocked: result.summary.flowsBlocked,
      totalSteps: result.summary.totalStepsDiscovered,
      coverageScore: bb.coverageAssessment?.coverageScore,
      qualitySummary: bb.coverageAssessment?.qualitySummary,
    }, 100);

    trace.writeExplorationEnd({
      status: 'completed',
      durationMs: result.durationMs,
      testCasesCount: result.testCases.length,
      summary: result.summary,
    });
    await trace.close();

    logger.info('[EXPLORATION] Exploration complete', {
      explorationId: this.config.explorationId,
      totalDurationMs: result.durationMs,
      testCasesTotal: result.testCases.length,
      testCasesPassed: result.summary.flowsPassed,
      testCasesFailed: result.summary.flowsFailed,
      testCasesBlocked: result.summary.flowsBlocked,
      testCasesSkipped: result.summary.flowsSkipped,
      totalSteps: result.summary.totalStepsDiscovered,
      categories: result.summary.categories,
      coverageScore: bb.coverageAssessment?.coverageScore,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESUME FROM CHECKPOINT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resume exploration from a saved checkpoint after crash/stall.
   * Skips Phase 1 if survey is already done. Resumes Phase 2 from last checkpoint.
   */
  static async resumeFromCheckpoint(
    browser: Browser,
    config: ExplorationConfig,
    checkpoint: ExplorationCheckpoint,
  ): Promise<ExplorationResult> {
    const engine = new ExplorationEngine(browser, config);
    const trace = new ExplorationTraceService(config.explorationId);

    logger.info('[EXPLORATION] Resuming from checkpoint', {
      explorationId: config.explorationId,
      phase: checkpoint.phase,
      checkpointAge: Date.now() - checkpoint.timestamp,
    });

    trace.writeExplorationStart(config);

    // Restore tree and budget from checkpoint
    const tree = ExplorationTree.fromCheckpoint(checkpoint.tree);
    const budget = BudgetTracker.fromCheckpoint(config.budget, checkpoint.budget);
    const rateLimiter = new RateLimiter(config.rateLimiting, budget);

    // Check if budget is already exhausted (stale checkpoint)
    if (budget.isExhausted()) {
      logger.warn('[EXPLORATION] Budget exhausted from checkpoint, building result from partial data');
      trace.writeExplorationEnd({
        status: 'completed',
        durationMs: 0,
        testCasesCount: 0,
        summary: { reason: 'budget_exhausted_from_checkpoint' },
      });
      await trace.close();
      const builder = new TestCaseBuilder();
      const tasks = checkpoint.flowRunner?.completedTasks || [];
      return builder.build(tree, tasks, budget, config, checkpoint.budget.startTime, []);
    }

    const allEntryPoints = tree.getAllEntryPoints();

    if (checkpoint.phase === 'survey') {
      // Survey completed, need to run Phase 2 from scratch
      if (allEntryPoints.length === 0) {
        trace.writeExplorationEnd({
          status: 'completed',
          durationMs: 0,
          testCasesCount: 0,
          summary: { reason: 'no_entry_points' },
        });
        await trace.close();
        const builder = new TestCaseBuilder();
        await ExplorationStorageService.clearCheckpoint(config.explorationId);
        return builder.build(tree, [], budget, config, checkpoint.budget.startTime, []);
      }

      const queue = FlowQueue.fromEntryPoints(allEntryPoints);
      trace.writePhaseStart('flow');
      const flowRunner = new FlowRunner(browser, config, budget, config.onProgress, rateLimiter, trace);

      let lastCheckpointFlows = 0;
      flowRunner.setCheckpointCallback(async (completedTasks) => {
        if (completedTasks.length - lastCheckpointFlows >= CHECKPOINT_EVERY_N_FLOWS) {
          lastCheckpointFlows = completedTasks.length;
          trace.writeCheckpointSaved({ phase: 'flow', flowsCompleted: completedTasks.length });
          await engine.saveCheckpoint({
            version: 1,
            phase: 'flow',
            timestamp: Date.now(),
            tree: tree.toCheckpoint(),
            budget: budget.toCheckpoint(),
            queue: queue.toCheckpoint(),
            flowRunner: {
              loginCompleted: flowRunner.isLoginCompleted(),
              knownFlowNames: flowRunner.getKnownFlowNames(),
              flowsCompleted: completedTasks.length,
              completedTasks,
            },
          });
        }
      });

      let flowTasks;
      try {
        flowTasks = await flowRunner.runAll(queue);
      } finally {
        await flowRunner.cleanup();
      }

      trace.writePhaseEnd('flow', { flowsExplored: flowTasks.length });

      const builder = new TestCaseBuilder();
      const result = builder.build(tree, flowTasks, budget, config, checkpoint.budget.startTime, queue.remaining());
      await ExplorationStorageService.clearCheckpoint(config.explorationId);
      trace.writeExplorationEnd({
        status: 'completed',
        durationMs: result.durationMs,
        testCasesCount: result.testCases.length,
        summary: result.summary,
      });
      await trace.close();
      return result;
    }

    // Phase === 'flow': resume Phase 2 with partial results
    const queue = checkpoint.queue
      ? FlowQueue.fromCheckpoint(checkpoint.queue)
      : FlowQueue.fromEntryPoints(allEntryPoints);

    const previousTasks = checkpoint.flowRunner?.completedTasks || [];
    trace.writePhaseStart('flow');
    const flowRunner = new FlowRunner(browser, config, budget, config.onProgress, rateLimiter, trace);

    // Restore FlowRunner state
    if (checkpoint.flowRunner) {
      flowRunner.restoreFromCheckpoint(checkpoint.flowRunner);
    }

    let lastCheckpointFlows = previousTasks.length;
    flowRunner.setCheckpointCallback(async (completedTasks) => {
      if (completedTasks.length - lastCheckpointFlows >= CHECKPOINT_EVERY_N_FLOWS) {
        lastCheckpointFlows = completedTasks.length;
        trace.writeCheckpointSaved({ phase: 'flow', flowsCompleted: completedTasks.length });
        await engine.saveCheckpoint({
          version: 1,
          phase: 'flow',
          timestamp: Date.now(),
          tree: tree.toCheckpoint(),
          budget: budget.toCheckpoint(),
          queue: queue.toCheckpoint(),
          flowRunner: {
            loginCompleted: flowRunner.isLoginCompleted(),
            knownFlowNames: flowRunner.getKnownFlowNames(),
            flowsCompleted: completedTasks.length,
            completedTasks,
          },
        });
      }
    });

    let flowTasks;
    try {
      flowTasks = await flowRunner.runAll(queue);
    } finally {
      await flowRunner.cleanup();
    }

    // Merge previous tasks with new ones
    const allFlowTasks = [...previousTasks, ...flowTasks];

    trace.writePhaseEnd('flow', { flowsExplored: allFlowTasks.length });

    const builder = new TestCaseBuilder();
    const result = builder.build(tree, allFlowTasks, budget, config, checkpoint.budget.startTime, queue.remaining());
    await ExplorationStorageService.clearCheckpoint(config.explorationId);
    trace.writeExplorationEnd({
      status: 'completed',
      durationMs: result.durationMs,
      testCasesCount: result.testCases.length,
      summary: result.summary,
    });
    await trace.close();
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHECKPOINT HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private async saveCheckpoint(checkpoint: ExplorationCheckpoint): Promise<void> {
    try {
      await ExplorationStorageService.saveCheckpoint(this.config.explorationId, checkpoint);
      logger.debug('[EXPLORATION] Checkpoint saved', {
        explorationId: this.config.explorationId,
        phase: checkpoint.phase,
      });
    } catch (error) {
      // Non-critical: log but don't fail exploration
      logger.warn('[EXPLORATION] Failed to save checkpoint', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
