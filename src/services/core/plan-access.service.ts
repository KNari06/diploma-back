import { getUserPlanSlug, isFreeSlug, userHasPaidBusinessPlan } from './db/plan-access.db';

/**
 * Whether the user is on a paid plan (anything other than 'free' / no plan).
 * Single source of truth for paid-feature gating (e.g. mobile testing).
 *
 * Credits belong to the USER account only. Two ways to be paid:
 *   1. Personal: `users.plan_id → pricing_plans.slug` is non-'free' (pro/ultra).
 *   2. B2B: a paid `user_credits.subscription_plan` (small_business /
 *      middle_business / enterprise). B2B slugs have no `pricing_plans` row so
 *      the personal check can't see them — without this a paying B2B user would
 *      be wrongly blocked from paid features.
 */
export async function isPaidUser(userId: string): Promise<boolean> {
  const slug = await getUserPlanSlug(userId);
  if (!isFreeSlug(slug)) return true;
  return userHasPaidBusinessPlan(userId);
}
