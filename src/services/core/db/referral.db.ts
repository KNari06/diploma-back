import { supabaseAdmin } from '@/db/supabase';
import type { PartnerRewardEvent } from '@/types/referral.types';

/**
 * db/ sublayer for referrals by link.
 * Pure Supabase queries — no business logic, no orchestration.
 * Each function throws on DB/network error; the calling service wraps in try/catch.
 * See supabase-migrations/20260713_referrals.sql for the schema.
 */

export interface PartnerRow {
  id: string;
  code: string;
  name: string;
  email: string | null;
  auth_user_id: string | null;
  status: string;
  reward_rate: number | null;
  reward_window_count: number | null;
  created_at: string;
}

/** Columns selected for every partner read. Keep in one place so all reads match. */
const PARTNER_COLUMNS =
  'id, code, name, email, auth_user_id, status, reward_rate, reward_window_count, created_at';

// ── partner lookups ────────────────────────────────────────────────────────

/** Resolve a partner by its ?ref code, case-insensitively (uses partners_code_lower_idx). */
export async function findPartnerByCode(code: string): Promise<PartnerRow | null> {
  const { data, error } = await supabaseAdmin
    .from('partners')
    .select(PARTNER_COLUMNS)
    .ilike('code', code)
    .maybeSingle();

  if (error) throw error;
  return (data as PartnerRow | null) ?? null;
}

/** Resolve the partner owned by a login user (partners.auth_user_id). Null if the user isn't a partner. */
export async function findPartnerByAuthUserId(authUserId: string): Promise<PartnerRow | null> {
  const { data, error } = await supabaseAdmin
    .from('partners')
    .select(PARTNER_COLUMNS)
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (error) throw error;
  return (data as PartnerRow | null) ?? null;
}

/** List all partners (staff view), newest first. */
export async function listPartners(): Promise<PartnerRow[]> {
  const { data, error } = await supabaseAdmin
    .from('partners')
    .select(PARTNER_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data as PartnerRow[] | null) ?? [];
}

// ── partner writes (admin) ───────────────────────────────────────────────────

export async function insertPartner(input: {
  code: string;
  name: string;
  email: string | null;
  authUserId: string | null;
}): Promise<PartnerRow> {
  const { data, error } = await supabaseAdmin
    .from('partners')
    .insert({
      code: input.code,
      name: input.name,
      email: input.email,
      auth_user_id: input.authUserId,
    })
    .select(PARTNER_COLUMNS)
    .single();

  if (error) throw error;
  return data as PartnerRow;
}

export async function updatePartner(
  id: string,
  patch: {
    name?: string;
    email?: string | null;
    status?: string;
    authUserId?: string | null;
    rewardRate?: number | null;
    rewardWindowCount?: number | null;
  }
): Promise<PartnerRow | null> {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.email !== undefined) update.email = patch.email;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.authUserId !== undefined) update.auth_user_id = patch.authUserId;
  if (patch.rewardRate !== undefined) update.reward_rate = patch.rewardRate;
  if (patch.rewardWindowCount !== undefined) update.reward_window_count = patch.rewardWindowCount;

  const { data, error } = await supabaseAdmin
    .from('partners')
    .update(update)
    .eq('id', id)
    .select(PARTNER_COLUMNS);

  if (error) throw error;
  return (data?.[0] as PartnerRow | undefined) ?? null;
}

/** Supabase Auth returns this code when the email is already registered. */
function isEmailExists(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const status = (error as { status?: number } | null)?.status;
  return code === 'email_exists' || status === 422;
}

/**
 * Invite an email via Supabase Auth (creates the auth user + sends the invite).
 * Returns the new auth user id, or null when Supabase returned no user. Throws
 * on a hard Supabase error; the service treats login provisioning as best-effort.
 * When the email is already registered, resolves the existing synced users row
 * instead (no invite email — the account already exists) so an existing user can
 * still be promoted to a partner login.
 */
export async function inviteAuthUser(email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
  if (error) {
    if (isEmailExists(error)) return findUserIdByEmail(email);
    throw error;
  }
  return data?.user?.id ?? null;
}

/** Resolve the synced public.users row id for an email (case-insensitive). Null if none. */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();

  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Promote a synced public.users row to a partner login: role='partner' +
 * status='approved' (so the account clears the requireApproved / ProtectedRoute
 * status gate and reaches the partner dashboard). Idempotent.
 */
