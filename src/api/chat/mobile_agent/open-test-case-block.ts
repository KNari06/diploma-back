/**
 * The OPEN TEST CASE system block — what the editor-scoped mobile agent is told
 * about the saved test the user has open.
 *
 * Its own module rather than a private in `handler.ts`: the handler is already
 * well past the size where a named concern should be extracted, and this is a
 * prompt builder, which the testing rules want asserted directly on its output
 * string.
 */

import { logger } from '@/utils/core/logger';
import { wrapUntrusted } from '@/services/chat/untrusted-content-wrapper';
import { buildRunBeforeLine } from './prompts';

/**
 * Build the OPEN TEST CASE system block from a saved test case's stated GOAL and
 * its existing steps, so the agent extends the flow rather than duplicating it
 * — and knows what the test is FOR before it has any steps to infer it from.
 *
 * The goal is `intent_test_cases.description`, which the Create-test dialog
 * writes from its "Goal" field. A freshly created case has a goal and ZERO
 * steps, which is precisely the turn where the agent used to open on a name and
 * nothing else and the user had to retype the goal into the chat — so the block
 * is emitted when EITHER a goal or steps exist, not only for steps.
 *
 * Owner-scoped read; best-effort — any failure (not found / no access / neither
 * goal nor steps) returns null and the turn proceeds without the block. Both
 * halves are capped so a long test or a pasted essay can't blow the prompt
 * budget, and the whole body is `wrapUntrusted` — it is user-authored text.
 */
export async function buildOpenTestCaseBlock(
  testCaseId: string | undefined,
  userId: string,
): Promise<string | null> {
  if (!testCaseId) return null;
  try {
    // Lazy import: pulling IntentTestCaseService at module top drags the
    // Supabase client into the graph, which throws at import time without env
    // vars (breaks handler.test.ts). Dynamic import keeps the handler test-
    // loadable — same pattern resolveProjectId uses for supabaseAdmin.
    const { IntentTestCaseService } = await import(
      '@/services/testing/ui/preview/intent-test-case.service'
    );
    const tc = await IntentTestCaseService.getById(testCaseId, userId);
    const steps = Array.isArray(tc?.stepsJson) ? tc!.stepsJson : [];
    const MAX_GOAL = 600;
    const goal =
      typeof tc?.description === 'string' && tc.description.trim()
        ? tc.description.trim().slice(0, MAX_GOAL)
        : null;
    if (!tc || (steps.length === 0 && !goal)) return null;

    const sections: string[] = [];
    if (goal) sections.push(`Goal of test case "${tc.name ?? testCaseId}": ${goal}`);

    if (steps.length > 0) {
      const MAX_STEPS = 40;
      const shown = steps.slice(0, MAX_STEPS);
      const lines = shown.map((s: any, i: number) => {
        const type = String(s?.type ?? 'step');
        const desc = String(s?.description ?? '').slice(0, 120);
        return `${i + 1}. ${type}${desc ? ` — ${desc}` : ''}`;
      });
      if (steps.length > MAX_STEPS) lines.push(`… (+${steps.length - MAX_STEPS} more)`);
      sections.push(
        `Test case "${tc.name ?? testCaseId}" already has ${steps.length} step(s):\n` +
          lines.join('\n'),
      );
    } else {
      sections.push('It has NO steps yet.');
    }

    const guidance =
      steps.length > 0
        ? 'These steps ALREADY exist. When the user asks to add/change steps, EXTEND '
          + 'this flow — do not re-author steps it already has.\n'
        : 'The goal above is the user\u2019s own statement of what this test is for — '
          + 'treat it as the brief, and do not ask them to restate it. It is a '
          + 'description, NOT an instruction to start authoring: still wait for the '
          + 'user to ask for steps.\n';

    return (
      '## OPEN TEST CASE (the editor is scoped to this saved test)\n' +
      guidance +
      buildRunBeforeLine(tc.resolvedDependencies) +
      wrapUntrusted(sections.join('\n\n'))
    );
  } catch (err) {
    logger.debug('[MOBILE_AGENT] buildOpenTestCaseBlock skipped', {
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

