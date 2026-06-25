import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { getUserPlanSlug } from './plan-access.db';

/**
 * Minimal pricing_plans row used by the plan facade.
 */
export interface PlanRow {
  id: string;
  name: string;
  slug: string;
}

/**
 * Read the user's current plan slug (via plan_id → pricing_plans.slug).
 * Re-exported from plan-access.db — same query, single owner. Used by the
 * downgrade guard in PlanService.
 */
export const getCurrentPlanSlug = getUserPlanSlug;

/**
 * DB sublayer for PlanService — the single funnel for user-level plan writes.
 *
 * Queries + row mapping only, no business logic. The orchestration (downgrade
 * guard, credit-side delegation, status mapping) lives in plan.service.ts.
 */

/**
 * Resolve a pricing plan by slug. Returns null when no active plan matches.
 */
export async function getPlanBySlug(slug: string): Promise<PlanRow | null> {
  const { data, error } = await supabaseAdmin
    .from('pricing_plans')
    .select('id, name, slug')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    logger.error('[PLAN_DB] Error resolving plan by slug', { error: error.message, slug });
    return null;
  }
  return (data as PlanRow | null) ?? null;
}

/**
 * Write the canonical plan mirror onto the `users` row.
 *
 * Always writes the tier mirrors (`plan_id` / `plan` / `plan_status`) so the
 * backend gate stays consistent. The per-period usage counters
 * (`credits_used_today` / `credits_used_this_month` / reset dates) +
 * `plan_started_at` are reset ONLY when `resetUsageCounters` is true — a real
 * plan grant (admin / self-serve). Stripe mirror-sync calls leave them alone,
 * because `customer.subscription.updated` fires for many non-renewal reasons
 * (cancel toggle, plan change, proration, payment-method change) and zeroing
 * the live counters there would hand the user a fresh allowance mid-period.
 * Genuine period resets are owned by the reset_daily/monthly_credits RPCs.
 */
export async function writeUserPlan(params: {
  userId: string;
  planId: string;
  planSlug: string;
  planStatus: 'paid' | 'free' | null;
  resetUsageCounters: boolean;
}): Promise<boolean> {
  const update: Record<string, unknown> = {
    plan_id: params.planId,
    plan: params.planSlug,
    plan_status: params.planStatus,
  };

  if (params.resetUsageCounters) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    update.plan_started_at = now.toISOString();
    update.credits_used_today = 0;
    update.credits_used_this_month = 0;
    update.last_credit_reset_date = today;
    update.monthly_reset_date = today;
  }

  const { error } = await supabaseAdmin.from('users').update(update).eq('id', params.userId);

  if (error) {
    logger.error('[PLAN_DB] Error writing user plan mirror', {
      error: error.message,
      userId: params.userId,
      planSlug: params.planSlug,
    });
    return false;
  }
  return true;
}
