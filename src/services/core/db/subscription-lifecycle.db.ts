import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for subscription-lifecycle emails (plan-expiring sweep).
 * Pure Supabase queries — no business logic, no orchestration.
 * Each function throws on DB/network error; the calling service wraps it.
 */

export interface ExpiringUserRow {
  id: string;
  email: string | null;
  name: string | null;
  current_period_end: string;
  cancel_at_period_end: boolean | null;
}

/**
 * Users whose paid subscription period ends within `withinDays` (and is still
 * in the future), excluding anyone already reminded for THIS period end
 * (expiry_reminder_sent_for equals the current period end). A new period
 * (different current_period_end) re-arms the reminder automatically.
 */
/**
 * Hard cap on candidates loaded per sweep. A daily sweep over a 3-day window
 * should never approach this; it's a backstop against loading the whole table
 * into memory. The caller logs when the cap is hit (no silent truncation).
 */
export const EXPIRING_USERS_LIMIT = 2000;

export async function fetchExpiringUsers(withinDays: number): Promise<ExpiringUserRow[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, name, current_period_end, cancel_at_period_end, expiry_reminder_sent_for')
    .eq('plan_status', 'paid')
    .not('current_period_end', 'is', null)
    .gt('current_period_end', now.toISOString())
    .lte('current_period_end', horizon.toISOString())
    .order('current_period_end', { ascending: true })
    .limit(EXPIRING_USERS_LIMIT);

  if (error) throw error;

  // Filter the already-reminded-for-this-period rows in code: PostgREST can't
  // express "column A != column B" cleanly, and the candidate set is tiny.
  return (data || [])
    .filter((u) => u.email && u.expiry_reminder_sent_for !== u.current_period_end)
    .map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      current_period_end: u.current_period_end as string,
      cancel_at_period_end: u.cancel_at_period_end,
    }));
}

/**
 * Mark a user as reminded for a specific period end (dedup marker), but only
 * if the period end hasn't changed since we read it — guards against marking a
 * stale period after a concurrent Stripe webhook advanced it.
 */
export async function markExpiryReminderSent(userId: string, periodEnd: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ expiry_reminder_sent_for: periodEnd })
    .eq('id', userId)
    .eq('current_period_end', periodEnd);

  if (error) throw error;
}
