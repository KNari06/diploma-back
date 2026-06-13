/**
 * Expiring-plans reminder sweep.
 *
 * Daily pass that emails users whose paid subscription period ends within 3
 * days (auto-renew heads-up, or lapse warning when cancel_at_period_end). The
 * per-period dedup marker (users.expiry_reminder_sent_for) means each user is
 * reminded at most once per billing period even though the sweep runs daily.
 *
 * Runs in all three scheduler paths, same as the other 24h sweeps: the local
 * scheduler container (src/scheduler/index.ts), the prod worker bundle behind
 * the Redis leader lock (src/scheduler/leader.ts), and the Cloud Run daily cron
 * (src/scheduler/job-daily.ts). Thin wrapper: all work delegates to
 * SubscriptionLifecycleService.
 */

import { SubscriptionLifecycleService } from '@/services/core/subscription-lifecycle.service';
import { logger } from '@/utils/core/logger';

/** Default: sweep once every 24 hours. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class ExpiringPlansJob {
  private static intervalId: NodeJS.Timeout | null = null;
  private static inFlight = false;

  static start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.intervalId) {
      logger.warn('[EXPIRING_PLANS] Already running');
      return;
    }
    logger.info('[EXPIRING_PLANS] Starting sweep loop', { intervalMs });

    // Kick immediately so a fresh deploy doesn't wait 24h.
    this.tick().catch((error) => {
      logger.error('[EXPIRING_PLANS] Initial sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.intervalId = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('[EXPIRING_PLANS] Interval sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('[EXPIRING_PLANS] Stopped');
    }
  }

  /** Single sweep pass. Safe to invoke manually (e.g. from an admin route). */
  static async tick(): Promise<{ sent: number; failed: number; skipped: boolean }> {
    if (this.inFlight) {
      logger.warn('[EXPIRING_PLANS] Previous sweep still running, skipping tick');
      return { sent: 0, failed: 0, skipped: true };
    }
    this.inFlight = true;
    try {
      const { sent, failed } = await SubscriptionLifecycleService.remindExpiringPlans();
      return { sent, failed, skipped: false };
    } finally {
      this.inFlight = false;
    }
  }
}
