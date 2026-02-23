/**
 * Tests Controller
 * Unified endpoint for listing all UI tests from all sources (Runs/Debug page)
 */

import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
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

type TestSource = 'regression' | 'chat' | 'manual' | 'intelligent' | 'all';

/**
 * Determine the source of a test based on its options and flags
 */
function classifyTestSource(test: any): TestSource {
  if (test.options?.metadata?.source === 'intent_test_case') return 'regression';
  if (test.intelligent_mode) return 'intelligent';
  if (test.options?.chatSessionId) return 'chat';
  return 'manual';
}

/**
 * Resolve workspace ID to an array of project IDs belonging to that workspace + user.
 */
async function resolveProjectIds(workspaceId: string, userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);

  if (error) {
    logger.error('[TESTS_API] Failed to resolve projects for workspace', { error, workspaceId });
    return [];
  }

  return (data || []).map(p => p.id);
}

/**
 * List all UI tests for a workspace (across all its projects) with source classification and pagination.
 *
 * @route GET /api/v1/tests
 * @query workspaceId (required), projectId (optional — single-project filter), source?, status?, page?, limit?
 */
export async function listTests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = getUserId(req);
    const { workspaceId, projectId, source, status, page: pageStr, limit: limitStr } = req.query;

    // Accept either workspaceId or projectId (backward compat)
    if (!workspaceId && !projectId) {
      res.status(400).json({ success: false, error: 'workspaceId or projectId query parameter is required' });
      return;
    }

    // Resolve project IDs
    let projectIds: string[];
    if (projectId && typeof projectId === 'string') {
      projectIds = [projectId];
    } else if (workspaceId && typeof workspaceId === 'string') {
      projectIds = await resolveProjectIds(workspaceId, userId);
      // Even if no projects found, we'll still query for tests with project_id = null
    } else {
      res.status(400).json({ success: false, error: 'Invalid workspaceId or projectId' });
      return;
    }

    const page = Math.max(parseInt(pageStr as string) || 1, 1);
    const limit = Math.min(Math.max(parseInt(limitStr as string) || 20, 1), 100);
    const offset = (page - 1) * limit;

    // Build base query — include tests in workspace projects OR tests with no project (legacy)
    const orConditions = [
      ...projectIds.map(id => `project_id.eq.${id}`),
      'project_id.is.null',
    ].join(',');
    let query = supabaseAdmin
      .from('tests')
      .select('id, url, status, browsers, options, intelligent_mode, test_goal, created_at, completed_at, started_at', { count: 'exact' })
      .or(orConditions)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Apply status filter at DB level
    if (status && typeof status === 'string' && status !== 'all') {
      query = query.eq('status', status);
    }

    // Source filter: if specified (and not 'all'), we need to filter in-app
    // because source is derived from JSONB fields, not a DB column.
    const sourceFilter = (source && typeof source === 'string' && source !== 'all')
      ? source as TestSource
      : null;

    if (sourceFilter) {
      // For source filtering, fetch more rows and filter in-app, then paginate
      const fetchLimit = limit * 5;
      const { data: allTests, error } = await query.limit(fetchLimit + offset);

      if (error) {
        logger.error('[TESTS_API] Failed to list tests', { error });
        res.status(500).json({ success: false, error: 'Failed to list tests' });
        return;
      }

      const filtered = (allTests || []).filter(t => classifyTestSource(t) === sourceFilter);
      const total = filtered.length;
      const pageTests = filtered.slice(offset, offset + limit);

      const testIds = pageTests.map(t => t.id);
      const bugsMap = await batchCheckHasBugs(testIds);
      const data = pageTests.map(t => mapTestToResponse(t, bugsMap));

      res.json({
        success: true,
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        timestamp: new Date(),
      });
    } else {
      // No source filter — use DB pagination directly
      const { data: tests, error, count } = await query.range(offset, offset + limit - 1);

      if (error) {
        logger.error('[TESTS_API] Failed to list tests', { error });
        res.status(500).json({ success: false, error: 'Failed to list tests' });
        return;
      }

      const total = count || 0;
      const testIds = (tests || []).map(t => t.id);
      const bugsMap = await batchCheckHasBugs(testIds);
      const data = (tests || []).map(t => mapTestToResponse(t, bugsMap));

      res.json({
        success: true,
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        timestamp: new Date(),
      });
    }
  } catch (error) {
    logger.error('[TESTS_API] Failed to list tests', { error });
    handleError(res, error, 'Failed to list tests');
  }
}

/**
 * Batch-check hasBugs for a list of test IDs.
 */
async function batchCheckHasBugs(testIds: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (!testIds.length) return map;

  const { data } = await supabaseAdmin
    .from('test_results')
    .select('test_id, ai_summary')
    .in('test_id', testIds);

  for (const row of data || []) {
    const bugs = row.ai_summary?.bugs;
    if (Array.isArray(bugs) && bugs.length > 0) {
      map.set(row.test_id, true);
    } else if (!map.has(row.test_id)) {
      map.set(row.test_id, false);
    }
  }

  return map;
}

/**
 * Map a test row to the API response format
 */
function mapTestToResponse(test: any, bugsMap: Map<string, boolean>) {
  const createdAt = test.created_at ? new Date(test.created_at).getTime() : null;
  const completedAt = test.completed_at ? new Date(test.completed_at).getTime() : null;
  const durationMs = (createdAt && completedAt) ? completedAt - createdAt : null;

  return {
    id: test.id,
    url: test.url,
    status: test.status,
    browsers: test.browsers,
    source: classifyTestSource(test),
    testGoal: test.test_goal || test.options?.testGoal || null,
    createdAt: test.created_at,
    completedAt: test.completed_at,
    durationMs: durationMs && durationMs > 0 ? durationMs : null,
    hasBugs: bugsMap.get(test.id) || false,
  };
}

function handleError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) return;

  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, error: 'Not found', message: error.message });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({ success: false, error: 'Validation error', message: error.message });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
