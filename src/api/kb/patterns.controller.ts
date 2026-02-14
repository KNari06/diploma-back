import { Request, Response } from 'express';
import { supabaseAdmin } from '@/db/supabase';
import { PatternsQueryService } from '@/services/kb/patterns-query.service';
import { successResponse, errorResponse } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PATTERNS CONTROLLER (Knowledge Base — Patterns Tab)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read-only analytics endpoints that aggregate data from test execution
 * history. Shows page flows, recurring errors, and element interactions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate and extract projectId from query params
 */
function getProjectId(req: Request, res: Response): string | null {
  const projectId = req.query.projectId as string;
  if (!projectId) {
    errorResponse(res, 'projectId query parameter is required', 400);
    return null;
  }
  if (!UUID_REGEX.test(projectId)) {
    errorResponse(res, 'Invalid projectId format', 400);
    return null;
  }
  return projectId;
}

/**
 * Check if user owns the project
 */
async function isProjectOwner(userId: string, projectId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();

    if (error || !data) return false;
    return data.user_id === userId;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// OVERVIEW
// GET /api/v1/kb/patterns/overview?projectId=xxx
// ─────────────────────────────────────────────────────────────────────────
export async function getPatternsOverview(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = getProjectId(req, res);
    if (!projectId) return;

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const overview = await PatternsQueryService.getOverview(projectId);

    successResponse(res, overview);
  } catch (error: any) {
    logger.error('[PATTERNS_API] Overview failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to get patterns overview', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PAGE PATTERNS
// GET /api/v1/kb/patterns/pages?projectId=xxx&limit=20
// ─────────────────────────────────────────────────────────────────────────
export async function getPagePatterns(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = getProjectId(req, res);
    if (!projectId) return;

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const pages = await PatternsQueryService.getPagePatterns(projectId, limit);

    successResponse(res, { pages, total: pages.length });
  } catch (error: any) {
    logger.error('[PATTERNS_API] Page patterns failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to get page patterns', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ERROR PATTERNS
// GET /api/v1/kb/patterns/errors?projectId=xxx&limit=20
// ─────────────────────────────────────────────────────────────────────────
export async function getErrorPatterns(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = getProjectId(req, res);
    if (!projectId) return;

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const errors = await PatternsQueryService.getErrorPatterns(projectId, limit);

    successResponse(res, { errors, total: errors.length });
  } catch (error: any) {
    logger.error('[PATTERNS_API] Error patterns failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to get error patterns', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ELEMENT PATTERNS
// GET /api/v1/kb/patterns/elements?projectId=xxx&limit=20
// ─────────────────────────────────────────────────────────────────────────
export async function getElementPatterns(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = getProjectId(req, res);
    if (!projectId) return;

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

    const elements = await PatternsQueryService.getElementPatterns(projectId, limit);

    successResponse(res, { elements, total: elements.length });
  } catch (error: any) {
    logger.error('[PATTERNS_API] Element patterns failed', { error: error.message });
    if (res.headersSent) return;
    errorResponse(res, error.message || 'Failed to get element patterns', 500);
  }
}
