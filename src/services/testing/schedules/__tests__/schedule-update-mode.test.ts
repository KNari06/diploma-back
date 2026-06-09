/**
 * Tests for ScheduleService.update() mode reconciliation.
 *
 * update() must keep schedule_type / cron_expression / run_at consistent so the
 * row always satisfies the check_schedule_mode CHECK constraint:
 *   - passing runAt  → schedule_type='one_time', run_at set, cron_expression=null
 *   - passing cron   → schedule_type='recurring', cron set, run_at=null
 *   - both at once    → rejected before any DB write
 * It also recomputes next_run_at appropriately per mode.
 */

// Captured payload from the .update(...) call + configurable returned row.
let __lastUpdate: any = null;
const __updateRow: { data: any; error: any } = { data: null, error: null };
// Row returned by getById (.select('*').eq().eq().single()) for branches that read current.
const __currentRow: { data: any; error: any } = { data: null, error: null };

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      // getById: select('*').eq('id').eq('user_id').single()
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          eq: jest.fn(() => ({
            single: jest.fn(async () => ({ data: __currentRow.data, error: __currentRow.error })),
          })),
        })),
      })),
      // update(payload).eq('id').eq('user_id').select('*').single()
      update: jest.fn((payload: any) => {
        __lastUpdate = payload;
        return {
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              select: jest.fn(() => ({
                single: jest.fn(async () => ({ data: __updateRow.data, error: __updateRow.error })),
              })),
            })),
          })),
        };
      }),
    })),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ScheduleService } from '../schedule.service';

const FUTURE_ISO = '2999-01-01T10:00:00.000Z';
const PAST_ISO = '2000-01-01T10:00:00.000Z';

function args(overrides: Record<string, any>) {
  return { id: 'sched-1', userId: 'user-1', ...overrides } as any;
}

