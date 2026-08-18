import crypto from 'crypto';
import { env } from '@/config/environment/env';
import { QueueManager } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { cache } from '@/utils/core/redis-cache';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { DependencySuggestion, SavedCaseDependencySuggester } from '@/services/testing/flows/saved-case-dependency-suggester.service';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { NegativeGenerationService } from '@/services/testing/negative/negative-generation.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import {
  applyDoctorFinding,
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
} from '@/services/regression-doctor/apply.service';
import { revertDoctorFinding } from '@/services/regression-doctor/revert.service';
import { readAnalysis } from '@/services/regression-doctor/analysis-record';
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
      hostPlatform,
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
      hostPlatform,
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
      const sugResult = await SavedCaseDependencySuggester.suggestForCase(
        result.savedTestCaseId,
        flowId,
        userId
      );
      suggestedDependsOn = sugResult.suggestions;
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
 * @route GET /api/v1/regression/runs?projectId=<uuid>&planId=<uuid>
 * @query {string} projectId - Project ID to list runs for
 * @query {string} [planId] - Optional: scope to one plan's run history (includes ad-hoc runs of the plan's member test cases)
 * @returns {array} List of regression runs with status and summary
 */
export async function listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, planId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const runs = await RegressionRunService.listRuns(
      projectId,
      userId,
      undefined,
      typeof planId === 'string' ? planId : undefined,
    );

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

    // Batch-fetch test case names for UI display, plus priority for UI cases.
    // Priority is surfaced so the frontend can colorize / sort the executions
    // list (critical rows in red, low rows muted) WITHOUT changing the
    // server-side execution order. We deliberately keep priority a
    // display-only signal here — runPlan/runFlow already preserve the
    // user's `position` ordering; reordering server-side would break that
    // contract. API tests have no priority column (see analytics-query
    // service:838) so the map is UI-only.
    const uiTestCaseIds = [...new Set(
      executions.filter((e) => e.testType === 'ui').map((e) => e.testCaseId)
    )];
    const apiTestCaseIds = [...new Set(
      executions.filter((e) => e.testType === 'api').map((e) => e.testCaseId)
    )];

    const namesMap = new Map<string, string>();
    const priorityMap = new Map<string, 'critical' | 'high' | 'medium' | 'low'>();

    if (uiTestCaseIds.length > 0) {
      const { data: uiRows } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, priority')
        .in('id', uiTestCaseIds);
      for (const row of uiRows || []) {
        namesMap.set(row.id, row.name);
        // Guard against schema drift: priority may be NULL or a free-form
        // string if anyone bypassed the CHECK constraint. Only forward
        // values we trust the frontend's badge / color scheme to handle.
        if (row.priority && ['critical', 'high', 'medium', 'low'].includes(row.priority)) {
          priorityMap.set(row.id, row.priority as 'critical' | 'high' | 'medium' | 'low');
        }
      }
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
      // UI tests only — API tests intentionally null (no priority column).
      // Frontend uses this to badge / colorize rows; absence == no badge.
      priority: priorityMap.get(exec.testCaseId) ?? null,
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

    // Cancel ordering matters here. Supabase's JS client cannot span a
    // transaction across tables, so we order writes by user-impact:
    //
    //   1. regression_runs.status = cancelled  → UI shows cancelled instantly
    //   2. Discover in-flight UI tests from test_executions (NOT
    //      regression_runs.test_ids — that field is empty for some run
    //      shapes and stale for others)
    //   3. test_executions.status = cancelled  → execution rows reflect intent
    //   4. per-test ManualTestService.cancelTest → signals workers to stop.
    //      Works for both web AND mobile because cancelTest() flips
    //      `tests.status = 'cancelled'`, which both web's
    //      manual-test-run.job.ts:checkTestCancelled and mobile's
    //      mobile-test-run.job.ts:isTestCancelled (running on a 2s poller
    //      inside runSteps) check on every iteration.
    //
    // If any step fails, the user-facing run row is already cancelled and
    // the cleanup can be retried (the cancel endpoint is idempotent — see
    // the `.in('status', ['running','pending'])` filters which prevent
    // double-mutation). Each step has its own try/catch so a transient
    // failure on one doesn't skip the others.

    // Step 1 — flip the run row first so the UI reflects intent immediately.
    let runMarkError: unknown;
    try {
      await supabaseAdmin
        .from('regression_runs')
        .update({
          status: 'cancelled',
          completed_at: new Date().toISOString(),
        })
        .eq('id', runId)
        .in('status', ['running', 'pending']);
    } catch (err) {
      runMarkError = err;
      logger.error('[REGRESSION_API] Failed to mark regression_runs as cancelled', { runId, error: err });
    }

    // Step 2 — discover in-flight UI tests via test_executions. Filter to
    // running/pending so we don't try to cancel tests that already
    // succeeded or failed naturally before the user clicked. UI tests
    // pin their `tests.id` into `result.testId` at dispatch time
    // (regression-run.service.ts:2247-2256). API tests don't dispatch a
    // `tests` row and don't need per-test cancel — their executor is
    // synchronous and either already returned a verdict or threw.
    //
    // Pre-fix used `regression_runs.test_ids` which is only populated
    // for plan/module/flow runs (regression-run.service.ts:2694), and
    // even then only for web testIds — mobile dispatches via BullMQ
    // queue and the array can lag. test_executions is the source of
    // truth: every dispatch creates an exec row, and the worker writes
    // back via TestCompletionHandler.
    const inFlightTestIds: string[] = [];
    try {
      const { data: execRows } = await supabaseAdmin
        .from('test_executions')
        .select('id, test_type, result, status')
        .eq('run_id', runId)
        .in('status', ['pending', 'running']);
      for (const row of execRows ?? []) {
        if (row.test_type !== 'ui') continue; // API tests have no `tests` row
        const testId: unknown = (row.result as any)?.testId;
        if (typeof testId === 'string' && testId) {
          inFlightTestIds.push(testId);
        }
      }
    } catch (err) {
      logger.warn('[REGRESSION_API] Failed to discover in-flight UI tests via test_executions', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let cancelledTests = 0;

    // Step 3 — flip executions in bulk. Independent of step 4 so a slow
    // per-test cancel loop doesn't delay this DB-level update.
    let executionsMarkError: unknown;
    try {
      await supabaseAdmin
        .from('test_executions')
        .update({
          status: 'cancelled',
          completed_at: new Date().toISOString(),
          error_message: 'Cancelled by user',
        })
        .eq('run_id', runId)
        .in('status', ['pending', 'running']);
    } catch (err) {
      executionsMarkError = err;
      logger.error('[REGRESSION_API] Failed to mark test_executions as cancelled', { runId, error: err });
    }

    // Step 4 — per-test cancel. This is the path that signals running
    // BullMQ workers to stop at their next phase boundary. cancelTest()
    // updates `tests.status = 'cancelled'` AND tries to remove waiting
    // jobs from the web testRunQueue. Mobile workers detect the status
    // flip via the cancellation poller in mobile-test-run.job.ts and
    // abort the in-flight runSteps fetch via AbortController.
    for (const testId of inFlightTestIds) {
      try {
        const result = await ManualTestService.cancelTest(testId, userId);
        if (result.success) cancelledTests++;
      } catch (err) {
        // Some tests may already be completed — that's fine. Log so a
        // sudden spike in per-test failures (e.g. all tests fail to
        // cancel because of an auth issue) is observable.
        logger.warn('[REGRESSION_API] Per-test cancel failed', {
          runId,
          testId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[REGRESSION_API] Run cancelled', {
      runId,
      cancelledTests,
      totalTestIds: inFlightTestIds.length,
      runMarkFailed: !!runMarkError,
      executionsMarkFailed: !!executionsMarkError,
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
        totalTests: inFlightTestIds.length,
        message: `Run cancelled. ${cancelledTests}/${inFlightTestIds.length} tests stopped.`,
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
          total_tests: inFlightTestIds.length,
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

    // Surface curator-set priority of the saved test case so the
    // execution-detail page can badge the header. UI tests only —
    // api_test_configs has no priority column (analytics-query:838).
    // Best-effort; CHECK-violating drift collapses to null on the wire.
    let priority: 'critical' | 'high' | 'medium' | 'low' | null = null;
    if (execution.test_type === 'ui' && execution.test_case_id) {
      try {
        const { data: tc } = await supabaseAdmin
          .from('intent_test_cases')
          .select('priority')
          .eq('id', execution.test_case_id)
          .maybeSingle();
        if (tc?.priority && ['critical', 'high', 'medium', 'low'].includes(tc.priority)) {
          priority = tc.priority as 'critical' | 'high' | 'medium' | 'low';
        }
      } catch { /* non-fatal — priority is display-only */ }
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
          priority,
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
 * Start the Regression Doctor for a run — the ONLY way it ever runs.
 *
 * POST /api/v1/regression/runs/:runId/doctor/analyze
 *
 * Deliberately manual. The analysis costs one vision call per failed test, so
 * running it on every finished regression would bill a nightly suite for
 * failures nobody has looked at yet. The user asks for it from the run report.
 *
 * Re-clicking is safe and cheap: the job skips every step that already has a
 * finding, so a second analysis only pays for what is new. A job still in
 * flight returns 202 with `alreadyRunning`, not a duplicate.
 */
export async function analyzeRunFailures(
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

    const { data: run } = await supabaseAdmin
      .from('regression_runs')
      .select('id, user_id, project_id, status')
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

    const { queued, alreadyRunning } = await QueueManager.addRegressionDoctorJob({
      runId,
      projectId: run.project_id,
      userId: run.user_id,
    });

    logger.info('[REGRESSION_API] Regression Doctor requested', {
      runId,
      userId,
      queued,
      alreadyRunning,
    });

    res.status(202).json({
      success: true,
      data: { runId, queued, alreadyRunning },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to start Regression Doctor', { error });
    handleControllerError(res, error, 'Failed to start analysis');
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

    // Whether an analysis has ever run for this run. Zero findings alone cannot
    // say so, and a panel that cannot tell the two apart looks broken after an
    // analysis that legitimately had nothing to propose.
    //
    // The durable record first, the queue only as a fallback: the job carries
    // the same numbers but is evicted after 25 completions queue-wide, and an
    // analysis that has aged out must not read as one that never happened. The
    // fallback still covers runs analyzed before the record existed, and an
    // in-flight job (which has no record yet) so the panel keeps waiting
    // instead of flipping to "nothing to fix" mid-run.
    const analysis =
      (await readAnalysis(runId)) ?? (await QueueManager.getRegressionDoctorJobStatus(runId));

    res.json({
      success: true,
      data: findings || [],
      analysis,
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

    const userId = getUserId(req);
    const result = await NegativeGenerationService.toggleItem(planId, itemId, userId, enabled);

    if (result.status === 'plan_not_found') {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }
    if (result.status === 'item_not_found') {
      res.status(404).json({ success: false, error: 'Plan item not found' });
      return;
    }

    res.json({ success: true, data: result.item });
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

    const result = await NegativeGenerationService.dispatchGeneration(planId, userId);

    if (result.status === 'plan_not_found') {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    if (result.status === 'forbidden') {
      res.status(403).json({ success: false, error: result.message });
      return;
    }

    res.json({
      success: true,
      data:
        result.testCaseCount === 0
          ? { testCaseCount: 0, message: result.message }
          : { jobId: result.jobId, testCaseCount: result.testCaseCount },
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

    const result = await NegativeGenerationService.listNegatives(planId, userId);
    if (result.status === 'plan_not_found') {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    res.json({ success: true, data: result.negatives });
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

    const result = await NegativeGenerationService.getStatus(planId, userId);
    if (result.status === 'plan_not_found') {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    handleControllerError(res, error, 'Failed to get negatives status');
  }
}

/**
 * GET /regression/plans/:planId/negatives/estimate
 * Pre-run estimate of extra test count + minutes from enabling negatives.
 */
export async function getNegativesEstimate(req: AuthenticatedRequest, res: Response) {
  try {
    const { planId } = req.params;
    const userId = getUserId(req);

    const result = await NegativeGenerationService.estimate(planId, userId);
    if (result.status === 'plan_not_found') {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    res.json({ success: true, data: result.data });
  } catch (error) {
    handleControllerError(res, error, 'Failed to estimate negatives');
  }
}

/**
 * POST /regression/plans/:planId/sources/:testCaseId/regenerate-negatives
 * Delete + regenerate negatives for one source test case.
 */
export async function regenerateNegatives(req: AuthenticatedRequest, res: Response) {
  try {
    const { testCaseId } = req.params;
    const userId = getUserId(req);

    const result = await NegativeGenerationService.regenerate(testCaseId, userId);
    if (result.status === 'not_found') {
      res.status(404).json({ success: false, error: 'Test case not found' });
      return;
    }
    if (result.status === 'forbidden') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }
    if (result.status === 'busy') {
      res.status(409).json({
        success: false,
        error: 'Negatives are already being generated for this test case. Try again shortly.',
      });
      return;
    }
    if (result.status === 'error') {
      res.status(500).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, data: { createdCount: result.createdIds.length } });
  } catch (error) {
    handleControllerError(res, error, 'Failed to regenerate negatives');
  }
}

/**
 * PATCH /regression/negatives/:negativeId
 * Enable/disable one generated negative (kept in DB either way).
 */
export async function setNegativeEnabled(req: AuthenticatedRequest, res: Response) {
  try {
    const { negativeId } = req.params;
    const { enabled } = req.body;
    const userId = getUserId(req);

    if (enabled !== true && enabled !== false) {
      res.status(400).json({ success: false, error: 'enabled must be true or false' });
      return;
    }

    const result = await NegativeGenerationService.setNegativeEnabled(negativeId, userId, enabled);
    if (result.status === 'not_found') {
      res.status(404).json({ success: false, error: 'Negative test not found' });
      return;
    }
    if (result.status === 'forbidden') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    handleControllerError(res, error, 'Failed to update negative');
  }
}

/**
 * DELETE /regression/negatives/:negativeId
 * Delete one generated negative.
 */
export async function deleteNegative(req: AuthenticatedRequest, res: Response) {
  try {
    const { negativeId } = req.params;
    const userId = getUserId(req);

    const result = await NegativeGenerationService.deleteNegative(negativeId, userId);
    if (result.status === 'not_found') {
      res.status(404).json({ success: false, error: 'Negative test not found' });
      return;
    }
    if (result.status === 'forbidden') {
      res.status(403).json({ success: false, error: 'Forbidden' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    handleControllerError(res, error, 'Failed to delete negative');
  }
}

/**
 * PATCH /regression/plans/:planId/negatives/bulk
 * Enable/disable many negatives at once. Authorized per-negative by project in
 * the service (the planId only scopes the route). Body: { negativeIds, enabled }.
 */
export async function bulkSetNegativesEnabled(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = getUserId(req);
    const { negativeIds, enabled } = req.body;

    if (!Array.isArray(negativeIds) || negativeIds.length === 0) {
      res.status(400).json({ success: false, error: 'negativeIds must be a non-empty array' });
      return;
    }
    if (enabled !== true && enabled !== false) {
      res.status(400).json({ success: false, error: 'enabled must be true or false' });
      return;
    }

    const result = await NegativeGenerationService.bulkSetEnabled(negativeIds, userId, enabled);
    res.json({ success: true, data: { updated: result.updated, forbidden: result.forbidden } });
  } catch (error) {
    handleControllerError(res, error, 'Failed to bulk-update negatives');
  }
}

/**
 * DELETE /regression/plans/:planId/negatives/bulk
 * Delete many negatives at once. Authorized per-negative by project in the
 * service. Body: { negativeIds }.
 */
export async function bulkDeleteNegatives(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = getUserId(req);
    const { negativeIds } = req.body;

    if (!Array.isArray(negativeIds) || negativeIds.length === 0) {
      res.status(400).json({ success: false, error: 'negativeIds must be a non-empty array' });
      return;
    }

    const result = await NegativeGenerationService.bulkDelete(negativeIds, userId);
    res.json({ success: true, data: { deleted: result.deleted, forbidden: result.forbidden } });
  } catch (error) {
    handleControllerError(res, error, 'Failed to bulk-delete negatives');
  }
}
