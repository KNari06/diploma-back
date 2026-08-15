/**
 * Tests for TestSchedulerJobHandler dispatch behaviour.
 *
 * Focus: routing per due schedule — claim gating, suite/null rejection (no
 * runSuite path), owner-access revalidation (E1), and correct module/plan
 * dispatch. The cron engine is covered by schedule-cron.test.ts; here we stub
 * ScheduleService entirely.
 */

jest.mock('@/services/testing/schedules/schedule.service', () => ({
  ScheduleService: {
    getDueSchedules: jest.fn(),
    claimDueSchedule: jest.fn(),
    deactivate: jest.fn(),
    userOwnsTarget: jest.fn(),
  },
}));

jest.mock('@/services/testing/regression/regression-run.service', () => ({
  RegressionRunService: { runModule: jest.fn(), runPlan: jest.fn() },
}));

jest.mock('@/services/notifications/notification.service', () => ({
  NotificationService: { createNotification: jest.fn() },
}));

jest.mock('@/config/infrastructure/queues', () => ({
  testRunQueue: {
    client: Promise.resolve({ set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) }),
  },
}));

jest.mock('@/config/environment/env', () => ({
  env: {
    QUEUE_PREFIX: 'test:',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    SUPABASE_BUCKET_NAME: 'test-bucket',
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { TestSchedulerJobHandler } from '../test-scheduler.job';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { NotificationService } from '@/services/notifications/notification.service';

const mockGetDue = ScheduleService.getDueSchedules as jest.Mock;
const mockClaim = ScheduleService.claimDueSchedule as jest.Mock;
const mockDeactivate = ScheduleService.deactivate as jest.Mock;
const mockOwns = ScheduleService.userOwnsTarget as jest.Mock;
const mockRunModule = RegressionRunService.runModule as jest.Mock;
const mockRunPlan = RegressionRunService.runPlan as jest.Mock;
const mockNotify = NotificationService.createNotification as jest.Mock;

function due(overrides: Record<string, any>) {
  return {
    scheduleId: 'sched-1',
    projectId: 'proj-1',
    userId: 'user-1',
    scheduleType: 'recurring',
    targetType: 'plan',
    targetId: 'plan-1',
    parameters: {},
    ...overrides,
  };
}

describe('TestSchedulerJobHandler.processSchedules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaim.mockResolvedValue(true);
    mockDeactivate.mockResolvedValue(undefined);
    mockOwns.mockResolvedValue(true); // owner still has access by default
    mockRunModule.mockResolvedValue({ runId: 'r1' });
    mockRunPlan.mockResolvedValue({ runId: 'r1' });
  });

  it('does nothing when there are no due schedules', async () => {
    mockGetDue.mockResolvedValue([]);
    await TestSchedulerJobHandler.processSchedules();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRunPlan).not.toHaveBeenCalled();
  });

  it('skips a schedule it fails to claim (lost the race)', async () => {
    mockGetDue.mockResolvedValue([due({})]);
    mockClaim.mockResolvedValue(false);
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).not.toHaveBeenCalled();
  });

  it('dispatches a plan schedule to runPlan with trigger "scheduled"', async () => {
    mockGetDue.mockResolvedValue([due({ targetType: 'plan', targetId: 'plan-9' })]);
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: 'plan-9', trigger: 'scheduled' }),
    );
  });

  it('dispatches a module schedule to runModule', async () => {
    mockGetDue.mockResolvedValue([due({ targetType: 'module', targetId: 'mod-9' })]);
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunModule).toHaveBeenCalledWith(
      expect.objectContaining({ moduleId: 'mod-9', trigger: 'scheduled' }),
    );
  });

  it('rejects a suite schedule: deactivates it, never calls runPlan', async () => {
    mockGetDue.mockResolvedValue([due({ targetType: 'suite', targetId: 'suite-9' })]);
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).not.toHaveBeenCalled();
    expect(mockRunModule).not.toHaveBeenCalled();
    expect(mockDeactivate).toHaveBeenCalledWith('sched-1', 'user-1');
  });

  it('rejects a schedule with a null target id and deactivates it', async () => {
    mockGetDue.mockResolvedValue([due({ targetType: 'plan', targetId: null })]);
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).not.toHaveBeenCalled();
    expect(mockDeactivate).toHaveBeenCalledWith('sched-1', 'user-1');
  });

  it('(E1) deactivates and does NOT dispatch when the owner DEFINITIVELY lost access', async () => {
    mockGetDue.mockResolvedValue([due({ targetType: 'plan', targetId: 'plan-9' })]);
    mockOwns.mockResolvedValue(false); // definitive "no access"
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).not.toHaveBeenCalled();
    expect(mockDeactivate).toHaveBeenCalledWith('sched-1', 'user-1');
  });

  it('(E1) on a TRANSIENT access-check error: skips the tick, does NOT deactivate, does NOT dispatch', async () => {
    // A DB blip during the ownership check must never permanently disable a
    // valid schedule. userOwnsTarget throws → skip this occurrence, retry next.
    mockGetDue.mockResolvedValue([due({ targetType: 'plan', targetId: 'plan-9' })]);
    mockOwns.mockRejectedValue(new Error('supabase timeout'));
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).not.toHaveBeenCalled();
    expect(mockDeactivate).not.toHaveBeenCalled(); // the critical assertion
  });

  it('continues to the next schedule when one dispatch throws', async () => {
    mockGetDue.mockResolvedValue([
      due({ scheduleId: 's1', targetId: 'plan-1' }),
      due({ scheduleId: 's2', targetId: 'plan-2' }),
    ]);
    mockRunPlan.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ runId: 'r2' });
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).toHaveBeenCalledTimes(2);
  });

  it('on a ONE_TIME dispatch failure, notifies that it will NOT retry (already deactivated by claim)', async () => {
    mockGetDue.mockResolvedValue([due({ scheduleType: 'one_time', targetType: 'plan', targetId: 'plan-9' })]);
    mockRunPlan.mockRejectedValueOnce(new Error('runner crash'));
    await TestSchedulerJobHandler.processSchedules();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = mockNotify.mock.calls[0][0];
    expect(arg.title).toMatch(/one-time/i);
    expect(arg.message).toMatch(/NOT retry/i);
    expect(arg.message).not.toMatch(/next scheduled run will try again/i);
  });

  it('on a RECURRING dispatch failure, notifies that the next run will retry', async () => {
    mockGetDue.mockResolvedValue([due({ scheduleType: 'recurring', targetType: 'plan', targetId: 'plan-9' })]);
    mockRunPlan.mockRejectedValueOnce(new Error('network blip'));
    await TestSchedulerJobHandler.processSchedules();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = mockNotify.mock.calls[0][0];
    expect(arg.message).toMatch(/next scheduled run will try again/i);
    expect(arg.message).not.toMatch(/NOT retry/i);
  });
});
