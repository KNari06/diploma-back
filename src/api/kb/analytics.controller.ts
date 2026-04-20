import { supabaseAdmin } from '@/db/supabase';
import { errorResponse, successResponse } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * KB retrieval analytics endpoints (admin only).
 *
 * These surface data from kb_retrieval_events to answer:
 *   - What are users actually asking?
 *   - Which files get retrieved most?
 *   - Which files correlate with 👎 feedback (dead-file candidates)?
 */

async function isAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return false;
    return data.role === 'admin';
  } catch (error) {
    logger.error('[KB_ANALYTICS] Admin check failed', { error, userId });
    return false;
  }
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumeric(raw: unknown, min: number, max: number, fallback: number): number {
  const n = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * GET /api/v1/kb/analytics/stats?days=7
 * Overview: totals, top queries, top files, by call_site
 */
export async function getRetrievalStats(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    if (!(await isAdmin(userId))) {
      errorResponse(res, 'Admin access required', 403);
      return;
    }

    const days = clampInt(req.query.days, 1, 365, 7);

    const { data, error } = await supabaseAdmin.rpc('kb_retrieval_stats', { p_days: days });
    if (error) {
      logger.error('[KB_ANALYTICS] kb_retrieval_stats failed', {
        error: error.message,
        code: error.code,
        days,
      });
      errorResponse(res, 'Failed to load stats', 500);
      return;
    }

    successResponse(res, { windowDays: days, ...(data && typeof data === 'object' ? data : {}) });
  } catch (error: any) {
    logger.error('[KB_ANALYTICS] getRetrievalStats failed', { error });
    if (!res.headersSent) errorResponse(res, error.message || 'Failed', 500);
  }
}

/**
 * GET /api/v1/kb/analytics/dead-files?days=30&minRetrievals=10&dislikeRatio=0.25
 * Files retrieved often but correlated with negative or no positive feedback.
 */
export async function getDeadFiles(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    if (!(await isAdmin(userId))) {
      errorResponse(res, 'Admin access required', 403);
      return;
    }

    const days = clampInt(req.query.days, 1, 365, 30);
    const minRetrievals = clampInt(req.query.minRetrievals, 1, 10_000, 10);
    const dislikeRatio = clampNumeric(req.query.dislikeRatio, 0, 1, 0.25);

    const { data, error } = await supabaseAdmin.rpc('kb_dead_files', {
      p_days: days,
      p_min_retrievals: minRetrievals,
      p_dislike_ratio: dislikeRatio,
    });

    if (error) {
      logger.error('[KB_ANALYTICS] kb_dead_files failed', {
        error: error.message,
        code: error.code,
        days,
        minRetrievals,
        dislikeRatio,
      });
      errorResponse(res, 'Failed to load dead files', 500);
      return;
    }

    successResponse(res, {
      windowDays: days,
      minRetrievals,
      dislikeRatio,
      files: Array.isArray(data) ? data : [],
    });
  } catch (error: any) {
    logger.error('[KB_ANALYTICS] getDeadFiles failed', { error });
    if (!res.headersSent) errorResponse(res, error.message || 'Failed', 500);
  }
}

/**
 * GET /api/v1/kb/analytics/events?limit=100&offset=0
 * Raw retrieval events (for debugging). Paginated, recent first.
 */
export async function listRetrievalEvents(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 401);
      return;
    }

    if (!(await isAdmin(userId))) {
      errorResponse(res, 'Admin access required', 403);
      return;
    }

    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);

    const { data, error, count } = await supabaseAdmin
      .from('kb_retrieval_events')
      .select(
        'event_id, created_at, user_id, session_id, message_id, project_id, query, call_site, source_files, global_count, project_count, latency_ms',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[KB_ANALYTICS] listRetrievalEvents failed', {
        error: error.message,
        code: error.code,
      });
      errorResponse(res, 'Failed to load events', 500);
      return;
    }

    successResponse(res, {
      limit,
      offset,
      total: count ?? 0,
      events: Array.isArray(data) ? data : [],
    });
  } catch (error: any) {
    logger.error('[KB_ANALYTICS] listRetrievalEvents failed', { error });
    if (!res.headersSent) errorResponse(res, error.message || 'Failed', 500);
  }
}
