/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION ENGINE — Top-level orchestrator
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Coordinates the autonomous test case discovery process:
 *
 *   Phase 1: SURVEY
 *   - BFS traversal of the web application
 *   - AI classification of each page
 *   - Discovery of all testable entry points
 *
 *   Phase 2: FLOW EXPLORATION
 *   - Prioritize discovered entry points
 *   - Run up to 5 parallel sub-agents (TestPipeline per flow)
 *   - Extract test steps from each flow
 *   - Detect branch points (new flows after completion)
 *
 *   Output: ExplorationResult with DiscoveredTestCase[]
 *
 * Usage:
 *   const engine = new ExplorationEngine(browser, config);
 *   const result = await engine.run();
 *
 * Reuses:
 *   - TestPipeline (pipeline/) for individual flow execution
 *   - SnapshotCollector for page analysis
 *   - ActionExecutor for Playwright actions
 *   - GoalDetector for progress scoring
 *   - All existing collector/analysis infrastructure
 */

import type { Browser, BrowserContext } from 'playwright';
import { logger } from '@/utils/core/logger';

import type { ExplorationConfig, ExplorationResult, ExplorationProgressCallback } from './types';
import { DEFAULT_EXPLORATION_BUDGET, DEFAULT_MAX_CONCURRENCY, DESKTOP_USER_AGENT } from './types';
import { BudgetTracker } from './budget-tracker';
import { RateLimiter } from './rate-limiter';
import { SurveyAgent } from './survey-agent';
import { FlowQueue } from './flow-queue';
import { FlowRunner } from './flow-runner';
import { TestCaseBuilder } from './test-case-builder';

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
   * Run the full exploration: Survey → Prioritize → Explore → Build results.
   */
  async run(): Promise<ExplorationResult> {
    const startTime = Date.now();
    const budget = new BudgetTracker(this.config.budget);
    const rateLimiter = new RateLimiter(this.config.rateLimiting, budget);

    logger.info('[EXPLORATION] Starting autonomous exploration', {
      explorationId: this.config.explorationId,
      entryUrl: this.config.entryUrl,
      maxFlows: this.config.budget.maxFlows,
      maxConcurrency: this.config.maxConcurrency,
      totalTimeoutMs: this.config.budget.totalTimeoutMs,
    });

    // ════════════════════════════════════════════════════════════════════
    // PHASE 1: SURVEY
    // BFS page discovery — read-only, no side effects
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 1: Starting page survey');

    const surveyContext = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent: DESKTOP_USER_AGENT,
    });

    let tree;
    try {
      const surveyPage = await surveyContext.newPage();
      const surveyAgent = new SurveyAgent(surveyPage, this.config, budget, rateLimiter);
      tree = await surveyAgent.survey();
      await surveyPage.close();
    } finally {
      await surveyContext.close();
    }

    const allEntryPoints = tree.getAllEntryPoints();

    this.emitProgress('survey', 'survey_complete', {
      pagesVisited: tree.getNodeCount(),
      entryPointsFound: allEntryPoints.length,
    }, 30);

    logger.info('[EXPLORATION] Phase 1 complete', {
      pagesVisited: tree.getNodeCount(),
      entryPointsFound: allEntryPoints.length,
      timeUsedMs: Date.now() - startTime,
    });

    // If no entry points found, return early
    if (allEntryPoints.length === 0) {
      logger.warn('[EXPLORATION] No entry points discovered, returning empty result');
      const builder = new TestCaseBuilder();
      return builder.build(tree, [], budget, this.config, startTime, []);
    }

    // ════════════════════════════════════════════════════════════════════
    // PRIORITIZE: Build flow queue from discovered entry points
    // ════════════════════════════════════════════════════════════════════

    const queue = FlowQueue.fromEntryPoints(allEntryPoints);

    logger.info('[EXPLORATION] Flow queue built', {
      totalFlows: queue.size(),
      budgetRemaining: budget.remainingFlows(),
    });

    // ════════════════════════════════════════════════════════════════════
    // PHASE 2: FLOW EXPLORATION
    // Parallel sub-agents, each in isolated BrowserContext
    // ════════════════════════════════════════════════════════════════════

    logger.info('[EXPLORATION] Phase 2: Starting flow exploration');

    const flowRunner = new FlowRunner(this.browser, this.config, budget, this.onProgress, rateLimiter);
    let flowTasks;

    try {
      flowTasks = await flowRunner.runAll(queue);
    } finally {
      await flowRunner.cleanup();
    }

    logger.info('[EXPLORATION] Phase 2 complete', {
      flowsExplored: flowTasks.length,
      passed: flowTasks.filter((t) => t.goalAchieved).length,
      failed: flowTasks.filter((t) => t.status === 'failed').length,
      blocked: flowTasks.filter((t) => t.status === 'blocked').length,
      timeUsedMs: Date.now() - startTime,
    });

    // ════════════════════════════════════════════════════════════════════
    // BUILD RESULT
    // ════════════════════════════════════════════════════════════════════

    // Collect skipped entry points (remaining in queue after budget exhaustion)
    const skippedEntryPoints = queue.remaining();

    const builder = new TestCaseBuilder();
    const result = builder.build(tree, flowTasks, budget, this.config, startTime, skippedEntryPoints);

    this.emitProgress('complete', 'survey_complete', {
      testCases: result.testCases.length,
      flowsPassed: result.summary.flowsPassed,
      flowsFailed: result.summary.flowsFailed,
      flowsBlocked: result.summary.flowsBlocked,
      totalSteps: result.summary.totalStepsDiscovered,
    }, 100);

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
    });

    return result;
  }
}
