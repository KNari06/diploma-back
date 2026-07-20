import { logger } from '@/utils/core/logger';
import { CreditCostTrackerService } from './credit-cost-tracker.service';
import { ImportCreditsFeature } from '@/config/features/import-credits';
import { importAlreadyCharged } from './db/import-credits.db';

/**
 * Charges credits for a completed AI-powered import (Allure ZIP / PDF / CSV).
 *
 * An import parses a document into `intent_test_cases` via multiple LLM calls
 * but historically deducted 0 credits. This service is the single funnel for
 * that charge. It runs AFTER the import completes (so a failed/partial import
 * that produced nothing costs nothing) and charges the buyer per imported test.
 *
 * Safety:
 *  - Feature-gated (ImportCreditsFeature) — no-op when off.
 *  - Idempotent — a BullMQ retry re-runs the job, so we skip if a charge row
 *    already exists for this importId (metadata->>import_id).
 *  - Charge-after-success into grace — an already-completed import is never
 *    rolled back; deduction may push the balance down to the grace floor. This
 *    mirrors the bug-report charge in ai-analysis.job.ts.
 *  - Never throws — billing must not fail the import path.
 */
export class ImportCreditsService {
  static async chargeForImport(params: {
    userId: string;
    importId: string;
    testsImported: number;
    fileName?: string;
  }): Promise<{ charged: boolean; credits: number; reason?: string }> {
    const { userId, importId, testsImported, fileName } = params;

    if (!ImportCreditsFeature.isEnabled()) {
      return { charged: false, credits: 0, reason: 'disabled' };
    }

    const credits = ImportCreditsFeature.creditsFor(testsImported);
    if (credits <= 0) {
      // Nothing imported (or per-test priced at 0) — no charge, not an error.
      return { charged: false, credits: 0, reason: 'zero_credits' };
    }

    try {
      if (await importAlreadyCharged(importId)) {
        logger.info('[IMPORT_CREDITS] Import already charged, skipping', { importId, userId });
        return { charged: false, credits, reason: 'already_charged' };
      }
    } catch (err) {
      // If the idempotency check itself fails we do NOT charge — double-charging
      // on retry is worse than a missed charge. Surface it and bail.
      logger.warn('[IMPORT_CREDITS] Idempotency check failed, skipping charge', {
        importId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { charged: false, credits, reason: 'idempotency_check_failed' };
    }

    const result = await CreditCostTrackerService.deductCreditsForTest({
      userId,
      testType: 'import',
      credits,
      costUSD: 0,
      testId: importId,
      description: `Import: ${testsImported} test(s)${fileName ? ` from ${fileName}` : ''}`,
    });

    if (!result.success) {
      logger.warn('[IMPORT_CREDITS] Deduction failed (insufficient credits or DB error)', {
        importId,
        userId,
        credits,
      });
      return { charged: false, credits, reason: 'deduction_failed' };
    }

    logger.info('[IMPORT_CREDITS] Import charged', {
      importId,
      userId,
      credits,
      testsImported,
      newBalance: result.newBalance,
    });
    return { charged: true, credits };
  }
}
