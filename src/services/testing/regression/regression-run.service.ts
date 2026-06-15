import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { BUG_REPORT_CREDITS } from '@/jobs/ai-analysis.job';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { NotFoundError, ValidationError, InsufficientCreditsError } from '@/types';
import type {
  Priority,
  RunResult,
  RunReport,
  ExecutableTestCase,
} from '@/types/testing.types';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { logger, formatError } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ExecutionService } from '../executions/execution.service';
import { RegressionPlanService } from '../plans/regression-plan.service';
import { ManualTestService } from '../ui/manualTest.service';
import { IntentTestCaseService } from '../ui/preview/intent-test-case.service';
import { deriveRunStatus } from '@/utils/testing/run-status.utils';
import {
  RegressionReportAssemblerService,
  getProjectWorkspaceMemberIds,
} from './regression-report-assembler.service';
import { MobileTestDispatcherService } from './mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from './web-test-request-builder.service';
import { RegressionTestQueryService } from './db/regression-test-query.db';
import {
  insertRun,
  updateRunById,
  failZombieRuns,
  listRunsByProject,
  getRunExecutionStatsRows,
} from './db/regression-run.db';
import { getProjectForAccess } from './db/regression.db';
import { priorityRank } from './resolve-test-case-priority.util';
import { TestExecutionOrchestratorService } from './test-execution-orchestrator.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION RUN SERVICE - Execute saved test cases and suites
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages regression test execution:
 * - Runs individual saved test cases with parameter substitution
 * - Runs regression suites (ordered execution of multiple test cases)
 * - Tracks execution via regression_runs table
 * - Lists saved test cases, suites, and runs for a project
 *
 * Key Features:
 * - Parameter substitution for runtime values (e.g., passwords)
 * - Access control verification
 * - Links regression runs to underlying tests for status tracking
 */

// Limits for pagination
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

/**
 * Service for running saved test cases and regression suites
 * Creates and dispatches underlying test executions
 */
export class RegressionRunService {
  /**
   * Clean up zombie runs that got stuck in 'running' or 'pending' status.
   * Should be called on server startup to recover from crashes.
   * Marks stale runs (older than 30 minutes) as 'failed'.
   */
  static async cleanupZombieRuns(): Promise<void> {
    try {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { ids: zombieRunIds, error } = await failZombieRuns(thirtyMinutesAgo);

      if (error) {
        // Use formatError so upstream HTML gateway responses (e.g. Cloudflare 520
        // when Supabase origin is down) don't dump multi-KB of HTML into the logs.
        logger.error('[REGRESSION_RUN] Failed to cleanup zombie runs', { error: formatError(error) });
        return;
      }

      if (zombieRunIds.length > 0) {
        logger.warn('[REGRESSION_RUN] Cleaned up zombie runs', {
          count: zombieRunIds.length,
          runIds: zombieRunIds,
        });
      }
    } catch (error) {
      logger.error('[REGRESSION_RUN] Error in zombie run cleanup', { error: formatError(error) });
    }
  }

