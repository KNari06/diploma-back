import { ReferralService, maskEmail } from '@/services/core/referral.service';
import * as referralDb from '@/services/core/db/referral.db';
import { ReferralsFeature } from '@/config/features/referrals';
import { cache } from '@/utils/core/redis-cache';

jest.mock('@/services/core/db/referral.db');
jest.mock('@/config/features/referrals', () => ({
  ReferralsFeature: {
    isEnabled: jest.fn(),
    getRewardRate: jest.fn(),
    getRewardWindowCount: jest.fn(),
    // Real resolvers so tests exercise the per-partner override → global fallback.
    resolveRewardRate: (o: number | null | undefined) =>
      o === null || o === undefined
        ? (ReferralsFeature.getRewardRate() as unknown as number)
        : Math.max(0, Math.min(1, o)),
    resolveRewardWindowCount: (o: number | null | undefined) =>
      o === null || o === undefined
        ? (ReferralsFeature.getRewardWindowCount() as unknown as number)
        : Math.max(0, Math.floor(o)),
    // Real formula so tests assert the actual computed share.
    computeReward: (paid: number, rate?: number) =>
      !Number.isFinite(paid) || paid <= 0
        ? 0
        : Math.round(paid * (rate ?? (ReferralsFeature.getRewardRate() as unknown as number))),
    // User-side bonus: stubbed per-plan config + the real credit formula, so
    // these tests cover the SERVICE's gating (idempotency, degrade) rather than
    // re-testing the arithmetic already pinned in the feature's own suite.
    getUserBonusForPlan: jest.fn(),
    computeUserCredits: (
      planCredits: number,
      opts: { isReferred: boolean; planCode: string; priorBonusPayments: number }
    ) => {
      const bonus = ReferralsFeature.getUserBonusForPlan(opts.planCode) as unknown as {
        multiplier: number;
        payments: number;
      } | null;
      if (!opts.isReferred || !bonus) return Math.floor(planCredits);
      if (opts.priorBonusPayments >= bonus.payments) return Math.floor(planCredits);
      return Math.floor(planCredits * bonus.multiplier);
    },
  },
}));
jest.mock('@/utils/core/redis-cache', () => ({
  cache: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const db = referralDb as jest.Mocked<typeof referralDb>;
const feature = ReferralsFeature as jest.Mocked<typeof ReferralsFeature>;
const mockCache = cache as jest.Mocked<typeof cache>;

const activePartner = {
  id: 'p1',
  code: 'acme',
  name: 'Acme',
  email: 'partner@acme.com',
  auth_user_id: 'auth1',
  status: 'active',
  reward_rate: null,
  reward_window_count: null,
  created_at: '2026-07-13T00:00:00Z',
};

/** Default reward config a referred user maps to (partner p1, no per-partner override). */
const defaultRewardConfig = { partnerId: 'p1', rewardRate: null, rewardWindowCount: null };

beforeEach(() => {
  jest.clearAllMocks();
  feature.isEnabled.mockReturnValue(true);
  feature.getRewardRate.mockReturnValue(0.7);
  feature.getRewardWindowCount.mockReturnValue(2);
});

describe('ReferralService.attributeUser', () => {
  it('does nothing when the feature is disabled', async () => {
    feature.isEnabled.mockReturnValue(false);
    const result = await ReferralService.attributeUser('u1', 'acme');
    expect(result).toBe(false);
    expect(db.findPartnerByCode).not.toHaveBeenCalled();
  });

  it('does nothing for an empty code', async () => {
    expect(await ReferralService.attributeUser('u1', '')).toBe(false);
    expect(await ReferralService.attributeUser('u1', null)).toBe(false);
    expect(db.findPartnerByCode).not.toHaveBeenCalled();
  });

  it('ignores an unknown code', async () => {
    db.findPartnerByCode.mockResolvedValue(null);
    expect(await ReferralService.attributeUser('u1', 'nope')).toBe(false);
    expect(db.attributeUserIfUnset).not.toHaveBeenCalled();
  });

  it('ignores a disabled partner', async () => {
    db.findPartnerByCode.mockResolvedValue({ ...activePartner, status: 'disabled' });
    expect(await ReferralService.attributeUser('u1', 'acme')).toBe(false);
    expect(db.attributeUserIfUnset).not.toHaveBeenCalled();
  });

  it('attributes to an active partner and reports the set-once result', async () => {
    db.findPartnerByCode.mockResolvedValue(activePartner);
    db.attributeUserIfUnset.mockResolvedValue(true);
    expect(await ReferralService.attributeUser('u1', 'ACME')).toBe(true);
    expect(db.attributeUserIfUnset).toHaveBeenCalledWith('u1', 'p1');
  });

  it('returns false when already attributed (set-once no-op), without throwing', async () => {
    db.findPartnerByCode.mockResolvedValue(activePartner);
    db.attributeUserIfUnset.mockResolvedValue(false);
    expect(await ReferralService.attributeUser('u1', 'acme')).toBe(false);
  });

  it('never throws on a db error', async () => {
    db.findPartnerByCode.mockRejectedValue(new Error('db down'));
    await expect(ReferralService.attributeUser('u1', 'acme')).resolves.toBe(false);
  });
});

describe('ReferralService.attributeAtAuth', () => {
  it('prefers an explicit code over the pending store', async () => {
    db.findPartnerByCode.mockResolvedValue(activePartner);
    db.attributeUserIfUnset.mockResolvedValue(true);
    await ReferralService.attributeAtAuth('u1', 'x@y.com', 'acme');
    expect(mockCache.get).not.toHaveBeenCalled();
    expect(db.findPartnerByCode).toHaveBeenCalledWith('acme');
  });

  it('falls back to the pending store keyed by email, then clears it', async () => {
    mockCache.get.mockResolvedValue('acme');
    db.findPartnerByCode.mockResolvedValue(activePartner);
    db.attributeUserIfUnset.mockResolvedValue(true);
    await ReferralService.attributeAtAuth('u1', 'x@y.com');
    expect(db.findPartnerByCode).toHaveBeenCalledWith('acme');
    expect(mockCache.del).toHaveBeenCalled();
  });

  it('is a no-op when no code is available anywhere', async () => {
    mockCache.get.mockResolvedValue(null);
    expect(await ReferralService.attributeAtAuth('u1', 'x@y.com')).toBe(false);
    expect(db.findPartnerByCode).not.toHaveBeenCalled();
  });
});

describe('ReferralService.rewardOnPayment', () => {
  const payment = {
    userId: 'u1',
    invoiceId: 'in_1',
    amountPaidMinorUnits: 3000, // $30.00
    currency: 'usd',
  };

  it('no-ops when the feature is disabled', async () => {
    feature.isEnabled.mockReturnValue(false);
    expect(await ReferralService.rewardOnPayment(payment)).toBe(false);
    expect(db.getUserRewardConfig).not.toHaveBeenCalled();
  });

  it('no-ops when the user has no referral partner', async () => {
    db.getUserRewardConfig.mockResolvedValue(null);
    expect(await ReferralService.rewardOnPayment(payment)).toBe(false);
    expect(db.insertRewardIfAbsent).not.toHaveBeenCalled();
  });

  it('grants 70% of the real paid amount ($30 → $21) for the first payment', async () => {
    db.getUserRewardConfig.mockResolvedValue(defaultRewardConfig);
    db.countRewardsForUser.mockResolvedValue(0);
    db.insertRewardIfAbsent.mockResolvedValue(true);
    expect(await ReferralService.rewardOnPayment(payment)).toBe(true);
    expect(db.insertRewardIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerId: 'p1',
        referredUserId: 'u1',
        eventType: 'paid_conversion',
        amount: 2100, // round(3000 * 0.70)
        currency: 'usd',
        stripeInvoiceId: 'in_1',
      })
    );
  });

  it('applies a per-partner rate override over the global default ($30 @ 50% → $15)', async () => {
    db.getUserRewardConfig.mockResolvedValue({ partnerId: 'p1', rewardRate: 0.5, rewardWindowCount: null });
    db.countRewardsForUser.mockResolvedValue(0);
    db.insertRewardIfAbsent.mockResolvedValue(true);
    expect(await ReferralService.rewardOnPayment(payment)).toBe(true);
    expect(db.insertRewardIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1500, // round(3000 * 0.50), not the global 0.70
        metadata: expect.objectContaining({ rate: 0.5 }),
      })
    );
  });

  it('applies a per-partner window override (window=1 → second payment not rewarded)', async () => {
    db.getUserRewardConfig.mockResolvedValue({ partnerId: 'p1', rewardRate: null, rewardWindowCount: 1 });
    db.countRewardsForUser.mockResolvedValue(1); // already one reward → window (1) exhausted
    expect(await ReferralService.rewardOnPayment({ ...payment, invoiceId: 'in_2' })).toBe(false);
    expect(db.insertRewardIfAbsent).not.toHaveBeenCalled();
  });

  it('still rewards the SECOND payment (window = 2)', async () => {
    db.getUserRewardConfig.mockResolvedValue(defaultRewardConfig);
    db.countRewardsForUser.mockResolvedValue(1); // one already rewarded
    db.insertRewardIfAbsent.mockResolvedValue(true);
    expect(await ReferralService.rewardOnPayment({ ...payment, invoiceId: 'in_2' })).toBe(true);
  });

  it('does NOT reward the third payment — window exhausted (100% ours)', async () => {
    db.getUserRewardConfig.mockResolvedValue(defaultRewardConfig);
    db.countRewardsForUser.mockResolvedValue(2); // window already full
    expect(await ReferralService.rewardOnPayment({ ...payment, invoiceId: 'in_3' })).toBe(false);
    expect(db.insertRewardIfAbsent).not.toHaveBeenCalled();
  });

  it('reports false (no double-reward) when the per-invoice conflict skips the insert', async () => {
    db.getUserRewardConfig.mockResolvedValue(defaultRewardConfig);
    db.countRewardsForUser.mockResolvedValue(0);
    db.insertRewardIfAbsent.mockResolvedValue(false); // ON CONFLICT (stripe_invoice_id)
    expect(await ReferralService.rewardOnPayment(payment)).toBe(false);
  });

  it('does not reward when the rate rounds the amount to zero', async () => {
    feature.getRewardRate.mockReturnValue(0);
    db.getUserRewardConfig.mockResolvedValue(defaultRewardConfig);
    db.countRewardsForUser.mockResolvedValue(0);
    expect(await ReferralService.rewardOnPayment(payment)).toBe(false);
    expect(db.insertRewardIfAbsent).not.toHaveBeenCalled();
  });

  it('no-ops without an invoice id (can\'t dedupe)', async () => {
    expect(await ReferralService.rewardOnPayment({ ...payment, invoiceId: '' })).toBe(false);
    expect(db.getUserRewardConfig).not.toHaveBeenCalled();
  });

  it('never throws on a db error (payment path must not fail)', async () => {
    db.getUserRewardConfig.mockRejectedValue(new Error('db down'));
    await expect(ReferralService.rewardOnPayment(payment)).resolves.toBe(false);
  });
});

