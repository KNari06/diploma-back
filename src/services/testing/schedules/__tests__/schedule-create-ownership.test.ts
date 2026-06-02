/**
 * Tests for the target-ownership gate on ScheduleService.create().
 *
 * Before this change, create() validated the cron + that exactly one target
 * was set, but never that the module/plan actually existed or belonged to the
 * caller. A schedule against a foreign/non-existent target was happily
 * persisted, then failed at run time and self-deactivated with a misleading
 * message — and it was an authorization gap.
 *
 * create() now delegates the access check to each domain's own getById
 * (dynamically imported to avoid the require cycle with RegressionPlanService).
 * These tests mock those modules and pin the gate.
 */

const __insertResult: { data: any; error: any } = { data: null, error: null };

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      insert: jest.fn(() => ({
        select: jest.fn(() => ({
          single: jest.fn(async () => ({ data: __insertResult.data, error: __insertResult.error })),
        })),
      })),
    })),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockModuleGetById = jest.fn();
const mockPlanGetById = jest.fn();

jest.mock('@/services/testing/modules/module.service', () => ({
  ModuleService: { getById: (...a: any[]) => mockModuleGetById(...a) },
}));
jest.mock('@/services/testing/plans/regression-plan.service', () => ({
  RegressionPlanService: { getById: (...a: any[]) => mockPlanGetById(...a) },
}));

import { ScheduleService } from '../schedule.service';

const PERSISTED_ROW = {
  id: 'sched-1',
  project_id: 'proj-1',
  user_id: 'user-1',
  name: 'My schedule',
  cron_expression: '0 9 * * *',
  timezone: 'UTC',
  module_id: null,
  plan_id: 'plan-1',
  parameters: {},
  is_active: true,
  next_run_at: '2026-06-04T09:00:00.000Z',
  last_run_at: null,
  created_at: '2026-06-03T00:00:00.000Z',
};

function params(overrides: Record<string, any>) {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    name: 'My schedule',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    ...overrides,
  } as any;
}

describe('ScheduleService.create — target ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __insertResult.data = PERSISTED_ROW;
    __insertResult.error = null;
  });

  it('rejects when neither moduleId nor planId is set', async () => {
    await expect(ScheduleService.create(params({}))).rejects.toThrow(
      /Exactly one of moduleId or planId/,
    );
  });

  it('rejects when both moduleId and planId are set', async () => {
    await expect(
      ScheduleService.create(params({ moduleId: 'm', planId: 'p' })),
    ).rejects.toThrow(/Exactly one of moduleId or planId/);
  });

  it('rejects an invalid cron before touching the DB', async () => {
    await expect(
      ScheduleService.create(params({ planId: 'plan-1', cronExpression: 'nope' })),
    ).rejects.toThrow(/Invalid cron expression/);
  });

  it('rejects a plan target the user cannot access', async () => {
    mockPlanGetById.mockResolvedValue(null); // no access / not found
    await expect(
      ScheduleService.create(params({ planId: 'plan-1' })),
    ).rejects.toThrow(/not found or access denied/);
    expect(mockPlanGetById).toHaveBeenCalledWith('plan-1', 'user-1');
  });

  it('rejects a module target the user cannot access', async () => {
    mockModuleGetById.mockResolvedValue(null);
    await expect(
      ScheduleService.create(params({ moduleId: 'mod-1' })),
    ).rejects.toThrow(/not found or access denied/);
    expect(mockModuleGetById).toHaveBeenCalledWith('mod-1', 'user-1');
  });

  it('creates the schedule when the plan target is accessible', async () => {
    mockPlanGetById.mockResolvedValue({ id: 'plan-1' });
    const result = await ScheduleService.create(params({ planId: 'plan-1' }));
    expect(result.id).toBe('sched-1');
    expect(result.planId).toBe('plan-1');
  });
});
