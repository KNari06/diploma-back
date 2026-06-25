// QueueMonitor wraps the BullMQ testRunQueue. We mock the queue module so no
// real Redis/BullMQ connection is opened. Logger + env are globally mocked in
// jest.setup.ts.
const mockQueue = {
  getJobCounts: jest.fn(),
  getWaiting: jest.fn(),
  getActive: jest.fn(),
  getFailed: jest.fn(),
  getJob: jest.fn(),
};

jest.mock('@/config/infrastructure/queues', () => ({
  testRunQueue: mockQueue,
  QUEUE_NAMES: { TEST_RUN: 'test-run' },
}));

import { QueueMonitor } from '../queue-monitor';

const ZERO_COUNTS = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 };

describe('QueueMonitor.getQueueStatus', () => {
  it('returns the raw counts object on success', async () => {
    const counts = { ...ZERO_COUNTS, waiting: 2, active: 1 };
    mockQueue.getJobCounts.mockResolvedValueOnce(counts);
    await expect(QueueMonitor.getQueueStatus()).resolves.toBe(counts);
  });

  it('returns a zeroed object when counts is not an object', async () => {
    mockQueue.getJobCounts.mockResolvedValueOnce(null);
    await expect(QueueMonitor.getQueueStatus()).resolves.toEqual(ZERO_COUNTS);
  });

  it('returns null when the queue throws', async () => {
    mockQueue.getJobCounts.mockRejectedValueOnce(new Error('redis down'));
    await expect(QueueMonitor.getQueueStatus()).resolves.toBeNull();
  });
});

describe('QueueMonitor.getWaitingJobs', () => {
  it('returns the jobs array on success', async () => {
    const jobs = [{ id: '1', data: { testId: 't1' }, timestamp: 1 }];
    mockQueue.getWaiting.mockResolvedValueOnce(jobs);
    await expect(QueueMonitor.getWaitingJobs()).resolves.toBe(jobs);
    expect(mockQueue.getWaiting).toHaveBeenCalledWith(0, 9);
  });

  it('tolerates malformed job entries while logging', async () => {
    mockQueue.getWaiting.mockResolvedValueOnce([null, { id: '2', data: {} }]);
    await expect(QueueMonitor.getWaitingJobs()).resolves.toHaveLength(2);
  });

  it('returns [] when the result is not an array', async () => {
    mockQueue.getWaiting.mockResolvedValueOnce('nope' as unknown as []);
    await expect(QueueMonitor.getWaitingJobs()).resolves.toEqual([]);
  });

  it('returns [] when the queue throws', async () => {
    mockQueue.getWaiting.mockRejectedValueOnce(new Error('boom'));
    await expect(QueueMonitor.getWaitingJobs()).resolves.toEqual([]);
  });
});

describe('QueueMonitor.getActiveJobs', () => {
  it('returns the jobs array on success', async () => {
    const jobs = [{ id: '1', data: {}, processedOn: 5 }];
    mockQueue.getActive.mockResolvedValueOnce(jobs);
    await expect(QueueMonitor.getActiveJobs()).resolves.toBe(jobs);
  });

  it('returns [] for a non-array result', async () => {
    mockQueue.getActive.mockResolvedValueOnce(undefined as unknown as []);
    await expect(QueueMonitor.getActiveJobs()).resolves.toEqual([]);
  });

  it('returns [] when the queue throws', async () => {
    mockQueue.getActive.mockRejectedValueOnce(new Error('boom'));
    await expect(QueueMonitor.getActiveJobs()).resolves.toEqual([]);
  });
});