describe('ReferralService.resolveInvoiceCredits', () => {
  const invoice = { userId: 'u1', invoiceId: 'in_1', planCode: 'pro_19', planCredits: 990 };
  const base = { credits: 990, bonusApplied: false, multiplier: 1 };

  beforeEach(() => {
    feature.isEnabled.mockReturnValue(true);
    feature.getUserBonusForPlan.mockReturnValue({ multiplier: 2, payments: Infinity });
    db.getUserReferralPartnerId.mockResolvedValue('p1');
    db.hasBonusForInvoice.mockResolvedValue(false);
    db.countUserBonusGrants.mockResolvedValue(0);
  });

  it('doubles the credits for a referred user on a bonused plan', async () => {
    expect(await ReferralService.resolveInvoiceCredits(invoice)).toEqual({
      credits: 1980,
      bonusApplied: true,
      multiplier: 2,
    });
  });

  it('returns base credits when the feature is off', async () => {
    feature.isEnabled.mockReturnValue(false);
    expect(await ReferralService.resolveInvoiceCredits(invoice)).toEqual(base);
    expect(db.getUserReferralPartnerId).not.toHaveBeenCalled();
  });

  it('returns base credits for a user with no referral partner', async () => {
    db.getUserReferralPartnerId.mockResolvedValue(null);
    expect(await ReferralService.resolveInvoiceCredits(invoice)).toEqual(base);
  });

  it('returns base credits for a plan with no configured bonus', async () => {
    feature.getUserBonusForPlan.mockReturnValue(null);
    expect(await ReferralService.resolveInvoiceCredits(invoice)).toEqual(base);
    // Cheap check first — no db round-trip for an unbonused plan.
    expect(db.getUserReferralPartnerId).not.toHaveBeenCalled();
  });

  it('does NOT re-bonus a Stripe webhook retry of the same invoice', async () => {
    db.hasBonusForInvoice.mockResolvedValue(true);
    expect(await ReferralService.resolveInvoiceCredits(invoice)).toEqual(base);
    expect(db.countUserBonusGrants).not.toHaveBeenCalled();
  });

  it('stops bonusing once the plan window is spent', async () => {
    feature.getUserBonusForPlan.mockReturnValue({ multiplier: 1.25, payments: 2 });
    db.countUserBonusGrants.mockResolvedValue(2);
    expect(
      await ReferralService.resolveInvoiceCredits({ ...invoice, planCode: 'pro_99', planCredits: 18000 })
    ).toEqual({ credits: 18000, bonusApplied: false, multiplier: 1 });
  });

  it('counts the window PER PLAN so an upgrade does not inherit a spent window', async () => {
    feature.getUserBonusForPlan.mockReturnValue({ multiplier: 1.5, payments: 2 });
    db.countUserBonusGrants.mockResolvedValue(0); // fresh count for pro_49
    const result = await ReferralService.resolveInvoiceCredits({
      ...invoice,
      planCode: 'pro_49',
      planCredits: 7000,
    });
    expect(db.countUserBonusGrants).toHaveBeenCalledWith('u1', 'pro_49');
    expect(result.credits).toBe(10_500);
  });

  it('degrades to base credits on a db error — never withholds what was paid for', async () => {
    db.countUserBonusGrants.mockRejectedValue(new Error('db down'));
    await expect(ReferralService.resolveInvoiceCredits(invoice)).resolves.toEqual(base);
  });

  it('returns base credits when the invoice id is missing (cannot dedupe)', async () => {
    expect(
      await ReferralService.resolveInvoiceCredits({ ...invoice, invoiceId: '' })
    ).toEqual(base);
  });
});

