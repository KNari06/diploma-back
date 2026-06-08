/**
 * Tests for one-time (one_time) schedules.
 *
 * A one-time schedule fires once at runAt then deactivates. create() accepts
 * exactly one of cronExpression (recurring) or runAt (one_time); claimDueSchedule()
 * flips is_active=false for a one_time row instead of advancing next_run_at.
 */

// Captures the last insert payload and serves a configurable insert result.
const __insertResult: { data: any; error: any } = { data: null, error: null };
let __lastInsert: any = null;

// claim-path mock state
const __fetchResult: { data: any; error: any } = { data: null, error: null };
const __updateResult: { data: any; error: any } = { data: null, error: null };
let __lastUpdate: any = null;

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      insert: jest.fn((payload: any) => {
        __lastInsert = payload;
        return {
          select: jest.fn(() => ({
            single: jest.fn(async () => ({ data: __insertResult.data, error: __insertResult.error })),
          })),
        };
      }),
      // SELECT chain for claimDueSchedule's fetch (.select().eq().single())
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          single: jest.fn(async () => ({ data: __fetchResult.data, error: __fetchResult.error })),
        })),
      })),
      // UPDATE chain: .update(payload).eq().eq().lte().select() resolves to a thenable array.
      update: jest.fn((payload: any) => {
        __lastUpdate = payload;
        const chain: any = {
          eq: jest.fn(() => chain),
          lte: jest.fn(() => chain),
          select: jest.fn(async () => ({ data: __updateResult.data, error: __updateResult.error })),
        };
        return chain;
      }),
    })),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPlanGetById = jest.fn();
jest.mock('@/services/testing/modules/module.service', () => ({
  ModuleService: { getById: jest.fn() },
}));
jest.mock('@/services/testing/plans/regression-plan.service', () => ({
  RegressionPlanService: { getById: (...a: any[]) => mockPlanGetById(...a) },
}));

import { ScheduleService } from '../schedule.service';

const FUTURE_ISO = '2999-01-01T10:00:00.000Z';
const PAST_ISO = '2000-01-01T10:00:00.000Z';

function params(overrides: Record<string, any>) {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    name: 'One-time run',
    planId: 'plan-1',
    ...overrides,
  } as any;
}

describe('ScheduleService.create — one-time vs recurring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __lastInsert = null;
    __insertResult.error = null;
    __insertResult.data = {
      id: 'sched-1',
      project_id: 'proj-1',
      user_id: 'user-1',
      name: 'One-time run',
      schedule_type: 'one_time',
      cron_expression: null,
      run_at: FUTURE_ISO,
      timezone: 'UTC',
      module_id: null,
      plan_id: 'plan-1',
      parameters: {},
      is_active: true,
      next_run_at: FUTURE_ISO,
      last_run_at: null,
      created_at: '2026-06-03T00:00:00.000Z',
    };
    mockPlanGetById.mockResolvedValue({ id: 'plan-1' });
  });

  it('rejects when both cronExpression and runAt are provided', async () => {
    await expect(
      ScheduleService.create(params({ cronExpression: '0 9 * * *', runAt: FUTURE_ISO })),
    ).rejects.toThrow(/exactly one of cronExpression or runAt/i);
  });

  it('rejects when neither cronExpression nor runAt is provided', async () => {
    await expect(ScheduleService.create(params({}))).rejects.toThrow(
      /exactly one of cronExpression or runAt/i,
    );
  });

  it('rejects a runAt in the past', async () => {
    await expect(ScheduleService.create(params({ runAt: PAST_ISO }))).rejects.toThrow(
      /must be in the future/i,
    );
  });

  it('rejects an unparseable runAt', async () => {
    // 'not-a-date' has no timezone offset, so it trips the offset guard first —
    // either way it is rejected before any DB write.
    await expect(ScheduleService.create(params({ runAt: 'not-a-date' }))).rejects.toThrow(
      /Invalid runAt|timezone offset/i,
    );
  });

  it('rejects an offset-naive runAt (no Z / ±HH:MM) so it cannot anchor to server-local time', async () => {
    await expect(
      ScheduleService.create(params({ runAt: '2999-01-01T14:30:00' })),
    ).rejects.toThrow(/timezone offset/i);
  });

  it('accepts a runAt with a ±HH:MM offset (not just Z)', async () => {
    const result = await ScheduleService.create(params({ runAt: '2999-01-01T14:30:00+05:00' }));
    expect(result.scheduleType).toBe('one_time');
    // normalized to absolute UTC: 14:30+05:00 → 09:30Z (same calendar day)
    expect(__lastInsert.run_at).toBe('2999-01-01T09:30:00.000Z');
  });

  it('persists a one_time row: schedule_type=one_time, cron null, run_at & next_run_at set', async () => {
    const result = await ScheduleService.create(params({ runAt: FUTURE_ISO }));
    expect(__lastInsert.schedule_type).toBe('one_time');
    expect(__lastInsert.cron_expression).toBeNull();
    expect(__lastInsert.run_at).toBe(FUTURE_ISO);
    expect(__lastInsert.next_run_at).toBe(FUTURE_ISO);
    expect(result.scheduleType).toBe('one_time');
    expect(result.runAt).toBe(FUTURE_ISO);
  });
});

describe('ScheduleService.claimDueSchedule — one-time deactivates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __lastUpdate = null;
    __fetchResult.error = null;
    __updateResult.error = null;
  });

  it('flips is_active=false and clears next_run_at on a one_time claim', async () => {
    __fetchResult.data = { schedule_type: 'one_time', cron_expression: null, timezone: 'UTC' };
    __updateResult.data = [{ id: 'sched-1' }]; // 1 row matched → we won the race

    const claimed = await ScheduleService.claimDueSchedule('sched-1');

    expect(claimed).toBe(true);
    expect(__lastUpdate.is_active).toBe(false);
    expect(__lastUpdate.next_run_at).toBeNull();
    expect(__lastUpdate.last_run_at).toBeDefined();
  });

  it('returns false when a one_time row was already claimed (0 rows matched)', async () => {
    __fetchResult.data = { schedule_type: 'one_time', cron_expression: null, timezone: 'UTC' };
    __updateResult.data = []; // lost the race

    const claimed = await ScheduleService.claimDueSchedule('sched-1');
    expect(claimed).toBe(false);
  });
});
