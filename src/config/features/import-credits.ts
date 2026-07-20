import { env } from '@/config/environment/env';

/**
 * Feature flags for charging credits on AI-powered imports
 * (Allure ZIP / PDF / CSV → intent_test_cases).
 *
 * Why: an import parses a document into test cases via multiple LLM calls
 * (classifier, PDF/CSV parser, step mapper, KB processor) but historically
 * deducted 0 credits and wrote 0 rows to ai_usage_log — the whole chain ran
 * outside any withAIContext scope and had no deduction call. This feature adds
 * both: usage logging (always, once the import runs inside withAIContext) and a
 * credit charge (gated by this flag) of `perTest × testsImported` on success.
 *
 * OFF by default so it can dark-launch: turn the import inside withAIContext on
 * first (usage rows start appearing), confirm attribution, then flip deduction.
 */
export const ImportCreditsFeature = {
  /** Deduct credits when an import completes? Usage logging is independent of this. */
  isEnabled(): boolean {
    return env.IMPORT_CREDITS_ENABLED;
  },

  /** Credits charged per successfully imported test case (decimal-safe, >= 0). */
  getPerTest(): number {
    const n = Number.isFinite(env.IMPORT_CREDITS_PER_TEST) ? env.IMPORT_CREDITS_PER_TEST : 1;
    return Math.max(0, n);
  },

  /** Total credits for an import of `testsImported` test cases. */
  creditsFor(testsImported: number): number {
    const count = Number.isFinite(testsImported) && testsImported > 0 ? Math.floor(testsImported) : 0;
    return Math.round(count * this.getPerTest() * 100) / 100;
  },
};