describe('QueueMonitor.getFailedJobs', () => {
  it('returns the jobs array and tolerates a non-numeric attemptsMade', async () => {
    const jobs = [{ id: '1', data: {}, failedReason: 'x', attemptsMade: 'NaN' }];
    mockQueue.getFailed.mockResolvedValueOnce(jobs);
    await expect(QueueMonitor.getFailedJobs()).resolves.toBe(jobs);
  });

  it('returns [] for a non-array result', async () => {
    mockQueue.getFailed.mockResolvedValueOnce(null as unknown as []);
    await expect(QueueMonitor.getFailedJobs()).resolves.toEqual([]);
  });

  it('returns [] when the queue throws', async () => {
    mockQueue.getFailed.mockRejectedValueOnce(new Error('boom'));
    await expect(QueueMonitor.getFailedJobs()).resolves.toEqual([]);
  });
});

describe('QueueMonitor.getJob', () => {
  it('rejects an empty or non-string jobId before querying', async () => {
    await expect(QueueMonitor.getJob('')).resolves.toBeNull();
    await expect(QueueMonitor.getJob('   ')).resolves.toBeNull();
    await expect(QueueMonitor.getJob(null as unknown as string)).resolves.toBeNull();
    expect(mockQueue.getJob).not.toHaveBeenCalled();
  });

  it('returns null when the job is not found', async () => {
    mockQueue.getJob.mockResolvedValueOnce(null);
    await expect(QueueMonitor.getJob('abc')).resolves.toBeNull();
  });

  it('trims the jobId before lookup', async () => {
    mockQueue.getJob.mockResolvedValueOnce(null);
    await QueueMonitor.getJob('  abc  ');
    expect(mockQueue.getJob).toHaveBeenCalledWith('abc');
  });

  it('returns the job and its state on success', async () => {
    const job = { id: 'j1', data: { testId: 't' }, getState: jest.fn().mockResolvedValue('active') };
    mockQueue.getJob.mockResolvedValueOnce(job);
    await expect(QueueMonitor.getJob('j1')).resolves.toEqual({ job, state: 'active' });
  });

  it('falls back to state "unknown" when getState throws', async () => {
    const job = { id: 'j1', data: {}, getState: jest.fn().mockRejectedValue(new Error('no state')) };
    mockQueue.getJob.mockResolvedValueOnce(job);
    await expect(QueueMonitor.getJob('j1')).resolves.toEqual({ job, state: 'unknown' });
  });

  it('returns null when the lookup throws', async () => {
    mockQueue.getJob.mockRejectedValueOnce(new Error('boom'));
    await expect(QueueMonitor.getJob('j1')).resolves.toBeNull();
  });
});

describe('QueueMonitor.monitorAfterJobAdd', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns early without scheduling for an invalid jobId', async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setTimeout');
    await QueueMonitor.monitorAfterJobAdd('', 't1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns early without scheduling for an invalid testId', async () => {
    jest.useFakeTimers();
    const spy = jest.spyOn(global, 'setTimeout');
    await QueueMonitor.monitorAfterJobAdd('j1', '   ');
    expect(spy).not.toHaveBeenCalled();
  });

  it('schedules a deferred check and runs it without throwing for valid input', async () => {
    jest.useFakeTimers();
    const statusSpy = jest.spyOn(QueueMonitor, 'getQueueStatus').mockResolvedValue(ZERO_COUNTS);
    const getJobSpy = jest.spyOn(QueueMonitor, 'getJob').mockResolvedValue({ job: { id: 'j1' } as any, state: 'active' });

    await QueueMonitor.monitorAfterJobAdd('j1', 't1');
    await jest.advanceTimersByTimeAsync(2000);

    expect(statusSpy).toHaveBeenCalled();
    expect(getJobSpy).toHaveBeenCalledWith('j1');
  });

  it('scans all states when the job is not directly found', async () => {
    jest.useFakeTimers();
    jest.spyOn(QueueMonitor, 'getQueueStatus').mockResolvedValue(ZERO_COUNTS);
    jest.spyOn(QueueMonitor, 'getJob').mockResolvedValue(null);
    const waitingSpy = jest.spyOn(QueueMonitor, 'getWaitingJobs').mockResolvedValue([]);
    const activeSpy = jest.spyOn(QueueMonitor, 'getActiveJobs').mockResolvedValue([]);
    const failedSpy = jest.spyOn(QueueMonitor, 'getFailedJobs').mockResolvedValue([]);

    await QueueMonitor.monitorAfterJobAdd('j1', 't1');
    await jest.advanceTimersByTimeAsync(2000);

    // Fallback path scanned every state looking for the missing job.
    expect(waitingSpy).toHaveBeenCalled();
    expect(activeSpy).toHaveBeenCalled();
    expect(failedSpy).toHaveBeenCalled();
  });

  it('finds the job in a non-default state without warning', async () => {
    jest.useFakeTimers();
    jest.spyOn(QueueMonitor, 'getQueueStatus').mockResolvedValue(ZERO_COUNTS);
    jest.spyOn(QueueMonitor, 'getJob').mockResolvedValue(null);
    jest.spyOn(QueueMonitor, 'getWaitingJobs').mockResolvedValue([{ id: 'j1' } as any]);
    jest.spyOn(QueueMonitor, 'getActiveJobs').mockResolvedValue([]);
    jest.spyOn(QueueMonitor, 'getFailedJobs').mockResolvedValue([]);

    await QueueMonitor.monitorAfterJobAdd('j1', 't1');
    await expect(jest.advanceTimersByTimeAsync(2000)).resolves.toBeUndefined();
  });

  it('swallows errors thrown inside the deferred callback', async () => {
    jest.useFakeTimers();
    jest.spyOn(QueueMonitor, 'getQueueStatus').mockRejectedValue(new Error('boom'));
    await QueueMonitor.monitorAfterJobAdd('j1', 't1');
    await expect(jest.advanceTimersByTimeAsync(2000)).resolves.toBeUndefined();
  });
});

