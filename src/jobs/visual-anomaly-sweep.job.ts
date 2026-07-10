import { Job } from 'bullmq';
import { logger, logQueueEvent } from '@/utils/core/logger';
import { getSweepTestContext } from '@/services/testing/visual-anomaly/db/visual-anomaly.db';
import { classifySweepDispatch, runSweep } from '@/services/testing/visual-anomaly/visual-anomaly-check.service';

interface VisualAnomalySweepJobData {
  testResultId: string;
  testId: string;
}

/**
 * Visual anomaly sweep job — ADR-0012. Mirrors `ai-analysis.job.ts`'s
 * per-test-execution trigger shape (same 6 enqueue call sites), but is a
 * thin handler: all real logic lives in `visual-anomaly-check.service.ts`,
 * per this repo's rule that job handlers delegate immediately.
 *
 * Not credit-gated (unlike the release narrative) — this is an automatic
 * background quality check the product absorbs the cost of, not an
 * on-demand feature the user pays for.
 */
export class VisualAnomalySweepJobHandler {
  static async process(job: Job<VisualAnomalySweepJobData>): Promise<void> {
    const { testResultId, testId } = job.data;
    if (!testResultId || !testId) {
      throw new Error('Missing required parameters: testResultId or testId');
    }

    logQueueEvent('processing', job.id!, { testResultId, testId });

    const context = await getSweepTestContext(testResultId);
    const decision = classifySweepDispatch(context);

    if (decision.action === 'skip') {
      logger.info('[VISUAL_ANOMALY_SWEEP] Skipping', { testResultId, testId, reason: decision.reason });
      return;
    }
    if (decision.action === 'retry') {
      throw new Error(`[VISUAL_ANOMALY_SWEEP] ${decision.reason} for test ${testId} (testResultId=${testResultId}) — retrying`);
    }

    try {
      await runSweep({
        testId: decision.testId,
        testCaseId: decision.testCaseId,
        runId: decision.runId,
        projectId: decision.projectId,
        userId: decision.userId,
      });
      logQueueEvent('completed', job.id!, { testResultId, testId });
    } catch (error) {
      // Best-effort quality signal — never fails the job loudly enough to
      // retry-storm; log and move on.
      logger.warn('[VISUAL_ANOMALY_SWEEP] Sweep failed', {
        testResultId,
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
