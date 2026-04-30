import { aiLogBuffer } from '@/services/ai/logging/ai-log-buffer';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

const VALID_SOURCES = new Set([
  'chat',
  'analysis',
  'explorer-web',
  'explorer-mobile',
  'ai-selector',
  'ai-check',
  'form-filler',
]);

const VALID_STATUSES = new Set(['succeeded', 'failed']);

const VALID_ENTITY_TYPES = new Set([
  'regression_run',
  'test_execution',
  'chat_session',
  'exploration_run',
  'mobile_run',
]);

/**
 * GET /api/v1/ai-logs
 *
 * Returns the in-memory AI action log entries for the authenticated user,
 * newest first. Backfill only — live updates arrive over WebSocket as
 * `ai:log:new`. No database is involved; entries are lost on process restart.
 *
 * Query params (all optional):
 *   source       — one of VALID_SOURCES
 *   status       — 'succeeded' | 'failed'
 *   entity_type  — one of VALID_ENTITY_TYPES
 *   entity_id    — string (only meaningful with entity_type)
 *   q            — free-text search on `summary`
 *   limit        — 1..200 (default 50)
 */
export const listAILogs = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const source = req.query.source as string | undefined;
    const status = req.query.status as string | undefined;
    const entityType = req.query.entity_type as string | undefined;
    const entityId = req.query.entity_id as string | undefined;
    const q = req.query.q as string | undefined;
    const limitParam = req.query.limit as string | undefined;

    let limit = 50;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 200) limit = parsed;
    }

    const rows = aiLogBuffer.query({
      userId,
      source: source && VALID_SOURCES.has(source) ? source : undefined,
      status: status && VALID_STATUSES.has(status) ? status : undefined,
      entityType: entityType && VALID_ENTITY_TYPES.has(entityType) ? entityType : undefined,
      entityId: entityType && VALID_ENTITY_TYPES.has(entityType) ? entityId : undefined,
      q: q && q.trim().length > 0 ? q.trim() : undefined,
      limit,
    });

    // No DB cursor — buffer is small (<= 500 entries). `next_cursor` always null.
    res.json({
      success: true,
      rows,
      next_cursor: null,
      count: rows.length,
    });
  } catch (err) {
    logger.error('[AI_LOGS_API] Unhandled error', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
};