describe('QueueMonitor.startPeriodicMonitoring', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('clamps an invalid interval to the default and returns a timer handle', () => {
    jest.useFakeTimers();
    const id = QueueMonitor.startPeriodicMonitoring(10 as number);
    expect(id).toBeDefined();
    QueueMonitor.stopPeriodicMonitoring(id);
  });

  it('warns when jobs are waiting but none are active', async () => {
    jest.useFakeTimers();
    const statusSpy = jest
      .spyOn(QueueMonitor, 'getQueueStatus')
      .mockResolvedValue({ ...ZERO_COUNTS, waiting: 3, active: 0 });

    const id = QueueMonitor.startPeriodicMonitoring(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(statusSpy).toHaveBeenCalled();
    QueueMonitor.stopPeriodicMonitoring(id);
  });

  it('pulls failed-job detail when failures exceed the threshold', async () => {
    jest.useFakeTimers();
    jest.spyOn(QueueMonitor, 'getQueueStatus').mockResolvedValue({ ...ZERO_COUNTS, failed: 6 });
    const failedSpy = jest.spyOn(QueueMonitor, 'getFailedJobs').mockResolvedValue([]);

    const id = QueueMonitor.startPeriodicMonitoring(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(failedSpy).toHaveBeenCalled();
    QueueMonitor.stopPeriodicMonitoring(id);
  });

  it('keeps running when a check throws', async () => {
    jest.useFakeTimers();
    jest.spyOn(QueueMonitor, 'getQueueStatus').mockRejectedValue(new Error('boom'));
    const id = QueueMonitor.startPeriodicMonitoring(1000);
    await expect(jest.advanceTimersByTimeAsync(1000)).resolves.toBeUndefined();
    QueueMonitor.stopPeriodicMonitoring(id);
  });
});

describe('QueueMonitor.stopPeriodicMonitoring', () => {
  it('is a no-op for a null/undefined handle', () => {
    expect(() => QueueMonitor.stopPeriodicMonitoring(null)).not.toThrow();
    expect(() => QueueMonitor.stopPeriodicMonitoring(undefined)).not.toThrow();
  });

  it('clears a real interval handle', () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const id = setInterval(() => {}, 100000);
    QueueMonitor.stopPeriodicMonitoring(id);
    expect(clearSpy).toHaveBeenCalledWith(id);
    clearSpy.mockRestore();
  });
});
