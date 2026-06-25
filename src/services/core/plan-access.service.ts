import { getUserPlanSlug, isFreeSlug, userHasPaidWorkspace } from './db/plan-access.db';

/**
 * Whether the user is on a paid plan (anything other than 'free' / no plan).
 * Single source of truth for paid-feature gating (e.g. mobile testing).
 *
 * Two ways to be paid:
 *   1. Personal: `users.plan_id → pricing_plans.slug` is non-'free'.
 *   2. B2B: the user owns or actively belongs to a workspace on a paid
 *      `workspace_credits` plan. B2B plans live on the workspace, NOT on
 *      `users.plan_id`, so a B2B user can have a paid workspace while their
 *      own plan_id is still free — without this check they'd be wrongly
 *      blocked from paid features.
 */
export async function isPaidUser(userId: string): Promise<boolean> {
  const slug = await getUserPlanSlug(userId);
  if (!isFreeSlug(slug)) return true;
  return userHasPaidWorkspace(userId);
}
