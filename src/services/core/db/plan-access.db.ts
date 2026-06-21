import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

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
