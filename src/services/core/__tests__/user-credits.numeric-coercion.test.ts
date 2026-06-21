/**
 * Regression tests: Postgres NUMERIC columns arrive as JSON STRINGS ("50.00")
 * from PostgREST, even though the TS interface types them as `number`. Before
 * the fix, every `Number.isFinite(credits.credits_balance)` guard saw a string,
 * returned false, and silently coerced the balance to 0 — breaking every gate,
 * deduction, and addition. These tests feed the REAL string shape through the
 * service and assert numbers come out.
 */

import { UserCreditsService } from '../user-credits.service';

// Controllable supabaseAdmin mock. We return STRING NUMERIC values (the real
// PostgREST shape) and capture what gets written back on update.
const state: {
  row: Record<string, any> | null;
  lastUpdate: Record<string, any> | null;
} = { row: null, lastUpdate: null };

jest.mock('@/db/supabase', () => {
  const makeBuilder = (table: string) => {
    const ctx: any = { table, op: 'select' };
    const builder: any = {
      select: jest.fn(() => builder),
      update: jest.fn((payload: any) => {
        ctx.op = 'update';
        if (table === 'user_credits') state.lastUpdate = payload;
        return builder;
      }),
      upsert: jest.fn(() => { ctx.op = 'upsert'; return builder; }),
      insert: jest.fn(async () => ({ data: null, error: null })),
      eq: jest.fn(() => builder),
      is: jest.fn(() => builder),
      maybeSingle: jest.fn(async () => {
        if (ctx.table === 'users') return { data: { plan_id: null, pricing_plans: null }, error: null };
        return { data: state.row, error: null };
      }),
    };
    return builder;
  };
  return { supabaseAdmin: { from: jest.fn((t: string) => makeBuilder(t)) } };
});

function stringRow(overrides: Record<string, any> = {}) {
  // Every NUMERIC field as a STRING, mirroring PostgREST.
  return {
    id: 'uc-1',
    user_id: 'user-1',
    credits_balance: '50.00',
    total_purchased: '0.00',
    total_used: '0.00',
    subscription_plan: 'free',
    subscription_status: 'inactive',
    subscription_expires_at: null,
    grace_limit: '0.00',
    overage_balance: '0.00',
    grace_started_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('UserCreditsService NUMERIC-as-string coercion', () => {
  beforeEach(() => {
    state.row = null;
    state.lastUpdate = null;
    jest.clearAllMocks();
  });

  it('getUserCredits returns a real number for a string balance', async () => {
    state.row = stringRow({ credits_balance: '50.00', grace_limit: '100.00' });
    const c = await UserCreditsService.getUserCredits('user-1');
    expect(c?.credits_balance).toBe(50);
    expect(c?.grace_limit).toBe(100);
    expect(typeof c?.credits_balance).toBe('number');
  });

  it('hasCredits is TRUE for a funded user whose balance is a string (was false before)', async () => {
    state.row = stringRow({ credits_balance: '50.00' });
    await expect(UserCreditsService.hasCredits('user-1', 1)).resolves.toBe(true);
  });

  it('hasCredits respects grace headroom with string grace_limit', async () => {
    state.row = stringRow({ credits_balance: '0.00', grace_limit: '100.00' });
    await expect(UserCreditsService.hasCredits('user-1', 30)).resolves.toBe(true);
  });

  it('deductCredits computes from the real balance, not a phantom 0', async () => {
    state.row = stringRow({ credits_balance: '50.00' });
    const res = await UserCreditsService.deductCredits('user-1', 1, 'test deduction');
    expect(res.success).toBe(true);
    expect(res.newBalance).toBe(49); // not -1
    expect(Number(state.lastUpdate?.credits_balance)).toBe(49); // written value is correct
  });

  it('addCredits adds to the real balance, not overwriting it with just the delta', async () => {
    state.row = stringRow({ credits_balance: '50.00' });
    const res = await UserCreditsService.addCredits('user-1', 10, 'bonus', 'top up');
    expect(res.success).toBe(true);
    expect(res.newBalance).toBe(60); // not 10 — the existing 50 is preserved
    expect(Number(state.lastUpdate?.credits_balance)).toBe(60);
  });
});