describe('ReferralService.getStatsForPartner', () => {
  it('aggregates registrations, paid users, credits used, and owed balance', async () => {
    db.getReferredUsers.mockResolvedValue([
      { id: 'a', email: 'a@x.com', referred_at: '2026-07-01', plan_status: 'paid' },
      { id: 'b', email: 'b@x.com', referred_at: '2026-07-02', plan_status: 'free' },
      { id: 'c', email: 'c@x.com', referred_at: '2026-07-03', plan_status: null },
    ]);
    db.getCreditsUsedForUsers.mockResolvedValue(
      new Map([
        ['a', 500],
        ['b', 250],
        ['c', 0],
      ])
    );
    db.getOwedBalance.mockResolvedValue(1000);

    const stats = await ReferralService.getStatsForPartner('p1', 'acme');
    expect(stats).toEqual({
      partnerId: 'p1',
      code: 'acme',
      registrations: 3,
      paidUsers: 1,
      creditsUsedByReferred: 750,
      owedBalance: 1000,
    });
  });
});

describe('ReferralService.getReferredUsersForPartner', () => {
  it('masks referred-user emails (PII)', async () => {
    db.getReferredUsers.mockResolvedValue([
      { id: 'a', email: 'jane@acme.com', referred_at: '2026-07-01', plan_status: 'paid' },
    ]);
    db.getCreditsUsedForUsers.mockResolvedValue(new Map([['a', 42]]));
    const [row] = await ReferralService.getReferredUsersForPartner('p1');
    expect(row.email).toBe('j***@acme.com');
    expect(row.isPaid).toBe(true);
    expect(row.creditsUsed).toBe(42);
  });
});

