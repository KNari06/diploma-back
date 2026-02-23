import { supabaseAdmin } from '@/db/supabase';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { DependencySuggestion, SavedCaseDependencySuggester } from '@/services/testing/flows/saved-case-dependency-suggester.service';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import { FullTestDataService } from '@/services/testing/ui/manual/full-test-data.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { NotFoundError, ValidationError } from '@/types';
import type { Priority } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION CONTROLLER - API endpoints for regression testing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Provides REST API for:
 * - Saving completed tests as reusable test cases
 * - Creating regression suites from multiple test cases
 * - Running saved test cases and suites
 * - Listing saved test cases, suites, and runs for a project
 */

// Extended Request type with authenticated user
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

/**
 * Extract and validate user ID from authenticated request
 * @throws {Error} If user ID is missing (auth middleware should prevent this)
 */
function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new Error('User ID not found - authentication failed');
  }
  return userId;
}

/**
 * Save a test as a regression test case
 *
 * @route POST /api/v1/regression/save
 * @body {string} sourceTestId - ID of completed test to save
 * @body {string} name - Display name for saved test case
 * @body {string} [description] - Optional description
 * @body {string} [kind='standalone'] - 'standalone' or 'regression_member'
 * @body {string} [flowId] - Optional flow ID to assign the case to
 * @returns {savedTestCaseId, projectId, replayStrategy, parametersCount, suggestedDependsOn}
 */
