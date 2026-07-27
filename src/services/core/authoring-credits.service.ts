import { logger } from '@/utils/core/logger';
import { CreditCostTrackerService } from './credit-cost-tracker.service';
import { AuthoringCreditsFeature } from '@/config/features/authoring-credits';
import type { LintResult } from '@/services/testing/ui/preview/preview.types';

/**
 * Charges credits for an AI-assisted step-editor Apply — web AND mobile, at the
 * same rate.
 *
 * Only fires when the Apply actually used the LLM: web `resolverPath`
 * 'llm'/'vision', mobile `resolvedVia` 'llm'/'vision'/'thinking';
 * identity / evidence / compiled resolves are free. Deduped per (session, step)
 * so tweaking-and-re-applying the same step in one editor session charges once
 * — the user pays for the AI resolve, not for each retry of it.
 *
 * Dedup is in-memory on purpose: applies are high-frequency and interactive, so
 * a DB round-trip per apply would add latency to the hot path. A process
 * restart resets the dedup set — worst case a step charged again after restart,
 * which is acceptable (bounded, rare) versus per-apply DB reads. The charge
 * itself is still auditable in credit_transactions.
 *
 * Never throws — billing must not break Apply.
 */
export class AuthoringCreditsService {
  /** In-memory "already charged this (session, step)" guard. */
  private static charged = new Set<string>();

  private static key(previewSessionId: string, stepId: string): string {
    return `${previewSessionId}:${stepId}`;
  }

  /**
   * Charge for a WEB apply if it used a paid resolver path and hasn't been
   * charged yet this session. Call fire-and-forget after a successful applyStep.
   */
  static async chargeForApply(params: {
    userId: string;
    previewSessionId: string;
    stepId: string;
    resolverPath: LintResult['resolverPath'] | undefined;
  }): Promise<{ charged: boolean; credits: number; reason?: string }> {
    const { resolverPath, ...rest } = params;
    return this.charge({
      ...rest,
      paid: AuthoringCreditsFeature.isPaidResolverPath(resolverPath),
      resolutionLabel: resolverPath,
    });
  }

  /**
   * Charge for a MOBILE apply. Same rate and same dedup as web — the only
   * difference is the vocabulary: the runner reports `resolvedVia`, not the
   * web `resolverPath`. Both mobile entry points (the REST
   * `POST /mobile/sessions/:id/apply` controller and the mobile WS handler)
   * call this, because `MobileStepApplyService` deliberately performs no side
   * effects of its own — persistence, tracing and billing all belong to the
   * caller.
   */
  static async chargeForMobileApply(params: {
    userId: string;
    previewSessionId: string;
    stepId: string;
    resolvedVia: string | undefined;
  }): Promise<{ charged: boolean; credits: number; reason?: string }> {
    const { resolvedVia, ...rest } = params;
    return this.charge({
      ...rest,
      paid: AuthoringCreditsFeature.isPaidMobileResolvedVia(resolvedVia),
      resolutionLabel: resolvedVia,
    });
  }

  /** Shared gate → dedup → deduct core for both editors. */
  private static async charge(params: {
    userId: string;
    previewSessionId: string;
    stepId: string;
    paid: boolean;
    resolutionLabel: string | undefined;
  }): Promise<{ charged: boolean; credits: number; reason?: string }> {
    const { userId, previewSessionId, stepId, paid, resolutionLabel } = params;

    if (!AuthoringCreditsFeature.isEnabled()) {
      return { charged: false, credits: 0, reason: 'disabled' };
    }
    if (!paid) {
      // identity / evidence / compiled / rule_fallback (web), or a
      // deterministic tree match (mobile) — no LLM ran, no charge.
      return { charged: false, credits: 0, reason: 'no_llm' };
    }
    if (!stepId) {
      // Without a step id every step in the session would collapse onto the
      // same dedup key and only the first would ever charge. Skip instead of
      // silently under-billing the rest of the session.
      logger.warn('[AUTHORING_CREDITS] Apply had no stepId — skipping charge', { previewSessionId, userId });
      return { charged: false, credits: 0, reason: 'no_step_id' };
    }

    const credits = AuthoringCreditsFeature.getPerResolve();
    if (credits <= 0) {
      return { charged: false, credits: 0, reason: 'zero_credits' };
    }

    const key = this.key(previewSessionId, stepId);
    if (this.charged.has(key)) {
      return { charged: false, credits, reason: 'already_charged' };
    }
    // Mark BEFORE the async deduct so a rapid double-apply can't double-charge
    // in the window before the RPC returns. On a failed deduct we clear it below
    // so a genuine retry (e.g. after a top-up) can charge.
    this.charged.add(key);

    const result = await CreditCostTrackerService.deductCreditsForTest({
      userId,
      testType: 'intelligent',
      credits,
      costUSD: 0,
      testId: previewSessionId,
      description: `AI element resolution (${resolutionLabel})`,
    });

    if (!result.success) {
      this.charged.delete(key);
      logger.warn('[AUTHORING_CREDITS] Deduction failed', { previewSessionId, stepId, userId, credits });
      return { charged: false, credits, reason: 'deduction_failed' };
    }

    logger.info('[AUTHORING_CREDITS] AI-assisted apply charged', {
      previewSessionId,
      stepId,
      userId,
      credits,
      resolvedBy: resolutionLabel,
      newBalance: result.newBalance,
    });
    return { charged: true, credits };
  }

  /** Drop all dedup entries for a session (call on session reset/teardown). */
  static clearSession(previewSessionId: string): void {
    const prefix = `${previewSessionId}:`;
    for (const k of this.charged) {
      if (k.startsWith(prefix)) this.charged.delete(k);
    }
  }
}
