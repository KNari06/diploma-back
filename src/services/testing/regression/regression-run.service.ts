import { supabaseAdmin } from '@/db/supabase';
import { ApiConfigService } from '@/services/api/api-config.service';
import { NotFoundError, ValidationError } from '@/types';
import type { Priority, RunResult } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { ExecutionService } from '../executions/execution.service';
import { RegressionPlanService } from '../plans/regression-plan.service';
import { ManualTestService } from '../ui/manualTest.service';

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
    trigger: 'manual' | 'chat' | 'scheduled';
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

      // 2. Create regression run record (now uses intent_test_case_id)
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          intent_test_case_id: intentTestCaseId,
          project_id: intentCase.project_id,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create regression run: ${runError?.message}`);
      }

      // 3. Build test request from intent case
      const testRequest = await this.buildTestRequest(intentCase, userId, parameters);

      // 4. Execute test using existing test service
      const testResult = await ManualTestService.runTest(testRequest);

      if (!testResult.success || !testResult.data?.id) {
        throw new Error('Failed to start test execution');
      }

      const testId = testResult.data.id;

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
    parameters: Record<string, any>
  ): Promise<any> {
    // Get source test for base configuration (optional - only for browsers/options)
    const { data: sourceTest } = await supabaseAdmin
      .from('tests')
      .select('browsers, options')
      .eq('id', intentCase.source_test_id)
      .maybeSingle();

    let commands: any[] = [];

    // Extract commands based on strategy
    if (intentCase.replay_strategy === 'commands' && intentCase.commands) {
      commands = intentCase.commands;
    } else if (intentCase.replay_strategy === 'graph_extract' && intentCase.graph_ref?.steps) {
      commands = intentCase.graph_ref.steps;
    } else {
      throw new ValidationError('Intent test case has no replayable data');
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

    // Validate URL exists (with fallback to start_url)
    const targetUrl = intentCase.url || intentCase.start_url;
    if (!targetUrl) {
      throw new ValidationError(
        'Intent test case has no URL. Please update the test case with a valid URL.'
      );
    }

    // Build request
    return {
      url: targetUrl, // Use url with fallback to start_url
      projectId: intentCase.project_id,
      userId,
      browsers: sourceTest?.browsers || ['chrome'],
      intelligentMode: true, // Use intelligent mode for regression cases
      testGoal: intentCase.description || intentCase.name,
      commands, // Pre-generated commands
      options: sourceTest?.options || {},
    };
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
    status: 'completed' | 'failed' | 'cancelled';
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
      .select('*')
      .eq('project_id', projectId)
      .order('started_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      throw new Error(`Failed to list runs: ${error.message}`);
    }

    return runs || [];
  }

  /**
   * Verify user has access to project
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
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id !== userId) {
      throw new ValidationError('Access denied to this project');
    }
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
    trigger: 'manual' | 'chat' | 'scheduled';
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
        throw new ValidationError('Plan has no test cases');
      }

      // 2. Create regression run record with plan_id
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          plan_id: planId,
          project_id: plan.projectId,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create plan run: ${runError?.message}`);
      }

      // 3. Create execution records for all test cases
      const executions = await ExecutionService.createBatch(
        run.id,
        expandedCases.map((tc) => ({
          testCaseId: tc.testCaseId,
          testType: tc.testType,
          moduleId: tc.moduleId,
          flowId: tc.flowId,
        }))
      );

      // 4. Start executing tests (async, don't wait)
      this.executeTestCasesAsync(
        run.id,
        expandedCases,
        userId,
        trigger,
        parameters
      ).catch((error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
      });

      logger.info('[REGRESSION_RUN] Plan execution started', {
        runId: run.id,
        planId,
        totalCases: expandedCases.length,
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: expandedCases.length,
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
    trigger: 'manual' | 'chat' | 'scheduled';
    parameters?: Record<string, any>;
  }): Promise<RunResult> {
    const { moduleId, userId, trigger, parameters = {} } = params;

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

      // 5. Create regression run record
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          module_id: moduleId,
          project_id: mod.project_id,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create module run: ${runError?.message}`);
      }

      // 6. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 7. Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases.map((tc) => ({
          testCaseId: tc.testCaseId,
          testType: tc.testType,
          moduleId: tc.moduleId,
          flowId: tc.flowId,
        })),
        userId,
        trigger,
        parameters
      ).catch((error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
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
    trigger: 'manual' | 'chat' | 'scheduled';
    parameters?: Record<string, any>;
  }): Promise<RunResult> {
    const { flowId, userId, trigger, parameters = {} } = params;

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
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create flow run: ${runError?.message}`);
      }

      // 4. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 5. Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases.map((tc) => ({
          testCaseId: tc.testCaseId,
          testType: tc.testType,
          moduleId: tc.moduleId,
          flowId: tc.flowId,
        })),
        userId,
        trigger,
        parameters
      ).catch((error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
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
    trigger: 'manual' | 'chat' | 'scheduled';
  }): Promise<RunResult> {
    const { projectId, tag, userId, trigger } = params;

    try {
      logger.info('[REGRESSION_RUN] Running by tag', { projectId, tag, userId });

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Get UI test cases with tag from intent_test_cases (unified table)
      const { data: uiCases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id')
        .eq('project_id', projectId)
        .contains('tags', [tag]);

      // Get API test cases with tag (scoped to project via environments/endpoints)
      const apiCases = await this.getApiTestConfigsByProjectAndTag(projectId, userId, tag);

      const testCases = [
        ...(uiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
        })),
        ...(apiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'api' as const,
          flowId: tc.flow_id || undefined,
        })),
      ];

      if (testCases.length === 0) {
        throw new ValidationError(`No test cases found with tag: ${tag}`);
      }

      // Create regression run
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          project_id: projectId,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create tag run: ${runError?.message}`);
      }

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases.map((tc) => ({
          testCaseId: tc.testCaseId,
          testType: tc.testType,
          flowId: tc.flowId,
        })),
        userId,
        trigger,
        {}
      ).catch((error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
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
    trigger: 'manual' | 'chat' | 'scheduled';
  }): Promise<RunResult> {
    const { projectId, priority, userId, trigger } = params;

    try {
      logger.info('[REGRESSION_RUN] Running by priority', { projectId, priority, userId });

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Get UI test cases with priority from intent_test_cases (unified table)
      const { data: uiCases } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, flow_id')
        .eq('project_id', projectId)
        .eq('priority', priority);

      // Get API test cases with priority (scoped to project via environments/endpoints)
      const apiCases = await this.getApiTestConfigsByProjectAndPriority(projectId, userId, priority);

      const testCases = [
        ...(uiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
        })),
        ...(apiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'api' as const,
          flowId: tc.flow_id || undefined,
        })),
      ];

      if (testCases.length === 0) {
        throw new ValidationError(`No test cases found with priority: ${priority}`);
      }

      // Create regression run
      const { data: run, error: runError } = await supabaseAdmin
        .from('regression_runs')
        .insert({
          project_id: projectId,
          user_id: userId,
          trigger,
          status: 'running',
        })
        .select('id')
        .single();

      if (runError || !run) {
        throw new Error(`Failed to create priority run: ${runError?.message}`);
      }

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      this.executeTestCasesAsync(
        run.id,
        testCases.map((tc) => ({
          testCaseId: tc.testCaseId,
          testType: tc.testType,
          flowId: tc.flowId,
        })),
        userId,
        trigger,
        {}
      ).catch((error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
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
  ): Promise<Array<{
    testCaseId: string;
    testType: 'ui' | 'api';
    moduleId?: string;
    flowId?: string;
  }>> {
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

    const testCases: Array<{
      testCaseId: string;
      testType: 'ui' | 'api';
      moduleId?: string;
      flowId?: string;
    }> = [];

    // UI test cases from intent_test_cases (unified table)
    const { data: uiCases, error: uiError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, flow_id')
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
      });
    }

    // API test configs
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
    testCases: Array<{
      testCaseId: string;
      testType: 'ui' | 'api';
      moduleId?: string;
      flowId?: string;
    }>,
    userId: string,
    trigger: 'manual' | 'chat' | 'scheduled',
    parameters: Record<string, any>
  ): Promise<void> {
    const startedAt = new Date().toISOString();

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

    const uiTestIds: string[] = [];
    let apiPassed = 0;
    let apiFailed = 0;

    for (const testCase of testCases) {
      const execId = execByKey.get(`${testCase.testType}:${testCase.testCaseId}`);

      try {
        if (execId) {
          await ExecutionService.updateStatus({ id: execId, status: 'running' });
        }

        if (testCase.testType === 'ui') {
          // Run UI test without creating nested regression_runs
          const savedCase = await this.getSavedTestCase(testCase.testCaseId, userId);
          const testRequest = await this.buildTestRequest(savedCase, userId, parameters);
          const testResult = await ManualTestService.runTest(testRequest);

          if (!testResult.success || !testResult.data?.id) {
            throw new Error('Failed to start UI test execution');
          }

          const testId = testResult.data.id;
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
          }
        } else {
          // Run API test via existing configuration-based executor
          const apiExecution = await ApiConfigService.executeWithConfig(userId, {
            test_config_id: testCase.testCaseId,
          } as any);

          const passed = !!apiExecution?.success;
          if (passed) apiPassed++;
          else apiFailed++;

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
        }
      } catch (error) {
        logger.error('[REGRESSION_RUN] Failed to execute test case', {
          runId,
          testCaseId: testCase.testCaseId,
          testType: testCase.testType,
          error,
        });

        if (execId) {
          await ExecutionService.updateStatus({
            id: execId,
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
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
      return;
    }

    // If only API tests exist, finalize run immediately
    const finalStatus = apiFailed > 0 ? 'failed' : 'completed';
    await supabaseAdmin
      .from('regression_runs')
      .update({
        status: finalStatus,
        summary: {
          total: testCases.length,
          api_passed: apiPassed,
          api_failed: apiFailed,
          completed_at: new Date().toISOString(),
        },
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId);
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
}
