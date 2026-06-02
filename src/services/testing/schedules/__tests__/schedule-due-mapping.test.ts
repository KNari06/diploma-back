/**
 * Tests for ScheduleService.getDueSchedules() target resolution.
 *
 * Regression guard: the old mapping `row.module_id ? 'module' : 'plan'` mapped a
 * SUITE row (only suite_id set) to 'plan' with a null targetId → the scheduler
 * called runPlan(undefined) → "not found" → self-deactivated with a misleading
 * "target was deleted" message. The fix resolves the target explicitly and
 * surfaces 'suite' so the scheduler rejects it with the correct reason.
 */

const __dueRows: { data: any[]; error: any } = { data: [], error: null };

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          lte: jest.fn(async () => ({ data: __dueRows.data, error: __dueRows.error })),
        })),
      })),
    })),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ScheduleService } from '../schedule.service';

function baseRow(overrides: Record<string, any>) {
  return {
    id: 'sched-1',
    project_id: 'proj-1',
    user_id: 'user-1',
    module_id: null,
    suite_id: null,
    plan_id: null,
    parameters: {},
    ...overrides,
  };
}

describe('ScheduleService.getDueSchedules — target resolution', () => {
  beforeEach(() => {
    __dueRows.data = [];
    __dueRows.error = null;
  });

  it('maps a module row to targetType "module"', async () => {
    __dueRows.data = [baseRow({ module_id: 'mod-1' })];
    const [due] = await ScheduleService.getDueSchedules();
    expect(due.targetType).toBe('module');
    expect(due.targetId).toBe('mod-1');
  });

  it('maps a plan row to targetType "plan"', async () => {
    __dueRows.data = [baseRow({ plan_id: 'plan-1' })];
    const [due] = await ScheduleService.getDueSchedules();
    expect(due.targetType).toBe('plan');
    expect(due.targetId).toBe('plan-1');
  });

  it('maps a suite row to "suite" (NOT "plan") with its suite id', async () => {
    __dueRows.data = [baseRow({ suite_id: 'suite-1' })];
    const [due] = await ScheduleService.getDueSchedules();
    expect(due.targetType).toBe('suite');
    expect(due.targetId).toBe('suite-1');
  });

  it('maps a row with no resolvable target to suite/null', async () => {
    __dueRows.data = [baseRow({})];
    const [due] = await ScheduleService.getDueSchedules();
    expect(due.targetId).toBeNull();
  });
});