describe('ScheduleService.update — mode reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __lastUpdate = null;
    __updateRow.error = null;
    __updateRow.data = {
      id: 'sched-1',
      project_id: 'proj-1',
      user_id: 'user-1',
      name: 'S',
      schedule_type: 'recurring',
      cron_expression: '0 9 * * *',
      run_at: null,
      timezone: 'UTC',
      module_id: null,
      plan_id: 'plan-1',
      parameters: {},
      is_active: true,
      next_run_at: FUTURE_ISO,
      last_run_at: null,
      created_at: '2026-06-03T00:00:00.000Z',
    };
    __currentRow.error = null;
    __currentRow.data = {
      schedule_type: 'recurring',
      cron_expression: '0 9 * * *',
      run_at: null,
      timezone: 'UTC',
    };
  });

  it('rejects sending both cronExpression and runAt', async () => {
    await expect(
      ScheduleService.update(args({ cronExpression: '0 9 * * *', runAt: FUTURE_ISO })),
    ).rejects.toThrow(/at most one of cronExpression or runAt/i);
    expect(__lastUpdate).toBeNull();
  });

  it('switching recurring → one_time writes all four mode columns consistently', async () => {
    await ScheduleService.update(args({ runAt: FUTURE_ISO }));
    expect(__lastUpdate.schedule_type).toBe('one_time');
    expect(__lastUpdate.run_at).toBe(FUTURE_ISO);
    expect(__lastUpdate.cron_expression).toBeNull();
    expect(__lastUpdate.next_run_at).toBe(FUTURE_ISO);
  });

  it('switching one_time → recurring nulls run_at and recomputes next_run_at from cron', async () => {
    await ScheduleService.update(args({ cronExpression: '0 9 * * *', timezone: 'UTC' }));
    expect(__lastUpdate.schedule_type).toBe('recurring');
    expect(__lastUpdate.cron_expression).toBe('0 9 * * *');
    expect(__lastUpdate.run_at).toBeNull();
    expect(typeof __lastUpdate.next_run_at).toBe('string');
    // next_run_at must be a real future instant, never null/undefined.
    expect(Date.parse(__lastUpdate.next_run_at)).toBeGreaterThan(Date.now());
  });

  it('rejects an invalid cron before any DB write', async () => {
    await expect(ScheduleService.update(args({ cronExpression: 'nope' }))).rejects.toThrow(
      /Invalid cron expression/i,
    );
    expect(__lastUpdate).toBeNull();
  });

  it('rejects a past runAt before any DB write', async () => {
    await expect(ScheduleService.update(args({ runAt: PAST_ISO }))).rejects.toThrow(
      /must be in the future/i,
    );
    expect(__lastUpdate).toBeNull();
  });

  it('timezone-only change on a recurring row recomputes next_run_at', async () => {
    await ScheduleService.update(args({ timezone: 'Asia/Almaty' }));
    expect(__lastUpdate.timezone).toBe('Asia/Almaty');
    expect(typeof __lastUpdate.next_run_at).toBe('string');
    // Must NOT touch the mode columns on a pure tz change.
    expect(__lastUpdate.schedule_type).toBeUndefined();
    expect(__lastUpdate.run_at).toBeUndefined();
    expect(__lastUpdate.cron_expression).toBeUndefined();
  });

  it('timezone-only change on a one_time row leaves next_run_at untouched', async () => {
    __currentRow.data = {
      schedule_type: 'one_time',
      cron_expression: null,
      run_at: FUTURE_ISO,
      timezone: 'UTC',
    };
    await ScheduleService.update(args({ timezone: 'Asia/Almaty' }));
    expect(__lastUpdate.timezone).toBe('Asia/Almaty');
    expect(__lastUpdate.next_run_at).toBeUndefined();
  });

  it('name-only change touches no timing columns', async () => {
    await ScheduleService.update(args({ name: 'Renamed' }));
    expect(__lastUpdate.name).toBe('Renamed');
    expect(__lastUpdate.schedule_type).toBeUndefined();
    expect(__lastUpdate.cron_expression).toBeUndefined();
    expect(__lastUpdate.run_at).toBeUndefined();
    expect(__lastUpdate.next_run_at).toBeUndefined();
  });

  it('re-arming a one_time row with a fresh runAt reactivates it', async () => {
    // A fired one_time row is is_active=false. Supplying a new future runAt is
    // an explicit "run again" intent → update() flips is_active back to true.
    await ScheduleService.update(args({ runAt: FUTURE_ISO }));
    expect(__lastUpdate.is_active).toBe(true);
    expect(__lastUpdate.run_at).toBe(FUTURE_ISO);
    expect(__lastUpdate.next_run_at).toBe(FUTURE_ISO);
  });

  it('re-arming respects an explicit isActive=false (does not force-reactivate)', async () => {
    await ScheduleService.update(args({ runAt: FUTURE_ISO, isActive: false }));
    expect(__lastUpdate.is_active).toBe(false);
  });

  it('rejects an offset-naive runAt before any DB write', async () => {
    await expect(
      ScheduleService.update(args({ runAt: '2999-01-01T14:30:00' })),
    ).rejects.toThrow(/timezone offset/i);
    expect(__lastUpdate).toBeNull();
  });
});

describe('ScheduleService.activate — fired one_time guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __lastUpdate = null;
    __updateRow.error = null;
    __updateRow.data = { id: 'sched-1', schedule_type: 'one_time', is_active: true, created_at: 'x' };
  });

  it('rejects re-activating a one_time schedule that already fired (next_run_at null)', async () => {
    __currentRow.data = {
      schedule_type: 'one_time',
      cron_expression: null,
      run_at: FUTURE_ISO, // run_at is retained as a record of when it ran
      timezone: 'UTC',
      next_run_at: null, // cleared by claimDueSchedule when it fired
    };
    await expect(ScheduleService.activate('sched-1', 'user-1')).rejects.toThrow(
      /already run and cannot be re-activated/i,
    );
    expect(__lastUpdate).toBeNull(); // never reached the update
  });

  it('allows activating a one_time schedule that has NOT yet fired', async () => {
    __currentRow.data = {
      schedule_type: 'one_time',
      cron_expression: null,
      run_at: FUTURE_ISO,
      timezone: 'UTC',
      next_run_at: FUTURE_ISO, // still pending
    };
    await ScheduleService.activate('sched-1', 'user-1');
    expect(__lastUpdate.is_active).toBe(true);
  });

  it('allows activating a recurring schedule (no one_time guard)', async () => {
    __currentRow.data = {
      schedule_type: 'recurring',
      cron_expression: '0 9 * * *',
      run_at: null,
      timezone: 'UTC',
      next_run_at: FUTURE_ISO,
    };
    await ScheduleService.activate('sched-1', 'user-1');
    expect(__lastUpdate.is_active).toBe(true);
  });
});
