/**
 * Resolve the persisted developer fix prompt (`ai_summary.fixPrompt`) for a
 * given `tests.id`.
 *
 * Background: the prompt is produced post-run by `DeveloperFixPromptService`
 * and folded into the `ai_summary` JSONB of the run's result row. Callers that
 * know only a `testId` — the manual "file this run to Jira" endpoint — have no
 * other way to reach it. The job path does NOT use this helper: it still has
 * the summary object in memory and passes `aiSummary.fixPrompt` directly.
 *
 * Two guarantees:
 *
 *   1. ALWAYS fail-open. Any error (RLS, schema drift, missing row) returns
 *      `undefined`. A missing fix prompt must never block filing the issue.
 *   2. Reads BOTH result tables. Web runs persist to `test_results`, mobile
 *      runs to the forked `mobile_test_results` — reading only the first
 *      returns `undefined` for every mobile run. Web is tried first because
 *      it is by far the common case.
 *
 * Multiple result rows can share one `test_id` (retries, per-browser runs), so
 * both readers order newest-first and this takes the first hit.
 *
 * No caching, unlike `resolveTestCasePriorityForTestId`: that helper fans out
 * across four notification paths per failure, whereas this runs once per
 * user-initiated request.
 */

import {
  getMobileTestResultsByTestIds,
  getTestResultsByTestIds,
} from '@/services/testing/regression/db/regression-report.db';
import { logger } from '@/utils/core/logger';

export async function resolveFixPromptForTestId(testId: string): Promise<string | undefined> {
  if (!testId) return undefined;

  try {
    const web = await getTestResultsByTestIds([testId]);
    const fromWeb = firstFixPrompt(web);
    if (fromWeb) return fromWeb;

    const mobile = await getMobileTestResultsByTestIds([testId]);
    return firstFixPrompt(mobile);
  } catch (err) {
    logger.debug('[resolveFixPrompt] lookup failed — returning undefined', {
      testId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** First non-empty `ai_summary.fixPrompt` across newest-first result rows. */
function firstFixPrompt(rows: any[]): string | undefined {
  for (const row of rows || []) {
    const prompt = row?.ai_summary?.fixPrompt;
    if (typeof prompt === 'string' && prompt.trim()) return prompt;
  }
  return undefined;
}
