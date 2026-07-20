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

/**
 * Write the `users` plan mirror for a B2B tier that has NO `pricing_plans` row
 * (pilot / small_business / middle_business / enterprise). Sets `plan_id = null`
 * (there is no pricing row to point at — the paid-gate still passes via the
 * secondary `userHasPaidBusinessPlan` check on `user_credits.subscription_plan`)
 * and mirrors the slug + status text so `users.plan` stops drifting from
 * `user_credits.subscription_plan` (the split-brain where a B2B user showed
 * `users.plan='pro'`). Optionally resets per-period usage counters for a real
 * grant. Credits themselves are written separately by grantBusinessPlan.
 */
export async function writeUserBusinessPlanMirror(params: {
  userId: string;
  planSlug: string;
  resetUsageCounters: boolean;
}): Promise<boolean> {
  const update: Record<string, unknown> = {
    plan_id: null,
    plan: params.planSlug,
    plan_status: 'paid',
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
    logger.error('[PLAN_DB] Error writing user business-plan mirror', {
      error: error.message,
      userId: params.userId,
      planSlug: params.planSlug,
    });
    return false;
  }
  return true;
}

/**
 * Clear the user's plan to free WITHOUT depending on a pricing_plans 'free'
 * row: writes `plan_id = null` (which getUserPlanSlug treats as free) + the
 * text/status mirrors. Fallback for a terminal downgrade (Stripe cancellation)
 * when the free plan row is missing/inactive — preserves the old guarantee
 * that a cancellation always downgrades, instead of silently no-op'ing.
 * Never resets usage counters (a cancellation is not a fresh grant).
 */
export async function clearUserPlanToFree(userId: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ plan_id: null, plan: 'free', plan_status: null })
    .eq('id', userId);

  if (error) {
    logger.error('[PLAN_DB] Error clearing user plan to free', {
      error: error.message,
      userId,
    });
    return false;
  }
  return true;
}