describe('ReferralService.createPartner', () => {
  it('rejects a duplicate code before inserting', async () => {
    db.findPartnerByCode.mockResolvedValue(activePartner);
    await expect(ReferralService.createPartner({ code: 'acme', name: 'x' })).rejects.toThrow(
      /already exists/
    );
    expect(db.insertPartner).not.toHaveBeenCalled();
  });

  it('inserts the partner row BEFORE provisioning a login (no orphaned login on insert failure)', async () => {
    // Regression guard: if the login were provisioned first and the insert then
    // failed, a role=partner login would exist with no partners row (a dead
    // account). Insert must come first.
    const calls: string[] = [];
    db.findPartnerByCode.mockResolvedValue(null);
    db.insertPartner.mockImplementation(async () => {
      calls.push('insert');
      return { ...activePartner, auth_user_id: null };
    });
    db.inviteAuthUser.mockImplementation(async () => {
      calls.push('invite');
      return 'auth-new';
    });
    db.markUserAsPartnerLogin.mockResolvedValue(undefined);
    db.updatePartner.mockResolvedValue({ ...activePartner, auth_user_id: 'auth-new' });

    await ReferralService.createPartner({
      code: 'e2e_new',
      name: 'New',
      email: 'p@acme.com',
      provisionLogin: true,
    });

    expect(calls[0]).toBe('insert');
    expect(calls.indexOf('insert')).toBeLessThan(calls.indexOf('invite'));
    expect(db.updatePartner).toHaveBeenCalledWith(activePartner.id, { authUserId: 'auth-new' });
  });

  it('links and promotes an existing user when the email is already registered', async () => {
    // inviteAuthUser resolves the existing synced user id (no invite email sent)
    // for an already-registered email; the partner must still be linked + promoted.
    db.findPartnerByCode.mockResolvedValue(null);
    db.insertPartner.mockResolvedValue({ ...activePartner, auth_user_id: null });
    db.inviteAuthUser.mockResolvedValue('auth-existing');
    db.markUserAsPartnerLogin.mockResolvedValue(undefined);
    db.updatePartner.mockResolvedValue({ ...activePartner, auth_user_id: 'auth-existing' });

    await ReferralService.createPartner({
      code: 'e2e_existing',
      name: 'Existing',
      email: 'known@acme.com',
      provisionLogin: true,
    });

    expect(db.markUserAsPartnerLogin).toHaveBeenCalledWith('auth-existing');
    expect(db.updatePartner).toHaveBeenCalledWith(activePartner.id, {
      authUserId: 'auth-existing',
    });
  });

  it('still returns the partner when login provisioning fails', async () => {
    db.findPartnerByCode.mockResolvedValue(null);
    db.insertPartner.mockResolvedValue({ ...activePartner, auth_user_id: null });
    db.inviteAuthUser.mockRejectedValue(new Error('invite failed'));

    const partner = await ReferralService.createPartner({
      code: 'e2e_new2',
      name: 'New2',
      email: 'p@acme.com',
      provisionLogin: true,
    });
    expect(partner.id).toBe(activePartner.id); // partner created despite login failure
  });
});

