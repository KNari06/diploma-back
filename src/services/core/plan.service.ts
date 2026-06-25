import { logger } from '@/utils/core/logger';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { getCurrentPlanSlug, getPlanBySlug, writeUserPlan } from '@/services/core/db/plan.db';
import { isFreeSlug } from '@/services/core/db/plan-access.db';

/** Subscription plans understood by user_credits.subscription_plan. */
type CreditPlan = 'free' | 'basic' | 'pro' | 'ultra' | 'enterprise' | 'business';
const CREDIT_PLANS: readonly CreditPlan[] = ['free', 'basic', 'pro', 'ultra', 'enterprise', 'business'];

export interface SetUserPlanOptions {
  /**
   * Plan status mirror written to users.plan_status. Defaults to 'free' for the
   * free slug and 'paid' for any other slug. Pass `null` to clear it explicitly
   * (e.g. Stripe terminal / failed states).
   */
  status?: 'paid' | 'free' | null;
  /** Caller tag for logging/diagnostics. */
  source?: string;
  /**
   * Bypass the "never silently downgrade a paid plan to free" guard. Set true
   * only for explicit cancellations / Stripe terminal states that INTEND to
   * drop the user back to free.
   */
  skipDowngradeGuard?: boolean;
  /**
   * Reset the per-period usage counters (credits_used_today / _this_month +
   * reset dates) and plan_started_at. TRUE only for a real plan grant
   * (admin / self-serve). FALSE for Stripe mirror-sync: customer.subscription.updated
   * fires for many non-renewal reasons, so zeroing the live counters there
   * would hand the user a fresh daily+monthly allowance mid-period. Defaults
   * to false — callers that grant a plan opt in explicitly.
   */
  resetUsageCounters?: boolean;
}

/**
 * Single source of truth for USER-LEVEL plan/tier writes.
 *
 * Every code path that changes a user's plan (Stripe webhooks, admin grant,
 * self-serve provisioning) MUST funnel through {@link PlanService.setUserPlan}
 * so the three plan mirrors never desync:
 *   - users.plan_id / users.plan / users.plan_status (read by isPaidUser gate)
 *   - user_credits.subscription_plan / subscription_status / grace_limit (read
 *     by the frontend credits UI)
 *
 * This facade owns ONLY plan/tier. Credit BALANCE mutation (addCredits /
 * deductCredits / resetToPlanCredits / RPCs) and Stripe-specific columns
 * (subscription JSON, stripe_price_id, current_period_end, …) stay with their
 * existing owners — the facade does not touch them.
 *
 * Workspace B2B plan writes (workspace_credits) are NOT routed here: those
 * already write plan + status atomically in one update and never desync.
 */
export class PlanService {
  /**
   * Set a user's plan, writing all user-level mirrors consistently.
   *
   * Best-effort + logged, mirroring the surrounding services. Returns true when
   * the canonical `users` mirror was written (or the downgrade guard
   * deliberately skipped a redundant free assignment). A failure to write the
   * credit-side mirror is logged but does NOT flip the result to false — the
   * authoritative plan_id mirror has already been committed.
   */
  static async setUserPlan(
    userId: string,
    planSlug: string,
    opts: SetUserPlanOptions = {}
  ): Promise<boolean> {
    try {
      if (!userId || typeof userId !== 'string') {
        logger.error('[PLAN_SERVICE] Invalid userId in setUserPlan', { userId });
        return false;
      }

      const plan = await getPlanBySlug(planSlug);
      if (!plan) {
        logger.error('[PLAN_SERVICE] Plan not found', { planSlug, source: opts.source });
        return false;
      }

      const isFreeTarget = isFreeSlug(planSlug);

      // Never silently downgrade a paid plan to free. This protects against
      // self-serve provisioning (ensureTrialCreditsAndPlan) resetting a
      // manually-granted or Stripe-purchased plan on re-login. Skippable for
      // explicit cancellations / Stripe terminal states.
      if (isFreeTarget && !opts.skipDowngradeGuard) {
        const currentSlug = await getCurrentPlanSlug(userId);
        if (currentSlug && currentSlug !== 'free') {
          logger.info('[PLAN_SERVICE] Skipping free assignment — user already on paid plan', {
            userId: userId.substring(0, 8) + '...',
            currentSlug,
            source: opts.source,
          });
          return true;
        }
      }

      // Resolve the plan_status mirror. Default: free slug → 'free', else 'paid'.
      // An explicitly-passed status (including null) always wins.
      const planStatus: 'paid' | 'free' | null =
        opts.status !== undefined ? opts.status : isFreeTarget ? 'free' : 'paid';

      // 1) Authoritative users mirror (plan_id / plan / plan_status). Usage
      //    counters reset only for real grants (opts.resetUsageCounters).
      const wroteUser = await writeUserPlan({
        userId,
        planId: plan.id,
        planSlug,
        planStatus,
        resetUsageCounters: opts.resetUsageCounters === true,
      });
      if (!wroteUser) {
        return false;
      }

      // 2) Credit-side mirror (user_credits.subscription_plan / status /
      //    grace_limit). Delegated to the credits primitive so the per-tier
      //    grace_limit mapping has a single owner. Best-effort: a failure here
      //    is logged but does not undo the committed users mirror.
      const creditPlan: CreditPlan = (CREDIT_PLANS as readonly string[]).includes(planSlug)
        ? (planSlug as CreditPlan)
        : 'free';
      const creditStatus = isFreeTarget ? 'inactive' : 'active';

      const creditOk = await UserCreditsService.updateSubscription(userId, creditPlan, creditStatus);
      if (!creditOk) {
        logger.warn('[PLAN_SERVICE] Credit-side subscription mirror write failed (users mirror committed)', {
          userId: userId.substring(0, 8) + '...',
          planSlug,
          source: opts.source,
        });
      }

      logger.info('[PLAN_SERVICE] User plan set', {
        userId: userId.substring(0, 8) + '...',
        planSlug,
        planName: plan.name,
        planStatus,
        creditStatus,
        source: opts.source,
      });

      return true;
    } catch (error) {
      logger.error('[PLAN_SERVICE] Exception in setUserPlan', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        planSlug,
        source: opts.source,
      });
      return false;
    }
  }
}
