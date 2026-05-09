import crypto from 'crypto';
import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { cache } from '@/utils/core/redis-cache';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { DependencySuggestion, SavedCaseDependencySuggester } from '@/services/testing/flows/saved-case-dependency-suggester.service';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import {
  applyDoctorFinding,
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
} from '@/services/regression-doctor/apply.service';
import { revertDoctorFinding } from '@/services/regression-doctor/revert.service';
import { FullTestDataService } from '@/services/testing/ui/manual/full-test-data.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import { NotFoundError, ValidationError } from '@/types';
import type { Priority } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
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
    const {
      // Mode A — replay from a completed web test
      sourceTestId,
      // Mode B — save an in-memory recording (mobile or step editor)
      projectId,
      platform,
      steps,
      appPackage,
      startActivity,
      tags,
      // Common
      name,
      description,
      kind,
      flowId,
    } = req.body;

    // Exactly one mode must be provided
    const hasMode_A = !!sourceTestId;
    const hasMode_B = !!(projectId && Array.isArray(steps) && steps.length > 0);
    if (!hasMode_A && !hasMode_B) {
      res.status(400).json({
        success: false,
        error:
          'Provide either `sourceTestId` (replay mode) or `projectId` + `steps[]` (recording mode).',
      });
      return;
    }
    if (!name) {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Saving test case', {
      mode: hasMode_A ? 'from_test' : 'from_recording',
      sourceTestId,
      projectId,
      platform,
      stepsCount: Array.isArray(steps) ? steps.length : 0,
      name,
      userId,
      flowId,
    });

    const result = await RegressionSaveService.saveTestCase({
      sourceTestId,
      projectId,
      platform,
      steps,
      appPackage,
      startActivity,
      tags,
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

      // Invalidate ptree:flow cache for the assigned flow
      await cache.delByPattern(`qait:cache:ptree:flow:${flowId}:*`);

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

    void WorkspaceAuditService.logForProject({
      projectId: result.projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.TEST_CASE_CREATED,
      targetType: 'test_case',
      targetId: result.savedTestCaseId,
      metadata: {
        name,
        kind: kind || 'standalone',
        platform,
        flow_id: flowId,
        source_test_id: sourceTestId,
        steps_count: Array.isArray(steps) ? steps.length : undefined,
      },
      ...getAuditContext(req),
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

    void (async () => {
      const { data: row } = await supabaseAdmin
        .from('intent_test_cases')
        .select('project_id, name')
        .eq('id', savedTestCaseId)
        .maybeSingle();
      if (!row?.project_id) return;
      await WorkspaceAuditService.logForProject({
        projectId: row.project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_RUN_STARTED,
        targetType: 'regression_run',
        targetId: result.runId,
        metadata: {
          scope: 'test_case',
          test_case_id: savedTestCaseId,
          test_case_name: (row as any).name,
          test_id: result.testId,
          trigger: trigger || 'manual',
        },
        ...getAuditContext(req),
      });
    })();
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
    const { projectId, platform } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const cases = await RegressionRunService.listSavedTestCases(
      projectId,
      userId,
      undefined,
      typeof platform === 'string' ? platform : undefined,
    );

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

    void (async () => {
      const { data: plan } = await supabaseAdmin
        .from('regression_plans')
        .select('project_id, name')
        .eq('id', planId)
        .maybeSingle();
      if (!plan?.project_id) return;
      await WorkspaceAuditService.logForProject({
        projectId: plan.project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_RUN_STARTED,
        targetType: 'regression_run',
        targetId: result.runId,
        metadata: {
          scope: 'plan',
          plan_id: planId,
          plan_name: (plan as any).name,
          total_tests: result.totalTests,
          trigger: 'manual',
        },
        ...getAuditContext(req),
      });
    })();
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

    void (async () => {
      const { data: mod } = await supabaseAdmin
        .from('test_modules')
        .select('project_id, name')
        .eq('id', moduleId)
        .maybeSingle();
      if (!mod?.project_id) return;
      await WorkspaceAuditService.logForProject({
        projectId: mod.project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_RUN_STARTED,
        targetType: 'regression_run',
        targetId: result.runId,
        metadata: {
          scope: 'module',
          module_id: moduleId,
          module_name: (mod as any).name,
          total_tests: result.totalTests,
          trigger: 'manual',
        },
        ...getAuditContext(req),
      });
    })();
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

    void (async () => {
      // test_flows.module_id → test_modules.project_id
      const { data: flow } = await supabaseAdmin
        .from('test_flows')
        .select('name, module_id, test_modules!inner(project_id)')
        .eq('id', flowId)
        .maybeSingle();
      const projectId = (flow as any)?.test_modules?.project_id;
      if (!projectId) return;
      await WorkspaceAuditService.logForProject({
        projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_RUN_STARTED,
        targetType: 'regression_run',
        targetId: result.runId,
        metadata: {
          scope: 'flow',
          flow_id: flowId,
          flow_name: (flow as any)?.name,
          total_tests: result.totalTests,
          trigger: 'manual',
        },
        ...getAuditContext(req),
      });
    })();
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

    void WorkspaceAuditService.logForProject({
      projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.REGRESSION_RUN_STARTED,
      targetType: 'regression_run',
      targetId: result.runId,
      metadata: {
        scope: 'tag',
        tag,
        total_tests: result.totalTests,
        trigger: 'manual',
      },
      ...getAuditContext(req),
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

    void WorkspaceAuditService.logForProject({
      projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.REGRESSION_RUN_STARTED,
      targetType: 'regression_run',
      targetId: result.runId,
      metadata: {
        scope: 'priority',
        priority,
        total_tests: result.totalTests,
        trigger: 'manual',
      },
      ...getAuditContext(req),
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

    // Include run-level status so frontend can detect cancelled/failed runs.
    // `started_at` / `completed_at` let the live UI show a true elapsed timer
    // anchored to the server-side start time instead of the moment the user
    // opened the page.
    const { data: run } = await supabaseAdmin
      .from('regression_runs')
      .select('status, started_at, completed_at')
      .eq('id', runId)
      .maybeSingle();

    // Normalize 'completed' → 'passed' for frontend compatibility
    const normalizedStatus = run?.status === 'completed' ? 'passed' : run?.status || null;

    res.json({
      success: true,
      data: {
        ...stats,
        status: normalizedStatus,
        startedAt: run?.started_at || null,
        completedAt: run?.completed_at || null,
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
      // Raw platform — null/undefined for legacy rows (pre-20260417 migration);
      // lets the frontend show a platform badge and pick a mobile-aware
      // status-viewer for mobile_* executions.
      platform: exec.platform ?? null,
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
      .select('id, user_id, status, test_ids, project_id')
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

    // Invalidate vizoverall cache — run status changed
    if (run.project_id) {
      await cache.delByPattern(`qait:cache:vizoverall:${run.project_id}:*`);
    }

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

    if (run.project_id) {
      void WorkspaceAuditService.logForProject({
        projectId: run.project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.REGRESSION_RUN_CANCELLED,
        targetType: 'regression_run',
        targetId: runId,
        metadata: {
          cancelled_tests: cancelledTests,
          total_tests: testIds.length,
        },
        ...getAuditContext(req),
      });
    }
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
 * Generate a public share link for a regression run.
 * If the run already has a share_token, reuse it (idempotent).
 *
 * @route POST /api/v1/regression/runs/:runId/share
 * @param {string} runId - Run ID
 * @returns {shareToken, shareUrl}
 */
export async function createShareLink(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { runId } = req.params;
    const userId = getUserId(req);

    if (!runId) {
      res.status(400).json({ success: false, error: 'runId is required' });
      return;
    }

    // Verify ownership and fetch existing share_token
    const { data: run, error: runError } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id, share_token')
      .eq('id', runId)
      .eq('user_id', userId)
      .single();

    if (runError || !run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }

    // Reuse existing token if present (idempotent)
    let shareToken = run.share_token;
    if (!shareToken) {
      // Try to set a new token atomically (only if still null)
      const newToken = crypto.randomBytes(16).toString('hex');
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('regression_runs')
        .update({ share_token: newToken })
        .eq('id', runId)
        .eq('user_id', userId)
        .is('share_token', null)
        .select('share_token')
        .maybeSingle();

      if (updateError) {
        logger.error('[REGRESSION_API] Failed to set share token', { error: updateError, runId });
        res.status(500).json({ success: false, error: 'Failed to generate share link' });
        return;
      }

      // If update matched (we won the race), use our token.
      // If not (concurrent request set it first), re-fetch theirs.
      shareToken = updated?.share_token;
      if (!shareToken) {
        const { data: refreshed } = await supabaseAdmin
          .from('regression_runs')
          .select('share_token')
          .eq('id', runId)
          .single();
        shareToken = refreshed?.share_token;
      }

      if (!shareToken) {
        res.status(500).json({ success: false, error: 'Failed to generate share link' });
        return;
      }
    }

    // Build the full public share URL using configured frontend origin
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:3000';
    const shareUrl = `${frontendUrl}/shared/report/${shareToken}`;

    res.json({
      success: true,
      data: { shareToken, shareUrl },
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Share link created', { runId, shareToken });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to create share link', { error });
    handleControllerError(res, error, 'Failed to create share link');
  }
}

/**
 * Get a shared regression run report (public — no auth required).
 *
 * @route GET /api/v1/regression/shared/:shareToken
 * @param {string} shareToken - Public share token
 * @returns RunReport (read-only, no sensitive user info)
 */
export async function getSharedReport(req: Request, res: Response): Promise<void> {
  try {
    const { shareToken } = req.params;

    if (!shareToken) {
      res.status(400).json({ success: false, error: 'shareToken is required' });
      return;
    }

    const report = await RegressionRunService.buildPublicReport(shareToken);

    if (!report) {
      res.status(404).json({ success: false, error: 'Shared report not found' });
      return;
    }

    res.json({ success: true, data: report, timestamp: new Date() });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get shared report', { error });
    handleControllerError(res, error, 'Failed to get shared report');
  }
}

/**
 * List Regression Doctor findings for a specific run.
 *
 * GET /api/v1/regression/runs/:runId/doctor
 *
 * Phase-1: read-only. Returns every finding (open / applied / dismissed)
 * so the UI can render full history for a run — the Bulk Fix UI filters
 * client-side based on status. RLS enforces ownership; the query just
 * scopes to the run.
 */
export async function getRunDoctorFindings(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { runId } = req.params;
    if (!runId || typeof runId !== 'string') {
      res.status(400).json({ success: false, error: 'runId is required' });
      return;
    }
    const userId = getUserId(req);

    // Ownership check — users can only see findings for runs they own.
    // We verify via regression_runs.user_id rather than relying solely on
    // RLS so we can return a clean 404 instead of an empty array when
    // the user doesn't own the run.
    const { data: run } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id')
      .eq('id', runId)
      .maybeSingle();

    if (!run) {
      res.status(404).json({ success: false, error: 'Run not found' });
      return;
    }
    if (run.user_id !== userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const { data: findings, error } = await supabaseAdmin
      .from('regression_doctor_findings')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch findings: ${error.message}`);
    }

    res.json({
      success: true,
      data: findings || [],
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get doctor findings', { error });
    handleControllerError(res, error, 'Failed to get doctor findings');
  }
}

/**
 * Mark a Regression Doctor finding as dismissed.
 *
 * POST /api/v1/regression/doctor/findings/:findingId/dismiss
 * body: { reason?: string }
 *
 * "Dismissed" means the user acknowledged the drift but does not want
 * the patch applied (e.g. they're fixing it a different way). The
 * finding stays in DB for observability but is hidden from "open"
 * filters in the UI.
 */
export async function dismissDoctorFinding(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { findingId } = req.params;
    const { reason } = req.body || {};

    if (!findingId || typeof findingId !== 'string') {
      res.status(400).json({ success: false, error: 'findingId is required' });
      return;
    }

    const userId = getUserId(req);

    // Verify ownership before update. We query + check instead of relying
    // on RLS so a wrong-owner attempt gets a clean 404 rather than a
    // silent 0-rows update.
    const { data: finding } = await supabaseAdmin
      .from('regression_doctor_findings')
      .select('id, user_id, status')
      .eq('id', findingId)
      .maybeSingle();

    if (!finding) {
      res.status(404).json({ success: false, error: 'Finding not found' });
      return;
    }
    if (finding.user_id !== userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (finding.status !== 'open') {
      res.status(409).json({
        success: false,
        error: `Finding already ${finding.status}`,
      });
      return;
    }

    const { error } = await supabaseAdmin
      .from('regression_doctor_findings')
      .update({
        status: 'dismissed',
        dismissed_reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      })
      .eq('id', findingId);

    if (error) {
      throw new Error(`Failed to dismiss finding: ${error.message}`);
    }

    res.json({ success: true, timestamp: new Date() });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to dismiss finding', { error });
    handleControllerError(res, error, 'Failed to dismiss finding');
  }
}

/**
 * Apply a Regression Doctor finding's proposed patch to affected test cases.
 *
 * POST /api/v1/regression/doctor/findings/:findingId/apply
 * body: { testCaseIds?: string[] }
 *
 * Behavior:
 *   • If `testCaseIds` is omitted, the server applies to the full
 *     `affected_test_ids` list from the finding.
 *   • Per-test outcomes are returned even when some fail — the UI renders
 *     a mixed summary ("Applied 13, skipped 2").
 *   • The finding flips to `applied` iff at least one test was patched.
 *   • Emits `regression:doctor:ready` so other open report tabs refresh
 *     (same channel used when the doctor first populates findings).
 *
 * Typed errors from the service map to:
 *   ApplyNotFoundError → 404
 *   ApplyAccessError   → 403
 *   ApplyConflictError → 409
 * Everything else → 500 via handleControllerError.
 */
export async function applyDoctorFindingHandler(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { findingId } = req.params;
    const { testCaseIds } = req.body || {};

    if (!findingId || typeof findingId !== 'string') {
      res.status(400).json({ success: false, error: 'findingId is required' });
      return;
    }
    // Accept undefined or a string array. Any other shape is a 400 so the
    // client finds the bug early — silently falling back to "apply to all"
    // on a malformed payload is worse than a clean validation error.
    if (testCaseIds !== undefined) {
      if (!Array.isArray(testCaseIds) || !testCaseIds.every((id) => typeof id === 'string')) {
        res.status(400).json({
          success: false,
          error: 'testCaseIds must be an array of strings when provided',
        });
        return;
      }
    }

    const userId = getUserId(req);

    const result = await applyDoctorFinding({
      findingId,
      userId,
      testCaseIds: Array.isArray(testCaseIds) ? testCaseIds : undefined,
    });

    // Nudge the UI — same event the doctor job emits on first run, so all
    // open report tabs for this run re-fetch findings + executions.
    // The finding row carries the runId, so we need to read it back quickly
    // to route the event. Cheap single-row read; acceptable even on the
    // happy path because the controller already did heavy lifting.
    try {
      const { data: finding } = await supabaseAdmin
        .from('regression_doctor_findings')
        .select('run_id')
        .eq('id', findingId)
        .maybeSingle();
      if (finding?.run_id) {
        webSocketService.emitToUser(userId, 'regression:doctor:ready', {
          runId: finding.run_id,
          // findingsCount here means "any doctor-related state changed"; the
          // client re-fetches, so the number is informational.
          findingsCount: 0,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (wsErr) {
      // Non-fatal: the DB update already landed.
      logger.debug('[REGRESSION_API] WS nudge failed post-apply', {
        findingId,
        error: wsErr instanceof Error ? wsErr.message : String(wsErr),
      });
    }

    res.json({
      success: true,
      data: result,
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Doctor finding applied', {
      findingId,
      userId,
      totalRequested: result.totalRequested,
      applied: result.results.filter((r) => r.status === 'applied').length,
      skipped: result.results.filter((r) => r.status === 'skipped').length,
      errored: result.results.filter((r) => r.status === 'error').length,
      findingStatus: result.findingStatus,
    });
  } catch (error) {
    if (error instanceof ApplyNotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof ApplyAccessError) {
      res.status(403).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof ApplyConflictError) {
      res.status(409).json({ success: false, error: error.message });
      return;
    }
    logger.error('[REGRESSION_API] Failed to apply doctor finding', { error });
    handleControllerError(res, error, 'Failed to apply doctor finding');
  }
}

/**
 * Revert a previously-applied Regression Doctor finding.
 *
 * POST /api/v1/regression/doctor/findings/:findingId/revert
 * body: { snapshotIds?: string[] }
 *
 * Restores each patched test case to its pre-apply `steps_json` using
 * the snapshots written during the original Bulk Apply. Safety
 * guarantees (see revert.service.ts):
 *   • Tests edited manually after the apply are skipped with
 *     `modified_after_apply` — we never silently overwrite user work.
 *   • Optimistic concurrency prevents clobbering parallel writes.
 *   • Successfully reverted snapshots are deleted (the apply they
 *     documented no longer exists). Skipped snapshots stay so the
 *     audit trail reflects "we tried and couldn't".
 *   • Finding flips back to 'open' iff EVERY snapshot was reverted
 *     (full revert). Partial reverts keep it 'applied'.
 *
 * Emits `regression:doctor:ready` so any open report tab re-fetches
 * the finding state.
 *
 * Typed errors from the service map to:
 *   ApplyNotFoundError → 404
 *   ApplyAccessError   → 403
 *   ApplyConflictError → 409 (not applied / no snapshots / empty selection)
 */
export async function revertDoctorFindingHandler(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { findingId } = req.params;
    const { snapshotIds } = req.body || {};

    if (!findingId || typeof findingId !== 'string') {
      res.status(400).json({ success: false, error: 'findingId is required' });
      return;
    }
    if (snapshotIds !== undefined) {
      if (
        !Array.isArray(snapshotIds) ||
        !snapshotIds.every((id) => typeof id === 'string')
      ) {
        res.status(400).json({
          success: false,
          error: 'snapshotIds must be an array of strings when provided',
        });
        return;
      }
    }

    const userId = getUserId(req);

    const result = await revertDoctorFinding({
      findingId,
      userId,
      snapshotIds: Array.isArray(snapshotIds) ? snapshotIds : undefined,
    });

    // WS nudge — same channel Apply uses. Cheap run_id lookup off the
    // finding row; non-fatal if it misses.
    try {
      const { data: finding } = await supabaseAdmin
        .from('regression_doctor_findings')
        .select('run_id')
        .eq('id', findingId)
        .maybeSingle();
      if (finding?.run_id) {
        webSocketService.emitToUser(userId, 'regression:doctor:ready', {
          runId: finding.run_id,
          findingsCount: 0,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (wsErr) {
      logger.debug('[REGRESSION_API] WS nudge failed post-revert', {
        findingId,
        error: wsErr instanceof Error ? wsErr.message : String(wsErr),
      });
    }

    res.json({ success: true, data: result, timestamp: new Date() });

    logger.info('[REGRESSION_API] Doctor finding reverted', {
      findingId,
      userId,
      totalRequested: result.totalRequested,
      reverted: result.results.filter((r) => r.status === 'reverted').length,
      skipped: result.results.filter((r) => r.status === 'skipped').length,
      errored: result.results.filter((r) => r.status === 'error').length,
      findingStatus: result.findingStatus,
      remainingSnapshots: result.remainingSnapshots,
    });
  } catch (error) {
    if (error instanceof ApplyNotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof ApplyAccessError) {
      res.status(403).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof ApplyConflictError) {
      res.status(409).json({ success: false, error: error.message });
      return;
    }
    logger.error('[REGRESSION_API] Failed to revert doctor finding', { error });
    handleControllerError(res, error, 'Failed to revert doctor finding');
  }
}

/**
 * List pre-apply snapshots captured for a Regression Doctor finding.
 *
 * GET /api/v1/regression/doctor/findings/:findingId/snapshots
 *
 * Returned rows back the "Review what changed" UI — one snapshot per
 * test case that was successfully patched by a Bulk Apply. Each row
 * carries the exact `steps_before` / `steps_after` JSON blobs so the
 * frontend can render a step-level diff without re-deriving it.
 *
 * Ownership is enforced via the finding's user_id before we hit the
 * snapshots table — a wrong-owner attempt gets a clean 403 rather
 * than a silent empty array.
 */
export async function getDoctorFindingSnapshots(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { findingId } = req.params;
    if (!findingId || typeof findingId !== 'string') {
      res.status(400).json({ success: false, error: 'findingId is required' });
      return;
    }

    const userId = getUserId(req);

    // Ownership check via the parent finding. Explicit query keeps the
    // 404 / 403 response semantics clean — RLS alone would return an
    // empty array in both cases and the UI can't tell them apart.
    const { data: finding } = await supabaseAdmin
      .from('regression_doctor_findings')
      .select('id, user_id')
      .eq('id', findingId)
      .maybeSingle();

    if (!finding) {
      res.status(404).json({ success: false, error: 'Finding not found' });
      return;
    }
    if (finding.user_id !== userId) {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    const { data: snapshots, error } = await supabaseAdmin
      .from('regression_doctor_apply_snapshots')
      .select(
        'id, test_case_id, steps_before, steps_after, change_description, before_updated_at, created_at',
      )
      .eq('finding_id', findingId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch snapshots: ${error.message}`);
    }

    // Hydrate with test case names so the UI doesn't need a second
    // round-trip. Small N (≤ affected test count), single batched query.
    const testCaseIds = Array.from(
      new Set((snapshots || []).map((s) => s.test_case_id as string)),
    );
    const namesMap = new Map<string, string>();
    if (testCaseIds.length > 0) {
      const { data: names } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name')
        .in('id', testCaseIds);
      for (const row of names || []) {
        namesMap.set(row.id as string, (row.name as string) || '');
      }
    }

    const payload = (snapshots || []).map((s) => ({
      id: s.id,
      testCaseId: s.test_case_id,
      testCaseName: namesMap.get(s.test_case_id as string) || null,
      stepsBefore: s.steps_before,
      stepsAfter: s.steps_after,
      changeDescription: s.change_description,
      beforeUpdatedAt: s.before_updated_at,
      createdAt: s.created_at,
    }));

    res.json({ success: true, data: payload, timestamp: new Date() });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to get doctor snapshots', { error });
    handleControllerError(res, error, 'Failed to get doctor snapshots');
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
    // Forward the QAIError `code` so the frontend can branch on specific
    // validation failures (e.g. INSUFFICIENT_CREDITS flips the global
    // "credits exhausted" banner instead of showing a generic toast).
    // Also forward `details` so the UI can render structured breakdowns
    // (required/available/etc.) when available.
    res.status(422).json({
      success: false,
      error: 'Validation error',
      code: (error as any).code || 'VALIDATION_ERROR',
      message: error.message,
      ...((error as any).details ? { details: (error as any).details } : {}),
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

// ============================================================================
// NEGATIVE TESTING
// ============================================================================

/**
 * PATCH /regression/plans/:planId/items/:itemId/negative-testing
 * Toggle negative testing on a plan item.
 */
export async function toggleNegativeTesting(req: AuthenticatedRequest, res: Response) {
  try {
    const { planId, itemId } = req.params;
    const { enabled } = req.body;

    if (enabled !== true && enabled !== false && enabled !== null) {
      res.status(400).json({
        success: false,
        error: 'enabled must be true, false, or null (inherit)',
      });
      return;
    }

    // Verify plan ownership
    const userId = getUserId(req);
    const plan = await RegressionPlanService.getById(planId, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    // Update the plan item
    const { data, error } = await supabaseAdmin
      .from('regression_plan_items')
      .update({ negative_testing_enabled: enabled })
      .eq('id', itemId)
      .eq('plan_id', planId)
      .select()
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Plan item not found' });
      return;
    }

    res.json({ success: true, data });
  } catch (error) {
    handleControllerError(res, error, 'Failed to toggle negative testing');
  }
}

/**
 * POST /regression/plans/:planId/generate-negatives
 * Dispatch BullMQ job to generate negative test cases for enabled test cases.
 */
export async function generateNegatives(req: AuthenticatedRequest, res: Response) {
  try {
    const { planId } = req.params;
    const userId = getUserId(req);

    // Verify plan ownership
    const plan = await RegressionPlanService.getById(planId, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    // Resolve which test cases have negatives enabled
    const { NegativeToggleResolverService } = await import(
      '@/services/testing/plans/negative-toggle-resolver.service'
    );
    const enabledTestCaseIds = await NegativeToggleResolverService.getEnabledTestCaseIds(planId);

    if (enabledTestCaseIds.length === 0) {
      res.json({
        success: true,
        data: { testCaseCount: 0, message: 'No test cases have negative testing enabled' },
      });
      return;
    }

    // Dispatch BullMQ job
    const { QueueManager } = await import('@/config/infrastructure/queues');
    const job = await QueueManager.addNegativeGenerationJob({
      planId,
      userId,
      testCaseIds: enabledTestCaseIds,
    });

    res.json({
      success: true,
      data: {
        jobId: job.id,
        testCaseCount: enabledTestCaseIds.length,
      },
    });
  } catch (error) {
    handleControllerError(res, error, 'Failed to generate negatives');
  }
}

/**
 * GET /regression/plans/:planId/negatives
 * List negative test cases for a plan.
 */
export async function getNegatives(req: AuthenticatedRequest, res: Response) {
  try {
    const { planId } = req.params;
    const userId = getUserId(req);

    // Verify plan ownership
    const plan = await RegressionPlanService.getById(planId, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    // Get all test case IDs in this plan
    const expanded = await RegressionPlanService.expandPlan(planId);
    const testCaseIds = expanded
      .filter((tc) => !tc.isNegative)
      .map((tc) => tc.testCaseId);

    if (testCaseIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    // Fetch negatives for these sources
    const { data: negatives } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, source_intent_test_case_id, negative_meta, negative_stale_reason, created_at')
      .eq('is_negative', true)
      .in('source_intent_test_case_id', testCaseIds)
      .order('created_at', { ascending: true });

    res.json({ success: true, data: negatives || [] });
  } catch (error) {
    handleControllerError(res, error, 'Failed to list negatives');
  }
}

/**
 * GET /regression/plans/:planId/negatives/status
 * Get generation status for reconnecting users.
 */
export async function getNegativesStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const { planId } = req.params;
    const userId = getUserId(req);

    // Verify plan ownership
    const plan = await RegressionPlanService.getById(planId, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    // Check if a generation job is currently running
    const { negativeGenerationQueue } = await import('@/config/infrastructure/queues');
    const activeJobs = await negativeGenerationQueue.getJobs(['active', 'waiting']);
    const planJob = activeJobs.find((j) => j.data.planId === planId);

    if (planJob) {
      const progress = await planJob.progress;
      res.json({
        success: true,
        data: {
          status: 'running',
          jobId: planJob.id,
          progress: typeof progress === 'number' ? progress : 0,
        },
      });
      return;
    }

    // No active job — return idle
    res.json({
      success: true,
      data: { status: 'idle' },
    });
  } catch (error) {
    handleControllerError(res, error, 'Failed to get negatives status');
  }
}