describe('maskEmail', () => {
  it('masks the local part, keeps the domain', () => {
    expect(maskEmail('jane@acme.com')).toBe('j***@acme.com');
  });
  it('handles null and malformed input', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('@nope.com')).toBe('***');
  });
});

/**
 * Refund reversal. The ledger is append-only, so a refunded payment can only be
 * corrected by a negative counter-entry — without it a partner keeps commission
 * on money the customer took back.
 */
describe('ReferralService.reverseRewardOnRefund', () => {
  const originalRow = {
    partner_id: 'p1',
    referred_user_id: 'u1',
    amount: 950, // $9.50 — 50% of a $19.00 invoice
    currency: 'usd',
  };

  beforeEach(() => {
    feature.isEnabled.mockReturnValue(true);
    db.findRewardByInvoice.mockResolvedValue(originalRow);
    db.insertRewardReversalIfAbsent.mockResolvedValue(true);
  });

  it('reverses the FULL reward when the whole invoice is refunded', async () => {
    const ok = await ReferralService.reverseRewardOnRefund({
      invoiceId: 'in_1',
      refundedAmountMinorUnits: 1900,
      originalAmountMinorUnits: 1900,
    });

    expect(ok).toBe(true);
    expect(db.insertRewardReversalIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'p1', referredUserId: 'u1', amount: 950 })
    );
  });

  it('reverses PROPORTIONALLY on a partial refund', async () => {
    // Half the invoice back → half the commission back.
    await ReferralService.reverseRewardOnRefund({
      invoiceId: 'in_1',
      refundedAmountMinorUnits: 950,
      originalAmountMinorUnits: 1900,
    });

    expect(db.insertRewardReversalIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 475 })
    );
  });

  it('never reverses MORE than was credited, even on an over-refund', async () => {
    await ReferralService.reverseRewardOnRefund({
      invoiceId: 'in_1',
      refundedAmountMinorUnits: 5000, // more than the invoice
      originalAmountMinorUnits: 1900,
    });

    expect(db.insertRewardReversalIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 950 })
    );
  });

  it('mirrors the ORIGINAL row instead of recomputing from the current rate', async () => {
    // Rates are captured per-row and may have changed since; recomputing would
    // reverse a different figure than was actually credited.
    db.findRewardByInvoice.mockResolvedValue({ ...originalRow, amount: 1330, currency: 'eur' });

    await ReferralService.reverseRewardOnRefund({
      invoiceId: 'in_1',
      refundedAmountMinorUnits: 1900,
      originalAmountMinorUnits: 1900,
    });

    expect(db.insertRewardReversalIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1330, currency: 'eur' })
    );
  });

  it('no-ops when no reward was ever written for that invoice', async () => {
    db.findRewardByInvoice.mockResolvedValue(null);

    await expect(
      ReferralService.reverseRewardOnRefund({
        invoiceId: 'in_unknown',
        refundedAmountMinorUnits: 1900,
        originalAmountMinorUnits: 1900,
      })
    ).resolves.toBe(false);
    expect(db.insertRewardReversalIfAbsent).not.toHaveBeenCalled();
  });

  it('no-ops when the feature is off', async () => {
    feature.isEnabled.mockReturnValue(false);

    await expect(
      ReferralService.reverseRewardOnRefund({
        invoiceId: 'in_1',
        refundedAmountMinorUnits: 1900,
        originalAmountMinorUnits: 1900,
      })
    ).resolves.toBe(false);
    expect(db.findRewardByInvoice).not.toHaveBeenCalled();
  });

  it('never throws on a db error (the refund webhook must not fail)', async () => {
    db.findRewardByInvoice.mockRejectedValue(new Error('db down'));

    await expect(
      ReferralService.reverseRewardOnRefund({
        invoiceId: 'in_1',
        refundedAmountMinorUnits: 1900,
        originalAmountMinorUnits: 1900,
      })
    ).resolves.toBe(false);
  });
});
