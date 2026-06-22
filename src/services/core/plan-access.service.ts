import { getUserPlanSlug } from './db/plan-access.db';

/**
 * Plan slugs that count as "free" — no access to paid-only features (mobile).
 * A null/absent plan is treated as free.
 */
const FREE_PLAN_SLUGS = new Set(['free']);

/**
 * Whether the user is on a paid plan (anything other than 'free' / no plan).
 * Single source of truth for paid-feature gating (e.g. mobile testing).
 */
export async function isPaidUser(userId: string): Promise<boolean> {
  const slug = await getUserPlanSlug(userId);
  if (!slug) return false;
  return !FREE_PLAN_SLUGS.has(slug);
}