  /**
   * Run an intent test case (unified table for UI test cases)
   * Method name kept as runSavedTestCase for API compatibility.
   *
   * @param params.savedTestCaseId - ID of intent_test_cases to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type ('manual' via API or 'chat' via AI command)
   * @param params.parameters - Runtime parameters for parameterized values
   * @returns Regression run ID and underlying test ID
   * @throws {NotFoundError} If intent test case not found
   * @throws {ValidationError} If validation fails or access denied
   */
  static async runSavedTestCase(params: {
    savedTestCaseId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
    /** Optional Playwright browser override (chromium | firefox | webkit). */
    browserOverride?: string;
  }): Promise<{
    runId: string;
    testId: string;
  }> {
    const { savedTestCaseId: intentTestCaseId, userId, trigger, parameters = {}, browserOverride } = params;

    try {
      logger.info('[REGRESSION_RUN] Running intent test case', {
        intentTestCaseId,
        userId,
        trigger,
      });

      // 1. Get intent test case
      const intentCase = await RegressionTestQueryService.getSavedTestCase(intentTestCaseId, userId);

      // 1a. Inline transitive dependency (precondition) steps so they run
      // in-session BEFORE this test's own steps (shared browser → shared
      // login/cookies/data). Borrowed steps carry `_preconditionSource` and
      // are excluded from this case's persisted steps_json at writeback time.
      const preconditionSteps = await IntentTestCaseService.collectPreconditionSteps(intentTestCaseId);
      if (preconditionSteps.length > 0) {
        intentCase.steps_json = [...preconditionSteps, ...(intentCase.steps_json || [])];
        logger.info('[REGRESSION_RUN] Inlined precondition steps', {
          intentTestCaseId,
          preconditionSteps: preconditionSteps.length,
          totalSteps: intentCase.steps_json.length,
        });
      }

      // 1b. Credit check + deduction for single test case
      await this.checkCreditBalance(
        userId,
        [{ testCaseId: intentTestCaseId, testType: 'ui', dependsOn: [] }],
        'regression_single'
      );

      // 2. Create regression run record (now uses intent_test_case_id)
      const { data: run, error: runError } = await insertRun({
        intent_test_case_id: intentTestCaseId,
        project_id: intentCase.project_id,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create regression run: ${(runError as any)?.message}`);
      }

      // 3. Route mobile vs web test
      const isMobile = intentCase.platform?.startsWith('mobile_');
      let testId: string;

      try {
        if (isMobile) {
          // Mobile test → dispatch to mobile runner queue. Parameters are
          // applied inside dispatchMobileTest before the job is queued so
          // placeholders in steps resolve to concrete values on the runner
          // (Phase 6 — same substitution pass as the web path below).
          const mobileResult = await MobileTestDispatcherService.dispatchMobileTest(
            intentCase,
            userId,
            trigger,
            undefined, // no triggerContext for single-case manual run
            parameters,
          );
          testId = mobileResult.testId;
        } else {
          // Web test → dispatch to Playwright queue
          const testRequest = await WebTestRequestBuilderService.buildTestRequest(intentCase, userId, parameters, browserOverride, trigger);
          const testResult = await ManualTestService.runTest(testRequest);

          if (!testResult.success || !testResult.data?.id) {
            throw new Error('Failed to start test execution');
          }
          testId = testResult.data.id;
        }
      } catch (execError) {
        // Mark run as failed — it was already created with 'running' status
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
        throw execError;
      }

      // 5. Update regression run with test_id for status tracking
      const { error: updateError } = await updateRunById(run.id, { test_id: testId });

      if (updateError) {
        logger.warn('[REGRESSION_RUN] Failed to update run with test_id', {
          error: updateError,
          runId: run.id,
          testId,
        });
      }

      logger.info('[REGRESSION_RUN] Test execution started', {
        runId: run.id,
        testId,
        intentTestCaseId,
      });

      return {
        runId: run.id,
        testId,
      };
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to run intent test case', {
        error,
        intentTestCaseId,
      });
      throw error;
    }
  }

  /**
   * Soft balance check before starting a regression run.
   * Verifies user can afford estimated steps but does NOT deduct credits.
   * Actual credits are deducted per-step during execution.
   *
   * Pricing: 1 credit per step for UI tests, API tests × API credit cost.
   * Fetches actual step counts from intent_test_cases so the estimate is
   * proportional to test complexity (20-step test = 20 estimated credits).
   *
   * Throws ValidationError with "Insufficient credits" so the scheduler
   * can detect and notify the user.
   */
  private static async checkCreditBalance(
    userId: string,
    testCases: ExecutableTestCase[],
    source: string
  ): Promise<void> {
    const uiCases = testCases.filter((tc) => tc.testType === 'ui');
    const apiCount = testCases.filter((tc) => tc.testType === 'api').length;
    const apiCreditCost = TokenCalculatorService.getTestCreditCost('api');

    // Fetch step counts for UI test cases (1 credit per step)
    let uiStepCredits = 0;
    if (uiCases.length > 0) {
      const uiIds = uiCases.map((tc) => tc.testCaseId);
      const rows = await RegressionTestQueryService.getUiStepCountRows(uiIds);

      for (const row of rows) {
        let stepCount = 0;
        if (row.replay_strategy === 'commands' && Array.isArray(row.commands)) {
          stepCount = row.commands.length;
        } else if (row.replay_strategy === 'graph_extract' && row.graph_ref?.steps) {
          stepCount = Array.isArray(row.graph_ref.steps) ? row.graph_ref.steps.length : 0;
        } else if (Array.isArray(row.steps_json)) {
          // Step editor test cases: count steps_json (+ 1 for initial goto)
          stepCount = row.steps_json.length + 1;
        }
        // Phase 3: setup_steps and teardown_steps are prepended / appended
        // at dispatch time by stitchPhases(). The user is billed for what
        // runs, so count those too. Empty arrays (default for pre-Phase-3
        // rows) contribute 0 — byte-identical credit to before.
        const setupCount = Array.isArray(row.setup_steps) ? row.setup_steps.length : 0;
        const teardownCount = Array.isArray(row.teardown_steps) ? row.teardown_steps.length : 0;
        stepCount += setupCount + teardownCount;
        // Minimum 1 credit per test case even if steps can't be counted
        uiStepCredits += Math.max(stepCount, 1);
      }

      // If some test case IDs weren't found in DB, charge 1 credit each as minimum
      const foundIds = new Set((rows || []).map((r: any) => r.id));
      const missingCount = uiIds.filter((id) => !foundIds.has(id)).length;
      uiStepCredits += missingCount;
    }

    // ai-analysis.job charges BUG_REPORT_CREDITS per UI test_result where bugs
    // are found. A regression run with N UI tests can incur up to N × 5 extra
    // credits after execution. Before this line was added, the estimate only
    // counted steps and users hit "insufficient credits" mid-run when the
    // post-analysis charge landed. We use the worst case (all UI tests find
    // bugs) to prevent that failure mode — users with tight balances see a
    // slightly conservative upfront estimate, which is the safer trade.
    const bugReportBudget = uiCases.length * BUG_REPORT_CREDITS;
    const totalRequired = uiStepCredits + apiCount * apiCreditCost + bugReportBudget;

    if (totalRequired <= 0) return;

    // Soft balance check — verify user can afford estimated steps, but don't deduct
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
    // Log the REAL totalRequired up-front so triage doesn't get fooled by
    // CreditCostTrackerService's own "required: 1" log (that logs the single
    // test-type cost, not the aggregated plan cost computed here).
    logger.info('[REGRESSION_RUN] Credit balance pre-flight', {
      userId,
      source,
      totalRequired,
      uiStepCredits,
      apiCount,
      apiCreditCost,
      bugReportBudget,
      available: creditCheck.available,
      graceLimit: creditCheck.graceLimit,
      effectiveAvailable: creditCheck.effectiveAvailable,
      uiTestCount: uiCases.length,
    });
    // Gate on effectiveAvailable (balance + grace_limit), matching the runtime
    // per-step gate in CreditCostTrackerService. Using raw `available` here made
    // the pre-flight reject grace-eligible users (e.g. Pro/Ultra) that the
    // runtime would have allowed — surfacing "insufficient credits" despite a
    // positive balance + grace headroom.
    if (creditCheck.effectiveAvailable < totalRequired) {
      // Use the dedicated error class so the controller can surface a stable
      // `code: 'INSUFFICIENT_CREDITS'` to the frontend (which then flips the
      // global "credits exhausted" banner instead of a generic toast).
      throw new InsufficientCreditsError(
        `Insufficient credits. Required: ${totalRequired} (${uiStepCredits} UI step credits + ${apiCount} API × ${apiCreditCost} + ${bugReportBudget} bug-report budget), Available: ${creditCheck.effectiveAvailable}`,
        {
          required: totalRequired,
          available: creditCheck.effectiveAvailable,
          breakdown: {
            uiStepCredits,
            apiCount,
            apiCreditCost,
            bugReportBudget,
          },
        },
      );
    }

    logger.info('[REGRESSION_RUN] Credit balance check passed (no deduction)', {
      userId,
      source,
      uiTestCount: uiCases.length,
      uiStepCredits,
      apiCount,
      bugReportBudget,
      totalEstimated: totalRequired,
      available: creditCheck.available,
    });
  }

  /**
   * Update run status (called after test completion)
   * Note: This is now primarily handled by test-completion-handler.service.ts
   * but kept for manual status updates if needed
   *
   * @deprecated Use test completion hook instead
   */
  static async updateRunStatus(params: {
    runId: string;
    status: 'passed' | 'completed' | 'failed' | 'cancelled';
    summary?: any;
  }): Promise<void> {
    const { runId, status, summary } = params;

    try {
      const { error } = await updateRunById(runId, {
        status,
        summary: summary || null,
        completed_at: new Date().toISOString(),
      });

      if (error) {
        throw new Error(`Failed to update run status: ${(error as any)?.message}`);
      }

      logger.info('[REGRESSION_RUN] Run status updated', { runId, status });
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to update run status', { error, runId });
      throw error;
    }
  }

  /**
   * List saved test cases for project
   *
   * @param projectId - Project ID to list cases for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @returns List of saved test cases
   */
  static async listSavedTestCases(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    platform?: string,
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    // Now fetches from intent_test_cases (unified table)
    const { data: cases, error } = await RegressionTestQueryService.listByProject(
      projectId,
      safeLimit,
      platform,
    );

    if (error) {
      throw new Error(`Failed to list intent test cases: ${(error as any)?.message}`);
    }

    return cases || [];
  }

  /**
   * List runs for project
   *
   * @param projectId - Project ID to list runs for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @returns List of regression runs with status and summary
   */
  static async listRuns(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    const { data: runs, error } = await listRunsByProject(projectId, safeLimit);

    if (error) {
      throw new Error(`Failed to list runs: ${(error as any)?.message}`);
    }

    if (!runs || runs.length === 0) return [];

    // Batch fetch stats for all runs.
    // Phase 7: also pull `platform` + `test_type` so each run row can
    // carry a per-platform composition (web / mobile / api counts).
    // Same single-query pattern as the existing stats fetch — no new
    // round-trip, just two extra columns.
    const runIds = runs.map((r: any) => r.id);
    const allExecs = await getRunExecutionStatsRows(runIds);

    // Bucket a raw `test_executions` row into web/mobile/api. Matches
    // PlanHealthReport's bucketing exactly (see healthBucketForPlatform
    // in regression-plan.service); duplicated as a local closure because
    // the two services don't currently share a util layer and importing
    // across would create a minor circular risk. When we extract a
    // shared analytics-util module these should merge.
    const bucketFor = (exec: any): 'web' | 'mobile' | 'api' => {
      if (exec.test_type === 'api') return 'api';
      const p = exec.platform as string | null | undefined;
      if (p && p.startsWith('mobile_')) return 'mobile';
      return 'web';
    };
    const emptyBreakdown = () => ({
      web:    { total: 0, passed: 0, failed: 0 },
      mobile: { total: 0, passed: 0, failed: 0 },
      api:    { total: 0, passed: 0, failed: 0 },
    });

    // Group by run_id and compute stats + platform breakdown in one pass.
    const statsMap = new Map<string, any>();
    const breakdownMap = new Map<string, ReturnType<typeof emptyBreakdown>>();
    const grouped = new Map<string, any[]>();
    for (const exec of allExecs || []) {
      const arr = grouped.get(exec.run_id) || [];
      arr.push(exec);
      grouped.set(exec.run_id, arr);
    }
    for (const [rid, execs] of grouped) {
      const total = execs.length;
      const passed = execs.filter((e: any) => e.status === 'passed').length;
      const failed = execs.filter((e: any) => e.status === 'failed').length;
      const skipped = execs.filter((e: any) => e.status === 'skipped').length;
      const pending = execs.filter((e: any) => e.status === 'pending').length;
      const running = execs.filter((e: any) => e.status === 'running').length;
      const cancelled = execs.filter((e: any) => e.status === 'cancelled').length;
      const completed = passed + failed;
      statsMap.set(rid, {
        total, passed, failed, skipped, pending, running, cancelled,
        passRate: completed > 0 ? Math.round((passed / completed) * 100) : 0,
      });

      // Platform breakdown for this run — zero-filled slices for platforms
      // that don't appear in this run, so the frontend can render a
      // consistent three-slot strip without null checks.
      const bd = emptyBreakdown();
      for (const exec of execs) {
        const bucket = bucketFor(exec);
        bd[bucket].total++;
        if (exec.status === 'passed') bd[bucket].passed++;
        else if (exec.status === 'failed') bd[bucket].failed++;
      }
      breakdownMap.set(rid, bd);
    }

    return runs.map((run: any) => {
      const runStats = statsMap.get(run.id) || { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, running: 0, cancelled: 0, passRate: 0 };
      const durationMs = run.started_at && run.completed_at
        ? Math.max(new Date(run.completed_at).getTime() - new Date(run.started_at).getTime(), 0)
        : null;
      const bugsFound = run.summary?.bugs_count ?? run.summary?.bugsFound ?? 0;

      // Derive status from live execution data to avoid stale regression_runs cache
      const normalizedStatus = deriveRunStatus({ cachedStatus: run.status, execStats: runStats });

      return {
        id: run.id,
        planId: run.plan_id || null,
        planName: (run.regression_plans as any)?.name || null,
        projectId: run.project_id,
        status: normalizedStatus,
        trigger: run.trigger,
        startedAt: run.started_at,
        completedAt: run.completed_at || null,
        durationMs,
        passRate: runStats.passRate,
        stats: runStats,
        bugsFound,
        /**
         * Phase 7 — runs-list platform composition. Same shape as
         * `RunReportSummary.platformBreakdown` on the report endpoint;
         * frontend renders a compact "4 web / 1 mobile" chip.
         */
        platformBreakdown: breakdownMap.get(run.id) || emptyBreakdown(),
      };
    });
  }

  /**
   * Verify user has access to project (owner or any workspace member with read access).
   * So webhook-triggered runs are visible to all workspace members, not only project owner.
   *
   * @throws {NotFoundError} If project not found
   * @throws {ValidationError} If access denied
   */
  private static async verifyProjectAccess(
    projectId: string,
    userId: string
  ): Promise<void> {
    const project = await getProjectForAccess(projectId);

    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id === userId) return;

    const workspaceId = project.workspace_id ?? undefined;
    if (workspaceId) {
      const role = await WorkspaceAccessService.getRole(userId, workspaceId);
      if (role != null) return;
    }

    throw new ValidationError('Access denied to this project');
  }

  // =========================================================================
  // NEW HIERARCHY METHODS
  // =========================================================================

  /**
   * Run a regression plan
   * Expands plan to individual test cases and executes them
   *
   * @param params.planId - ID of regression plan to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @param params.parameters - Runtime parameters
   * @returns Run result with run ID and test case count
   */
  static async runPlan(params: {
    planId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
    /**
     * Phase 5: optional trigger context — threaded from the git webhook
     * handler so mobile cases can install the APK built from that branch /
     * commit. Ignored by the web dispatch path (Playwright agent pulls the
     * site by URL regardless of git context).
     *
     * Precedence inside the mobile resolver:
     *   commitSha > branch > legacy project.settings.mobileApp
     *
     * When this context is absent (manual runs, scheduled runs without a
     * pinned build, pre-Phase-5 callers), the resolver falls back to the
     * legacy slot — byte-identical to pre-Phase-5 behaviour.
     */
    triggerContext?: {
      branch?: string;
      commitSha?: string;
      /** Explicit mobile build pin from plan/run settings (wins over branch/commit). */
      buildId?: string;
    };
  }): Promise<RunResult> {
    const { planId, userId, trigger, parameters = {}, triggerContext: rawTriggerContext } = params;

    try {
      logger.info('[REGRESSION_RUN] Running plan', { planId, userId, trigger });

      // 1. Verify plan access and expand to test cases
      const plan = await RegressionPlanService.getById(planId, userId);
      if (!plan) {
        throw new NotFoundError('Regression plan', planId);
      }

      // Merge the plan-level mobile build pin into triggerContext so the
      // resolver picks the pinned APK by default. Explicit triggerContext
      // from the caller (e.g. a git webhook with branch + commitSha)
      // still wins — webhook context is always more specific than a
      // generic "use this version" plan default.
      //
      // Detect a stale pin (build was pruned out by `pruneOldBuilds` after
      // the plan was created) so we can surface it loudly. The resolver
      // falls through to latest-on-project either way, but a silent
      // downgrade is exactly the kind of "why did my regression run
      // against v1.3 instead of v1.2?" incident we want to make visible.
      if (plan.mobileBuildMode === 'pinned' && plan.pinnedMobileAppBuildId) {
        const pinnedRow = await MobileAppStorageService.getBuildById(
          plan.pinnedMobileAppBuildId,
          plan.projectId,
        );
        if (!pinnedRow) {
          logger.warn('[REGRESSION_RUN] plan pin missing — pruned or deleted, falling back to latest', {
            planId,
            projectId: plan.projectId,
            pinnedBuildId: plan.pinnedMobileAppBuildId,
            trigger,
          });
        }
      }
      const triggerContext =
        plan.mobileBuildMode === 'pinned' && plan.pinnedMobileAppBuildId
          ? { buildId: plan.pinnedMobileAppBuildId, ...(rawTriggerContext ?? {}) }
          : rawTriggerContext;
      if (triggerContext?.buildId) {
        logger.info('[REGRESSION_RUN] triggerContext.buildId active', {
          planId,
          buildId: triggerContext.buildId,
          fromPlanPin: plan.mobileBuildMode === 'pinned' && plan.pinnedMobileAppBuildId === triggerContext.buildId,
        });
      }

      const expandedCases = await RegressionPlanService.expandPlan(planId);
      if (expandedCases.length === 0) {
        const items = await RegressionPlanService.getItems(planId);
        const flowItems = items.filter((i) => i.itemType === 'flow');
        const moduleItems = items.filter((i) => i.itemType === 'module');
        logger.error('[REGRESSION_RUN] Plan expanded to 0 test cases', {
          planId,
          totalItems: items.length,
          flowItems: flowItems.map((i) => i.flowId),
          moduleItems: moduleItems.map((i) => i.moduleId),
        });
        throw new ValidationError(
          items.length === 0
            ? 'Plan has no items. Add modules, flows, or test cases to the plan before running.'
            : `Plan has ${items.length} item(s) but none contain test cases. The referenced flows/modules may be empty.`
        );
      }

      // 1b. Batch-fetch depends_on + priority for UI test cases.
      // Dependencies are passed RAW (not filtered to in-run ids): the
      // orchestrator detects out-of-run references, surfaces them in the
      // run summary as `missingDependencies`, and the topological sort
      // ignores them for ordering — so the user sees the gap instead of
      // it being silently swallowed here.
      const uiCaseIds = expandedCases.filter((tc) => tc.testType === 'ui').map((tc) => tc.testCaseId);
      const depMap = new Map<string, string[]>();
      const priorityMap = new Map<string, string | null>();
      if (uiCaseIds.length > 0) {
        const depRows = await RegressionTestQueryService.getDependsOnRows(uiCaseIds);
        for (const row of depRows) {
          depMap.set(row.id, row.depends_on || []);
          priorityMap.set(row.id, row.priority ?? null);
        }
      }

      const executableCases: ExecutableTestCase[] = expandedCases.map((tc) => ({
        testCaseId: tc.testCaseId,
        testType: tc.testType,
        moduleId: tc.moduleId,
        flowId: tc.flowId,
        dependsOn: depMap.get(tc.testCaseId) || [],
        priority: priorityMap.get(tc.testCaseId) ?? null,
        ...(tc.isNegative && { isNegative: true }),
        ...(tc.platform && { platform: tc.platform }),
      }));

      // 1c. Credit check — verify user has enough credits for all test cases
      await this.checkCreditBalance(userId, executableCases, 'regression_plan');

      // 2. Create regression run record with plan_id (initially 'pending' until executions are created)
      const { data: run, error: runError } = await insertRun({
        plan_id: planId,
        project_id: plan.projectId,
        user_id: userId,
        trigger,
        status: 'pending',
      });

      if (runError || !run) {
        throw new Error(`Failed to create plan run: ${(runError as any)?.message}`);
      }

      // Invalidate plans list cache (new run affects lastRun display)
      await cache.delByPattern(`qait:cache:plans:proj:${plan.projectId}:*`);

      // 3. Create execution records for all test cases
      let executions;
      try {
        executions = await ExecutionService.createBatch(
          run.id,
          executableCases.map((tc) => ({
            testCaseId: tc.testCaseId,
            testType: tc.testType,
            moduleId: tc.moduleId,
            flowId: tc.flowId,
            ...(tc.isNegative && { isNegative: true }),
            // Denormalise platform so reports / WS events can render the
            // right mobile/web artifacts without joining back to
            // intent_test_cases on every query.
            ...(tc.platform ? { platform: tc.platform } : {}),
          }))
        );
      } catch (batchError) {
        // Rollback: mark run as failed since executions couldn't be created
        logger.error('[REGRESSION_RUN] Failed to create executions, marking run as failed', {
          runId: run.id,
          error: batchError,
        });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
        throw batchError;
      }

      // Transition from 'pending' to 'running' now that executions exist
      await updateRunById(run.id, { status: 'running', started_at: new Date().toISOString() });

      // Notify all workspace members immediately — closes the gap between run creation
      // and the first progress event from executeTestCasesAsync (which fires only
      // after the BullMQ job picks up, potentially seconds later).
      // Non-fatal: a WS emit failure must never block run startup — the run row
      // already exists with status='running' and BullMQ will execute it regardless.
      try {
        const creationRecipients = await getProjectWorkspaceMemberIds(plan.projectId, userId);
        const creationPayload = {
          runId: run.id,
          userId,
          planId,
          projectId: plan.projectId,
          trigger,
          status: 'started' as const,
          progress: 0,
          message: 'Regression run started',
          details: { totalTests: executableCases.length, completedTests: 0 },
          timestamp: new Date().toISOString(),
        };
        for (const recipientId of creationRecipients) {
          webSocketService.emitRegressionRunProgress(recipientId, creationPayload);
        }
        logger.info('[REGRESSION_RUN] Creation WS event emitted', {
          runId: run.id,
          planId,
          recipients: creationRecipients.length,
        });
      } catch (wsError) {
        logger.warn('[REGRESSION_RUN] Failed to emit creation WS event — run will proceed normally', {
          runId: run.id, planId, error: wsError,
        });
      }

      // 4. Read runtime config from plan's automation_config
      const browserOverride = plan.automationConfig?.runtime?.browser;
      // Opt-in fail-fast: stop dispatching new tests after the first
      // failure / skipped-prereq. Default (undefined / false) preserves
      // the current "run every test" behaviour.
      const failOnFirstFailure = plan.automationConfig?.runtime?.failOnFirstFailure === true;

      // 5. Start executing tests (async, don't wait)
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        executableCases,
        userId,
        trigger,
        parameters,
        browserOverride,
        triggerContext,
        failOnFirstFailure,
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      logger.info('[REGRESSION_RUN] Plan execution started', {
        runId: run.id,
        planId,
        totalCases: executableCases.length,
        browserOverride,
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: executableCases.length,
      };
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to run plan', { error, planId });
      throw error;
    }
  }

  /**
   * Run all tests in a module
   * Platform determines whether this runs UI or API tests (enforced by DB triggers)
   *
   * @param params.moduleId - ID of module to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @param params.parameters - Runtime parameters
   * @returns Run result
   */
  static async runModule(params: {
    moduleId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
  }): Promise<RunResult> {
    const { moduleId, userId, trigger, parameters = {} } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running module', { moduleId, userId, trigger });

      // 1. Get module with platform info and verify access
      const { data: mod, error: modError } = await RegressionTestQueryService.getModuleWithAccess(moduleId);

      if (modError || !mod) {
        throw new NotFoundError('Module', moduleId);
      }

      if ((mod.projects as any)?.user_id !== userId) {
        throw new ValidationError('Access denied to this module');
      }

      const platformKey = (mod.test_platforms as any)?.platform_key;
      logger.info('[REGRESSION_RUN] Module platform resolved', {
        moduleId,
        moduleName: mod.name,
        platformKey,
      });

      // 2. Get all flows in module
      const flowIds = await RegressionTestQueryService.getFlowIdsByModule(moduleId);

      // 3. Get all test cases in flows
      const testCases = await RegressionTestQueryService.getTestCasesInFlows(flowIds);

      if (testCases.length === 0) {
        throw new ValidationError('Module has no test cases');
      }

      // 4. Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_module');

      // 5. Create regression run record
      const { data: run, error: runError } = await insertRun({
        module_id: moduleId,
        project_id: mod.project_id,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create module run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // 6. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 7. Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        parameters
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      // Mark run as failed if it was already created
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run module', { error, moduleId });
      throw error;
    }
  }

  /**
   * Run all tests in a flow
   *
   * @param params.flowId - ID of flow to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @param params.parameters - Runtime parameters
   * @returns Run result
   */
  static async runFlow(params: {
    flowId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
  }): Promise<RunResult> {
    const { flowId, userId, trigger, parameters = {} } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running flow', { flowId, userId, trigger });

      // 1. Get flow and verify access
      const { data: flow, error: flowError } = await RegressionTestQueryService.getFlowWithAccess(flowId);

      if (flowError || !flow) {
        throw new NotFoundError('Flow', flowId);
      }

      const module = flow.test_modules as any;
      if (module?.projects?.user_id !== userId) {
        throw new ValidationError('Access denied to this flow');
      }

      // 2. Get test cases in flow
      const testCases = await RegressionTestQueryService.getTestCasesInFlows([flowId]);

      if (testCases.length === 0) {
        throw new ValidationError('Flow has no test cases');
      }

      // 2b. Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_flow');

      // 3. Create regression run record
      const { data: run, error: runError } = await insertRun({
        flow_id: flowId,
        module_id: flow.module_id,
        project_id: module.project_id,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create flow run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // 4. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 5. Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        parameters
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run flow', { error, flowId });
      throw error;
    }
  }

  /**
   * Run all tests with a specific tag
   *
   * @param params.projectId - Project ID
   * @param params.tag - Tag to filter by
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @returns Run result
   */
  static async runByTag(params: {
    projectId: string;
    tag: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
  }): Promise<RunResult> {
    const { projectId, tag, userId, trigger } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running by tag', { projectId, tag, userId });

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Get UI test cases with tag from intent_test_cases (unified table).
      // We pull `priority` so we can run higher-priority tests first
      // within a tag bucket — a tag is an unordered collection (unlike
      // a plan which has explicit `position`, or a module/flow which
      // has `order_index`), so reordering here doesn't violate any
      // curator-set sequence. Sort is below.
      const uiCases = await RegressionTestQueryService.getUiTestCasesByTag(projectId, tag);

      // Get API test cases with tag (scoped to project via environments/endpoints)
      const apiCases = await RegressionTestQueryService.getApiTestConfigsByProjectAndTag(projectId, userId, tag);

      // Sort UI cases by curator-set priority — critical first.
      // Stable within the same priority bucket (we lean on Array.sort's
      // stability guarantee, ES2019+). API cases stay in their original
      // relative order at the end because `api_test_configs` has no
      // priority column repo-wide (see analytics-query.service:838) — no
      // signal to sort on, so we don't pretend to.
      //
      // NULL / wrongly-cased handling lives in the shared priorityRank()
      // (resolve-test-case-priority.util.ts): legacy NULL rows and schema
      // drift like 'Critical' collapse into the medium bucket.
      const orderedUiCases = [...(uiCases || [])].sort(
        (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
      );

      const testCases: ExecutableTestCase[] = [
        ...orderedUiCases.map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: tc.depends_on || [],
          platform: tc.platform || undefined,
          priority: tc.priority ?? null,
        })),
        ...(apiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'api' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: [] as string[],
        })),
      ];

      if (testCases.length === 0) {
        throw new ValidationError(`No test cases found with tag: ${tag}`);
      }

      // Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_tag');

      // Create regression run
      const { data: run, error: runError } = await insertRun({
        project_id: projectId,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create tag run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        {}
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run by tag', { error, projectId, tag });
      throw error;
    }
  }

  /**
   * Run all tests with a specific priority
   *
   * @param params.projectId - Project ID
   * @param params.priority - Priority to filter by
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @returns Run result
   */
  static async runByPriority(params: {
    projectId: string;
    priority: Priority;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
  }): Promise<RunResult> {
    const { projectId, priority, userId, trigger } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running by priority', { projectId, priority, userId });

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Get UI test cases with priority from intent_test_cases (unified table)
      const uiCases = await RegressionTestQueryService.getUiTestCasesByPriority(projectId, priority);

      // Get API test cases with priority (scoped to project via environments/endpoints)
      const apiCases = await RegressionTestQueryService.getApiTestConfigsByProjectAndPriority(projectId, userId, priority);

      const testCases: ExecutableTestCase[] = [
        ...(uiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: tc.depends_on || [],
          platform: tc.platform || undefined,
          priority: tc.priority ?? null,
        })),
        ...(apiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'api' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: [] as string[],
        })),
      ];

      if (testCases.length === 0) {
        throw new ValidationError(`No test cases found with priority: ${priority}`);
      }

      // Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_priority');

      // Create regression run
      const { data: run, error: runError } = await insertRun({
        project_id: projectId,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create priority run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        {}
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run by priority', { error, projectId, priority });
      throw error;
    }
  }

  // =========================================================================
  // RUN REPORT — delegates to RegressionReportAssemblerService
  // =========================================================================

  static async buildFullReport(runId: string, userId: string): Promise<RunReport | null> {
    return RegressionReportAssemblerService.buildFullReport(runId, userId);
  }

  static async buildPublicReport(shareToken: string): Promise<RunReport | null> {
    return RegressionReportAssemblerService.buildPublicReport(shareToken);
  }

  static async batchGetTestResults(testIds: string[]) {
    return RegressionReportAssemblerService.batchGetTestResults(testIds);
  }
}
