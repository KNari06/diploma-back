import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * Plan slugs that count as "free" — no access to paid-only features (mobile).
 * A null/absent plan is treated as free. Single source shared by the plan
 * gate (isPaidUser) and the plan facade (PlanService.setUserPlan).
 */
export const FREE_PLAN_SLUGS = new Set(['free']);

/** Whether a slug (or null/absent) counts as a free tier. */
export function isFreeSlug(slug: string | null | undefined): boolean {
  return !slug || FREE_PLAN_SLUGS.has(slug);
}

/**
 * Resolve a user's current plan slug ('free' | 'pro' | 'ultra' | ...).
 *
 * Reads `users.plan_id → pricing_plans.slug`. Returns null when the user has
 * no plan row (treated as free by callers). DB-only — no business logic here.
 */
export async function getUserPlanSlug(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('plan_id, pricing_plans!plan_id(slug)')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.warn('[PLAN_ACCESS] Failed to read user plan slug', {
      userId,
      error: error.message,
    });
    return null;
  }

  const joined = (data as { pricing_plans?: { slug?: string } | { slug?: string }[] } | null)
    ?.pricing_plans;
  if (!joined) return null;
  const plan = Array.isArray(joined) ? joined[0] : joined;
  return plan?.slug ?? null;
}

/**
 * Whether the user holds a paid B2B plan on their own credit row.
 *
 * Credits + plan tier belong to the USER account (see PlanService / Stripe
 * webhook → UserCreditsService.grantBusinessPlan): a B2B invoice sets
 * `user_credits.subscription_plan` to the B2B slug (small_business /
 * middle_business / enterprise) with `subscription_status = 'active'`. B2B slugs
 * have no `pricing_plans` row, so `getUserPlanSlug` (users.plan_id join) can't
 * see them — this reads `user_credits` directly so a paying B2B user isn't
 * wrongly blocked from paid features (mobile). Returns false on any error
 * (caller fails closed). DB-only.
 */
export async function userHasPaidBusinessPlan(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('user_credits')
    .select('subscription_plan')
    .eq('user_id', userId)
    .eq('subscription_status', 'active')
    .neq('subscription_plan', 'free')
    .maybeSingle();

  if (error) {
    logger.warn('[PLAN_ACCESS] Failed to read user_credits plan', { userId, error: error.message });
    return false;
  }
  return !!data && !isFreeSlug(data.subscription_plan);
}
