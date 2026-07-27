/**
 * DeveloperFixPromptService — turns a bug found by a test run into a paste-ready
 * markdown prompt a developer drops into an AI coding assistant to fix it.
 *
 * Black-box: built only from external evidence the run already captured (bug
 * fields, failing selector, bounded console/network output, screenshot ref) —
 * no repo/source access. One LLM call. Never throws (returns null on any
 * failure or when there is no bug to fix). The caller persists the result.
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildFixPromptMessages, type FixPromptInput } from '@/ai/prompts/fix-prompt.prompts';
import { logger } from '@/utils/core/logger';
import type { AISummary, BugReport } from '@/types';

const MAX_CONSOLE = 3;
const MAX_NETWORK = 5;
const MAX_MARKDOWN_CHARS = 8000;

export class DeveloperFixPromptService {
  /**
   * Generate the fix-prompt markdown for the highest-severity bug in the summary.
   * Returns null when there are no bugs or the LLM call fails.
   */
  static async generate(params: {
    testResult: any;            // the result row (errors / logs / network_logs / dom / url)
    aiSummary: AISummary;
    pageUrl?: string;
  }): Promise<string | null> {
    try {
      const bug = this.pickPrimaryBug(params.aiSummary?.bugs);
      if (!bug) return null;

      const input: FixPromptInput = {
        bugTitle: bug.title || 'Bug',
        bugDescription: bug.description || '',
        severity: bug.severity || 'medium',
        pageUrl: params.pageUrl || params.testResult?.url,
        failingSelector: bug.domSelector,
        expectedResult: bug.expectedResult,
        actualResult: bug.actualResult,
        reproSteps: Array.isArray(bug.steps) ? bug.steps.slice(0, 10) : undefined,
        rootCauseHint: this.rootCauseHint(params.aiSummary),
        consoleErrors: this.consoleErrors(params.testResult),
        networkErrors: this.networkErrors(params.testResult),
        screenshotUrl: bug.screenshot || params.testResult?.screenshot,
      };

      const { system, user } = buildFixPromptMessages(input);
      const completion = await getChatCompletionWithMessages(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { temperature: 0.2, max_tokens: 900 },
      );
      const md = (completion.content || '').trim();
      if (!md) return null;
      return md.length > MAX_MARKDOWN_CHARS ? `${md.slice(0, MAX_MARKDOWN_CHARS)}…` : md;
    } catch (err) {
      logger.warn('[FIX_PROMPT] Generation failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Highest-severity bug (critical → high → medium → low); first on ties. */
  private static pickPrimaryBug(bugs: BugReport[] | undefined): BugReport | null {
    if (!bugs?.length) return null;
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...bugs].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2))[0];
  }

  private static rootCauseHint(summary: AISummary | undefined): string | undefined {
    if (!summary) return undefined;
    const parts: string[] = [];
    if (summary.failureClassification) parts.push(String(summary.failureClassification));
    if (summary.rootCauseStep != null) parts.push(`failing at step ${summary.rootCauseStep}`);
    return parts.length ? parts.join(', ') : undefined;
  }

  /** Bounded console error lines (strings only). */
  private static consoleErrors(testResult: any): string[] | undefined {
    const errs = Array.isArray(testResult?.errors) ? testResult.errors : [];
    const out = errs
      .map((e: any) => (typeof e === 'string' ? e : e?.message || e?.text || ''))
      .filter((s: string) => !!s)
      .slice(0, MAX_CONSOLE);
    return out.length ? out : undefined;
  }

  /** Bounded network-failure summaries "METHOD url → status" for non-2xx calls. */
  private static networkErrors(testResult: any): string[] | undefined {
    const logs = Array.isArray(testResult?.network_logs)
      ? testResult.network_logs
      : Array.isArray(testResult?.networkLogs) ? testResult.networkLogs : [];
    const out = logs
      .filter((n: any) => typeof n?.status === 'number' && n.status >= 400)
      .map((n: any) => `${(n.method || 'GET').toUpperCase()} ${n.url || ''} → ${n.status}`.trim())
      .slice(0, MAX_NETWORK);
    return out.length ? out : undefined;
  }
}
