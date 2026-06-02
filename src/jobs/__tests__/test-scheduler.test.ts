/**
 * Tests for TestSchedulerJobHandler dispatch behaviour.
 *
 * Focus: the routing decisions made per due schedule — claim gating, suite
 * rejection (no runSuite() path), and correct dispatch for module/plan. The
 * cron engine itself is covered by schedule-cron.test.ts; here we stub
 * ScheduleService entirely and assert how the handler reacts.
 */

jest.mock('@/services/testing/schedules/schedule.service', () => ({
  ScheduleService: {
    getDueSchedules: jest.fn(),
    claimDueSchedule: jest.fn(),
    deactivate: jest.fn(),
  },
}));

jest.mock('@/services/testing/regression/regression-run.service', () => ({
  RegressionRunService: {
    runModule: jest.fn(),
    runPlan: jest.fn(),
  },
}));

jest.mock('@/services/notifications/notification.service', () => ({
  NotificationService: { createNotification: jest.fn() },
}));

// Heartbeat writes to Redis — stub the queue client so no real Redis is hit.
jest.mock('@/config/infrastructure/queues', () => ({
  testRunQueue: {
    client: Promise.resolve({
      set: jest.fn(async () => 'OK'),
      get: jest.fn(async () => null),
    }),
  },
}));

jest.mock('@/config/environment/env', () => ({ env: { QUEUE_PREFIX: 'test:' } }));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { TestSchedulerJobHandler } from '../test-scheduler.job';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';

const mockGetDue = ScheduleService.getDueSchedules as jest.Mock;
const mockClaim = ScheduleService.claimDueSchedule as jest.Mock;
const mockDeactivate = ScheduleService.deactivate as jest.Mock;
const mockRunModule = RegressionRunService.runModule as jest.Mock;
const mockRunPlan = RegressionRunService.runPlan as jest.Mock;

function due(overrides: Record<string, any>) {
  return {
    scheduleId: 'sched-1',
    projectId: 'proj-1',
    userId: 'user-1',
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

  it('rejects a suite schedule: deactivates it and never calls runPlan', async () => {
    mockGetDue.mockResolvedValue([due({ targetType: 'suite', targetId: 'suite-9' })]);
    await TestSchedulerJobHandler.processSchedules();
    // Regression: a suite must NOT be misrouted to runPlan(undefined).
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

  it('continues to the next schedule when one dispatch throws', async () => {
    mockGetDue.mockResolvedValue([
      due({ scheduleId: 's1', targetId: 'plan-1' }),
      due({ scheduleId: 's2', targetId: 'plan-2' }),
    ]);
    mockRunPlan.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ runId: 'r2' });
    await TestSchedulerJobHandler.processSchedules();
    expect(mockRunPlan).toHaveBeenCalledTimes(2);
  });
});