export async function saveTestCase(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { sourceTestId, name, description, kind, flowId } = req.body;

    // Validate required inputs
    if (!sourceTestId || !name) {
      res.status(400).json({
        success: false,
        error: 'sourceTestId and name are required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Saving test case', { sourceTestId, name, userId, flowId });

    const result = await RegressionSaveService.saveTestCase({
      sourceTestId,
      userId,
      name,
      description,
      kind: kind || 'standalone',
    });

    // If flowId provided, update the saved case and get suggestions
    let suggestedDependsOn: DependencySuggestion[] = [];
    if (flowId) {
      // Verify flow exists, belongs to user, and is within the same project
      const { data: flow, error: flowError } = await supabaseAdmin
        .from('test_flows')
        .select('id, module_id, test_modules!inner(project_id)')
        .eq('id', flowId)
        .eq('user_id', userId)
        .single();

      if (flowError || !flow) {
        res.status(404).json({ success: false, error: 'Flow not found or access denied' });
        return;
      }

      const flowProjectId = (flow as any).test_modules?.project_id;
      if (!flowProjectId || flowProjectId !== result.projectId) {
        res.status(422).json({
          success: false,
          error: 'Validation error',
          message: 'Flow belongs to a different project',
        });
        return;
      }

      // Update flow_id in intent_test_cases (unified table)
      const { error: updateError } = await supabaseAdmin
        .from('intent_test_cases')
        .update({ flow_id: flowId })
        .eq('id', result.savedTestCaseId)
        .eq('user_id', userId);

      if (updateError) {
        throw new Error(`Failed to assign intent test case to flow: ${updateError.message}`);
      }

      // Get AI suggestions
      suggestedDependsOn = await SavedCaseDependencySuggester.suggestForCase(
        result.savedTestCaseId,
        flowId,
        userId
      );
    }

    res.json({
      success: true,
      data: {
        savedTestCaseId: result.savedTestCaseId,
        projectId: result.projectId,
        replayStrategy: result.replayStrategy,
        parametersCount: result.parametersCount,
        flowId: flowId || undefined,
        suggestedDependsOn,
        message: 'Test case saved successfully',
        nextActions: [
          `Run test case: POST /api/v1/regression/run with savedTestCaseId="${result.savedTestCaseId}"`,
          `Add to plan: POST /api/v1/regression-plans/:planId/items with testCaseId="${result.savedTestCaseId}"`,
          flowId ? `Confirm dependencies: PATCH /api/v1/saved-test-cases/${result.savedTestCaseId}/dependencies` : null,
        ].filter(Boolean),
      },
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Test case saved successfully', {
      savedTestCaseId: result.savedTestCaseId,
      suggestionsCount: suggestedDependsOn.length,
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to save test case', { error });
    handleControllerError(res, error, 'Failed to save test case');
  }
}

/**
/**
 * Run a saved test case
 *
 * @route POST /api/v1/regression/run
 * @body {string} savedTestCaseId - ID of saved test case to run
 * @body {string} [trigger='manual'] - 'manual' or 'chat'
 * @body {object} [parameters] - Runtime parameters for test execution
 * @returns {runId, testId}
 */
export async function runRegression(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { savedTestCaseId, trigger, parameters } = req.body;

    // Validate savedTestCaseId is provided
    if (!savedTestCaseId) {
      res.status(400).json({
        success: false,
        error: 'savedTestCaseId is required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running regression test case', {
      savedTestCaseId,
      userId,
    });

    const result = await RegressionRunService.runSavedTestCase({
      savedTestCaseId,
      userId,
      trigger: trigger || 'manual',
      parameters: parameters || {},
    });

    res.json({
      success: true,
      data: {
        runId: result.runId,
        testId: result.testId,
        message: 'Test case run started',
      },
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Regression run started', { runId: result.runId });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run regression', { error });
    handleControllerError(res, error, 'Failed to run regression');
  }
}

/**
 * List saved test cases for project
 *
 * @route GET /api/v1/regression/saved-test-cases?projectId=<uuid>
 * @query {string} projectId - Project ID to list test cases for
 * @returns {array} List of saved test cases with dependsOn
 */
export async function listSavedTestCases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const cases = await RegressionRunService.listSavedTestCases(projectId, userId);

    // Map to camelCase response format with dependsOn
    const mappedCases = cases.map(mapSavedTestCaseToResponse);

    res.json({
      success: true,
      data: mappedCases,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to list saved test cases', { error });
    handleControllerError(res, error, 'Failed to list saved test cases');
  }
}

/**
 * Map saved test case database row to API response format
 */
function mapSavedTestCaseToResponse(row: any): any {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    sourceTestId: row.source_test_id,
    sourceIntelligentSessionId: row.source_intelligent_session_id,
    name: row.name,
    description: row.description || undefined,
    kind: row.kind,
    replayStrategy: row.replay_strategy,
    url: row.url,
    flowId: row.flow_id || undefined,
    tags: row.tags || [],
    priority: row.priority || undefined,
    preconditions: row.preconditions || [],
    setupSteps: row.setup_steps || [],
    teardownSteps: row.teardown_steps || [],
    expectedResult: row.expected_result || undefined,
    dependsOn: row.depends_on || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List runs for project
 *
 * @route GET /api/v1/regression/runs?projectId=<uuid>
 * @query {string} projectId - Project ID to list runs for
 * @returns {array} List of regression runs with status and summary
 */
export async function listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const runs = await RegressionRunService.listRuns(projectId, userId);

    res.json({
      success: true,
      data: runs,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to list runs', { error });
    handleControllerError(res, error, 'Failed to list runs');
  }
}

// =========================================================================
// NEW HIERARCHY ENDPOINTS
// =========================================================================

/**
 * Run a regression plan
 *
 * @route POST /api/v1/regression/run-plan
 * @body {string} planId - ID of regression plan to run
 * @body {object} [parameters] - Runtime parameters
 * @returns {runId, executionIds, totalTests}
 */
export async function runPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { planId, parameters } = req.body;

    if (!planId) {
      res.status(400).json({
        success: false,
        error: 'planId is required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running plan', { planId, userId });

    const result = await RegressionRunService.runPlan({
      planId,
      userId,
      trigger: 'manual',
      parameters: parameters || {},
    });

    res.json({
      success: true,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        message: `Plan run started with ${result.totalTests} tests`,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run plan', { error });
    handleControllerError(res, error, 'Failed to run plan');
  }
}

/**
 * Run all tests in a module
 *
 * @route POST /api/v1/regression/run-module
 * @body {string} moduleId - ID of module to run
 * @body {object} [parameters] - Runtime parameters
 * @returns {runId, executionIds, totalTests}
 */
export async function runModule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { moduleId, parameters } = req.body;

    if (!moduleId) {
      res.status(400).json({
        success: false,
        error: 'moduleId is required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running module', { moduleId, userId });

    const result = await RegressionRunService.runModule({
      moduleId,
      userId,
      trigger: 'manual',
      parameters: parameters || {},
    });

    res.json({
      success: true,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        message: `Module run started with ${result.totalTests} tests`,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run module', { error });
    handleControllerError(res, error, 'Failed to run module');
  }
}

/**
 * Run all tests in a flow
 *
 * @route POST /api/v1/regression/run-flow
 * @body {string} flowId - ID of flow to run
 * @body {object} [parameters] - Runtime parameters
 * @returns {runId, executionIds, totalTests}
 */
export async function runFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { flowId, parameters } = req.body;

    if (!flowId) {
      res.status(400).json({
        success: false,
        error: 'flowId is required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running flow', { flowId, userId });

    const result = await RegressionRunService.runFlow({
      flowId,
      userId,
      trigger: 'manual',
      parameters: parameters || {},
    });

    res.json({
      success: true,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        message: `Flow run started with ${result.totalTests} tests`,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run flow', { error });
    handleControllerError(res, error, 'Failed to run flow');
  }
}

/**
 * Run tests by tag
 *
 * @route POST /api/v1/regression/run-by-tag
 * @body {string} projectId - Project ID
 * @body {string} tag - Tag to filter by
 * @returns {runId, executionIds, totalTests}
 */
export async function runByTag(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, tag } = req.body;

    if (!projectId || !tag) {
      res.status(400).json({
        success: false,
        error: 'projectId and tag are required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running by tag', { projectId, tag, userId });

    const result = await RegressionRunService.runByTag({
      projectId,
      tag,
      userId,
      trigger: 'manual',
    });

    res.json({
      success: true,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        message: `Tag run started with ${result.totalTests} tests`,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run by tag', { error });
    handleControllerError(res, error, 'Failed to run by tag');
  }
}

/**
 * Run tests by priority
 *
 * @route POST /api/v1/regression/run-by-priority
 * @body {string} projectId - Project ID
 * @body {string} priority - Priority level (critical, high, medium, low)
 * @returns {runId, executionIds, totalTests}
 */
export async function runByPriority(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, priority } = req.body;

    if (!projectId || !priority) {
      res.status(400).json({
        success: false,
        error: 'projectId and priority are required',
      });
      return;
    }

    const validPriorities = ['critical', 'high', 'medium', 'low'];
    if (!validPriorities.includes(priority)) {
      res.status(400).json({
        success: false,
        error: `priority must be one of: ${validPriorities.join(', ')}`,
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running by priority', { projectId, priority, userId });

    const result = await RegressionRunService.runByPriority({
      projectId,
      priority: priority as Priority,
      userId,
      trigger: 'manual',
    });

    res.json({
      success: true,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        message: `Priority run started with ${result.totalTests} tests`,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run by priority', { error });
    handleControllerError(res, error, 'Failed to run by priority');
  }
}

/**
 * Get execution stats for a run
 *
 * @route GET /api/v1/regression/runs/:runId/stats
 * @param {string} runId - Run ID
 * @returns ExecutionStats
 */
export async function getRunStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { runId } = req.params;

    if (!runId) {
      res.status(400).json({
        success: false,
        error: 'runId is required',
      });
      return;
    }

    const stats = await ExecutionService.getStats(runId);

    // Include run-level status so frontend can detect cancelled/failed runs
    const { data: run } = await supabaseAdmin
      .from('regression_runs')
      .select('status')
      .eq('id', runId)
      .maybeSingle();

    res.json({
      success: true,
      data: {
        ...stats,
        status: run?.status || null,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get run stats', { error });
    handleControllerError(res, error, 'Failed to get run stats');
  }
}

/**
 * Get test case commands for shared steps picker
 *
 * @route GET /api/v1/regression/test-cases/:id/commands
 * @param {string} id - Intent test case ID
 * @returns { commands, parametersSchema, name }
 */
export async function getTestCaseCommands(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    if (!id) {
      res.status(400).json({
        success: false,
        error: 'Test case ID is required',
      });
      return;
    }

    // Query intent_test_cases for commands
    const { data: testCase, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, commands, parameters_schema, project_id, projects!inner(user_id)')
      .eq('id', id)
      .single();

    if (error || !testCase) {
      res.status(404).json({
        success: false,
        error: 'Test case not found',
      });
      return;
    }

    // Verify user has access via project ownership
    const projectUserId = (testCase.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      res.status(403).json({
        success: false,
        error: 'Access denied to this test case',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        id: testCase.id,
        name: testCase.name,
        commands: testCase.commands || [],
        parametersSchema: testCase.parameters_schema || {},
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get test case commands', { error });
    handleControllerError(res, error, 'Failed to get test case commands');
  }
}

/**
 * Get full run report with executions, bugs, artifacts
 *
 * @route GET /api/v1/regression/runs/:runId/report
 */
export async function getRunReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { runId } = req.params;
    const userId = getUserId(req);

    if (!runId) {
      res.status(400).json({ success: false, error: 'runId is required' });
      return;
    }

    const report = await RegressionRunService.buildFullReport(runId, userId);

    if (!report) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    res.json({ success: true, data: report, timestamp: new Date() });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get run report', { error });
    handleControllerError(res, error, 'Failed to get run report');
  }
}

/**
 * Get plan health report with trend history and flaky tests
 *
 * @route GET /api/v1/regression/plans/:planId/health
 */
export async function getPlanHealth(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { planId } = req.params;
    const userId = getUserId(req);
    const historyLimit = Math.min(Math.max(parseInt(req.query.historyLimit as string) || 10, 1), 50);

    if (!planId) {
      res.status(400).json({ success: false, error: 'planId is required' });
      return;
    }

    // Verify ownership
    const plan = await RegressionPlanService.getById(planId, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    const report = await RegressionPlanService.getPlanHealthReport(planId, historyLimit);

    res.json({ success: true, data: report, timestamp: new Date() });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get plan health', { error });
    handleControllerError(res, error, 'Failed to get plan health');
  }
}

/**
 * Get executions for a run (with testId mapping)
 *
 * @route GET /api/v1/regression/runs/:runId/executions
 * @param {string} runId - Run ID
 * @returns Array of executions with testCaseId, status, and result.testId
 */
export async function getRunExecutions(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { runId } = req.params;
    const userId = getUserId(req);

    if (!runId) {
      res.status(400).json({ success: false, error: 'runId is required' });
      return;
    }

    // Verify access: check that the run belongs to this user
    const { data: run, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id')
      .eq('id', runId)
      .eq('user_id', userId)
      .single();

    if (runError || !run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    const executions = await ExecutionService.getByRunId(runId);

    // Batch-fetch test case names for UI display
    const uiTestCaseIds = [...new Set(
      executions.filter((e) => e.testType === 'ui').map((e) => e.testCaseId)
    )];
    const apiTestCaseIds = [...new Set(
      executions.filter((e) => e.testType === 'api').map((e) => e.testCaseId)
    )];

    const namesMap = new Map<string, string>();

    if (uiTestCaseIds.length > 0) {
      const { data: uiNames } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', uiTestCaseIds);
      for (const row of uiNames || []) namesMap.set(row.id, row.name);
    }
    if (apiTestCaseIds.length > 0) {
      const { data: apiNames } = await supabaseAdmin
        .from('api_test_configs')
        .select('id, name')
        .in('id', apiTestCaseIds);
      for (const row of apiNames || []) namesMap.set(row.id, row.name);
    }

    // Map to frontend-friendly format with testId and testCaseName
    const mapped = executions.map((exec) => ({
      id: exec.id,
      testCaseId: exec.testCaseId,
      testCaseName: namesMap.get(exec.testCaseId) || null,
      testType: exec.testType,
      status: exec.status,
      browser: exec.browser,
      durationMs: exec.durationMs,
      errorMessage: exec.errorMessage,
      testId: exec.result?.testId || null,
      startedAt: exec.startedAt,
      completedAt: exec.completedAt,
    }));

    res.json({ success: true, data: mapped, timestamp: new Date() });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get run executions', { error });
    handleControllerError(res, error, 'Failed to get run executions');
  }
}

/**
 * Cancel a regression run
 * Cancels all running/pending tests within the run and marks run as cancelled.
 *
 * @route POST /api/v1/regression/runs/:runId/cancel
 * @param {string} runId - Run ID to cancel
 */
export async function cancelRun(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { runId } = req.params;
    const userId = getUserId(req);

    if (!runId) {
      res.status(400).json({ success: false, error: 'runId is required' });
      return;
    }

    // Verify access and get run data
    const { data: run, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id, status, test_ids')
      .eq('id', runId)
      .eq('user_id', userId)
      .single();

    if (runError || !run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    if (run.status !== 'running' && run.status !== 'pending') {
      res.status(422).json({
        success: false,
        error: `Cannot cancel run with status "${run.status}"`,
      });
      return;
    }

    // Cancel all running/pending underlying tests
    const testIds: string[] = run.test_ids || [];
    let cancelledTests = 0;

    for (const testId of testIds) {
      try {
        const result = await ManualTestService.cancelTest(testId, userId);
        if (result.success) cancelledTests++;
      } catch {
        // Some tests may already be completed — skip them
      }
    }

    // Cancel all pending/running test_executions
    await supabaseAdmin
      .from('test_executions')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        error_message: 'Cancelled by user',
      })
      .eq('run_id', runId)
      .in('status', ['pending', 'running']);

    // Mark the run as cancelled
    await supabaseAdmin
      .from('regression_runs')
      .update({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      })
      .eq('id', runId)
      .in('status', ['running', 'pending']);

    logger.info('[REGRESSION_API] Run cancelled', {
      runId,
      cancelledTests,
      totalTestIds: testIds.length,
    });

    res.json({
      success: true,
      data: {
        runId,
        cancelledTests,
        totalTests: testIds.length,
        message: `Run cancelled. ${cancelledTests}/${testIds.length} tests stopped.`,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to cancel run', { error });
    handleControllerError(res, error, 'Failed to cancel run');
  }
}

/**
 * Get full test detail for a regression execution
 *
 * @route GET /api/v1/regression/runs/:runId/executions/:executionId/detail
 * @param {string} runId - Run ID
 * @param {string} executionId - Execution ID
 * @returns Execution metadata + full test data (screenshots, video, logs, errors, AI analysis)
 */
export async function getExecutionDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { runId, executionId } = req.params;
    const userId = getUserId(req);

    if (!runId || !executionId) {
      res.status(400).json({ success: false, error: 'runId and executionId are required' });
      return;
    }

    // Verify run ownership
    const { data: run, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id')
      .eq('id', runId)
      .eq('user_id', userId)
      .single();

    if (runError || !run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    // Get execution and verify it belongs to this run
    const { data: execution, error: execError } = await supabaseAdmin
      .from('test_executions')
      .select('*')
      .eq('id', executionId)
      .eq('run_id', runId)
      .single();

    if (execError || !execution) {
      res.status(404).json({ success: false, error: 'Execution not found' });
      return;
    }

    // Extract testId from execution result
    const testId = execution.result?.testId || null;
    let testDetail = null;

    if (testId) {
      try {
        testDetail = await FullTestDataService.getFullTestData(testId, userId);
      } catch (error) {
        logger.warn('[REGRESSION_API] Could not load test detail for execution', {
          executionId,
          testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    res.json({
      success: true,
      data: {
        execution: {
          id: execution.id,
          runId: execution.run_id,
          testCaseId: execution.test_case_id,
          testType: execution.test_type,
          status: execution.status,
          browser: execution.browser,
          durationMs: execution.duration_ms,
          errorMessage: execution.error_message,
          testId,
          startedAt: execution.started_at,
          completedAt: execution.completed_at,
          result: execution.result,
        },
        testDetail,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get execution detail', { error });
    handleControllerError(res, error, 'Failed to get execution detail');
  }
}

/**
 * Centralized error handler for regression controller
 * Maps error types to appropriate HTTP status codes and formats responses consistently
 *
 * @param res - Express response object
 * @param error - Error to handle
 * @param defaultMessage - Default error message if error type is unknown
 */
function handleControllerError(
  res: Response,
  error: unknown,
  defaultMessage: string
): void {
  // Don't send response if already sent
  if (res.headersSent) {
    logger.warn('[REGRESSION_API] Response already sent, cannot send error response');
    return;
  }

  // Handle known error types
  if (error instanceof NotFoundError) {
    res.status(404).json({
      success: false,
      error: 'Resource not found',
      message: error.message,
    });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({
      success: false,
      error: 'Validation error',
      message: error.message,
    });
    return;
  }

  // Handle generic errors
  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
