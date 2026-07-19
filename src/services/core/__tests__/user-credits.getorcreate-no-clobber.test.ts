/**
 * Regression tests for UserCreditsService.getOrCreateUserCredits — it must NEVER
 * overwrite an existing (funded) credits row.
 *
 * Bug history (2026-07-10 incident):
 *  - getUserCredits() returns `null` on a TRANSIENT read error, not only when the
 *    row is genuinely absent. getOrCreateUserCredits treats any falsy result as
 *    "no row exists" and runs its create branch.
 *  - That branch upserted { credits_balance: 0, subscription_plan: 'free',
 *    subscription_status: 'inactive', grace_limit: 0 } with `onConflict:'user_id'`
 *    but WITHOUT `ignoreDuplicates`. In Postgres that is INSERT ... ON CONFLICT DO
 *    UPDATE, so a spurious null wiped a live, paid row back to the free defaults —
 *    with no credit_transactions entry. An active user lost ~8.3k credits this way.
 *
 * The fix makes the upsert insert-only (`ignoreDuplicates: true` → ON CONFLICT DO
 * NOTHING); the create branch's `if (!data)` refetch then returns the untouched
 * existing row.
 *
 * The mock below encodes real ON CONFLICT semantics keyed off the upsert options,
 * so with the old (unguarded) upsert these tests FAIL (row clobbered) and with the
 * fix they PASS (row preserved).
 */

import { UserCreditsService } from '../user-credits.service';

type Row = Record<string, any> | null;

const state: {
  storedRow: Row; // what actually lives in the user_credits "table"
  forceFirstReadNull: boolean; // simulate a transient error on the first getUserCredits
  userCreditsReadCount: number;
  bonusTxnExists: boolean; // welcome-bonus marker — keep true to isolate the create path
  userPlanRow: Row;
  upsertCalls: Array<{ payload: Record<string, any>; options: Record<string, any> }>;
  clobbered: boolean; // set if a conflict resolved to DO UPDATE (the bug)
} = {
  storedRow: null,
  forceFirstReadNull: false,
  userCreditsReadCount: 0,
  bonusTxnExists: true,
  userPlanRow: null,
  upsertCalls: [],
  clobbered: false,
};

function resetState(): void {
  state.storedRow = null;
  state.forceFirstReadNull = false;
  state.userCreditsReadCount = 0;
  state.bonusTxnExists = true;
  state.userPlanRow = null;
  state.upsertCalls = [];
  state.clobbered = false;
}

jest.mock('@/db/supabase', () => {
  const makeBuilder = (table: string) => {
    const ctx: any = { table, isUpsert: false };
    const builder: any = {
      select: jest.fn(() => builder),
      eq: jest.fn(() => builder),
      is: jest.fn(() => builder),
      limit: jest.fn(() => builder),
      update: jest.fn(() => builder),
      insert: jest.fn(async () => ({ data: null, error: null })),
      upsert: jest.fn((payload: any, options: any) => {
        ctx.isUpsert = true;
        ctx.payload = payload;
        if (table === 'user_credits') {
          state.upsertCalls.push({ payload, options: options || {} });
        }
        return builder;
      }),
      maybeSingle: jest.fn(async () => {
        if (table === 'users') {
          return { data: state.userPlanRow, error: null };
        }
        if (table === 'credit_transactions') {
          return { data: state.bonusTxnExists ? { id: 'txn-1' } : null, error: null };
        }
        if (table === 'user_credits') {
          if (ctx.isUpsert) {
            // Emulate INSERT ... ON CONFLICT.
            const options = state.upsertCalls[state.upsertCalls.length - 1]?.options || {};
            if (state.storedRow) {
              // Conflict on an existing row.
              if (options.ignoreDuplicates === true) {
                return { data: null, error: null }; // DO NOTHING
              }
              // DO UPDATE — the data-loss path we are guarding against.
              state.storedRow = { ...state.storedRow, ...ctx.payload };
              state.clobbered = true;
              return { data: state.storedRow, error: null };
            }
            // No existing row — genuine insert.
            state.storedRow = { ...ctx.payload };
            return { data: state.storedRow, error: null };
          }
          // Plain read (getUserCredits).
          state.userCreditsReadCount += 1;
          if (state.forceFirstReadNull && state.userCreditsReadCount === 1) {
            return { data: null, error: null }; // transient error surfaced as null
          }
          return { data: state.storedRow, error: null };
        }
        return { data: null, error: null };
      }),
    };
    return builder;
  };

  return { supabaseAdmin: { from: jest.fn((table: string) => makeBuilder(table)) } };
});

describe('UserCreditsService.getOrCreateUserCredits — no clobber of existing row', () => {
  beforeEach(() => resetState());

  it('preserves a funded balance when getUserCredits transiently returns null', async () => {
    // A real, paid row already exists in the DB.
    state.storedRow = {
      user_id: 'u-1',
      credits_balance: 8298,
      total_used: 1702,
      subscription_plan: 'pro',
      subscription_status: 'active',
      grace_limit: 100,
    };
    // First read fails transiently -> create branch runs even though the row exists.
    state.forceFirstReadNull = true;

    const result = await UserCreditsService.getOrCreateUserCredits('u-1');

    // The balance and plan must be untouched.
    expect(result.credits_balance).toBe(8298);
    expect(result.subscription_plan).toBe('pro');
    expect(result.subscription_status).toBe('active');
    expect(state.clobbered).toBe(false);
    expect(state.storedRow?.credits_balance).toBe(8298);
  });

  it('issues the create upsert as insert-only (ON CONFLICT DO NOTHING)', async () => {
    state.storedRow = { user_id: 'u-1', credits_balance: 8298, subscription_plan: 'pro' };
    state.forceFirstReadNull = true;

    await UserCreditsService.getOrCreateUserCredits('u-1');

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0].options).toMatchObject({
      onConflict: 'user_id',
      ignoreDuplicates: true,
    });
  });

  it('still creates a fresh row at 0 for a genuinely new user', async () => {
    state.storedRow = null; // no row yet
    state.forceFirstReadNull = false;

    const result = await UserCreditsService.getOrCreateUserCredits('u-new');

    expect(result.credits_balance).toBe(0);
    expect(result.subscription_plan).toBe('free');
    expect(result.subscription_status).toBe('inactive');
    expect(state.storedRow).not.toBeNull();
  });
});
