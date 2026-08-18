/**
 * "Analysed and found nothing" and "never analysed" are indistinguishable from
 * the findings table alone — both are zero rows. The run report needs to tell
 * them apart, and the only thing that already knows is the run's own completed
 * BullMQ job, whose id is pinned to `doctor-<runId>`.
 *
 * This reads that job. It is best-effort on purpose: a Redis hiccup, or a job
 * that has aged out of the retained history, must degrade the panel's wording
 * rather than fail the request that draws the report.
 *
 * The queue module replaces BullMQ with an inert proxy under test (`IS_TEST`),
 * so the seam here is the exported queue object itself, not the `bullmq` module.
 */

import { QueueManager, regressionDoctorQueue } from '../queues';

const getJob = jest.spyOn(regressionDoctorQueue, 'getJob');

describe('QueueManager.getRegressionDoctorJobStatus', () => {
  beforeEach(() => jest.clearAllMocks());
  afterAll(() => getJob.mockRestore());

  it('reports a finished analysis that proposed nothing, with the reasons', async () => {
    getJob.mockResolvedValue({
      getState: async () => 'completed',
      returnvalue: {
        findingsCreated: 0,
        skipped: 2,
        skipReasons: { injected_step: 1, no_executed_steps: 1 },
        cappedOut: 0,
      },
      finishedOn: Date.parse('2026-08-17T07:10:00.000Z'),
    } as never);

    const status = await QueueManager.getRegressionDoctorJobStatus('run-1');

    expect(getJob).toHaveBeenCalledWith('doctor-run-1');
    expect(status).toEqual({
      state: 'completed',
      findingsCreated: 0,
      skipped: 2,
      skipReasons: { injected_step: 1, no_executed_steps: 1 },
      cappedOut: 0,
      finishedAt: '2026-08-17T07:10:00.000Z',
    });
  });

  it('carries how many failures the per-run cap excluded', async () => {
    getJob.mockResolvedValue({
      getState: async () => 'completed',
      returnvalue: { findingsCreated: 10, skipped: 0, skipReasons: {}, cappedOut: 11 },
      finishedOn: Date.parse('2026-08-17T08:06:00.000Z'),
    } as never);

    const status = await QueueManager.getRegressionDoctorJobStatus('run-1');

    expect(status?.findingsCreated).toBe(10);
    expect(status?.cappedOut).toBe(11);
  });

  it('reports cappedOut as null for a job that predates the field', async () => {
    getJob.mockResolvedValue({
      getState: async () => 'completed',
      returnvalue: { findingsCreated: 1, skipped: 0 },
      finishedOn: Date.parse('2026-08-16T12:00:00.000Z'),
    } as never);

    const status = await QueueManager.getRegressionDoctorJobStatus('run-1');

    expect(status?.cappedOut).toBeNull();
  });

  it('returns null for a run nobody has analysed', async () => {
    getJob.mockResolvedValue(undefined as never);

    expect(await QueueManager.getRegressionDoctorJobStatus('run-1')).toBeNull();
  });

  it('reports an in-flight analysis as not finished, so the panel keeps waiting', async () => {
    getJob.mockResolvedValue({
      getState: async () => 'active',
      returnvalue: undefined,
      finishedOn: undefined,
    } as never);

    const status = await QueueManager.getRegressionDoctorJobStatus('run-1');

    expect(status?.state).toBe('active');
    expect(status?.findingsCreated).toBeNull();
    expect(status?.finishedAt).toBeNull();
  });

  it('degrades to null instead of throwing when the queue is unreachable', async () => {
    getJob.mockRejectedValue(new Error('redis down'));

    await expect(QueueManager.getRegressionDoctorJobStatus('run-1')).resolves.toBeNull();
  });
});
