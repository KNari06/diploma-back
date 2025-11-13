import { Request, Response } from 'express';
import { logger } from '@/utils/logger';
import { QueueMonitor } from '@/utils/queue-monitor';

/**
 * GET /api/v1/queue/status
 * Получить состояние очереди (для debugging)
 */
export const getQueueStatus = async (req: Request, res: Response) => {
  try {
    logger.info('[QUEUE_STATUS] Fetching queue status');

    const status = await QueueMonitor.getQueueStatus();
    const waiting = await QueueMonitor.getWaitingJobs();
    const active = await QueueMonitor.getActiveJobs();
    const failed = await QueueMonitor.getFailedJobs();

    res.json({
      success: true,
      data: {
        status,
        waiting: waiting.map(job => ({
          id: job.id,
          testId: job.data?.testId,
          browser: job.data?.browser,
          intelligentMode: job.data?.intelligentMode,
        })),
        active: active.map(job => ({
          id: job.id,
          testId: job.data?.testId,
          browser: job.data?.browser,
          intelligentMode: job.data?.intelligentMode,
        })),
        failed: failed.map(job => ({
          id: job.id,
          testId: job.data?.testId,
          browser: job.data?.browser,
          failedReason: job.failedReason,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[QUEUE_STATUS] Failed to get queue status', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get queue status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

/**
 * GET /api/v1/queue/job/:jobId
 * Получить информацию о конкретном job
 */
export const getJobStatus = async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    logger.info('[QUEUE_STATUS] Fetching job status', { jobId });

    const result = await QueueMonitor.getJob(jobId);

    if (!result) {
      res.status(404).json({
        success: false,
        error: 'Job not found',
      });
      return;
    }

    const { job, state } = result;

    res.json({
      success: true,
      data: {
        id: job.id,
        state,
        testId: job.data?.testId,
        browser: job.data?.browser,
        intelligentMode: job.data?.intelligentMode,
        attempts: job.attemptsMade,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[QUEUE_STATUS] Failed to get job status', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get job status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};
