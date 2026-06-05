/**
 * AI call-logs retention sweep.
 *
 * ai_call_logs stores REDACTED LLM prompt/completion text (opt-in, for
 * hallucination debugging). Each row carries a STORED `expires_at`
 * (created_at + 30 days). This daily sweep hard-deletes rows past their TTL so
 * sensitive debug data never lingers indefinitely — the retention half of the
 * privacy contract (the redaction-before-write half lives in redactForPersist).
 *
 * Run-to-completion, idempotent: deleting already-expired rows again is a no-op.
 * Best-effort: a failure is logged and surfaced to the daily runner, but it's a
 * housekeeping task — it must never throw into request paths.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export class AiCallLogsRetentionJob {
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Start the daily sweep loop (local-dev persistent scheduler only). The
   * canonical production path is job-daily.ts (Cloud Run Job) calling tick().
   * Kicks an immediate pass so a fresh process doesn't wait 24h.
   */
  static start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.intervalId) {
      logger.warn('[AI_CALL_LOGS_RETENTION] Already running');
      return;
    }
    logger.info('[AI_CALL_LOGS_RETENTION] Starting sweep loop', { intervalMs });
    this.tick().catch((error) => {
      logger.error('[AI_CALL_LOGS_RETENTION] Initial sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.intervalId = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('[AI_CALL_LOGS_RETENTION] Interval sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[AI_CALL_LOGS_RETENTION] Stopped');
    }
  }

  /** Single sweep pass. Safe to invoke manually. */
  static async tick(): Promise<{ deleted: number }> {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('ai_call_logs')
      .delete()
      .lt('expires_at', nowIso)
      .select('id');

    if (error) {
      logger.warn('[AI_CALL_LOGS_RETENTION] Delete of expired rows failed', {
        error: error.message,
      });
      throw new Error(`ai_call_logs retention failed: ${error.message}`);
    }

    const deleted = (data as Array<{ id: string }> | null)?.length ?? 0;
    logger.info('[AI_CALL_LOGS_RETENTION] Expired rows purged', { deleted });
    return { deleted };
  }
}
