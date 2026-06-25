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
 * Whether the user belongs to ANY workspace on a paid plan — either as the
 * owner or an active member. Reads `workspace_credits.subscription_plan` for
 * the user's owned + member workspaces; paid = any non-'free' active plan.
 *
 * Needed because B2B plans live on `workspace_credits`, not `users.plan_id`,
 * so a B2B user can have a paid workspace while their own `plan_id` is still
 * free/null. Returns false on any error (caller fails closed). DB-only.
 *
 * Note the id-type split: `workspaces.user_id` is text, `workspace_members.user_id` is uuid.
 */
export async function userHasPaidWorkspace(userId: string): Promise<boolean> {
  const [owned, member] = await Promise.all([
    supabaseAdmin.from('workspaces').select('id').eq('user_id', userId),
    supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .eq('status', 'active'),
  ]);

  if (owned.error) {
    logger.warn('[PLAN_ACCESS] Failed to read owned workspaces', { userId, error: owned.error.message });
    return false;
  }
  if (member.error) {
    logger.warn('[PLAN_ACCESS] Failed to read workspace memberships', { userId, error: member.error.message });
    return false;
  }

  const workspaceIds = [
    ...(owned.data?.map((w) => w.id) ?? []),
    ...(member.data?.map((m) => m.workspace_id) ?? []),
  ].filter(Boolean);
  if (workspaceIds.length === 0) return false;

  const { data, error } = await supabaseAdmin
    .from('workspace_credits')
    .select('workspace_id')
    .in('workspace_id', workspaceIds)
    .eq('subscription_status', 'active')
    .neq('subscription_plan', 'free')
    .limit(1);

  if (error) {
    logger.warn('[PLAN_ACCESS] Failed to read workspace credits', { userId, error: error.message });
    return false;
  }
  return (data?.length ?? 0) > 0;
}
