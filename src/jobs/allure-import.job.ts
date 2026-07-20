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
import {
  processAllureImportDispatch,
  type ProgressEmitter,
  type AllureImportResult,
} from '@/services/allure-import/allure-import.service';
import type { AllureImportJobData } from '@/services/allure-import/allure-import.types';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { ImportCreditsService } from '@/services/core/import-credits.service';

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
    const { importId, projectId, userId, workspaceId } = job.data;

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

    // Wrap the whole import in an AI tracking scope so every LLM call inside
    // (classifier, PDF/CSV parser, step mapper, KB processor) is attributed to
    // this workspace and flushed to ai_usage_log. Without this the calls run
    // with no context and AIUsageTracker.record() silently drops them.
    //
    // The session id MUST equal ctx.testId: AIUsageTracker.record() keys the
    // session by `ctx.testId` (ai-usage-tracker.ts), so begin/record/end only
    // agree when the explicit session id matches it.
    const trackingSessionId = importId;
    AIUsageTracker.beginSession(trackingSessionId, {
      workspaceId,
      userId,
      testId: importId,
      operationType: 'import',
    });

    try {
      const result = await withAIContext(
        { workspaceId, userId, testId: importId, operationType: 'import' },
        () => processAllureImportDispatch(job.data, emitProgress),
      );

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

      // Charge credits for the imported test cases (feature-gated + idempotent).
      // Best-effort: a billing failure must never fail a completed import.
      try {
        await ImportCreditsService.chargeForImport({
          userId,
          importId,
          testsImported: result.stats.testsImported,
          fileName: job.data.originalFileName,
        });
      } catch (chargeErr) {
        logger.warn('[AllureImportJob] Import credit charge failed (non-fatal)', {
          importId,
          error: chargeErr instanceof Error ? chargeErr.message : String(chargeErr),
        });
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logQueueEvent('failed', job.id!, { importId, error: message });
      logger.error('[AllureImportJob] Job failed (fatal)', { jobId: job.id, importId, error: message });
      throw err;
    } finally {
      // Flush accumulated AI usage to ai_usage_log. Runs on both success and
      // fatal-parse paths so even a failed import records what it spent.
      try {
        await AIUsageTracker.endSession(trackingSessionId);
      } catch (flushErr) {
        logger.warn('[AllureImportJob] AI usage flush failed (non-fatal)', {
          importId,
          error: flushErr instanceof Error ? flushErr.message : String(flushErr),
        });
      }
    }
  }
}
