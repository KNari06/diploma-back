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
 * Write the canonical plan mirror onto the `users` row and reset the
 * per-period credit counters. Mirrors the columns the old `assignPlanToUser`
 * wrote, plus `plan` (text slug) and `plan_status` so the `users`-level
 * mirrors read by the backend gate stay consistent.
 */
export async function writeUserPlan(params: {
  userId: string;
  planId: string;
  planSlug: string;
  planStatus: 'paid' | 'free' | null;
}): Promise<boolean> {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      plan_id: params.planId,
      plan: params.planSlug,
      plan_status: params.planStatus,
      plan_started_at: now.toISOString(),
      credits_used_today: 0,
      credits_used_this_month: 0,
      last_credit_reset_date: today,
      monthly_reset_date: today,
    })
    .eq('id', params.userId);

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
