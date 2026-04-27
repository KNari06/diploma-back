import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { logBuffer } from '@/utils/core/log-buffer';
import { Request, Response } from 'express';

const VALID_LEVELS = new Set(['error', 'warn', 'info', 'http', 'debug']);

/**
 * GET /api/v1/ai-logs/system
 *
 * Returns the in-memory Winston ring buffer for operators flagged with
 * `users.show_logs = true`. Polled by the frontend's System Logs tab.
 *
 * Query params:
 *   since   — last seen `seq`; only entries with `seq > since` are returned.
 *   limit   — 1..1000 (default 200).
 *   level   — error|warn|info|http|debug (optional exact match).
 *
 * Response: { success, rows, latest_seq, count }.
 */
export const listSystemLogs = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  // Permission gate — read users.show_logs.
  let allowed = false;
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('show_logs, role')
      .eq('id', userId)
      .single();
    if (error) {
      logger.warn('[SYSTEM_LOGS_API] Failed to read user.show_logs', {
        userId,
        message: error.message,
      });
    } else {
      allowed = data?.show_logs === true || data?.role === 'admin';
    }
  } catch (err) {
    logger.warn('[SYSTEM_LOGS_API] DB error reading user.show_logs', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!allowed) {
    res.status(403).json({ success: false, error: 'Forbidden — show_logs is not enabled for this user' });
    return;
  }

  const sinceParam = req.query.since as string | undefined;
  const limitParam = req.query.limit as string | undefined;
  const level = req.query.level as string | undefined;

  let sinceSeq = 0;
  if (sinceParam) {
    const parsed = parseInt(sinceParam, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) sinceSeq = parsed;
  }
  let limit = 200;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 1000) limit = parsed;
  }
  const levelFilter = level && VALID_LEVELS.has(level) ? level : undefined;

  const rows = logBuffer.query({ sinceSeq, limit, level: levelFilter });

  res.json({
    success: true,
    rows,
    latest_seq: logBuffer.latestSeq(),
    count: rows.length,
  });
};
