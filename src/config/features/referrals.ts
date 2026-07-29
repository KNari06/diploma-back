import { env } from '@/config/environment/env';

/**
 * Feature flag + reward config for referrals by link.
 *
 * The referral is TWO-SIDED:
 *
 * 1. Partner side — a time-windowed revenue share. When a referred user pays,
 *    the partner earns `getRewardRate()` (default 50%) of the REAL amount paid,
 *    for the referred user's first `getRewardWindowCount()` monthly payments
 *    (default 2), then 0% (100% ours). Owed balance accrues in the invoice's
 *    currency.
 * 2. User side — a PER-PLAN credit multiplier (`REFERRAL_USER_BONUS_PLANS`). A
 *    referred user's paid invoice grants `multiplier` × the plan's credits: 2×
 *    on pro_19 (unbounded), 1.5× on pro_49 and 1.25× on pro_99 (2 invoices
 *    each). Same money to us, more credits to them, which reads as a price cut
 *    per credit. The multiplier shrinks as the plan grows because 2× on the top
 *    plan is 18 000 free credits on an invoice we already share 50% of.
 *
 * The partner rate is 50% rather than the original 70% precisely because the
 * user side now costs us too — both sides come out of one margin.
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

  /**
   * Effective rate for a partner: the per-partner override when set, else the
   * global default. Clamped 0..1. `override` is null when the partner uses the default.
   */
  resolveRewardRate(override: number | null | undefined): number {
    if (override === null || override === undefined) return this.getRewardRate();
    const r = Number.isFinite(override) ? (override as number) : 0;
    return Math.max(0, Math.min(1, r));
  },

  /**
   * Effective window for a partner: the per-partner override when set, else the
   * global default. Floored, >= 0. `override` is null when the partner uses the default.
   */
  resolveRewardWindowCount(override: number | null | undefined): number {
    if (override === null || override === undefined) return this.getRewardWindowCount();
    const n = Number.isFinite(override) ? (override as number) : 0;
    return Math.max(0, Math.floor(n));
  },

  /**
   * Reward owed for one paid invoice: round(paidAmount * rate), 0 if rate is 0.
   * `rate` defaults to the global rate when omitted.
   */
  computeReward(paidAmountMinorUnits: number, rate?: number): number {
    if (!Number.isFinite(paidAmountMinorUnits) || paidAmountMinorUnits <= 0) return 0;
    const effectiveRate = rate === undefined ? this.getRewardRate() : rate;
    return Math.round(paidAmountMinorUnits * effectiveRate);
  },

  // ── user-side benefit ──────────────────────────────────────────────────────

  /**
   * The user-side bonus for one plan. `payments` is Infinity when the bonus
   * applies to every invoice while the user stays subscribed.
   */
  parseUserBonusPlans(): Map<string, { multiplier: number; payments: number }> {
    const out = new Map<string, { multiplier: number; payments: number }>();
    const raw = typeof env.REFERRAL_USER_BONUS_PLANS === 'string'
      ? env.REFERRAL_USER_BONUS_PLANS
      : '';

    for (const entry of raw.split(',')) {
      const [code, rawMultiplier, rawPayments] = entry.split(':').map(s => s?.trim());
      if (!code) continue;

      // Floor the multiplier at 1: a referral must never grant FEWER credits
      // than a normal purchase, so a typo degrades to "no bonus" rather than to
      // a silent downgrade of what the user paid for.
      const multiplier = Math.max(1, Number.isFinite(Number(rawMultiplier)) ? Number(rawMultiplier) : 1);

      // `inf`/omitted = unbounded. Anything unparseable means 0 (no bonus)
      // rather than unbounded — a malformed count must not become "free forever".
      const payments = rawPayments === 'inf' || rawPayments === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(Number.isFinite(Number(rawPayments)) ? Number(rawPayments) : 0));

      out.set(code, { multiplier, payments });
    }
    return out;
  },

  /** Bonus config for one plan code, or null when that plan has no bonus. */
  getUserBonusForPlan(planCode: string): { multiplier: number; payments: number } | null {
    if (!this.isEnabled() || !planCode) return null;
    const found = this.parseUserBonusPlans().get(planCode);
    if (!found || found.multiplier <= 1 || found.payments <= 0) return null;
    return found;
  },

  /**
   * Credits to grant for one paid invoice of a referred user, given how many
   * bonus-eligible invoices they have already had on this plan. Returns the plan
   * credits unchanged when the feature is off, the user isn't referred, the plan
   * has no bonus, or their bonus window is exhausted — so callers can apply it
   * unconditionally.
   */
  computeUserCredits(
    planCredits: number,
    opts: { isReferred: boolean; planCode: string; priorBonusPayments: number }
  ): number {
    if (!Number.isFinite(planCredits) || planCredits <= 0) return 0;
    const base = Math.floor(planCredits);
    if (!opts.isReferred) return base;

    const bonus = this.getUserBonusForPlan(opts.planCode);
    if (!bonus) return base;

    const prior = Number.isFinite(opts.priorBonusPayments)
      ? Math.max(0, Math.floor(opts.priorBonusPayments))
      : 0;
    if (prior >= bonus.payments) return base;

    return Math.floor(base * bonus.multiplier);
  },
};
