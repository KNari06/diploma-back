/**
 * Explorations Controller
 * REST API for listing and viewing exploration runs + discovered test cases.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

function handleError(res: Response, error: unknown, message: string): void {
  logger.error(`[EXPLORATIONS_API] ${message}`, {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ success: false, error: message });
}

/**
 * List exploration runs for a project.
 * GET /api/v1/explorations?projectId=xxx
 */
export async function listExplorations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId query parameter is required' });
      return;
    }

    const userId = getUserId(req);

    const { data, error } = await supabaseAdmin
      .from('exploration_runs')
      .select('id, exploration_id, entry_url, status, summary, duration_ms, test_cases_count, started_at, completed_at')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('[EXPLORATIONS_API] DB error listing explorations', { error: error.message });
      res.status(500).json({ success: false, error: 'Failed to list explorations' });
      return;
    }

    res.json({ success: true, data: data || [] });
  } catch (error) {
    handleError(res, error, 'Failed to list explorations');
  }
}

/**
 * Get a single exploration run with summary.
 * GET /api/v1/explorations/:explorationId
 */
export async function getExploration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    const { data, error } = await supabaseAdmin
      .from('exploration_runs')
      .select('*')
      .eq('exploration_id', explorationId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'Failed to get exploration');
  }
}

/**
 * Get discovered test cases for an exploration.
 * GET /api/v1/explorations/:explorationId/test-cases
 */
export async function getExplorationTestCases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    // Verify ownership
    const { data: run, error: runError } = await supabaseAdmin
      .from('exploration_runs')
      .select('project_id')
      .eq('exploration_id', explorationId)
      .eq('user_id', userId)
      .single();

    if (runError || !run) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    // Get test cases created by this exploration
    const { data: testCases, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, start_url, steps_json, tags, priority, status, created_at')
      .eq('project_id', run.project_id)
      .eq('user_id', userId)
      .eq('source', 'exploration')
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('[EXPLORATIONS_API] DB error getting test cases', { error: error.message });
      res.status(500).json({ success: false, error: 'Failed to get test cases' });
      return;
    }

    res.json({ success: true, data: testCases || [] });
  } catch (error) {
    handleError(res, error, 'Failed to get exploration test cases');
  }
}

/**
 * Add selected exploration test cases to a regression plan.
 * POST /api/v1/explorations/:explorationId/add-to-regression
 */
export async function addToRegressionPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const { testCaseIds, regressionPlanId } = req.body;
    const userId = getUserId(req);

    if (!testCaseIds?.length || !regressionPlanId) {
      res.status(400).json({
        success: false,
        error: 'testCaseIds (array) and regressionPlanId are required',
      });
      return;
    }

    // Verify exploration ownership
    const { data: run } = await supabaseAdmin
      .from('exploration_runs')
      .select('project_id')
      .eq('exploration_id', explorationId)
      .eq('user_id', userId)
      .single();

    if (!run) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    // Verify plan ownership
    const { data: plan } = await supabaseAdmin
      .from('regression_plans')
      .select('id')
      .eq('id', regressionPlanId)
      .eq('user_id', userId)
      .single();

    if (!plan) {
      res.status(404).json({ success: false, error: 'Regression plan not found' });
      return;
    }

    // Get the test cases to add
    const { data: testCases, error: tcError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .in('id', testCaseIds)
      .eq('user_id', userId);

    if (tcError || !testCases?.length) {
      res.status(400).json({ success: false, error: 'No valid test cases found' });
      return;
    }

    // Get existing max order_index in plan (maybeSingle for empty plans)
    const { data: maxOrder } = await supabaseAdmin
      .from('regression_plan_items')
      .select('order_index')
      .eq('plan_id', regressionPlanId)
      .order('order_index', { ascending: false })
      .limit(1)
      .maybeSingle();

    let nextOrder = (maxOrder?.order_index ?? -1) + 1;

    // Insert plan items with required fields for CHECK constraint
    const items = testCases.map((tc) => ({
      plan_id: regressionPlanId,
      test_case_id: tc.id,
      item_type: 'test_case',
      test_case_type: 'ui',
      order_index: nextOrder++,
    }));

    const { error: insertError } = await supabaseAdmin
      .from('regression_plan_items')
      .insert(items);

    if (insertError) {
      logger.error('[EXPLORATIONS_API] Failed to add to regression plan', { error: insertError.message });
      res.status(500).json({ success: false, error: 'Failed to add test cases to plan' });
      return;
    }

    res.json({
      success: true,
      data: { added: testCases.length, planId: regressionPlanId },
    });
  } catch (error) {
    handleError(res, error, 'Failed to add to regression plan');
  }
}

/**
 * Get exploration state snapshot (checkpoint + summary).
 * Useful for debugging running/stuck explorations.
 * GET /api/v1/explorations/:explorationId/state
 */
export async function getExplorationState(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    const { data, error } = await supabaseAdmin
      .from('exploration_runs')
      .select('exploration_id, status, config, summary, budget_used, duration_ms, test_cases_count, error_message, checkpoint, started_at, completed_at')
      .eq('exploration_id', explorationId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    // Build state overview
    const state: Record<string, any> = {
      explorationId: data.exploration_id,
      status: data.status,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      durationMs: data.duration_ms,
      testCasesCount: data.test_cases_count,
      errorMessage: data.error_message,
      config: data.config,
      summary: data.summary,
      budgetUsed: data.budget_used,
    };

    // Include checkpoint data for running explorations (debug)
    if (data.status === 'running' && data.checkpoint) {
      state.checkpoint = {
        phase: data.checkpoint.phase,
        flowsCompleted: data.checkpoint.completedFlows?.length ?? 0,
        flowsQueued: data.checkpoint.pendingEntryPoints?.length ?? 0,
        pagesVisited: data.checkpoint.tree?.nodes?.length ?? 0,
        lastActivity: data.checkpoint.lastCheckpointAt,
      };
    }

    res.json({ success: true, data: state });
  } catch (error) {
    handleError(res, error, 'Failed to get exploration state');
  }
}
