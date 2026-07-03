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

import type { ExplorationConfig, ExplorationResult, ExplorationProgressCallback, ExplorationProgressEvent, ExplorationCheckpoint } from './types';
import { DEFAULT_EXPLORATION_BUDGET, DEFAULT_MAX_CONCURRENCY, DESKTOP_USER_AGENT } from './types';
import { BROWSER_EXTRA_HEADERS, BROWSER_STEALTH_SCRIPT } from '@/config/testing/playwright-tuning';
import { BudgetTracker } from './budget-tracker';
import { RateLimiter } from './rate-limiter';
import { ExplorationTree } from './exploration-tree';
import { SurveyAgent } from './survey-agent';
import { FlowQueue } from './flow-queue';
import { PerPageBudget, DEFAULT_MAX_FLOWS_PER_PAGE } from './per-page-budget';
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
  /**
   * Per-page fairness counter shared across every queue rebuild in this run.
   * Must outlive individual FlowQueue instances — otherwise a rebuild in
   * Phase 1.5 / 2.5 would reset the count and a saturated page could
   * collect another full quota of flows. Null when the gate is disabled.
   */
  private perPageBudget: PerPageBudget | null = null;

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
    phase: ExplorationProgressEvent['phase'],
    event: ExplorationProgressEvent['event'],
    data: Record<string, any>,
    progressPercent?: number,
  ): void {
    if (!this.onProgress) return;
    try {
      this.onProgress({
        explorationId: this.config.explorationId,
        phase,
        event,
        data,
        progressPercent: progressPercent != null ? Math.min(100, Math.max(0, Math.round(progressPercent))) : 0,
        timestamp: Date.now(),
      });
    } catch { /* never let progress reporting crash exploration */ }
  }

  /**
   * Attach the dedup + per-page-fairness policies to a freshly built queue.
   * Called everywhere a FlowQueue is (re)created within a run so both
   * survey targeted-rebuilds and the Sentinel-driven extra round see the
   * same saturation state and don't grant a saturated page extra quota.
   */
  private attachQueuePolicies(queue: FlowQueue, trace: ExplorationTraceService): void {
    queue.setDedupTrace((data) => trace.writeQueueDedup(data));
    if (this.perPageBudget) {
      queue.setPerPageBudget(this.perPageBudget);
    }
  }

  /**
   * Lazily construct the per-page budget using the configured cap.
   * Returns the existing instance on subsequent calls so counts persist
   * across queue rebuilds within a single run.
   */
  private ensurePerPageBudget(): PerPageBudget | null {
    if (this.perPageBudget !== null) return this.perPageBudget;
    const cap = this.config.budget.maxFlowsPerPage ?? DEFAULT_MAX_FLOWS_PER_PAGE;
    // Treat non-positive / non-finite values as "disabled" — no gate.
    if (!Number.isFinite(cap) || cap <= 0) return null;
    this.perPageBudget = new PerPageBudget(cap);
    return this.perPageBudget;
  }

  /**
   * Build the common context options used by every survey context spawned
   * by this engine (entry + targeted surveys). Centralized so an auth
   * fixture is picked up by all three call sites automatically — adding
   * a fourth context creation should stay correct without remembering
   * the storageState plumbing.
   */
  private buildSurveyContextOptions(): Parameters<Browser['newContext']>[0] {
    return {
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent: DESKTOP_USER_AGENT,
      extraHTTPHeaders: { ...BROWSER_EXTRA_HEADERS },
      // Auth fixture: let even Phase 1 hit auth-gated pages when the user
      // supplied pre-seeded state. Playwright accepts the same JSON shape
      // we validated upstream, so no further conversion is needed.
      ...(this.config.authFixture
        ? { storageState: this.config.authFixture as any }
        : {}),
    };
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
  /**
   * @param onResultReady Optional async hook invoked with the built result
   *   AFTER the test cases are produced but BEFORE the trace is finalized and
   *   closed. The job uses it to persist test cases so the save is part of the
   *   single traced lifecycle (fixes the old bug where trace.close() ran before
   *   persistence, so a failed save still showed "completed"). It returns the
   *   persistence outcome which is folded into the exploration_end status.
   */
  async run(
    onResultReady?: (result: ExplorationResult) => Promise<{ savedCount: number; error?: string } | void>,
  ): Promise<ExplorationResult> {
    const startTime = Date.now();
    const budget = new BudgetTracker(this.config.budget);
    const rateLimiter = new RateLimiter(this.config.rateLimiting, budget);
    const trace = new ExplorationTraceService(this.config.explorationId, {
      explorationId: this.config.explorationId,
      userId: this.config.userId,
    });
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

    const surveyContext = await this.browser.newContext(this.buildSurveyContextOptions());
    await surveyContext.addInitScript(BROWSER_STEALTH_SCRIPT);

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
      pageInsights: Array.from(bb.pageInsights.entries()),
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

    // Initialize the per-page fairness counter before the first queue is
    // built so every dequeue throughout the run shares one accounting.
    this.ensurePerPageBudget();

    // Build queue from Strategist output (AI-driven order, not static formula)
    bb.queue = FlowQueue.fromStrategyOutput(allEntryPoints, bb.currentStrategy);
    this.attachQueuePolicies(bb.queue, trace);

    // Log the full queue order for debugging prioritization
    trace.writeQueueOrder({
      source: bb.currentStrategy.plan.length > 0 ? 'strategy' : 'fallback',
      flows: bb.queue.remaining().map((ep) => ({
        id: ep.id,
        name: ep.name,
        category: ep.category,
        priority: ep.priority,
      })),
    });

    this.emitProgress('strategizing', 'strategy_planned', {
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

    // If Strategist wants more survey, run targeted survey on specific URLs
    if (bb.currentStrategy.continueSurvey && bb.currentStrategy.surveyTargets?.length) {
      logger.info('[EXPLORATION] Strategist requested targeted survey', {
        targets: bb.currentStrategy.surveyTargets,
      });

      try {
        const targetedSurveyContext = await this.browser.newContext(this.buildSurveyContextOptions());
        await targetedSurveyContext.addInitScript(BROWSER_STEALTH_SCRIPT);

        try {
          const targetedPage = await targetedSurveyContext.newPage();
          try {
            const { setupThirdPartyBlocker } = await import('@/agent/playwright/execution/third-party-blocker');
            await setupThirdPartyBlocker(targetedPage);
          } catch { /* non-fatal */ }

          const targetedSurvey = new SurveyAgent(targetedPage, this.config, budget, rateLimiter, trace);
          const updatedTree = await targetedSurvey.surveyTargets(
            bb.currentStrategy.surveyTargets,
            bb.tree!,
          );
          bb.tree = updatedTree;

          // Rebuild queue with new entry points from targeted survey
          const updatedEntryPoints = bb.tree.getAllEntryPoints();
          bb.queue = FlowQueue.fromStrategyOutput(updatedEntryPoints, bb.currentStrategy);
          this.attachQueuePolicies(bb.queue, trace);

          logger.info('[EXPLORATION] Targeted survey complete', {
            newPages: updatedTree.getNodeCount(),
            newEntryPoints: updatedEntryPoints.length,
          });

          await targetedPage.close();
        } finally {
          await targetedSurveyContext.close();
        }
      } catch (err) {
        // Targeted survey failed → some Strategist-requested pages are NOT in
        // the queue, so coverage will be incomplete. Continuing is right (one
        // failed sub-survey shouldn't kill the whole run), but it must be
        // VISIBLE — otherwise the user sees "exploration complete" believing
        // full coverage when pages were unreachable.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[EXPLORATION] Targeted survey failed, continuing with existing queue', { error: msg });
        trace.writeWarning('targeted_survey_failed', {
          phase: 'strategizing',
          targets: bb.currentStrategy.surveyTargets,
          error: msg,
        });
        this.emitProgress('strategizing', 'agent_warning', {
          message: 'Some requested pages could not be surveyed — coverage may be incomplete.',
          targets: bb.currentStrategy.surveyTargets,
        });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PHASE 2: FLOW EXPLORATION
    // Parallel sub-agents, each in isolated BrowserContext
    // Scout discovers branches after each flow
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 2: Starting flow exploration');
    this.emitProgress('flow', 'strategy_planned', {
      phase: 'executing',
      totalFlowsPlanned: bb.queue?.size() ?? 0,
    }, 30);
    trace.writePhaseStart('flow');
    trace.writeQueueState({
      pendingCount: bb.queue.size(),
      completedCount: 0,
      totalEnqueued: bb.queue.size(),
    });

    const flowRunner = new FlowRunner(this.browser, this.config, budget, this.onProgress, rateLimiter, trace, bb);

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
          pageInsights: Array.from(bb.pageInsights.entries()),
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

    this.emitProgress('evaluating', 'coverage_evaluated', {
      coverageScore: bb.coverageAssessment.coverageScore,
      gaps: bb.coverageAssessment.gaps,
      qualitySummary: bb.coverageAssessment.qualitySummary,
      continueExploring: bb.coverageAssessment.continueExploring,
      recommendations: bb.coverageAssessment.recommendations,
      riskAreas: bb.coverageAssessment.riskAreas,
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

      // If Strategist says to continue surveying, run targeted survey to discover new pages/flows
      if (focused.continueSurvey && focused.surveyTargets?.length && budget.canSurveyMorePages()) {
        logger.info('[EXPLORATION] Phase 2.5: Strategist requested targeted survey', {
          targets: focused.surveyTargets,
        });

        try {
          const targetedSurveyContext = await this.browser.newContext(this.buildSurveyContextOptions());
          await targetedSurveyContext.addInitScript(BROWSER_STEALTH_SCRIPT);

          try {
            const targetedPage = await targetedSurveyContext.newPage();
            try {
              const { setupThirdPartyBlocker } = await import('@/agent/playwright/execution/third-party-blocker');
              await setupThirdPartyBlocker(targetedPage);
            } catch { /* non-fatal */ }

            const targetedSurvey = new SurveyAgent(targetedPage, this.config, budget, rateLimiter, trace);
            const updatedTree = await targetedSurvey.surveyTargets(
              focused.surveyTargets,
              bb.tree!,
            );
            bb.tree = updatedTree;

            // Rebuild queue with newly discovered entry points. Exclude flows
            // already executed in Phase 2 and pre-seed dedup memory with their
            // names/goals so the extra round neither re-runs nor re-queues a
            // near-duplicate of an already-explored flow.
            const updatedEntryPoints = bb.tree.getAllEntryPoints();
            bb.queue = FlowQueue.fromStrategyOutput(updatedEntryPoints, focused, {
              excludeIds: flowTasks.map((t) => t.entryPoint.id),
              seedDedup: {
                names: flowTasks.map((t) => t.entryPoint.name),
                goals: flowTasks.map((t) => t.entryPoint.goal),
              },
            });
            this.attachQueuePolicies(bb.queue, trace);

            logger.info('[EXPLORATION] Phase 2.5: Targeted survey complete', {
              newPages: updatedTree.getNodeCount(),
              newEntryPoints: updatedEntryPoints.length,
            });

            await targetedPage.close();
          } finally {
            await targetedSurveyContext.close();
          }
        } catch (err) {
          // Same rationale as the Phase 1.5 targeted-survey catch: continue, but
          // make the incomplete coverage visible rather than reporting a clean
          // "complete".
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('[EXPLORATION] Phase 2.5: Targeted survey failed, continuing with existing queue', { error: msg });
          trace.writeWarning('targeted_survey_failed', {
            phase: 'evaluating',
            targets: focused.surveyTargets,
            error: msg,
          });
          this.emitProgress('evaluating', 'agent_warning', {
            message: 'Some follow-up pages could not be surveyed — coverage may be incomplete.',
            targets: focused.surveyTargets,
          });
        }
      }

      if (bb.queue) {
        bb.queue.reorder(focused.plan, focused.skipFlows.map((s) => s.id));
      }

      if (bb.queue && !bb.queue.isEmpty()) {
        const extraFlowRunner = new FlowRunner(this.browser, this.config, budget, this.onProgress, rateLimiter, trace, bb);
        // Pass accumulated flow names from Phase 2 so Scout knows what's already been tested,
        // AND the cached auth state so auth-gated extra flows reuse the session instead of
        // running logged-out (loginCompleted=true without cookies = silent unauthenticated runs).
        extraFlowRunner.restoreFromCheckpoint({
          loginCompleted: flowRunner.isLoginCompleted(),
          knownFlowNames: flowRunner.getKnownFlowNames(),
          flowsCompleted: flowTasks.length,
          completedTasks: flowTasks,
          authState: flowRunner.getAuthState(),
        });
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

    const skippedEntryPoints = bb.queue?.remaining() ?? [];

    const builder = new TestCaseBuilder();
    const result = builder.build(bb.tree, flowTasks, budget, this.config, startTime, skippedEntryPoints);

    // Trace each discovered test case + the result summary so the END of the
    // path (what tests were produced) is visible, not just silence after the
    // last flow_end. Best-effort — tracing must never affect the result.
    try {
      for (const tc of result.testCases) {
        trace.writeTestCaseDiscovered({
          name: tc.name,
          category: tc.category,
          stepsCount: tc.steps?.length ?? 0,
          assertionsCount: (tc as any).assertions?.length,
          hasCompiledLocators: tc.steps?.some((s: any) => !!s.compiled) ?? false,
          isNegative: (tc as any).isNegative ?? false,
        });
      }
      trace.writeResultBuilt({
        testCasesCount: result.testCases.length,
        totalSteps: result.summary.totalStepsDiscovered,
        categories: result.summary.categories,
      });
    } catch { /* tracing is best-effort */ }

    // Attach Sentinel assessment to result
    if (bb.coverageAssessment) {
      result.summary.coverageScore = bb.coverageAssessment.coverageScore;
      result.summary.qualitySummary = bb.coverageAssessment.qualitySummary;
      result.summary.gaps = bb.coverageAssessment.gaps;
      result.summary.recommendations = bb.coverageAssessment.recommendations;
      result.summary.riskAreas = bb.coverageAssessment.riskAreas;
    }

    await ExplorationStorageService.clearCheckpoint(this.config.explorationId);

    this.emitProgress('complete', 'coverage_evaluated', {
      testCases: result.testCases.length,
      flowsPassed: result.summary.flowsPassed,
      flowsFailed: result.summary.flowsFailed,
      flowsBlocked: result.summary.flowsBlocked,
      totalSteps: result.summary.totalStepsDiscovered,
      coverageScore: bb.coverageAssessment?.coverageScore ?? 0,
      qualitySummary: bb.coverageAssessment?.qualitySummary ?? '',
      gaps: bb.coverageAssessment?.gaps ?? [],
      recommendations: bb.coverageAssessment?.recommendations ?? [],
      riskAreas: bb.coverageAssessment?.riskAreas ?? [],
      continueExploring: false,
    }, 100);

    // Persist BEFORE finalizing the trace so the save (and any failure) is part
    // of the single traced lifecycle — fixes the old ordering where the trace
    // closed first and a failed save still showed "completed".
    let persistError: string | undefined;
    if (onResultReady) {
      try {
        const outcome = await onResultReady(result);
        if (outcome) {
          trace.writeTestCasesSaved({
            requestedCount: result.testCases.length,
            savedCount: outcome.savedCount,
            projectId: this.config.projectId,
            error: outcome.error,
          });
          persistError = outcome.error;
        }
      } catch (err) {
        persistError = err instanceof Error ? err.message : String(err);
        trace.writeTestCasesSaved({
          requestedCount: result.testCases.length,
          savedCount: 0,
          projectId: this.config.projectId,
          error: persistError,
        });
      }
    }

    trace.writeExplorationEnd({
      status: persistError ? 'failed' : 'completed',
      durationMs: result.durationMs,
      testCasesCount: result.testCases.length,
      summary: result.summary,
      error: persistError,
    });
    await trace.close();

    // A failed persist is a failed run: surface it so the job marks the run
    // failed and does NOT charge / report success for tests that weren't saved.
    if (persistError) {
      throw new Error(`Exploration persistence failed: ${persistError}`);
    }

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
    const trace = new ExplorationTraceService(config.explorationId, {
      explorationId: config.explorationId,
      userId: config.userId,
    });

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

    // Rebuild a blackboard for the resumed FlowRunner so Scout keeps its
    // known-pages dedup + Cartographer page-insight context (same as a fresh
    // run). Without this, resumed runs degrade Scout branch discovery.
    const bb = createBlackboard(config, budget, rateLimiter, trace, config.onProgress || (() => {}));
    bb.tree = tree;
    if (checkpoint.pageInsights) {
      bb.pageInsights = new Map(checkpoint.pageInsights);
    }
    // Rehydrate completedFlows from the checkpoint so the blackboard matches the
    // non-resume path (which fills it at Phase 2 end). Today the resume path goes
    // straight to builder.build and skips Sentinel/Phase 2.5, so nothing reads
    // this yet — but leaving it empty is a latent trap: any future coverage/
    // re-strategy step added to resume would see 0 prior flows. Cheap to keep sound.
    for (const task of checkpoint.flowRunner?.completedTasks ?? []) {
      bb.completedFlows.push(taskToFlowResult(task));
    }

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
      queue.setDedupTrace((data) => trace.writeQueueDedup(data));
      // Per-page fairness cap on resume too — counter necessarily resets,
      // but the cap still prevents a saturation burst after restart.
      const resumePerPageCap = config.budget.maxFlowsPerPage ?? DEFAULT_MAX_FLOWS_PER_PAGE;
      if (Number.isFinite(resumePerPageCap) && resumePerPageCap > 0) {
        queue.setPerPageBudget(new PerPageBudget(resumePerPageCap));
      }
      trace.writePhaseStart('flow');
      const flowRunner = new FlowRunner(browser, config, budget, config.onProgress, rateLimiter, trace, bb);

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
    queue.setDedupTrace((data) => trace.writeQueueDedup(data));
    // Per-page fairness cap on resume too (counter starts fresh).
    const resumePerPageCap2 = config.budget.maxFlowsPerPage ?? DEFAULT_MAX_FLOWS_PER_PAGE;
    if (Number.isFinite(resumePerPageCap2) && resumePerPageCap2 > 0) {
      queue.setPerPageBudget(new PerPageBudget(resumePerPageCap2));
    }

    const previousTasks = checkpoint.flowRunner?.completedTasks || [];
    trace.writePhaseStart('flow');
    const flowRunner = new FlowRunner(browser, config, budget, config.onProgress, rateLimiter, trace, bb);

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
