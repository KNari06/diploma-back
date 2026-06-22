import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { EmailService } from '@/services/core/email.service';
import {
  fetchExpiringUsers,
  markExpiryReminderSent,
  EXPIRING_USERS_LIMIT,
} from '@/services/core/db/subscription-lifecycle.db';

/**
 * Subscription-lifecycle emails. Today: the "plan expiring soon" reminder,
 * driven by a daily sweep (ExpiringPlansJob). Webhook-driven lifecycle emails
 * (payment failed, canceled) live in the Stripe controller next to their
 * events — only the time-based reminder needs orchestration here.
 */
export class SubscriptionLifecycleService {
  /** Remind users whose paid period ends within this many days. */
  static readonly DEFAULT_WITHIN_DAYS = 3;

  /**
   * Send the "your plan expires soon" email to every eligible user, then mark
   * each as reminded so the daily sweep doesn't re-send within the same period.
   * Best-effort per user: one failure never aborts the batch. Returns counts.
   */
  static async remindExpiringPlans(
    withinDays: number = this.DEFAULT_WITHIN_DAYS
  ): Promise<{ sent: number; failed: number; candidates: number }> {
    const users = await fetchExpiringUsers(withinDays);
    if (users.length >= EXPIRING_USERS_LIMIT) {
      // Cap hit — some expiring users may be deferred to the next sweep. Loud
      // so we notice before it becomes a silent coverage gap.
      logger.warn('[SUB_LIFECYCLE] Expiring-plan candidate cap hit', {
        limit: EXPIRING_USERS_LIMIT,
      });
    }
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      if (!user.email) continue;
      try {
        const result = await EmailService.sendPlanExpiringEmail({
          recipientEmail: user.email,
          recipientName: user.name || undefined,
          expiresAt: user.current_period_end,
          // Only claim auto-renew when Stripe explicitly says the sub does NOT
          // cancel at period end (=== false). A null/unknown value is treated
          // as "will end" — better to nudge the user to renew than to falsely
          // reassure them their card will be charged.
          willAutoRenew: user.cancel_at_period_end === false,
          frontendUrl: env.FRONTEND_URL,
        });
        if (!result.success) {
          failed += 1;
          logger.error('[SUB_LIFECYCLE] Expiring-plan email not sent', {
            userId: user.id,
            error: result.error,
          });
          continue; // don't mark reminded — retry on the next sweep
        }
        sent += 1;
        // Mark only after a successful send so a mail failure retries tomorrow.
        await markExpiryReminderSent(user.id, user.current_period_end);
      } catch (err) {
        failed += 1;
        logger.error('[SUB_LIFECYCLE] Expiring-plan reminder failed for user', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[SUB_LIFECYCLE] Expiring-plan sweep complete', {
      candidates: users.length,
      sent,
      failed,
    });
    return { sent, failed, candidates: users.length };
  }
}
