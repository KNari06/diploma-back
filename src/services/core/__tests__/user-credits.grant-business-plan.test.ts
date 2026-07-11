/**
 * Unit tests for UserCreditsService.grantBusinessPlan.
 *
 * Credits belong to the USER account — B2B plans (pilot / small_business /
 * middle_business / enterprise) grant the plan's allotment + grace onto the
 * user's user_credits, NOT a workspace pool. Both the Stripe B2B webhook and
 * the ops assign script funnel through this method.
 *
 * Covered:
 *  - 'upgrade' mode ADDs to the existing balance (first charge / plan change).
 *  - 'renew' mode SETs the balance to the allotment (no rollover).
 *  - grace_limit + B2B subscription_plan + 'active' status are written.
 *  - a funded period clears prior grace debt (overage_balance / grace_started_at).
 *  - a 'purchase' credit_transactions row is recorded with the b2b_plan tag.
 *  - invalid inputs fail closed with { success: false }.
 */

import { UserCreditsService } from '../user-credits.service';

type AnyRow = Record<string, any> | null;

const state: {
  existingCreditsRow: AnyRow;
  lastUpdatePayload: Record<string, any> | null;
  creditsUpdateCalls: number;
  txnInserts: Array<Record<string, any>>;
  updateError: { message: string } | null;
} = {
  existingCreditsRow: null,
  lastUpdatePayload: null,
  creditsUpdateCalls: 0,
  txnInserts: [],
  updateError: null,
};

jest.mock('@/db/supabase', () => {
  const makeBuilder = (table: string) => {
    const builder: any = {
      select: jest.fn(() => builder),
      update: jest.fn((payload: any) => {
        if (table === 'user_credits') {
          state.creditsUpdateCalls += 1;
          state.lastUpdatePayload = payload;
          state.existingCreditsRow = { ...state.existingCreditsRow, ...payload };
        }
        // `.update(...).eq(...)` resolves as a thenable returning { error }.
        return {
          eq: jest.fn(async () => ({ error: state.updateError })),
        };
      }),
      insert: jest.fn(async (payload: any) => {
        if (table === 'credit_transactions') state.txnInserts.push(payload);
        return { data: null, error: null };
      }),
      eq: jest.fn(() => builder),
      maybeSingle: jest.fn(async () => ({ data: state.existingCreditsRow, error: null })),
    };
    return builder;
  };

  return { supabaseAdmin: { from: jest.fn((table: string) => makeBuilder(table)) } };
});

function baseRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'uc-1',
    user_id: 'user-1',
    credits_balance: 0,
    total_purchased: 0,
    total_used: 0,
    subscription_plan: 'free',
    subscription_status: 'inactive',
    subscription_expires_at: null,
    grace_limit: 0,
    overage_balance: 0,
    grace_started_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('UserCreditsService.grantBusinessPlan', () => {
  beforeEach(() => {
    state.existingCreditsRow = baseRow();
    state.lastUpdatePayload = null;
    state.creditsUpdateCalls = 0;
    state.txnInserts = [];
    state.updateError = null;
    jest.clearAllMocks();
    // Drive the "existing row" path without exercising provisioning.
    jest
      .spyOn(UserCreditsService, 'getOrCreateUserCredits')
      .mockImplementation(async () => state.existingCreditsRow as any);
  });

  it('upgrade ADDs the allotment to the current balance', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 500, total_purchased: 500 });

    const res = await UserCreditsService.grantBusinessPlan(
      'user-1',
      'small_business',
      29_000,
      3_000,
      'upgrade',
      'Subscription payment - small_business plan'
    );

    expect(res.success).toBe(true);
    expect(res.newBalance).toBe(29_500); // 500 + 29_000
    expect(state.lastUpdatePayload?.credits_balance).toBe(29_500);
    expect(state.lastUpdatePayload?.total_purchased).toBe(29_500); // 500 + 29_000
    expect(state.lastUpdatePayload?.subscription_plan).toBe('small_business');
    expect(state.lastUpdatePayload?.subscription_status).toBe('active');
    expect(state.lastUpdatePayload?.grace_limit).toBe(3_000);
  });

  it('renew SETs the balance to the allotment (no rollover)', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 12_345, total_purchased: 60_000 });

    const res = await UserCreditsService.grantBusinessPlan(
      'user-1',
      'middle_business',
      79_000,
      8_000,
      'renew',
      'Subscription renewal - middle_business plan'
    );

    expect(res.success).toBe(true);
    expect(res.newBalance).toBe(79_000); // SET, not 12_345 + 79_000
    expect(state.lastUpdatePayload?.credits_balance).toBe(79_000);
    expect(state.lastUpdatePayload?.total_purchased).toBe(139_000); // still accumulates
    expect(state.lastUpdatePayload?.grace_limit).toBe(8_000);
  });

  it('clears prior grace debt when the new balance is >= 0', async () => {
    state.existingCreditsRow = baseRow({
      credits_balance: -200,
      overage_balance: 200,
      grace_started_at: '2026-01-01T00:00:00Z',
    });

    await UserCreditsService.grantBusinessPlan(
      'user-1',
      'enterprise',
      200_000,
      20_000,
      'upgrade',
      'Subscription payment - enterprise plan'
    );

    expect(state.lastUpdatePayload?.overage_balance).toBe(0);
    expect(state.lastUpdatePayload?.grace_started_at).toBeNull();
  });

  it('records a purchase transaction tagged with the B2B plan', async () => {
    await UserCreditsService.grantBusinessPlan(
      'user-1',
      'pilot',
      10_000,
      1_000,
      'upgrade',
      'B2B plan (pilot) assigned via ops script',
      { source: 'assign-workspace-plan.ts' }
    );

    expect(state.txnInserts).toHaveLength(1);
    const txn = state.txnInserts[0];
    expect(txn.transaction_type).toBe('purchase');
    expect(txn.amount).toBe(10_000);
    expect(txn.balance_after).toBe(10_000);
    expect(txn.metadata?.b2b_plan).toBe('pilot');
    expect(txn.metadata?.source).toBe('assign-workspace-plan.ts');
  });

  it('fails closed on invalid credits amount without writing', async () => {
    const res = await UserCreditsService.grantBusinessPlan(
      'user-1',
      'small_business',
      -5,
      3_000,
      'upgrade',
      'bad'
    );

    expect(res.success).toBe(false);
    expect(state.creditsUpdateCalls).toBe(0);
    expect(state.txnInserts).toHaveLength(0);
  });

  it('returns failure and does not record a transaction when the DB update errors', async () => {
    state.updateError = { message: 'db down' };

    const res = await UserCreditsService.grantBusinessPlan(
      'user-1',
      'small_business',
      29_000,
      3_000,
      'upgrade',
      'Subscription payment - small_business plan'
    );

    expect(res.success).toBe(false);
    expect(state.txnInserts).toHaveLength(0);
  });
});
