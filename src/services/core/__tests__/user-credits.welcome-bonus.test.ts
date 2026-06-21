/**
 * Regression tests for the idempotent welcome-bonus grant in
 * UserCreditsService.getOrCreateUserCredits.
 *
 * Bug history: the 50-credit bonus was granted only on the branch that first
 * created the user_credits row, gated on `balance === 0`. A row materialized at
 * 0 by any other caller (or a failed first grant) left the user stuck at 0
 * forever. The fix grants idempotently on any path, gated on a DURABLE marker —
 * the presence of a credit_transactions row tagged metadata.is_initial_bonus —
 * with no schema change.
 *
 * These tests describe behavior through getOrCreateUserCredits' observable
 * effects (whether the marker is checked and whether addCredits fires).
 */

import { UserCreditsService } from '../user-credits.service';

type AnyRow = Record<string, any> | null;

const state: {
  existingCreditsRow: AnyRow;
  userPlanRow: AnyRow;
  bonusTxnExists: boolean; // does a credit_transactions is_initial_bonus row exist?
  bonusLookupError: { message: string } | null;
  bonusLookupCalls: number;
} = {
  existingCreditsRow: null,
  userPlanRow: null,
  bonusTxnExists: false,
  bonusLookupError: null,
  bonusLookupCalls: 0,
};

jest.mock('@/db/supabase', () => {
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select', filters: {} };
    const builder: any = {
      select: jest.fn(() => builder),
      update: jest.fn(() => { ctx.op = 'update'; return builder; }),
      upsert: jest.fn(() => { ctx.op = 'upsert'; return builder; }),
      insert: jest.fn(async () => ({ data: null, error: null })),
      eq: jest.fn((col: string, val: any) => { ctx.filters[col] = val; return builder; }),
      is: jest.fn(() => builder),
      limit: jest.fn(() => builder),
      maybeSingle: jest.fn(async () => resolve(ctx)),
    };
    return builder;
  };

  const resolve = (ctx: any) => {
    if (ctx.table === 'users') {
      return { data: state.userPlanRow, error: null };
    }
    if (ctx.table === 'credit_transactions') {
      // The idempotency marker lookup.
      state.bonusLookupCalls += 1;
      if (state.bonusLookupError) return { data: null, error: state.bonusLookupError };
      return { data: state.bonusTxnExists ? { id: 'txn-1' } : null, error: null };
    }
    if (ctx.table === 'user_credits') {
      return { data: state.existingCreditsRow, error: null };
    }
    return { data: null, error: null };
  };

  return { supabaseAdmin: { from: jest.fn((table: string) => makeBuilder(table)) } };
});

// getUserCredits drives the "existing row" path deterministically.
const getUserCreditsSpy = jest
  .spyOn(UserCreditsService, 'getUserCredits')
  .mockImplementation(async () => state.existingCreditsRow as any);

// addCredits is exercised by the grant; spy to assert it fires and control result.
let addCreditsResult = { success: true, newBalance: 50 };
const addCreditsSpy = jest
  .spyOn(UserCreditsService, 'addCredits')
  .mockImplementation(async () => addCreditsResult as any);

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

describe('UserCreditsService welcome bonus (idempotent, no schema change)', () => {
  beforeEach(() => {
    state.existingCreditsRow = null;
    state.userPlanRow = { plan_id: null, pricing_plans: null }; // free / no plan
    state.bonusTxnExists = false;
    state.bonusLookupError = null;
    state.bonusLookupCalls = 0;
    addCreditsResult = { success: true, newBalance: 50 };
    jest.clearAllMocks();
    getUserCreditsSpy.mockImplementation(async () => state.existingCreditsRow as any);
    addCreditsSpy.mockImplementation(async () => addCreditsResult as any);
  });

  it('grants the bonus to an existing free-plan row with no bonus transaction (the original bug)', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });
    state.bonusTxnExists = false; // never granted
    const grantedRow = baseRow({ credits_balance: 50 });
    getUserCreditsSpy
      .mockResolvedValueOnce(state.existingCreditsRow as any)
      .mockResolvedValue(grantedRow as any);

    const result = await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(state.bonusLookupCalls).toBeGreaterThan(0); // marker was checked
    expect(addCreditsSpy).toHaveBeenCalledWith(
      'user-1',
      50,
      'bonus',
      expect.any(String),
      expect.objectContaining({ is_initial_bonus: true })
    );
    expect(result.credits_balance).toBe(50);
  });

  it('does NOT grant again when a bonus transaction already exists', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 12 });
    state.bonusTxnExists = true; // already granted in the past

    const result = await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(addCreditsSpy).not.toHaveBeenCalled();
    expect(result.credits_balance).toBe(12);
  });

  it('does NOT grant to a paid-plan user even with no bonus transaction', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });
    state.bonusTxnExists = false;
    state.userPlanRow = { plan_id: 'p1', pricing_plans: { slug: 'pro' } };

    await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(addCreditsSpy).not.toHaveBeenCalled();
  });

  it('does NOT grant when the marker lookup errors (avoids accidental double-grant)', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });
    state.bonusLookupError = { message: 'db down' };

    await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(addCreditsSpy).not.toHaveBeenCalled();
  });

  it('leaves the user eligible for retry when the credit add fails', async () => {
    state.existingCreditsRow = baseRow({ credits_balance: 0 });
    state.bonusTxnExists = false;
    addCreditsResult = { success: false, newBalance: 0 }; // transient failure
    const stillZero = baseRow({ credits_balance: 0 });
    getUserCreditsSpy
      .mockResolvedValueOnce(state.existingCreditsRow as any)
      .mockResolvedValue(stillZero as any);

    const result = await UserCreditsService.getOrCreateUserCredits('user-1');

    expect(addCreditsSpy).toHaveBeenCalled();
    // Add failed → no is_initial_bonus txn written → next call retries. Balance 0.
    expect(result.credits_balance).toBe(0);
  });
});
