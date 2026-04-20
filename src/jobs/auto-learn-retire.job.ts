/**
 * Auto-learn retirement scheduler (Phase 5)
 *
 * Periodically retires auto:trace chunks whose `last_confirmed_at` is older
 * than the TTL (default 30 days). Retired chunks are marked is_current=false
 * — retrieval stops serving them immediately, but rows stay in the table
 * for audit.
 *
 * Runs inside the scheduler process alongside TestSchedulerJobHandler.
 * Single-instance (scheduler process is deliberately not horizontally scaled,
 * same as the existing test scheduler), so no distributed lock needed.
 */

import { retireStaleAutoLearnChunks } from '@/services/kb/auto-learn.service';
import { logger } from '@/utils/core/logger';

/** Default: retire chunks not re-confirmed in 30 days. */
const DEFAULT_TTL_DAYS = 30;

/** Default: sweep once every 24 hours. TTL is a day, no need to churn more. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AutoLearnRetireJob {
  private static intervalId: NodeJS.Timeout | null = null;
  private static inFlight = false;
  private static ttlDays = DEFAULT_TTL_DAYS;

  /**
   * Start the nightly retire sweep. Called once from the scheduler process.
   * - Kicks an immediate pass so fresh deploys don't wait 24h.
   * - In-flight guard so an overlapping next interval is skipped (shouldn't
   *   happen at 24h cadence, but cheap insurance).
   */
  static start(
    intervalMs: number = DEFAULT_INTERVAL_MS,
    ttlDays: number = DEFAULT_TTL_DAYS
  ): void {
    if (this.intervalId) {
      logger.warn('[AUTO_LEARN_RETIRE] Already running');
      return;
    }
    this.ttlDays = Math.max(1, Math.floor(ttlDays));

    logger.info('[AUTO_LEARN_RETIRE] Starting sweep loop', {
      intervalMs,
      ttlDays: this.ttlDays,
    });

    // Kick immediately, don't wait intervalMs on process start
    this.tick().catch((error) => {
      logger.error('[AUTO_LEARN_RETIRE] Initial sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.intervalId = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('[AUTO_LEARN_RETIRE] Interval sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    // No .unref() — matches TestSchedulerJobHandler pattern.
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[AUTO_LEARN_RETIRE] Stopped');
    }
  }

  /** Single sweep pass. Safe to invoke manually (e.g. from an admin route). */
  static async tick(): Promise<{ retired: number; skipped: boolean }> {
    if (this.inFlight) {
      logger.warn('[AUTO_LEARN_RETIRE] Previous sweep still running, skipping tick');
      return { retired: 0, skipped: true };
    }
    this.inFlight = true;
    const startedAt = Date.now();

    try {
      const retired = await retireStaleAutoLearnChunks(this.ttlDays);
      logger.info('[AUTO_LEARN_RETIRE] Sweep complete', {
        retired,
        ttlDays: this.ttlDays,
        durationMs: Date.now() - startedAt,
      });
      return { retired, skipped: false };
    } finally {
      this.inFlight = false;
    }
  }
}
