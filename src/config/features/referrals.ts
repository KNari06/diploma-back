import { env } from '@/config/environment/env';

/**
 * Feature flag + reward config for referrals by link.
 *
 * Reward model (v1): a time-windowed revenue share. When a referred user pays,
 * the partner earns `getRewardRate()` (default 70%) of the REAL amount paid, for
 * the referred user's first `getRewardWindowCount()` monthly payments (default 2),
 * then 0% (100% ours). The owed balance accrues in the invoice's currency.
 *
 * OFF by default — dark in prod until REFERRALS_ENABLED is set in the infra .env
 * (see CLAUDE.md "Env vars: local vs prod"). When off, attribution and reward are
 * no-ops and the /referrals routes return 404.
 */
export const ReferralsFeature = {
  /** Is the referrals feature enabled at all? */
  isEnabled(): boolean {
    return env.REFERRALS_ENABLED;
  },

  /** Share of the paid amount a partner earns during the reward window, clamped 0..1. */
  getRewardRate(): number {
    const r = Number.isFinite(env.REFERRAL_REWARD_RATE) ? env.REFERRAL_REWARD_RATE : 0;
    return Math.max(0, Math.min(1, r));
  },

  /** How many of a referred user's monthly payments are rewarded (>= 0). */
  getRewardWindowCount(): number {
    const n = Number.isFinite(env.REFERRAL_REWARD_MONTHS) ? env.REFERRAL_REWARD_MONTHS : 0;
    return Math.max(0, Math.floor(n));
  },

  /** Reward owed for one paid invoice: round(paidAmount * rate), 0 if rate is 0. */
  computeReward(paidAmountMinorUnits: number): number {
    if (!Number.isFinite(paidAmountMinorUnits) || paidAmountMinorUnits <= 0) return 0;
    return Math.round(paidAmountMinorUnits * this.getRewardRate());
  },
};
