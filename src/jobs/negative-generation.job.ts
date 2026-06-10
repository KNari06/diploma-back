import type { NegativeGenerationJobData } from '@/config/infrastructure/queues';
import { NegativeGenerationService } from '@/services/testing/negative/negative-generation.service';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { Job } from 'bullmq';
import * as negativeDb from '@/services/testing/negative/db/negative.db';

/**
 * BullMQ job handler for generating negative test cases.
 * Dispatched when user enables negative testing toggle and clicks generate,
 * or on plan save with negatives enabled.
 *
 * Emits WebSocket progress events for real-time UI updates.
 */
export async function processNegativeGeneration(
  job: Job<NegativeGenerationJobData>,
): Promise<{ totalGenerated: number; duration: number }> {
  const { planId, userId, testCaseIds } = job.data;
  const startTime = Date.now();

  logger.info('[NEGATIVE_GEN_JOB] Starting negative test generation', {
    planId,
    testCaseCount: testCaseIds.length,
    jobId: job.id,
  });

  // Emit start event
  webSocketService.emitToUser(userId, 'negatives:generation:started', {
    planId,
    totalTestCases: testCaseIds.length,
  });

  let totalGenerated = 0;

  for (let i = 0; i < testCaseIds.length; i++) {
    const testCaseId = testCaseIds[i];

    // Get test case name for progress events
    const testCaseName = (await negativeDb.getTestCaseName(testCaseId)) || 'Unknown';

    // Emit generating progress
    webSocketService.emitToUser(userId, 'negatives:generation:progress', {
      planId,
      testCaseId,
      testCaseName,
      status: 'generating',
      index: i,
      total: testCaseIds.length,
    });

    try {
      // Check-then-generate under the shared per-source mutex so this job and
      // an interactive regenerate can't both generate for the same source.
      const result = await NegativeGenerationService.generateForSourceGuarded(testCaseId, userId);
      if (result.skipped) {
        logger.info('[NEGATIVE_GEN_JOB] Skipping — already has fresh negatives', { testCaseId });

        webSocketService.emitToUser(userId, 'negatives:generation:progress', {
          planId,
          testCaseId,
          testCaseName,
          status: 'completed',
          generatedCount: 0,
          skipped: true,
          index: i,
          total: testCaseIds.length,
        });
        continue;
      }

      const createdIds = result.createdIds;
      totalGenerated += createdIds.length;

      // Emit completed progress
      webSocketService.emitToUser(userId, 'negatives:generation:progress', {
        planId,
        testCaseId,
        testCaseName,
        status: 'completed',
        generatedCount: createdIds.length,
        index: i,
        total: testCaseIds.length,
      });

      // Update job progress (non-critical — swallow errors)
      try {
        await job.updateProgress(Math.round(((i + 1) / testCaseIds.length) * 100));
      } catch (progressErr) {
        logger.warn('[NEGATIVE_GEN_JOB] Failed to update job progress', {
          testCaseId,
          error: progressErr instanceof Error ? progressErr.message : String(progressErr),
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      logger.error('[NEGATIVE_GEN_JOB] Failed for test case', {
        testCaseId,
        testCaseName,
        error: errorMessage,
      });

      // Non-blocking — emit failure and continue to next
      webSocketService.emitToUser(userId, 'negatives:generation:progress', {
        planId,
        testCaseId,
        testCaseName,
        status: 'failed',
        error: errorMessage,
        index: i,
        total: testCaseIds.length,
      });
    }
  }

  const duration = Date.now() - startTime;

  // Emit completion event
  webSocketService.emitToUser(userId, 'negatives:generation:completed', {
    planId,
    totalGenerated,
    duration,
  });

  logger.info('[NEGATIVE_GEN_JOB] Completed', {
    planId,
    totalGenerated,
    duration,
    jobId: job.id,
  });

  return { totalGenerated, duration };
}
