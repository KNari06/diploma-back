/**
 * Referrals-by-link domain types. Shared across the referral service, db/
 * sublayer, and the /referrals API. See supabase-migrations/20260713_referrals.sql.
 */

export type PartnerStatus = 'active' | 'disabled';

export interface Partner {
  id: string;
  code: string;
  name: string;
  email: string | null;
  authUserId: string | null;
  status: PartnerStatus;
  /** Per-partner reward share 0..1; null = use the global REFERRAL_REWARD_RATE default. */
  rewardRate: number | null;
  /** Per-partner rewarded-payment count; null = use the global REFERRAL_REWARD_MONTHS default. */
  rewardWindowCount: number | null;
  createdAt: string;
}

/** A referred user as surfaced to a partner (email is masked before it leaves the service). */
export interface ReferredUser {
  userId: string;
  email: string | null; // masked (e.g. j***@acme.com) before returning to a partner
  referredAt: string | null;
  isPaid: boolean;
  creditsUsed: number;
}

/** Aggregate stats for a single partner. */
export interface PartnerStats {
  partnerId: string;
  code: string;
  registrations: number;
  paidUsers: number;
  creditsUsedByReferred: number;
  owedBalance: number;
}

/** Reward-event kinds recorded in partner_reward_transactions. */
export type PartnerRewardEvent = 'paid_conversion' | 'signup' | 'adjustment';