export async function markUserAsPartnerLogin(userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('users')
    .update({ role: 'partner', status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', userId);

  if (error) throw error;
}

// ── attribution ──────────────────────────────────────────────────────────────

/**
 * First-touch, permanent attribution. Set-once is enforced BY THE DB, not app
 * logic: the WHERE clause only matches a row whose referred_by_partner_id is
 * still NULL, so two concurrent first-auths can't both win and a later ?ref
 * can never overwrite an earlier one. Returns true when this call was the one
 * that set it (1 row updated), false otherwise (already attributed / no row).
 */
export async function attributeUserIfUnset(
  userId: string,
  partnerId: string
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ referred_by_partner_id: partnerId, referred_at: new Date().toISOString() })
    .eq('id', userId)
    .is('referred_by_partner_id', null)
    .select('id');

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Read a user's current referral partner id (null when unattributed / missing). */
export async function getUserReferralPartnerId(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('referred_by_partner_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data?.referred_by_partner_id as string | null | undefined) ?? null;
}

/** A referred user's partner id + that partner's per-partner reward overrides (null = use global default). */
export interface UserRewardConfig {
  partnerId: string;
  rewardRate: number | null;
  rewardWindowCount: number | null;
}

/**
 * Resolve the partner a referred user is attributed to, together with the
 * partner's reward overrides, in a single query. Returns null when the user has
 * no partner. Reward path uses this instead of getUserReferralPartnerId so a
 * custom per-partner rate/window is applied without a second round-trip.
 */
export async function getUserRewardConfig(userId: string): Promise<UserRewardConfig | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('referred_by_partner_id, partners:referred_by_partner_id (reward_rate, reward_window_count)')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  const row = data as {
    referred_by_partner_id: string | null;
    partners?: PartnerRewardCols | PartnerRewardCols[] | null;
  } | null;
  const partnerId = row?.referred_by_partner_id ?? null;
  if (!partnerId) return null;

  // Supabase types an embedded relation as an array; a to-one FK yields 0..1 rows.
  const rel = row?.partners;
  const partner = Array.isArray(rel) ? rel[0] ?? null : rel ?? null;
  return {
    partnerId,
    rewardRate: partner?.reward_rate ?? null,
    rewardWindowCount: partner?.reward_window_count ?? null,
  };
}

interface PartnerRewardCols {
  reward_rate: number | null;
  reward_window_count: number | null;
}

// ── reward ledger ────────────────────────────────────────────────────────────

/**
 * How many reward rows a referred user already has (across all its qualifying
 * invoices). Used to enforce the "first N monthly payments" window before
 * granting another reward.
 */
export async function countRewardsForUser(referredUserId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('partner_reward_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('referred_user_id', referredUserId);

  if (error) throw error;
  return count ?? 0;
}

/**
 * Insert a reward row for one paid invoice, idempotent via ON CONFLICT DO
 * NOTHING against the per-invoice unique index (stripe_invoice_id). A webhook
 * retry of the SAME invoice is a silent no-op — it neither errors nor
 * double-rewards. Distinct invoices (month 1, month 2) are distinct rows.
 * Returns true when a row was actually inserted.
 */
export async function insertRewardIfAbsent(input: {
  partnerId: string;
  referredUserId: string;
  eventType: PartnerRewardEvent;
  amount: number;
  currency: string;
  stripeInvoiceId: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('partner_reward_transactions')
    .upsert(
      {
        partner_id: input.partnerId,
        referred_user_id: input.referredUserId,
        event_type: input.eventType,
        amount: input.amount,
        currency: input.currency,
        stripe_invoice_id: input.stripeInvoiceId,
        metadata: input.metadata ?? {},
      },
      { onConflict: 'stripe_invoice_id', ignoreDuplicates: true }
    )
    .select('id');

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ── stats reads (batched — no N+1) ───────────────────────────────────────────

/** All referred users' ids + paid flag + referred_at for a partner. One query. */
export interface ReferredUserRow {
  id: string;
  email: string | null;
  referred_at: string | null;
  plan_status: string | null;
}

export async function getReferredUsers(partnerId: string): Promise<ReferredUserRow[]> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, email, referred_at, plan_status')
    .eq('referred_by_partner_id', partnerId)
    .order('referred_at', { ascending: false });

  if (error) throw error;
  return (data as ReferredUserRow[] | null) ?? [];
}

/** Sum of total_used across a set of users. One query, batched by .in(). */
export async function getCreditsUsedForUsers(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from('user_credits')
    .select('user_id, total_used')
    .in('user_id', userIds);

  if (error) throw error;
  const map = new Map<string, number>();
  for (const row of (data as { user_id: string; total_used: number | null }[] | null) ?? []) {
    map.set(row.user_id, Number(row.total_used) || 0);
  }
  return map;
}

/** Sum of owed reward balance for a partner. One aggregate read. */
export async function getOwedBalance(partnerId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('partner_reward_transactions')
    .select('amount')
    .eq('partner_id', partnerId);

  if (error) throw error;
  let sum = 0;
  for (const row of (data as { amount: number | null }[] | null) ?? []) {
    sum += Number(row.amount) || 0;
  }
  return sum;
}
