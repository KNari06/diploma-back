/**
 * Unit tests for PlanService.setUserPlan — the single funnel that keeps a
 * user's plan mirrors in sync (users.{plan_id,plan,plan_status} and
 * user_credits.{subscription_plan,subscription_status,grace_limit}).
 *
 * Each test maps to one invariant the funnel must preserve:
 *   - a paid assignment writes BOTH the users mirror AND the credit mirror
 *   - paid → subscription_status 'active'; free → 'inactive'
 *   - the downgrade guard skips a free assignment for a user already on a paid
 *     plan, and writes nothing
 *   - skipDowngradeGuard forces the free write through (explicit cancellation)
 *   - an unknown plan slug is rejected without any write
 *
 * The db/ sublayer and the credits primitive are mocked at their module
 * boundary; we drive the real service logic (no Supabase).
 */

const planRows: Record<string, { id: string; name: string; slug: string } | null> = {
  free: { id: 'plan-free', name: 'Free Plan', slug: 'free' },
  pro: { id: 'plan-pro', name: 'Pro Plan', slug: 'pro' },
};

let currentSlugImpl: () => Promise<string | null> = async () => null;
let writeUserPlanResult = true;
let updateSubscriptionResult = true;

const writeUserPlanMock = jest.fn(
  async (_p: { userId: string; planId: string; planSlug: string; planStatus: 'paid' | 'free' | null }) =>
    writeUserPlanResult
);
const updateSubscriptionMock = jest.fn(
  async (_userId: string, _plan: string, _status: string) => updateSubscriptionResult
);

jest.mock('@/services/core/db/plan.db', () => ({
  getPlanBySlug: jest.fn(async (slug: string) => planRows[slug] ?? null),
  getCurrentPlanSlug: jest.fn(async () => currentSlugImpl()),
  writeUserPlan: jest.fn((p: any) => writeUserPlanMock(p)),
}));

jest.mock('@/services/core/user-credits.service', () => ({
  UserCreditsService: {
    updateSubscription: jest.fn((userId: string, plan: string, status: string) =>
      updateSubscriptionMock(userId, plan, status)
    ),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { PlanService } from '@/services/core/plan.service';

const USER = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  currentSlugImpl = async () => null;
  writeUserPlanResult = true;
  updateSubscriptionResult = true;
});

describe('PlanService.setUserPlan', () => {
  it('writes BOTH the users mirror and the credit mirror for a paid plan', async () => {
    const ok = await PlanService.setUserPlan(USER, 'pro');

    expect(ok).toBe(true);
    expect(writeUserPlanMock).toHaveBeenCalledWith({
      userId: USER,
      planId: 'plan-pro',
      planSlug: 'pro',
      planStatus: 'paid',
      resetUsageCounters: false,
    });
    expect(updateSubscriptionMock).toHaveBeenCalledWith(USER, 'pro', 'active');
  });

  it('maps free → inactive credit status and free plan_status', async () => {
    const ok = await PlanService.setUserPlan(USER, 'free');

    expect(ok).toBe(true);
    expect(writeUserPlanMock).toHaveBeenCalledWith({
      userId: USER,
      planId: 'plan-free',
      planSlug: 'free',
      planStatus: 'free',
      resetUsageCounters: false,
    });
    expect(updateSubscriptionMock).toHaveBeenCalledWith(USER, 'free', 'inactive');
  });

  it('skips a free assignment for a user already on a paid plan (downgrade guard)', async () => {
    currentSlugImpl = async () => 'pro';

    const ok = await PlanService.setUserPlan(USER, 'free', { source: 'self-serve' });

    expect(ok).toBe(true); // reported success — nothing to do
    expect(writeUserPlanMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it('forces a free write through when skipDowngradeGuard is set', async () => {
    currentSlugImpl = async () => 'pro';

    const ok = await PlanService.setUserPlan(USER, 'free', {
      status: null,
      skipDowngradeGuard: true,
    });

    expect(ok).toBe(true);
    expect(writeUserPlanMock).toHaveBeenCalledWith({
      userId: USER,
      planId: 'plan-free',
      planSlug: 'free',
      planStatus: null, // explicit status wins
      resetUsageCounters: false,
    });
    expect(updateSubscriptionMock).toHaveBeenCalledWith(USER, 'free', 'inactive');
  });

  it('resets usage counters only when resetUsageCounters is set (real grant)', async () => {
    await PlanService.setUserPlan(USER, 'pro', { resetUsageCounters: true });
    expect(writeUserPlanMock).toHaveBeenCalledWith({
      userId: USER,
      planId: 'plan-pro',
      planSlug: 'pro',
      planStatus: 'paid',
      resetUsageCounters: true,
    });
  });

  it('does NOT reset usage counters by default (Stripe mirror-sync path)', async () => {
    await PlanService.setUserPlan(USER, 'pro', { source: 'stripe:subscription' });
    expect(writeUserPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ resetUsageCounters: false })
    );
  });

  it('rejects an unknown plan slug without writing anything', async () => {
    const ok = await PlanService.setUserPlan(USER, 'enterprise-xyz');

    expect(ok).toBe(false);
    expect(writeUserPlanMock).not.toHaveBeenCalled();
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it('returns false when the authoritative users mirror write fails (no credit write)', async () => {
    writeUserPlanResult = false;

    const ok = await PlanService.setUserPlan(USER, 'pro');

    expect(ok).toBe(false);
    expect(updateSubscriptionMock).not.toHaveBeenCalled();
  });

  it('still returns true when only the credit mirror write fails (users mirror committed)', async () => {
    updateSubscriptionResult = false;

    const ok = await PlanService.setUserPlan(USER, 'pro');

    expect(ok).toBe(true);
    expect(writeUserPlanMock).toHaveBeenCalled();
    expect(updateSubscriptionMock).toHaveBeenCalled();
  });
});
