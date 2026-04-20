/**
 * Auto-learn job handler
 *
 * One job per successful test run. Extracts facts from executed_steps and
 * upserts them into project_kb_chunks as auto:trace chunks. Feature-flagged
 * per project (projects.settings.autoLearnFromTests).
 *
 * Never throws to BullMQ: auto-learn is pure improvement, not blocking. If
 * we fail, the test result is already final — we just log and move on.
 * Returning normally keeps the job marked completed and skips BullMQ retries
 * for application-level failures.
 */

import type { Job } from 'bullmq';
import { learnFromTestRun } from '@/services/kb/auto-learn.service';
import { logger } from '@/utils/core/logger';

export interface AutoLearnJobData {
  testId: string;
  projectId: string;
}

export class AutoLearnJobHandler {
  static async process(job: Job<AutoLearnJobData>): Promise<{
    inserted: number;
    refreshed: number;
    skipped: number;
    reason?: string;
  }> {
    const { testId, projectId } = job.data || {};

    if (!testId || !projectId) {
      logger.warn('[AUTO_LEARN_JOB] Missing testId or projectId, skipping', {
        jobId: job.id,
      });
      return { inserted: 0, refreshed: 0, skipped: 0, reason: 'invalid-payload' };
    }

    try {
      const result = await learnFromTestRun({
        testId,
        projectId,
        uploadedBy: 'auto-learn',
      });

      logger.info('[AUTO_LEARN_JOB] Completed', {
        jobId: job.id,
        testId,
        projectId,
        inserted: result.inserted,
        refreshed: result.refreshed,
        skipped: result.skipped,
        reason: result.reason,
      });

      return result;
    } catch (err) {
      // Service already logs and returns; this catch is a safety net.
      logger.warn('[AUTO_LEARN_JOB] Handler threw (non-fatal)', {
        jobId: job.id,
        testId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { inserted: 0, refreshed: 0, skipped: 0, reason: 'handler-error' };
    }
  }
}
