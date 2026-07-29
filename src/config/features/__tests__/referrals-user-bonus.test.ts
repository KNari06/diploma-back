/**
 * The referral is two-sided: the partner earns a revenue share and the referred
 * USER gets a credit multiplier. Both come out of one margin, so the numbers
 * here are money — these tests pin the arithmetic and, more importantly, the
 * degrade-safe behaviour of a mis-set multiplier.
 *
 * NOTE ON THE SEAM: `src/test/jest.setup.ts` globally mocks
 * `@/config/environment/env` with a hand-written object, so env vars are NOT
 * readable through the real env under Jest (setting `process.env` silently does
 * nothing). This suite therefore mocks the env module itself and mutates the
 * mocked object between cases.
 */

const DEFAULT_PLANS = 'pro_19:2:inf,pro_49:1.5:2,pro_99:1.25:2';

const mockEnv: Record<string, unknown> = {
  REFERRALS_ENABLED: true,
  REFERRAL_REWARD_RATE: 0.5,
  REFERRAL_REWARD_MONTHS: 2,
  REFERRAL_USER_BONUS_PLANS: DEFAULT_PLANS,
};

jest.mock('@/config/environment/env', () => ({
  get env() {
    return mockEnv;
  },
}));

const { ReferralsFeature } = require('@/config/features/referrals');

const reset = (): void => {
  mockEnv.REFERRALS_ENABLED = true;
  mockEnv.REFERRAL_REWARD_RATE = 0.5;
  mockEnv.REFERRAL_REWARD_MONTHS = 2;
  mockEnv.REFERRAL_USER_BONUS_PLANS = DEFAULT_PLANS;
};

/** Credits per period as configured in prod's `plans` table. */
const PLAN_CREDITS = { pro_19: 990, pro_49: 7000, pro_99: 18000 } as const;

const credits = (
  planCode: keyof typeof PLAN_CREDITS | string,
  priorBonusPayments: number,
  isReferred = true
): number =>
  ReferralsFeature.computeUserCredits(
    PLAN_CREDITS[planCode as keyof typeof PLAN_CREDITS] ?? 1000,
    { isReferred, planCode, priorBonusPayments }
  );

beforeEach(reset);

describe('partner reward rate', () => {
  it('defaults to 50% — halved from 70% because the user side now costs us too', () => {
    expect(ReferralsFeature.getRewardRate()).toBe(0.5);
    // $19.00 invoice → $9.50 owed to the partner.
    expect(ReferralsFeature.computeReward(1900)).toBe(950);
  });

  it('still honours a per-partner override over the global rate', () => {
    expect(ReferralsFeature.computeReward(1900, ReferralsFeature.resolveRewardRate(0.6))).toBe(1140);
  });
});

describe('referred-user credit bonus, per plan', () => {
  it('applies the configured multiplier on each plan first payment', () => {
    expect(credits('pro_19', 0)).toBe(1980); // 990 x 2
    expect(credits('pro_49', 0)).toBe(10_500); // 7000 x 1.5
    expect(credits('pro_99', 0)).toBe(22_500); // 18000 x 1.25
  });

  it('keeps the pro_19 bonus on EVERY renewal — the bonus is unbounded there', () => {
    // The whole point of `inf`: a bounded bonus would visibly drop at renewal
    // (1980 -> 990), which reads to the user as a takeaway.
    for (const prior of [1, 2, 11, 500]) {
      expect(credits('pro_19', prior)).toBe(1980);
    }
  });

  it('stops the larger-plan bonus after its 2-invoice window', () => {
    expect(credits('pro_49', 1)).toBe(10_500); // 2nd invoice — still bonused
    expect(credits('pro_49', 2)).toBe(7000); // 3rd — back to normal
    expect(credits('pro_99', 1)).toBe(22_500);
    expect(credits('pro_99', 2)).toBe(18_000);
  });

  it('grants normal credits to a user who was not referred', () => {
    expect(credits('pro_19', 0, false)).toBe(990);
    expect(credits('pro_99', 0, false)).toBe(18_000);
  });

  it('grants normal credits when the feature is off, even for a referred user', () => {
    mockEnv.REFERRALS_ENABLED = false;
    expect(credits('pro_19', 0)).toBe(990);
  });

  it('gives no bonus on a plan absent from the map — new plans are opt-in', () => {
    // A future pro_199 must not inherit a bonus by accident.
    expect(credits('pro_199', 0)).toBe(1000);
    expect(ReferralsFeature.getUserBonusForPlan('pro_199')).toBeNull();
  });

  it('gives no bonus to B2B plan codes', () => {
    expect(ReferralsFeature.getUserBonusForPlan('small_business')).toBeNull();
    expect(ReferralsFeature.getUserBonusForPlan('enterprise')).toBeNull();
  });

  it('disables the whole user-side benefit on an empty map', () => {
    mockEnv.REFERRAL_USER_BONUS_PLANS = '';
    expect(credits('pro_19', 0)).toBe(990);
  });

  it('NEVER grants fewer credits than paid for when a multiplier is mis-set', () => {
    // A referral must not silently downgrade a purchase, so a typo floors to 1x
    // (= no bonus) instead of shorting the user.
    for (const bad of ['0', '-1', 'abc', '']) {
      mockEnv.REFERRAL_USER_BONUS_PLANS = `pro_19:${bad}:inf`;
      expect(credits('pro_19', 0)).toBe(990);
    }
  });

  it('treats an unparseable payment count as no bonus, never as unbounded', () => {
    // Failing open here would mean "free credits forever" on a typo.
    mockEnv.REFERRAL_USER_BONUS_PLANS = 'pro_19:2:abc';
    expect(credits('pro_19', 0)).toBe(990);
  });

  it('treats a missing payment count as unbounded', () => {
    mockEnv.REFERRAL_USER_BONUS_PLANS = 'pro_19:2';
    expect(credits('pro_19', 99)).toBe(1980);
  });

  it('tolerates whitespace and a trailing comma in the map', () => {
    mockEnv.REFERRAL_USER_BONUS_PLANS = ' pro_19 : 2 : inf , ';
    expect(credits('pro_19', 0)).toBe(1980);
  });

  it('floors fractional results to a whole credit count', () => {
    // 990 x 1.5 = 1485 exactly; use an odd base to prove the floor.
    expect(
      ReferralsFeature.computeUserCredits(999, {
        isReferred: true,
        planCode: 'pro_49',
        priorBonusPayments: 0,
      })
    ).toBe(1498); // floor(999 * 1.5)
  });

  it('treats a non-positive plan credit amount as zero', () => {
    const opts = { isReferred: true, planCode: 'pro_19', priorBonusPayments: 0 };
    expect(ReferralsFeature.computeUserCredits(0, opts)).toBe(0);
    expect(ReferralsFeature.computeUserCredits(Number.NaN, opts)).toBe(0);
  });

  it('tolerates a garbage prior-payment count', () => {
    expect(credits('pro_49', Number.NaN)).toBe(10_500); // NaN -> 0 prior
  });
});
