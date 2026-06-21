/**
 * Regression tests for the idempotent welcome-bonus grant in
 * UserCreditsService.getOrCreateUserCredits.
 *
 * Bug history:
 *  - The 50-credit bonus was once gated on "row just created" / balance===0, so a
 *    row materialized at 0 by another caller left the user stuck at 0 forever.
 *  - The first idempotent rewrite called addCredits() to grant, which re-entered
 *    getOrCreateUserCredits() -> grantInitialBonusIfEligible() before the marker
 *    was written -> UNBOUNDED RECURSION (heap OOM) on every first-time grant.
 *
 * The current design grants DIRECTLY on the resolved row (no addCredits, no
 * re-provisioning) and is gated on a durable credit_transactions is_initial_bonus
 * marker. These tests deliberately DO NOT mock addCredits — mocking it is exactly
 * what hid the recursion bug.
 */

import { UserCreditsService } from '../user-credits.service';

type AnyRow = Record<string, any> | null;

const state: {
  existingCreditsRow: AnyRow;
  userPlanRow: AnyRow;
  bonusTxnExists: boolean;
  bonusLookupError: { message: string } | null;
  bonusLookupCalls: number;
  creditsUpdateCalls: number;
  txnInserts: Array<Record<string, any>>;
} = {
  existingCreditsRow: null,
  userPlanRow: null,
  bonusTxnExists: false,
  bonusLookupError: null,
  bonusLookupCalls: 0,
  creditsUpdateCalls: 0,
  txnInserts: [],
};

jest.mock('@/db/supabase', () => {
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select' };
    const builder: any = {
      select: jest.fn(() => builder),
      update: jest.fn((payload: any) => {
        ctx.op = 'update';
        if (table === 'user_credits') {
          state.creditsUpdateCalls += 1;
          // Reflect the credited balance back into the row the next read returns.
          state.existingCreditsRow = { ...state.existingCreditsRow, ...payload };
        }
        return builder;
      }),
      upsert: jest.fn(() => { ctx.op = 'upsert'; return builder; }),
      insert: jest.fn(async (payload: any) => {
        if (table === 'credit_transactions') {
          state.txnInserts.push(payload);
          if (payload?.metadata?.is_initial_bonus) state.bonusTxnExists = true;
        }
        return { data: null, error: null };
      }),
      eq: jest.fn(() => builder),
      is: jest.fn(() => builder),
      limit: jest.fn(() => builder),
      maybeSingle: jest.fn(async () => resolve(ctx)),
    };
    return builder;
  };

  const resolve = (ctx: any) => {
    if (ctx.table === 'users') return { data: state.userPlanRow, error: null };
    if (ctx.table === 'credit_transactions') {
      state.bonusLookupCalls += 1;
      if (state.bonusLookupError) return { data: null, error: state.bonusLookupError };
      return { data: state.bonusTxnExists ? { id: 'txn-1' } : null, error: null };
    }
    if (ctx.table === 'user_credits') return { data: state.existingCreditsRow, error: null };
    return { data: null, error: null };
  };

  return { supabaseAdmin: { from: jest.fn((table: string) => makeBuilder(table)) } };
});

// Drive the "existing row" path. (addCredits is intentionally NOT mocked.)
jest.spyOn(UserCreditsService, 'getUserCredits')
  .mockImplementation(async () => state.existingCreditsRow as any);

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

describe('UserCreditsService welcome bonus (idempotent, no recursion)', () => {
  beforeEach(() => {
    state.existingCreditsRow = null;
    state.userPlanRow = { plan_id: null, pricing_plans: null }; // free / no plan
    state.bonusTxnExists = false;
    state.bonusLookupError = null;
    state.bonusLookupCalls = 0;
    state.creditsUpdateCalls = 0;
    state.txnInserts = [];
    jest.clearAllMocks();
    jest.spyOn(UserCreditsService, 'getUserCredits')
      .mockImplementation(async () => state.existingCreditsRow as any);
  });

  it('grants the bonus once, directly on the row, with NO recursion/stack overflow', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });

    const result = await UserCreditsService.getOrCreateUserCredits('user-1');

    // Exactly one balance update and one is_initial_bonus transaction.
    expect(state.creditsUpdateCalls).toBe(1);
    const bonusTxns = state.txnInserts.filter((t) => t?.metadata?.is_initial_bonus);
    expect(bonusTxns).toHaveLength(1);
    expect(bonusTxns[0].amount).toBe(50);
    expect(result.credits_balance).toBe(50); // 0 + 50
  });

  it('does NOT grant again when a bonus transaction already exists', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 12 });
    state.bonusTxnExists = true;

    const result = await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(state.creditsUpdateCalls).toBe(0);
    expect(state.txnInserts.filter((t) => t?.metadata?.is_initial_bonus)).toHaveLength(0);
    expect(result.credits_balance).toBe(12);
  });

  it('does NOT grant to a paid-plan user', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });
    state.userPlanRow = { plan_id: 'p1', pricing_plans: { slug: 'pro' } };

    await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(state.creditsUpdateCalls).toBe(0);
    expect(state.txnInserts).toHaveLength(0);
  });

  it('does NOT grant when the marker lookup errors (avoids accidental double-grant)', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });
    state.bonusLookupError = { message: 'db down' };

    await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(state.creditsUpdateCalls).toBe(0);
  });
});
