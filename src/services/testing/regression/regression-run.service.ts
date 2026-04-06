import { supabaseAdmin } from '@/db/supabase';
import { ApiConfigService } from '@/services/api/api-config.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { NotFoundError, ValidationError } from '@/types';
import type { RegressionRunProgressPayload } from '@/websocket/types/types';
import type {
  Priority,
  RunResult,
  RunReport,
  RunReportExecution,
  RunReportStep,
  RunReportSummary,
  RunReportArtifactsSummary,
  EnrichedBug,
  ExecutableTestCase,
  ExecutionHealthChecks,
  NegativeSummary,
} from '@/types/testing.types';
import { HealthCheckAggregatorService } from './health-check-aggregator.service';
import { logger, formatError } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { topologicalSort } from '@/utils/graph/topological-sort';
import { webSocketService } from '@/websocket/core/websocket.service';
import { executionCompletionEmitter } from '../executions/execution-completion-emitter';
import { ExecutionService } from '../executions/execution.service';
import { RegressionPlanService } from '../plans/regression-plan.service';
import { ManualTestService } from '../ui/manualTest.service';
import { TestReportGeneratorService } from '../results/test-report-generator.service';
import { env } from '@/config/environment/env';
import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService } from '@/db/supabase';
import type { MobileTestJobData, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { buildMetadataFromTestCase } from '@/services/mobile/mobile-runner.types';
import { v4 as uuidv4 } from 'uuid';

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
      const { data: zombieRuns, error } = await supabaseAdmin
        .from('regression_runs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
        })
        .in('status', ['running', 'pending'])
        .lt('started_at', thirtyMinutesAgo)
        .select('id');

      if (error) {
        // Use formatError so upstream HTML gateway responses (e.g. Cloudflare 520
        // when Supabase origin is down) don't dump multi-KB of HTML into the logs.
        logger.error('[REGRESSION_RUN] Failed to cleanup zombie runs', { error: formatError(error) });
        return;
      }

      if (zombieRuns && zombieRuns.length > 0) {
        logger.warn('[REGRESSION_RUN] Cleaned up zombie runs', {
          count: zombieRuns.length,
          runIds: zombieRuns.map((r: any) => r.id),
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
  }): Promise<{
    runId: string;
    testId: string;
  }> {
    const { savedTestCaseId: intentTestCaseId, userId, trigger, parameters = {} } = params;

    try {
      logger.info('[REGRESSION_RUN] Running intent test case', {
        intentTestCaseId,
        userId,
        trigger,
      });

      // 1. Get intent test case
      const intentCase = await this.getSavedTestCase(intentTestCaseId, userId);

      // 1b. Credit check + deduction for single test case
      await this.checkCreditBalance(
        userId,
        [{ testCaseId: intentTestCaseId, testType: 'ui', dependsOn: [] }],
        'regression_single'
      );

      // 2. Create regression run record (now uses intent_test_case_id)
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          intent_test_case_id: intentTestCaseId,
          project_id: intentCase.project_id,
          user_id: userId,
          trigger,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create regression run: ${runError?.message}`);
      }

      // 3. Route mobile vs web test
      const isMobile = intentCase.platform?.startsWith('mobile_');
      let testId: string;

      try {
        if (isMobile) {
          // Mobile test → dispatch to mobile runner queue
          const mobileResult = await this.dispatchMobileTest(intentCase, userId, trigger);
          testId = mobileResult.testId;
        } else {
          // Web test → dispatch to Playwright queue
          const testRequest = await this.buildTestRequest(intentCase, userId, parameters);
          const testResult = await ManualTestService.runTest(testRequest);

          if (!testResult.success || !testResult.data?.id) {
            throw new Error('Failed to start test execution');
          }
          testId = testResult.data.id;
        }
      } catch (execError) {
        // Mark run as failed — it was already created with 'running' status
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
        throw execError;
      }

      // 5. Update regression run with test_id for status tracking
      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({ test_id: testId })
        .eq('id', run.id);

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
      const { data: rows } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, commands, graph_ref, steps_json, replay_strategy')
        .in('id', uiIds);

      for (const row of rows || []) {
        let stepCount = 0;
        if (row.replay_strategy === 'commands' && Array.isArray(row.commands)) {
          stepCount = row.commands.length;
        } else if (row.replay_strategy === 'graph_extract' && row.graph_ref?.steps) {
          stepCount = Array.isArray(row.graph_ref.steps) ? row.graph_ref.steps.length : 0;
        } else if (Array.isArray(row.steps_json)) {
          // Step editor test cases: count steps_json (+ 1 for initial goto)
          stepCount = row.steps_json.length + 1;
        }
        // Minimum 1 credit per test case even if steps can't be counted
        uiStepCredits += Math.max(stepCount, 1);
      }

      // If some test case IDs weren't found in DB, charge 1 credit each as minimum
      const foundIds = new Set((rows || []).map((r: any) => r.id));
      const missingCount = uiIds.filter((id) => !foundIds.has(id)).length;
      uiStepCredits += missingCount;
    }

    const totalRequired = uiStepCredits + apiCount * apiCreditCost;

    if (totalRequired <= 0) return;

    // Soft balance check — verify user can afford estimated steps, but don't deduct
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
    if (creditCheck.available < totalRequired) {
      throw new ValidationError(
        `Insufficient credits. Required: ${totalRequired} (${uiStepCredits} UI step credits + ${apiCount} API × ${apiCreditCost}), Available: ${creditCheck.available}`
      );
    }

    logger.info('[REGRESSION_RUN] Credit balance check passed (no deduction)', {
      userId,
      source,
      uiTestCount: uiCases.length,
      uiStepCredits,
      apiCount,
      totalEstimated: totalRequired,
      available: creditCheck.available,
    });
  }

  /**
   * Get intent test case and verify access
   * Now fetches from intent_test_cases (unified table).
   *
   * @throws {NotFoundError} If intent test case not found
   * @throws {ValidationError} If access denied
   */
  private static async getSavedTestCase(
    intentTestCaseId: string,
    userId: string
  ): Promise<any> {
    const { data: intentCase, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*, projects!inner(user_id)')
      .eq('id', intentTestCaseId)
      .single();

    if (error || !intentCase) {
      throw new NotFoundError('Intent test case', intentTestCaseId);
    }

    // Verify user has access via project ownership
    const projectUserId = (intentCase.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new ValidationError('Access denied to this intent test case');
    }

    return intentCase;
  }

  /**
   * Build test request from intent test case
   * Constructs a test execution request with parameterized values.
   * Uses url field with fallback to start_url for compatibility.
   *
   * @throws {ValidationError} If intent case has no replayable data or URL
   */
  private static async buildTestRequest(
    intentCase: any,
    userId: string,
    parameters: Record<string, any>,
    browserOverride?: string
  ): Promise<any> {
    // Validate URL exists first (with fallback to start_url)
    const targetUrl = intentCase.url || intentCase.start_url;
    if (!targetUrl) {
      throw new ValidationError(
        `Intent test case "${intentCase.name}" (${intentCase.id}) has no URL. ` +
        'Please set a URL on the test case before running.'
      );
    }

    // Get source test for base configuration (optional - only for browsers/options)
    // Step editor test cases have no source_test_id — query returns null, defaults apply
    const { data: sourceTest } = intentCase.source_test_id
      ? await supabaseAdmin
          .from('tests')
          .select('browsers, options')
          .eq('id', intentCase.source_test_id)
          .maybeSingle()
      : { data: null };

    let commands: any[] = [];

    // Extract commands based on strategy (3 paths):
    // 1. Pre-compiled commands (saved from completed test via /regression/save)
    // 2. Graph extract steps (saved from intelligent session)
    // 3. steps_json conversion (step editor test cases — converted at runtime)
    if (intentCase.replay_strategy === 'commands' && Array.isArray(intentCase.commands) && intentCase.commands.length > 0) {
      commands = intentCase.commands;
    } else if (intentCase.replay_strategy === 'graph_extract' && Array.isArray(intentCase.graph_ref?.steps) && intentCase.graph_ref.steps.length > 0) {
      commands = intentCase.graph_ref.steps;
    } else if (Array.isArray(intentCase.steps_json) && intentCase.steps_json.length > 0) {
      // Convert intent steps to executable Playwright commands (same path as preview runner)
      const { IntentStepConverterService } = await import('../ui/preview/intent-step-converter.service');
      commands = IntentStepConverterService.convertToCommands(intentCase.steps_json, targetUrl, intentCase.id);
      logger.info('[REGRESSION_RUN] Converted steps_json to commands', {
        intentTestCaseId: intentCase.id,
        stepsCount: intentCase.steps_json.length,
        commandsCount: commands.length,
        stepsWithCompiled: intentCase.steps_json.filter((s: any) => !!s.compiled).length,
      });
    } else {
      throw new ValidationError(
        `Intent test case "${intentCase.name}" (${intentCase.id}) has no replayable data. ` +
        `replay_strategy=${intentCase.replay_strategy}, commands=${intentCase.commands === null ? 'null' : typeof intentCase.commands}, ` +
        `steps_json=${intentCase.steps_json === null ? 'null' : (Array.isArray(intentCase.steps_json) ? `array(${intentCase.steps_json.length})` : typeof intentCase.steps_json)}, ` +
        `status=${intentCase.status}.`
      );
    }

    if (commands.length === 0) {
      throw new ValidationError(
        `Intent test case "${intentCase.name}" (${intentCase.id}) produced no executable commands.`
      );
    }

    // Resolve shared_steps references BEFORE applying parameters
    const { SharedStepResolverService } = await import('../shared-steps/shared-step-resolver.service');
    const { commands: resolvedCommands, warnings } =
      await SharedStepResolverService.resolveCommands(commands, intentCase.project_id);

    if (warnings.length > 0) {
      logger.warn('[REGRESSION_RUN] Shared step resolution warnings', {
        intentTestCaseId: intentCase.id,
        warnings,
      });
    }

    // Apply parameters AFTER resolution (so parent parameters apply to all expanded commands)
    commands = this.applyParameters(resolvedCommands, parameters);

    // Build request
    return {
      url: targetUrl,
      projectId: intentCase.project_id,
      userId,
      browsers: browserOverride ? [browserOverride] : (sourceTest?.browsers || ['chrome']),
      intelligentMode: false, // Background Replay: deterministic step-by-step execution with self-healing
      testGoal: intentCase.description || intentCase.name,
      commands, // Pre-generated commands
      options: sourceTest?.options || {},
      metadata: {
        intentTestCaseId: intentCase.id,
        intentTestCaseName: intentCase.name,
        source: 'intent_test_case',
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MOBILE TEST DISPATCH
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Dispatch a mobile test case to the mobile runner queue.
   * Mirrors the pattern from ci.controller.ts and preview.controller.ts.
   *
   * Creates a `tests` DB record + queues a `MobileTestJobData` job.
   * The existing test-completion-handler will track completion.
   */
  private static async dispatchMobileTest(
    intentCase: any,
    userId: string,
    trigger: string,
  ): Promise<{ testId: string }> {
    // 1. Resolve platform and browser
    const PLATFORM_MAP: Record<string, MobilePlatform> = {
      mobile_ios: 'ios',
      mobile_flutter: 'flutter',
    };
    const platform: MobilePlatform = PLATFORM_MAP[intentCase.platform] ?? 'android';

    const BROWSER_MAP: Record<string, 'mobile-android' | 'mobile-ios' | 'mobile-flutter'> = {
      mobile_ios: 'mobile-ios',
      mobile_flutter: 'mobile-flutter',
    };
    const browser = BROWSER_MAP[intentCase.platform] ?? 'mobile-android';

    // 2. Fetch project settings for mobile app metadata
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('workspace_id, settings')
      .eq('id', intentCase.project_id)
      .single();

    const mobileApp = (project?.settings as any)?.mobileApp;

    // 3. Extract intent steps from steps_json
    const intentSteps = (intentCase.steps_json || []).map((step: any, index: number) => ({
      id: step.id || `step_${index}`,
      type: step.type || 'click',
      description: step.description || `Step ${index + 1}`,
      value: step.value,
      assertionText: step.assertionText,
      bindingHints: step.bindingHints,
      options: step.options,
      isAutoInjected: step.isAutoInjected,
      expectedOutcome: step.expectedOutcome,
    }));

    if (intentSteps.length === 0) {
      throw new ValidationError(
        `Mobile test case "${intentCase.name}" has no steps (steps_json is empty)`,
      );
    }

    // 4. Create test record in DB (same pattern as ci.controller.ts)
    const testId = uuidv4();
    await dbAdminService.createTest({
      id: testId,
      url: `mobile://${platform}`,
      project_id: intentCase.project_id,
      user_id: userId,
      status: 'pending',
      browsers: [browser as any],
      options: {
        mode: 'lite',
        platform,
        trigger,
        appPackage: mobileApp?.packageName,
      },
      intelligent_mode: false,
      test_goal: `Regression: ${intentCase.name} (${platform})`,
      commands: [],
    });

    // 5. Build and queue mobile job
    const jobData: MobileTestJobData = {
      testId,
      userId,
      workspaceId: project?.workspace_id || '',
      projectId: intentCase.project_id,
      platform,
      browser,
      intentSteps,
      runnerUrl: env.MOBILE_RUNNER_URL,
      runnerApiKey: env.MOBILE_RUNNER_API_KEY,
      appStoragePath: mobileApp?.storagePath,
      appOriginalName: mobileApp?.originalName,
      appPackage: mobileApp?.packageName,
      testCaseId: intentCase.id,
      testCaseName: intentCase.name,
      metadata: buildMetadataFromTestCase(intentCase),
    };

    await QueueManager.addMobileTestRunJob(jobData);

    logger.info('[REGRESSION_RUN] Mobile test dispatched', {
      testId,
      platform,
      testCaseId: intentCase.id,
      testCaseName: intentCase.name,
      stepsCount: intentSteps.length,
    });

    return { testId };
  }

  /**
   * Apply parameters to commands/steps
   * Replaces {{paramName}} placeholders with actual values
   *
   * @param items - Commands or steps with parameter placeholders
   * @param parameters - Runtime parameter values
   * @returns Commands with substituted values
   */
  private static applyParameters(
    items: any[],
    parameters: Record<string, any>
  ): any[] {
    return items.map(item => {
      const newItem = { ...item };

      // Replace parameter placeholders in value
      if (newItem.value && typeof newItem.value === 'string') {
        newItem.value = newItem.value.replace(/\{\{(.+?)\}\}/g, (match: string, paramName: string) => {
          if (parameters[paramName] !== undefined) {
            return String(parameters[paramName]);
          }
          logger.warn('[REGRESSION_RUN] Missing parameter', { paramName });
          return match; // Keep placeholder if parameter not provided
        });
      }

      return newItem;
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
      const { error } = await supabaseAdmin
        .from('regression_runs')
        .update({
          status,
          summary: summary || null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);

      if (error) {
        throw new Error(`Failed to update run status: ${error.message}`);
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
    limit: number = DEFAULT_LIST_LIMIT
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    // Now fetches from intent_test_cases (unified table)
    const { data: cases, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      throw new Error(`Failed to list intent test cases: ${error.message}`);
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

    const { data: runs, error } = await supabaseAdmin
      .from('regression_runs')
      .select('*, regression_plans(name)')
      .eq('project_id', projectId)
      .order('started_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      throw new Error(`Failed to list runs: ${error.message}`);
    }

    if (!runs || runs.length === 0) return [];

    // Batch fetch stats for all runs
    const runIds = runs.map((r: any) => r.id);
    const { data: allExecs } = await supabaseAdmin
      .from('test_executions')
      .select('run_id, status, duration_ms')
      .in('run_id', runIds);

    // Group by run_id and compute stats
    const statsMap = new Map<string, any>();
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
    }

    return runs.map((run: any) => {
      const runStats = statsMap.get(run.id) || { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, running: 0, cancelled: 0, passRate: 0 };
      const durationMs = run.started_at && run.completed_at
        ? Math.max(new Date(run.completed_at).getTime() - new Date(run.started_at).getTime(), 0)
        : null;
      const bugsFound = run.summary?.bugs_count ?? run.summary?.bugsFound ?? 0;

      // Normalize 'completed' → 'passed' for frontend compatibility
      const normalizedStatus = run.status === 'completed' ? 'passed' : run.status;

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
    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('user_id, workspace_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id === userId) return;

    const workspaceId = (project as any).workspace_id as string | undefined;
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
  }): Promise<RunResult> {
    const { planId, userId, trigger, parameters = {} } = params;

    try {
      logger.info('[REGRESSION_RUN] Running plan', { planId, userId, trigger });

      // 1. Verify plan access and expand to test cases
      const plan = await RegressionPlanService.getById(planId, userId);
      if (!plan) {
        throw new NotFoundError('Regression plan', planId);
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

      // 1b. Batch-fetch depends_on for UI test cases
      const uiCaseIds = expandedCases.filter((tc) => tc.testType === 'ui').map((tc) => tc.testCaseId);
      const depMap = new Map<string, string[]>();
      if (uiCaseIds.length > 0) {
        const { data: depRows } = await supabaseAdmin
          .from('intent_test_cases')
          .select('id, depends_on')
          .in('id', uiCaseIds);
        for (const row of depRows || []) {
          depMap.set(row.id, row.depends_on || []);
        }
      }

      // Filter depends_on to only include test cases that are part of this run
      const runTestCaseIds = new Set(expandedCases.map((tc) => tc.testCaseId));

      const executableCases: ExecutableTestCase[] = expandedCases.map((tc) => {
        const rawDeps = depMap.get(tc.testCaseId) || [];
        const validDeps = rawDeps.filter((depId) => runTestCaseIds.has(depId));
        if (validDeps.length !== rawDeps.length) {
          logger.warn('[REGRESSION_RUN] Filtered out-of-run dependencies', {
            testCaseId: tc.testCaseId,
            originalDeps: rawDeps,
            filteredDeps: validDeps,
          });
        }
        return {
          testCaseId: tc.testCaseId,
          testType: tc.testType,
          moduleId: tc.moduleId,
          flowId: tc.flowId,
          dependsOn: validDeps,
          ...(tc.isNegative && { isNegative: true }),
          ...(tc.platform && { platform: tc.platform }),
        };
      });

      // 1c. Credit check — verify user has enough credits for all test cases
      await this.checkCreditBalance(userId, executableCases, 'regression_plan');

      // 2. Create regression run record with plan_id (initially 'pending' until executions are created)
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          plan_id: planId,
          project_id: plan.projectId,
          user_id: userId,
          trigger,
          status: 'pending',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create plan run: ${runError?.message}`);
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
          }))
        );
      } catch (batchError) {
        // Rollback: mark run as failed since executions couldn't be created
        logger.error('[REGRESSION_RUN] Failed to create executions, marking run as failed', {
          runId: run.id,
          error: batchError,
        });
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
        throw batchError;
      }

      // Transition from 'pending' to 'running' now that executions exist
      await supabaseAdmin
        .from('regression_runs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', run.id);

      // 4. Read runtime config from plan's automation_config
      const browserOverride = plan.automationConfig?.runtime?.browser;

      // 5. Start executing tests (async, don't wait)
      this.executeTestCasesAsync(
        run.id,
        executableCases,
        userId,
        trigger,
        parameters,
        browserOverride
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
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
      const { data: mod, error: modError } = await supabaseAdmin
        .from('test_modules')
        .select('*, projects!inner(user_id), test_platforms!inner(platform_key)')
        .eq('id', moduleId)
        .single();

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
      const { data: flows } = await supabaseAdmin
        .from('test_flows')
        .select('id')
        .eq('module_id', moduleId);

      const flowIds = (flows || []).map((f: any) => f.id);

      // 3. Get all test cases in flows
      const testCases = await this.getTestCasesInFlows(flowIds);

      if (testCases.length === 0) {
        throw new ValidationError('Module has no test cases');
      }

      // 4. Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_module');

      // 5. Create regression run record
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          module_id: moduleId,
          project_id: mod.project_id,
          user_id: userId,
          trigger,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create module run: ${runError?.message}`);
      }
      createdRunId = run.id;

      // 6. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 7. Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        parameters
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
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
          await supabaseAdmin
            .from('regression_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString() })
            .eq('id', createdRunId);
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
      const { data: flow, error: flowError } = await supabaseAdmin
        .from('test_flows')
        .select('*, test_modules!inner(project_id, projects!inner(user_id))')
        .eq('id', flowId)
        .single();

      if (flowError || !flow) {
        throw new NotFoundError('Flow', flowId);
      }

      const module = flow.test_modules as any;
      if (module?.projects?.user_id !== userId) {
        throw new ValidationError('Access denied to this flow');
      }

      // 2. Get test cases in flow
      const testCases = await this.getTestCasesInFlows([flowId]);

      if (testCases.length === 0) {
        throw new ValidationError('Flow has no test cases');
      }

      // 2b. Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_flow');

      // 3. Create regression run record
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          flow_id: flowId,
          module_id: flow.module_id,
          project_id: module.project_id,
          user_id: userId,
          trigger,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create flow run: ${runError?.message}`);
      }
      createdRunId = run.id;

      // 4. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 5. Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        parameters
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await supabaseAdmin
            .from('regression_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString() })
            .eq('id', createdRunId);
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

      // Get UI test cases with tag from intent_test_cases (unified table)
      const { data: uiCases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id, depends_on, platform')
        .eq('project_id', projectId)
        .contains('tags', [tag]);

      // Get API test cases with tag (scoped to project via environments/endpoints)
      const apiCases = await this.getApiTestConfigsByProjectAndTag(projectId, userId, tag);

      const testCases: ExecutableTestCase[] = [
        ...(uiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: tc.depends_on || [],
          platform: tc.platform || undefined,
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
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          project_id: projectId,
          user_id: userId,
          trigger,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create tag run: ${runError?.message}`);
      }
      createdRunId = run.id;

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        {}
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await supabaseAdmin
            .from('regression_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString() })
            .eq('id', createdRunId);
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
      const { data: uiCases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id, depends_on, platform')
        .eq('project_id', projectId)
        .eq('priority', priority);

      // Get API test cases with priority (scoped to project via environments/endpoints)
      const apiCases = await this.getApiTestConfigsByProjectAndPriority(projectId, userId, priority);

      const testCases: ExecutableTestCase[] = [
        ...(uiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: tc.depends_on || [],
          platform: tc.platform || undefined,
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
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          project_id: projectId,
          user_id: userId,
          trigger,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create priority run: ${runError?.message}`);
      }
      createdRunId = run.id;

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        {}
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await supabaseAdmin
          .from('regression_runs')
          .update({ status: 'failed', completed_at: new Date().toISOString() })
          .eq('id', run.id);
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await supabaseAdmin
            .from('regression_runs')
            .update({ status: 'failed', completed_at: new Date().toISOString() })
            .eq('id', createdRunId);
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run by priority', { error, projectId, priority });
      throw error;
    }
  }

  // =========================================================================
  // HELPER METHODS FOR NEW HIERARCHY
  // =========================================================================

  /**
   * Get all test cases in flows with hierarchy info
   */
  private static async getTestCasesInFlows(
    flowIds: string[]
  ): Promise<ExecutableTestCase[]> {
    if (flowIds.length === 0) {
      return [];
    }

    // Map flow -> module (direct, no suite intermediary)
    const { data: flows, error: flowsError } = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id')
      .in('id', flowIds);

    if (flowsError) {
      throw new Error(`Failed to load flows: ${flowsError.message}`);
    }

    const flowToModule = new Map<string, string | undefined>();
    for (const f of flows || []) {
      if (f?.id) {
        flowToModule.set(f.id, f.module_id || undefined);
      }
    }

    const testCases: ExecutableTestCase[] = [];

    // UI test cases from intent_test_cases (unified table)
    const { data: uiCases, error: uiError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, flow_id, depends_on, platform')
      .in('flow_id', flowIds);

    if (uiError) {
      throw new Error(`Failed to load UI test cases: ${uiError.message}`);
    }

    for (const tc of uiCases || []) {
      const flowId = tc.flow_id || undefined;
      const moduleId = flowId ? flowToModule.get(flowId) : undefined;
      testCases.push({
        testCaseId: tc.id,
        testType: 'ui',
        moduleId,
        flowId,
        dependsOn: tc.depends_on || [],
        platform: tc.platform || undefined,
      });
    }

    // API test configs (no depends_on support for API tests)
    const { data: apiCases, error: apiError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, flow_id')
      .in('flow_id', flowIds);

    if (apiError) {
      throw new Error(`Failed to load API test cases: ${apiError.message}`);
    }

    for (const tc of apiCases || []) {
      const flowId = tc.flow_id || undefined;
      const moduleId = flowId ? flowToModule.get(flowId) : undefined;
      testCases.push({
        testCaseId: tc.id,
        testType: 'api',
        moduleId,
        flowId,
        dependsOn: [],
      });
    }

    return testCases;
  }

  /**
   * Execute test cases asynchronously
   * Updates execution records as tests complete
   */
  private static async executeTestCasesAsync(
    runId: string,
    testCases: ExecutableTestCase[],
    userId: string,
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook',
    parameters: Record<string, any>,
    browserOverride?: string
  ): Promise<void> {
    const startedAt = new Date().toISOString();

    // Resolve recipients + plan/project for progress payload once (so git-trigger progress is visible to workspace members, not only owner)
    let planIdForWs: string | null = null;
    let projectIdForWs: string | null = null;
    let progressRecipients: string[] = [userId];
    try {
      const { data: runRow } = await supabaseAdmin
        .from('regression_runs')
        .select('plan_id, project_id, user_id')
        .eq('id', runId)
        .maybeSingle();
      planIdForWs = (runRow?.plan_id as string | null) ?? null;
      projectIdForWs = (runRow?.project_id as string | null) ?? null;

      if (projectIdForWs) {
        progressRecipients = await getProjectWorkspaceMemberIds(projectIdForWs, userId);
      }
    } catch {
      // non-fatal: fall back to owner-only
    }

    // Preload executions to avoid per-test lookups
    const { data: executions, error: execError } = await supabaseAdmin
      .from('test_executions')
      .select('id, test_case_id, test_type')
      .eq('run_id', runId);

    if (execError) {
      logger.error('[REGRESSION_RUN] Failed to preload executions', { error: execError, runId });
      return;
    }

    const execByKey = new Map<string, string>();
    for (const e of executions || []) {
      execByKey.set(`${e.test_type}:${e.test_case_id}`, e.id);
    }

    // Topological sort by depends_on
    const { levels, hasCycle, cycleNodes } = topologicalSort(testCases);

    if (hasCycle) {
      logger.error('[REGRESSION_RUN] Dependency cycle detected in run', { runId, cycleNodes });
      // Mark cycle nodes as failed
      for (const nodeId of cycleNodes || []) {
        const tc = testCases.find((t) => t.testCaseId === nodeId);
        if (tc) {
          const execId = execByKey.get(`${tc.testType}:${tc.testCaseId}`);
          if (execId) {
            await ExecutionService.updateStatus({
              id: execId,
              status: 'failed',
              errorMessage: 'Circular dependency detected. Cannot execute.',
            });
          }
        }
      }
    }

    // Level-based execution with dependency tracking
    const failedOrSkippedIds = new Set<string>();
    const uiTestIds: string[] = [];
    let apiPassed = 0;
    let apiFailed = 0;
    let skippedCount = 0;
    let completedCount = 0;
    const totalTests = testCases.length;
    const totalLevels = levels.length;

    // Helper to emit regression progress (non-fatal)
    const emitProgress = (
      status: 'started' | 'level_started' | 'test_started' | 'test_completed' | 'level_completed' | 'completed' | 'failed',
      message: string,
      extra?: { currentLevel?: number; currentTestName?: string; errorCode?: string }
    ) => {
      try {
        const progress = totalTests > 0 ? Math.round((completedCount / totalTests) * 100) : 0;
        const payload: RegressionRunProgressPayload = {
          runId,
          userId,
          planId: planIdForWs,
          projectId: projectIdForWs,
          trigger,
          status,
          progress,
          message,
          errorCode: extra?.errorCode,
          details: {
            totalTests,
            completedTests: completedCount,
            currentLevel: extra?.currentLevel,
            totalLevels,
            currentTestName: extra?.currentTestName,
            passed: apiPassed,
            failed: apiFailed,
            skipped: skippedCount,
          },
          timestamp: new Date().toISOString(),
        };

        for (const recipientId of progressRecipients) {
          webSocketService.emitRegressionRunProgress(recipientId, payload);
        }
      } catch { /* non-fatal */ }
    };

    emitProgress('started', `Regression run started: ${totalTests} tests in ${totalLevels} levels`);

    let creditExhausted = false;

    for (let levelIdx = 0; levelIdx < levels.length && !creditExhausted; levelIdx++) {
      const level = levels[levelIdx];
      const uiWaiters: Array<{ testCaseId: string; execId: string; promise: Promise<string> }> = [];

      emitProgress('level_started', `Starting level ${levelIdx + 1}/${totalLevels} (${level.length} tests)`, {
        currentLevel: levelIdx + 1,
      });

      for (const testCase of level) {
        const execId = execByKey.get(`${testCase.testType}:${testCase.testCaseId}`);

        // Check if any prerequisite failed or was skipped
        const failedPrereqs = (testCase.dependsOn || []).filter((d) => failedOrSkippedIds.has(d));
        if (failedPrereqs.length > 0) {
          failedOrSkippedIds.add(testCase.testCaseId);
          skippedCount++;
          if (execId) {
            await ExecutionService.updateStatus({
              id: execId,
              status: 'skipped',
              errorMessage: `Skipped: prerequisite test(s) failed or were skipped [${failedPrereqs.join(', ')}]`,
            });
          }
          logger.info('[REGRESSION_RUN] Skipped test due to dependency failure', {
            runId,
            testCaseId: testCase.testCaseId,
            failedPrereqs,
          });
          continue;
        }

        // Execute test (existing logic preserved)
        try {
          // For non-UI tests, mark execution as running before dispatch.
          // For UI tests, we defer this to after runTest() so we can write
          // result.testId atomically — prevents a race where the BullMQ job
          // completes before result.testId is persisted.
          if (execId && testCase.testType !== 'ui') {
            await ExecutionService.updateStatus({ id: execId, status: 'running' });
          }

          emitProgress('test_started', `Running ${testCase.testType.toUpperCase()} test (${completedCount + 1}/${totalTests})`, {
            currentLevel: levelIdx + 1,
            currentTestName: testCase.testCaseId,
          });

          if (testCase.testType === 'ui') {
            // Run UI test without creating nested regression_runs
            const savedCase = await this.getSavedTestCase(testCase.testCaseId, userId);

            // Route: mobile tests → mobile runner queue, web tests → Playwright queue
            const isMobile = savedCase.platform?.startsWith('mobile_');
            let testId: string;

            if (isMobile) {
              const mobileResult = await this.dispatchMobileTest(savedCase, userId, trigger);
              testId = mobileResult.testId;
            } else {
              const testRequest = await this.buildTestRequest(savedCase, userId, parameters, browserOverride);
              const testResult = await ManualTestService.runTest(testRequest);

              if (!testResult.success || !testResult.data?.id) {
                throw new Error('Failed to start UI test execution');
              }
              testId = testResult.data.id;
            }

            uiTestIds.push(testId);

            if (execId) {
              await ExecutionService.updateStatus({
                id: execId,
                status: 'running',
                result: {
                  type: 'ui',
                  testId,
                  trigger,
                  startedAt,
                },
              });

              // Register waiter for dependency-aware ordering
              const waitPromise = executionCompletionEmitter.waitForCompletion(execId);
              uiWaiters.push({ testCaseId: testCase.testCaseId, execId, promise: waitPromise });
            }
          } else {
            // Deduct API test credits upfront (flat cost per API test)
            const apiCreditCost = TokenCalculatorService.getTestCreditCost('api');
            const apiDeduction = await CreditCostTrackerService.deductCreditsForTest({
              userId,
              testType: 'api',
              credits: apiCreditCost,
              costUSD: 0,
              testId: `api_${testCase.testCaseId}_${Date.now()}`,
              description: `API test: ${testCase.testCaseId}`,
            });

            if (!apiDeduction.success) {
              throw new Error('Insufficient credits for API test');
            }

            // Run API test via existing configuration-based executor
            const apiExecution = await ApiConfigService.executeWithConfig(userId, {
              test_config_id: testCase.testCaseId,
            } as any);

            const passed = !!apiExecution?.success;
            if (passed) {
              apiPassed++;
            } else {
              apiFailed++;
              failedOrSkippedIds.add(testCase.testCaseId);
            }

            if (execId) {
              await ExecutionService.updateStatus({
                id: execId,
                status: passed ? 'passed' : 'failed',
                result: {
                  type: 'api',
                  apiExecutionId: apiExecution?.id,
                  statusCode: apiExecution?.status_code,
                  durationMs: apiExecution?.duration_ms,
                },
                errorMessage: passed ? undefined : apiExecution?.error_message || 'API test failed',
              });
            }

            completedCount++;
            emitProgress('test_completed', `API test ${passed ? 'passed' : 'failed'} (${completedCount}/${totalTests})`, {
              currentLevel: levelIdx + 1,
            });
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const isCreditError = errMsg.toLowerCase().includes('insufficient credits');

          logger.error('[REGRESSION_RUN] Failed to execute test case', {
            runId,
            testCaseId: testCase.testCaseId,
            testType: testCase.testType,
            errorMessage: errMsg,
            errorCode: (error as any)?.code,
            isCreditError,
            error,
          });

          failedOrSkippedIds.add(testCase.testCaseId);

          if (execId) {
            try {
              await ExecutionService.updateStatus({
                id: execId,
                status: 'failed',
                errorMessage: errMsg,
              });
            } catch (statusError) {
              logger.error('[REGRESSION_RUN] Failed to update execution status', {
                execId,
                statusError: statusError instanceof Error ? statusError.message : String(statusError),
              });
            }
          }

          // Emit credit-specific progress event so frontend can show top-up prompt
          if (isCreditError) {
            creditExhausted = true;
            emitProgress('failed', 'Regression run stopped: insufficient credits. Please top up to continue.', {
              currentLevel: levelIdx + 1,
              errorCode: 'INSUFFICIENT_CREDITS',
            });
            break;
          }
        }
      }

      // Wait for all UI tests in this level to complete before moving to next level
      if (uiWaiters.length > 0) {
        logger.info('[REGRESSION_RUN] Waiting for UI tests in level to complete', {
          runId,
          level: levelIdx,
          uiTestCount: uiWaiters.length,
        });

        const results = await Promise.all(
          uiWaiters.map(async (w) => {
            const status = await w.promise;
            return { testCaseId: w.testCaseId, status };
          })
        );

        for (const result of results) {
          completedCount++;
          if (result.status !== 'passed') {
            failedOrSkippedIds.add(result.testCaseId);
          }
          emitProgress('test_completed', `UI test ${result.status} (${completedCount}/${totalTests})`, {
            currentLevel: levelIdx + 1,
          });
        }
      }

      emitProgress('level_completed', `Level ${levelIdx + 1}/${totalLevels} completed`, {
        currentLevel: levelIdx + 1,
      });
    }

    // If credit exhaustion stopped the run, mark remaining tests as skipped and finalize
    if (creditExhausted) {
      // Mark all non-started executions as skipped
      for (const tc of testCases) {
        if (!failedOrSkippedIds.has(tc.testCaseId)) {
          const execId = execByKey.get(`${tc.testType}:${tc.testCaseId}`);
          if (execId) {
            await ExecutionService.updateStatus({
              id: execId,
              status: 'skipped',
              errorMessage: 'Skipped: regression run stopped due to insufficient credits',
            }).catch(() => {});
          }
          skippedCount++;
        }
      }

      await supabaseAdmin
        .from('regression_runs')
        .update({
          status: 'failed',
          test_ids: uiTestIds.length > 0 ? uiTestIds : undefined,
          summary: {
            total: testCases.length,
            api_passed: apiPassed,
            api_failed: apiFailed,
            skipped: skippedCount,
            creditExhausted: true,
            started_at: startedAt,
            completed_at: new Date().toISOString(),
          },
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId);

      return;
    }

    // Link UI test IDs to regression_runs so existing completion pipeline can update the run
    if (uiTestIds.length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({
          test_ids: uiTestIds,
          summary: {
            total: testCases.length,
            ui_started: uiTestIds.length,
            api_passed: apiPassed,
            api_failed: apiFailed,
            skipped: skippedCount,
            started_at: startedAt,
          },
        })
        .eq('id', runId);

      if (updateError) {
        logger.warn('[REGRESSION_RUN] Failed to update run with UI test_ids', {
          error: updateError,
          runId,
        });
      }

      // Do not finalize run here — it will be recomputed on UI test completion
      // Emit progress so frontend knows all tests have been dispatched (UI tests still running)
      emitProgress('started', `All ${uiTestIds.length} UI tests dispatched, waiting for completion...`);
      return;
    }

    // If only API tests exist, finalize run immediately.
    // NOTE: regression_runs.status uses 'completed' (not 'passed') for success — match DB convention.
    const hasFails = apiFailed > 0;
    const persistedStatus = hasFails ? 'failed' : 'completed';
    await supabaseAdmin
      .from('regression_runs')
      .update({
        status: persistedStatus,
        summary: {
          total: testCases.length,
          passed: apiPassed,
          failed: apiFailed,
          api_passed: apiPassed,
          api_failed: apiFailed,
          skipped: skippedCount,
          completed_at: new Date().toISOString(),
        },
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);

    emitProgress(
      persistedStatus === 'completed' ? 'completed' : 'failed',
      `Regression run ${persistedStatus}: ${apiPassed} passed, ${apiFailed} failed, ${skippedCount} skipped`
    );
  }

  /**
   * Get API test configs filtered by project and tag (via api_environments/api_endpoints).
   */
  private static async getApiTestConfigsByProjectAndTag(
    projectId: string,
    userId: string,
    tag: string
  ): Promise<Array<{ id: string; flow_id?: string }>> {
    const { data: envs, error: envError } = await supabaseAdmin
      .from('api_environments')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (envError) {
      throw new Error(`Failed to load API environments: ${envError.message}`);
    }

    const envIds = (envs || []).map((e: any) => e.id);
    if (envIds.length === 0) return [];

    const { data: endpoints, error: epError } = await supabaseAdmin
      .from('api_endpoints')
      .select('id')
      .in('environment_id', envIds);

    if (epError) {
      throw new Error(`Failed to load API endpoints: ${epError.message}`);
    }

    const endpointIds = (endpoints || []).map((e: any) => e.id);
    if (endpointIds.length === 0) return [];

    const { data: configs, error: cfgError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, flow_id')
      .eq('user_id', userId)
      .in('endpoint_id', endpointIds)
      .contains('tags', [tag]);

    if (cfgError) {
      throw new Error(`Failed to load API test configs: ${cfgError.message}`);
    }

    return (configs || []).map((c: any) => ({ id: c.id, flow_id: c.flow_id || undefined }));
  }

  /**
   * Get API test configs filtered by project and priority (via api_environments/api_endpoints).
   */
  private static async getApiTestConfigsByProjectAndPriority(
    projectId: string,
    userId: string,
    priority: Priority
  ): Promise<Array<{ id: string; flow_id?: string }>> {
    const { data: envs, error: envError } = await supabaseAdmin
      .from('api_environments')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (envError) {
      throw new Error(`Failed to load API environments: ${envError.message}`);
    }

    const envIds = (envs || []).map((e: any) => e.id);
    if (envIds.length === 0) return [];

    const { data: endpoints, error: epError } = await supabaseAdmin
      .from('api_endpoints')
      .select('id')
      .in('environment_id', envIds);

    if (epError) {
      throw new Error(`Failed to load API endpoints: ${epError.message}`);
    }

    const endpointIds = (endpoints || []).map((e: any) => e.id);
    if (endpointIds.length === 0) return [];

    const { data: configs, error: cfgError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, flow_id')
      .eq('user_id', userId)
      .in('endpoint_id', endpointIds)
      .eq('priority', priority);

    if (cfgError) {
      throw new Error(`Failed to load API test configs: ${cfgError.message}`);
    }

    return (configs || []).map((c: any) => ({ id: c.id, flow_id: c.flow_id || undefined }));
  }

  // =========================================================================
  // RUN REPORT METHODS
  // =========================================================================

  /**
   * Get a run with ownership check, including plan name
   */
  static async getRunWithOwnership(
    runId: string,
    userId: string,
  ): Promise<any | null> {
    const { data, error } = await supabaseAdmin
      .from('regression_runs')
      .select('*, regression_plans(name)')
      .eq('id', runId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      logger.error('[REGRESSION_RUN] Failed to get run', { error, runId });
      return null;
    }
    return data;
  }

  /**
   * Fetch a run by its public share token (no ownership check)
   */
  static async getRunByShareToken(shareToken: string): Promise<any | null> {
    const { data, error } = await supabaseAdmin
      .from('regression_runs')
      .select('*, regression_plans(name)')
      .eq('share_token', shareToken)
      .maybeSingle();

    if (error) {
      logger.error('[REGRESSION_RUN] Failed to get run by share token', { error, shareToken });
      return null;
    }
    return data;
  }

  /**
   * Batch fetch test case names by IDs
   */
  static async batchGetTestCaseNames(
    testCaseIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!testCaseIds.length) return map;

    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .in('id', testCaseIds);

    if (error) {
      logger.warn('[REGRESSION_RUN] Failed to fetch test case names', { error, count: testCaseIds.length });
    }

    for (const row of data || []) {
      map.set(row.id, row.name);
    }
    return map;
  }

  /**
   * Batch fetch test results (artifacts + ai_summary) by test IDs.
   * When a test has multiple results (one per browser), picks the first one
   * with ai_summary, or falls back to the first result.
   */
  static async batchGetTestResults(
    testIds: string[],
  ): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    if (!testIds.length) return map;

    const { data, error } = await supabaseAdmin
      .from('test_results')
      .select('test_id, video_url, trace_url, screenshot, logs, network_logs, errors, ai_summary, quality_checks')
      .in('test_id', testIds)
      .order('created_at', { ascending: false });

    if (error) {
      logger.warn('[REGRESSION_RUN] Failed to fetch test results', { error, count: testIds.length });
    }

    for (const row of data || []) {
      // Prefer the result that has ai_summary
      const existing = map.get(row.test_id);
      if (!existing || (!existing.ai_summary && row.ai_summary)) {
        map.set(row.test_id, row);
      }
    }
    return map;
  }

  /**
   * Batch fetch executed steps from tests table
   */
  static async batchGetExecutedSteps(
    testIds: string[],
  ): Promise<Map<string, any[]>> {
    const map = new Map<string, any[]>();
    if (!testIds.length) return map;

    const { data, error } = await supabaseAdmin
      .from('tests')
      .select('id, executed_steps')
      .in('id', testIds);

    if (error) {
      logger.warn('[REGRESSION_RUN] Failed to fetch executed steps', { error, count: testIds.length });
    }

    for (const row of data || []) {
      map.set(row.id, row.executed_steps || []);
    }
    return map;
  }

  /**
   * Build a full aggregated run report (authenticated — checks ownership)
   */
  static async buildFullReport(
    runId: string,
    userId: string,
  ): Promise<RunReport | null> {
    const run = await this.getRunWithOwnership(runId, userId);
    if (!run) return null;
    return this.assembleReport(run);
  }

  /**
   * Build a full report for a publicly shared run (no ownership check).
   */
  static async buildPublicReport(shareToken: string): Promise<RunReport | null> {
    const run = await this.getRunByShareToken(shareToken);
    if (!run) return null;
    return this.assembleReport(run);
  }

  /**
   * Shared report assembly logic used by both buildFullReport and buildPublicReport.
   * Fetches executions, test results, steps, bugs, artifacts and assembles RunReport.
   */
  private static async assembleReport(run: any): Promise<RunReport> {
    // Phase 1: Parallel fetch stats + executions
    const [stats, executions] = await Promise.all([
      ExecutionService.getStats(run.id),
      ExecutionService.getByRunId(run.id),
    ]);

    const planName = (run.regression_plans as any)?.name || null;

    // Get test case names
    const testCaseIds = [...new Set(executions.map((e) => e.testCaseId))];
    const namesMap = await this.batchGetTestCaseNames(testCaseIds);

    // Extract testIds from UI executions (stored in execution.result.testId)
    const testIds: string[] = [];
    for (const exec of executions) {
      const testId = exec.result?.testId;
      if (testId && exec.testType === 'ui') {
        testIds.push(testId);
      }
    }

    // Batch-fetch negativeMeta for negative test cases
    const negativeTestCaseIds = executions.filter((e) => e.isNegative).map((e) => e.testCaseId);
    const negativeMetaMap = new Map<string, import('@/types/testing.types').NegativeMeta>();
    if (negativeTestCaseIds.length > 0) {
      const { data: negRows } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, negative_meta')
        .in('id', negativeTestCaseIds);
      for (const row of negRows || []) {
        if (row.negative_meta) {
          negativeMetaMap.set(row.id, row.negative_meta as import('@/types/testing.types').NegativeMeta);
        }
      }
    }

    // Phase 2: Parallel enrichment fetch
    const [testResultsMap, testReports, executedStepsMap] = await Promise.all([
      this.batchGetTestResults(testIds),
      TestReportGeneratorService.batchGetReportsByTestIds(testIds),
      this.batchGetExecutedSteps(testIds),
    ]);

    // Index reports by testId
    const reportsMap = new Map<string, any>();
    for (const report of testReports) {
      reportsMap.set(report.testId, report);
    }

    // Build executions, bugs, aggregated artifacts
    const reportExecutions: RunReportExecution[] = [];
    const allBugs: EnrichedBug[] = [];
    const allRecommendations = new Set<string>();
    let totalConfidence = 0;
    let confidenceCount = 0;

    const aggArtifacts: RunReportArtifactsSummary = {
      screenshots: [],
      bugScreenshots: [],
      consoleLogs: [],
      networkLogs: [],
    };

    const validSeverities = new Set(['critical', 'high', 'medium', 'low']);
    const validCategories = new Set(['functional', 'performance', 'accessibility', 'visual', 'security']);

    for (const exec of executions) {
      const testCaseName = namesMap.get(exec.testCaseId) || 'Unknown';
      const testId = exec.result?.testId;

      // Build steps from executed_steps
      const steps: RunReportStep[] = [];
      let execArtifacts: {
        videoUrl?: string;
        traceUrl?: string;
        screenshots: string[];
        bugScreenshots: string[];
        consoleLogs: string[];
        networkLogs: Array<{ method: string; url: string; status?: number; durationMs?: number }>;
        qualityChecks?: any;
      } = {
        videoUrl: undefined,
        traceUrl: undefined,
        screenshots: [],
        bugScreenshots: [],
        consoleLogs: [],
        networkLogs: [],
      };
      let bugsCount = 0;
      let execHealthChecks: ExecutionHealthChecks | undefined;

      if (testId && exec.testType === 'ui') {
        // Build steps
        const rawSteps = executedStepsMap.get(testId) || [];
        const completedSteps = rawSteps.filter((s: any) => s.type === 'step_completed');
        for (let i = 0; i < completedSteps.length; i++) {
          const step = completedSteps[i];
          const meta = step.data?.runtimeMeta;
          const success = step.data?.success !== false;
          steps.push({
            index: i + 1,
            description: step.data?.stepDescription || step.data?.step || `Step ${i + 1}`,
            status: success ? 'passed' : 'failed',
            durationMs: meta?.executionMs,
            error: !success ? {
              message: meta?.failureExplanation || meta?.failedReason || 'Step failed',
              failedReason: meta?.failedReason,
              screenshot: meta?.bugScreenshotUrl,
              rootCause: meta?.rootCause,
              networkVerdict: meta?.networkVerdict,
            } : undefined,
          });
        }

        // Build artifacts from test_results
        const testResult = testResultsMap.get(testId);
        if (testResult) {
          execArtifacts.videoUrl = testResult.video_url || undefined;
          execArtifacts.traceUrl = testResult.trace_url || undefined;
          if (testResult.screenshot) {
            const screenshots = Array.isArray(testResult.screenshot)
              ? testResult.screenshot
              : [testResult.screenshot];
            // Filter out base64 data — only include URLs
            execArtifacts.screenshots = screenshots.filter(
              (s: string) => typeof s === 'string' && !s.startsWith('data:'),
            );
          }
          if (testResult.logs) {
            execArtifacts.consoleLogs = Array.isArray(testResult.logs) ? testResult.logs : [];
          }
          if (testResult.network_logs && Array.isArray(testResult.network_logs)) {
            execArtifacts.networkLogs = testResult.network_logs.map((nl: any) => ({
              method: nl.method || '',
              url: nl.url || '',
              status: nl.status ?? undefined,
              durationMs: nl.responseTime || nl.durationMs,
            }));
          }

          // Extract quality checks from test_results
          if (testResult.quality_checks && typeof testResult.quality_checks === 'object') {
            const qc = testResult.quality_checks;
            execArtifacts.qualityChecks = {
              webVitals: qc.webVitals || undefined,
              accessibility: qc.accessibility || undefined,
              brokenResources: Array.isArray(qc.brokenResources) ? qc.brokenResources : undefined,
              slowAPIs: Array.isArray(qc.slowAPIs) ? qc.slowAPIs : undefined,
            };
          }

          // Aggregate health checks from existing test result data
          execHealthChecks = HealthCheckAggregatorService.aggregateFromTestResult(testResult);

          // Aggregate into run-level artifacts
          if (execArtifacts.videoUrl && !aggArtifacts.videoUrl) aggArtifacts.videoUrl = execArtifacts.videoUrl;
          if (execArtifacts.traceUrl && !aggArtifacts.traceUrl) aggArtifacts.traceUrl = execArtifacts.traceUrl;
          aggArtifacts.screenshots.push(...execArtifacts.screenshots);
          aggArtifacts.consoleLogs.push(...execArtifacts.consoleLogs);
          aggArtifacts.networkLogs.push(...execArtifacts.networkLogs);
        }

        // Extract bug screenshots from executed steps (stored in runtimeMeta.bugScreenshotUrl)
        for (const step of steps) {
          if (step.error?.screenshot && typeof step.error.screenshot === 'string') {
            execArtifacts.bugScreenshots.push(step.error.screenshot);
          }
        }
        aggArtifacts.bugScreenshots.push(...execArtifacts.bugScreenshots);

        // Aggregate quality checks at run level
        if (execArtifacts.qualityChecks) {
          if (!aggArtifacts.qualityChecks) {
            aggArtifacts.qualityChecks = { brokenResources: [], slowAPIs: [] };
          }
          const agg = aggArtifacts.qualityChecks;
          const ec = execArtifacts.qualityChecks;

          // Web vitals: keep the latest non-empty one
          if (ec.webVitals) agg.webVitals = ec.webVitals;

          // Accessibility: merge warnings arrays, sum totals
          if (ec.accessibility) {
            if (!agg.accessibility) {
              agg.accessibility = { warnings: [], totalWarnings: 0 };
            }
            agg.accessibility.warnings.push(...(ec.accessibility.warnings || []));
            agg.accessibility.totalWarnings += ec.accessibility.totalWarnings || 0;
          }

          // Broken resources / slow APIs: concatenate
          if (ec.brokenResources) {
            agg.brokenResources = [...(agg.brokenResources || []), ...ec.brokenResources];
          }
          if (ec.slowAPIs) {
            agg.slowAPIs = [...(agg.slowAPIs || []), ...ec.slowAPIs];
          }
        }

        // Extract bugs: prefer test_reports > ai_summary
        const report = reportsMap.get(testId);
        const testResultData = testResultsMap.get(testId);
        const rawBugSource =
          report?.analysis?.bugs ||
          testResultData?.ai_summary?.bugs ||
          [];
        const rawBugs: any[] = Array.isArray(rawBugSource) ? rawBugSource : [];

        for (let i = 0; i < rawBugs.length; i++) {
          const bug = rawBugs[i];
          if (!bug || typeof bug !== 'object') continue;
          allBugs.push({
            id: bug.id || `${exec.id}-bug-${i}`,
            title: bug.title || bug.message || bug.description || '',
            severity: validSeverities.has(bug.severity) ? bug.severity : 'medium',
            category: validCategories.has(bug.category) ? bug.category : 'functional',
            testCaseId: exec.testCaseId,
            testCaseName,
            executionId: exec.id,
            steps: Array.isArray(bug.steps) ? bug.steps : (Array.isArray(bug.stepsToReproduce) ? bug.stepsToReproduce : []),
            expected: bug.expectedResult || bug.expected || '',
            actual: bug.actualResult || bug.actual || '',
            selector: bug.domSelector || bug.selector,
            recommendation: bug.recommendation || '',
          });
        }
        bugsCount = rawBugs.length;

        // Collect recommendations
        const recsSource =
          report?.analysis?.recommendations ||
          testResultData?.ai_summary?.recommendations ||
          [];
        const recs: string[] = Array.isArray(recsSource) ? recsSource : [];
        for (const r of recs) {
          if (typeof r === 'string' && r.trim()) {
            allRecommendations.add(r);
          }
        }

        // Collect confidence
        const conf = report?.analysis?.confidence ?? testResultData?.ai_summary?.confidence;
        if (typeof conf === 'number') {
          totalConfidence += conf;
          confidenceCount++;
        }
      }

      // V14: Extract failure classification from AI summary
      const execAiSummary = testId ? (testResultsMap.get(testId)?.ai_summary) : null;
      const failureClassification = execAiSummary?.failureClassification || null;
      const rootCauseStep = execAiSummary?.rootCauseStep ?? null;

      reportExecutions.push({
        id: exec.id,
        testCaseId: exec.testCaseId,
        testCaseName,
        status: exec.status,
        durationMs: exec.durationMs || 0,
        browser: exec.browser || 'chrome',
        bugsCount,
        steps,
        artifacts: execArtifacts,
        ...(exec.isNegative && { isNegative: true }),
        ...(exec.isNegative && negativeMetaMap.has(exec.testCaseId) && { negativeMeta: negativeMetaMap.get(exec.testCaseId) }),
        ...(execHealthChecks && { healthChecks: execHealthChecks }),
        ...(failureClassification && { failureClassification }),
        ...(rootCauseStep !== null && { rootCauseStep }),
        ...(execAiSummary?.classificationEvidence?.length > 0 && {
          classificationEvidence: execAiSummary.classificationEvidence,
        }),
      });
    }

    // Build merged summary (stats + bugs breakdown)
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const bug of allBugs) {
      bySeverity[bug.severity] = (bySeverity[bug.severity] || 0) + 1;
      byCategory[bug.category] = (byCategory[bug.category] || 0) + 1;
    }
    // V14: Compute real flaky count and classification breakdown from AI analysis
    const byClassification: Record<string, number> = {};
    for (const re of reportExecutions) {
      if (re.failureClassification) {
        byClassification[re.failureClassification] = (byClassification[re.failureClassification] || 0) + 1;
      }
    }

    const summary: RunReportSummary = {
      total: stats.total,
      passed: stats.passed,
      failed: stats.failed,
      skipped: stats.skipped,
      flaky: byClassification['flaky'] || 0,
      totalBugs: allBugs.length,
      bySeverity,
      byCategory,
      byClassification,
    };

    // Compute duration (guard against negative if clocks are skewed)
    let durationMs: number | null = null;
    if (run.started_at && run.completed_at) {
      const diff = new Date(run.completed_at).getTime() - new Date(run.started_at).getTime();
      durationMs = diff > 0 ? diff : 0;
    }

    // Normalize 'completed' → 'passed' for frontend compatibility
    const normalizedStatus = run.status === 'completed' ? 'passed' : (run.status || null);

    // Build health summary from all execution health checks
    const healthSummary = HealthCheckAggregatorService.buildHealthSummary(
      reportExecutions.map((e) => e.healthChecks),
    );

    // Split executions into positive and negative
    const positiveExecutions = reportExecutions.filter((e) => !e.isNegative);
    const negativeExecs = reportExecutions.filter((e) => e.isNegative);

    let negativeSummary: NegativeSummary | undefined;
    if (negativeExecs.length > 0) {
      negativeSummary = {
        total: negativeExecs.length,
        passed: negativeExecs.filter((e) => e.status === 'passed').length,
        failed: negativeExecs.filter((e) => e.status === 'failed').length,
        skipped: negativeExecs.filter((e) => e.status === 'skipped').length,
      };
    }

    return {
      id: run.id,
      planId: run.plan_id || null,
      planName,
      status: normalizedStatus,
      trigger: run.trigger,
      startedAt: run.started_at,
      completedAt: run.completed_at || null,
      durationMs,
      aiConfidence: confidenceCount > 0 ? Math.round(totalConfidence / confidenceCount) : null,
      summary,
      executions: positiveExecutions,
      bugs: allBugs,
      recommendations: [...allRecommendations],
      artifactsSummary: aggArtifacts,
      healthSummary,
      ...(negativeSummary && { negativeSummary }),
      ...(negativeExecs.length > 0 && { negativeExecutions: negativeExecs }),
    };
  }
}

// ============================================================================
// WORKSPACE MEMBER RESOLUTION HELPER
// ============================================================================

/**
 * Resolve all active workspace member user IDs for a project.
 * Returns at least the given ownerId, plus all workspace members if the project belongs to a workspace.
 * Non-fatal: falls back to [ownerId] on any error.
 */
export async function getProjectWorkspaceMemberIds(projectId: string, ownerId: string): Promise<string[]> {
  try {
    const { data: projRow } = await supabaseAdmin
      .from('projects')
      .select('workspace_id')
      .eq('id', projectId)
      .maybeSingle();

    const workspaceId = (projRow as any)?.workspace_id as string | undefined;
    if (!workspaceId) return [ownerId];

    const { data: members } = await supabaseAdmin
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active');

    const ids = new Set<string>();
    ids.add(ownerId);
    for (const m of members || []) {
      const uid = (m as any)?.user_id as string | undefined;
      if (uid) ids.add(uid);
    }
    return Array.from(ids);
  } catch {
    return [ownerId];
  }
}
