/**
 * Allure Import BullMQ Job Handler
 *
 * Processes async Allure ZIP import jobs queued by the REST API controller.
 * Follows the AIAnalysisJobHandler template:
 *   - Static `process()` method
 *   - WebSocket progress/completed/failed events (non-fatal try-catch)
 *   - Re-throws on fatal parse errors so BullMQ marks job as failed
 */

import { Job } from 'bullmq';
import { logger, logQueueEvent } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { processAllureImportDispatch } from '@/services/allure-import/allure-import.service';
import type { AllureImportJobData } from '@/services/allure-import/allure-import.types';
import type { ProgressEmitter, AllureImportResult } from '@/services/allure-import/allure-import.service';

export class AllureImportJobHandler {
  /**
   * Process an Allure import job.
   *
   * Emits WebSocket progress events to room `import:{importId}`.
   * Returns the final AllureImportStats (stored by BullMQ as job returnvalue).
   *
   * Only re-throws if the ZIP itself cannot be parsed (catastrophic failure).
   * All other errors are collected in stats.errors[] and the job completes
   * with partial success.
   */
  static async process(job: Job<AllureImportJobData>): Promise<AllureImportResult> {
    const { importId, projectId, userId } = job.data;

    logger.info('[AllureImportJob] Starting job', {
      jobId: job.id,
      importId,
      projectId,
      userId,
    });
    logQueueEvent('processing', job.id!, { importId, projectId });

    // Build a progress emitter that forwards events to WebSocket
    const emitProgress: ProgressEmitter = (payload) => {
      try {
        // 'phase' property distinguishes progress vs completed vs failed
        if ('phase' in payload) {
          // AllureImportProgressPayload
          webSocketService.emitAllureImportProgress(userId, payload as any);
        } else if ('success' in payload) {
          // AllureImportCompletedPayload
          webSocketService.emitAllureImportCompleted(userId, payload as any);
        } else {
          // AllureImportFailedPayload
          webSocketService.emitAllureImportFailed(userId, payload as any);
        }
      } catch (wsErr) {
        logger.warn('[AllureImportJob] WebSocket emit failed (non-fatal)', {
          importId,
          error: wsErr instanceof Error ? wsErr.message : String(wsErr),
        });
      }
    };

    try {
      const result = await processAllureImportDispatch(job.data, emitProgress);

      logQueueEvent('completed', job.id!, {
        importId,
        testsImported: result.stats.testsImported,
        errors: result.stats.errors.length,
      });

      logger.info('[AllureImportJob] Job complete', {
        jobId: job.id,
        importId,
        stats: result.stats,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logQueueEvent('failed', job.id!, { importId, error: message });
      logger.error('[AllureImportJob] Job failed (fatal)', { jobId: job.id, importId, error: message });
      throw err;
    }
  }
}
