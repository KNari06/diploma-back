/**
 * Auto-learn admin endpoints (Phase 5).
 *
 * Scope is per-project: only the project owner can toggle auto-learn or
 * read stats. (Admin override is intentionally NOT added here — this is
 * data the owner needs to manage, not platform-global telemetry.)
 */

import { supabaseAdmin } from '@/db/supabase';
import { errorResponse, successResponse } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function isProjectOwner(userId: string, projectId: string): Promise<boolean> {
  if (!UUID_REGEX.test(projectId)) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) return false;
    return data.user_id === userId;
  } catch (err) {
    logger.error('[AUTO_LEARN_API] owner check failed', { err, userId, projectId });
    return false;
  }
}

/**
 * GET /api/v1/kb/auto-learn/status?projectId=xxx
 * Returns current toggle state + chunk stats for the project.
 */
export async function getAutoLearnStatus(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = req.query.projectId as string;
    if (!projectId || !UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid or missing projectId', 400);
      return;
    }

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const { data: proj, error: projErr } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle();

    if (projErr || !proj) {
      errorResponse(res, 'Project not found', 404);
      return;
    }

    const enabled = (proj.settings as Record<string, unknown> | null)?.autoLearnFromTests === true;

    // Chunk stats — counts are cheap and useful for "is this working?"
    const { count: currentCount } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('format', 'auto:trace')
      .eq('is_current', true);

    const { count: retiredCount } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('format', 'auto:trace')
      .eq('is_current', false);

    successResponse(res, {
      enabled,
      stats: {
        currentChunks: currentCount ?? 0,
        retiredChunks: retiredCount ?? 0,
      },
    });
  } catch (error: any) {
    logger.error('[AUTO_LEARN_API] getAutoLearnStatus failed', { error });
    if (!res.headersSent) errorResponse(res, error.message || 'Failed', 500);
  }
}

/**
 * PUT /api/v1/kb/auto-learn/toggle
 * Body: { projectId: string, enabled: boolean }
 *
 * Enables or disables auto-learn. Disabling does NOT retire existing
 * auto:trace chunks — the TTL sweep will retire stale ones over time. If
 * the user wants an immediate purge, they can call the delete endpoint
 * (not exposed yet; left for when a UI need arises).
 */
export async function toggleAutoLearn(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const { projectId, enabled, purge } = req.body ?? {};
    if (!projectId || typeof projectId !== 'string' || !UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid projectId', 400);
      return;
    }
    if (typeof enabled !== 'boolean') {
      errorResponse(res, 'enabled must be boolean', 400);
      return;
    }
    const shouldPurge = purge === true;
    if (shouldPurge && enabled !== false) {
      errorResponse(res, 'purge=true only valid when enabled=false', 400);
      return;
    }

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    // Read-modify-write on settings JSONB. projects.settings has default '{}'.
    const { data: proj, error: readErr } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle();

    if (readErr || !proj) {
      errorResponse(res, 'Project not found', 404);
      return;
    }

    const nextSettings: Record<string, unknown> = {
      ...((proj.settings as Record<string, unknown> | null) ?? {}),
      autoLearnFromTests: enabled,
    };

    const { error: updateErr } = await supabaseAdmin
      .from('projects')
      .update({ settings: nextSettings })
      .eq('id', projectId);

    if (updateErr) {
      logger.error('[AUTO_LEARN_API] toggle update failed', {
        error: updateErr.message,
        code: updateErr.code,
        projectId,
      });
      errorResponse(res, 'Failed to update project settings', 500);
      return;
    }

    // Optional immediate purge of auto-learned chunks. Default behaviour on
    // disable is to leave existing chunks (TTL sweep will retire them);
    // purge=true forces an immediate hard delete when the owner wants to
    // wipe all learned facts (e.g. before a demo, after a product pivot).
    let purgedCount: number | undefined;
    if (shouldPurge) {
      const { data: purgeData, error: purgeErr, count } = await supabaseAdmin
        .from('project_kb_chunks')
        .delete({ count: 'exact' })
        .eq('project_id', projectId)
        .eq('format', 'auto:trace')
        .select('id');

      if (purgeErr) {
        logger.warn('[AUTO_LEARN_API] purge failed (non-fatal, toggle already applied)', {
          error: purgeErr.message,
          code: purgeErr.code,
          projectId,
        });
      } else {
        purgedCount = count ?? (Array.isArray(purgeData) ? purgeData.length : 0);
      }
    }

    logger.info('[AUTO_LEARN_API] toggled', {
      projectId,
      enabled,
      userId,
      purgedCount,
    });
    successResponse(res, {
      enabled,
      ...(purgedCount !== undefined ? { purgedCount } : {}),
    });
  } catch (error: any) {
    logger.error('[AUTO_LEARN_API] toggleAutoLearn failed', { error });
    if (!res.headersSent) errorResponse(res, error.message || 'Failed', 500);
  }
}

/**
 * GET /api/v1/kb/auto-learn/chunks?projectId=xxx&limit=50
 * Returns current auto:trace chunks for debugging / admin review.
 */
export async function listAutoLearnChunks(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    const projectId = req.query.projectId as string;
    if (!projectId || !UUID_REGEX.test(projectId)) {
      errorResponse(res, 'Invalid or missing projectId', 400);
      return;
    }

    const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 50;

    if (!(await isProjectOwner(userId, projectId))) {
      errorResponse(res, 'Access denied to this project', 403);
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('id, file_name, content, metadata, uploaded_at, is_current')
      .eq('project_id', projectId)
      .eq('format', 'auto:trace')
      .eq('is_current', true)
      .order('uploaded_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[AUTO_LEARN_API] list failed', {
        error: error.message,
        code: error.code,
      });
      errorResponse(res, 'Failed to list chunks', 500);
      return;
    }

    successResponse(res, {
      limit,
      total: Array.isArray(data) ? data.length : 0,
      chunks: Array.isArray(data) ? data : [],
    });
  } catch (error: any) {
    logger.error('[AUTO_LEARN_API] listAutoLearnChunks failed', { error });
    if (!res.headersSent) errorResponse(res, error.message || 'Failed', 500);
  }
}
