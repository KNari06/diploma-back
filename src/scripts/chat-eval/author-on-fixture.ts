/**
 * Tier-2b Stage 2 (impure) — the agent authors a test against the LIVE fixture,
 * under production conditions.
 *
 * Flow: start a headless preview session on the fixture flow page → drive the
 * real iterative-authoring loop (`EditorIterativeAuthorService.authorTest`,
 * Planner→Executor→Reviewer against the live DOM) → convert its grounded
 * DiscoveredStep[] → IntentStep[]. The caller then replays those via the Tier-2b
 * run primitive on clean + broken fixture.
 *
 * We call the service directly (not through the skill registry) so the confirm-
 * gate is a non-issue and no production path is weakened (plan §6). No credits
 * are billed on this path — the TestPipeline path doesn't charge (lite CLAUDE.md
 * invariant #6). Requires a valid OPENAI_API_KEY (+ model config).
 *
 * The engine emits at most ONE terminal assertion (a `mark_done` → `ai_check`
 * whose text is the agent's free-text done-evidence, LLM-judged at replay). We
 * surface it verbatim for the honesty check (plan §5) and DROP any ai_check with
 * an empty assertionText — that would otherwise throw "aiCheck requires
 * intentMeta.assertionText" at replay and false-RED the whole run.
 */

import { getPreviewSessionService } from '@/services/testing/ui/preview/preview-session.service';
import { EditorIterativeAuthorService } from '@/services/testing/ui/preview/editor-iterative-author.service';
import { toIntentSteps } from '@/agent/core/lite/exploration/types';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { FixtureScenario } from './fixture-types';

// Same synthetic ids for startSession AND authorTest (ownership is checked in the
// in-process singleton). Valid-format UUIDs — no real rows are read/written.
const EVAL_USER_ID = '00000000-0000-4000-8000-000000000001';
const EVAL_PROJECT_ID = '00000000-0000-4000-8000-000000000003';

/** What kind of assertion the agent authored — the headline finding of this rung. */
export type AuthoredAssertKind = 'deterministic' | 'ai_check' | 'none';

export interface AuthorOnFixtureResult {
  /** Authoring succeeded and produced at least one runnable step. */
  ok: boolean;
  /** Grounded, runnable steps (empty-assertion ai_checks dropped). */
  steps: IntentStep[];
  /**
   * The most meaningful assertion the agent authored (null = none). Prefers a
   * DETERMINISTIC `type:'assert'` step (the rung-3 capability) over the terminal
   * `ai_check` self-judge.
   */
  authoredAssertion: string | null;
  /** Which kind of assertion `authoredAssertion` is — the run-proof of this rung. */
  assertKind: AuthoredAssertKind;
  /** Every deterministic `type:'assert'` the agent authored (human-readable). */
  deterministicAsserts: string[];
  /** Rounds the authoring loop executed. */
  roundsExecuted: number;
  /** Why the loop stopped (goal met / blocked / timeout) or the start failure. */
  reason: string;
  error?: string;
}

/**
 * Author a test for one scenario against the live fixture. `fixtureBaseUrl` is the
 * fixture origin (e.g. http://127.0.0.1:4400); the session starts on the flow's
 * `startPath`. Tears the preview session down in `finally`.
 */
export async function authorOnFixture(
  scenario: FixtureScenario,
  fixtureBaseUrl: string,
): Promise<AuthorOnFixtureResult> {
  const sessionService = getPreviewSessionService();
  const startUrl = `${fixtureBaseUrl}${scenario.startPath}`;
  let previewSessionId: string | undefined;

  try {
    const session = await sessionService.startSession({
      userId: EVAL_USER_ID,
      projectId: EVAL_PROJECT_ID,
      startUrl,
    });
    previewSessionId = session.previewSessionId;

    const credentials = scenario.credentials
      ? { email: scenario.credentials.username, username: scenario.credentials.username, password: scenario.credentials.password }
      : undefined;

    const result = await EditorIterativeAuthorService.authorTest({
      previewSessionId,
      userId: EVAL_USER_ID,
      goal: scenario.goal,
      credentials,
    });

    if (!result.success) {
      return {
        ok: false, steps: [], authoredAssertion: null, assertKind: 'none', deterministicAsserts: [],
        roundsExecuted: result.roundsExecuted, reason: result.reason, error: result.error,
      };
    }

    const allSteps = toIntentSteps(result.steps);

    // Rung-3 headline: deterministic `type:'assert'` steps (text-contains on a
    // value). These are what makes an authored test catch a value-bug without an
    // LLM judge — the whole point of this rung.
    const deterministicAsserts = allSteps
      .filter((s) => s.type === 'assert' && typeof s.value === 'string' && s.value.trim() !== '')
      .map((s) => `${s.description || 'assert'} (expects "${(s.value as string).trim()}")`);

    // The terminal LLM-judged assertion(s): ai_check steps with real text.
    const aiChecks = allSteps
      .filter((s) => s.type === 'ai_check' && typeof s.assertionText === 'string' && s.assertionText.trim() !== '')
      .map((s) => s.assertionText as string);

    // Prefer the deterministic assert as THE authored assertion (it's the stronger
    // check); fall back to the terminal ai_check evidence, else none.
    const assertKind: AuthoredAssertKind =
      deterministicAsserts.length > 0 ? 'deterministic' : aiChecks.length > 0 ? 'ai_check' : 'none';
    const authoredAssertion =
      deterministicAsserts.length > 0 ? deterministicAsserts[deterministicAsserts.length - 1]
        : aiChecks.length > 0 ? aiChecks[aiChecks.length - 1]
          : null;

    // Drop empty-assertion ai_checks so replay doesn't throw and false-RED.
    const steps = allSteps.filter(
      (s) => !(s.type === 'ai_check' && (typeof s.assertionText !== 'string' || s.assertionText.trim() === '')),
    );

    return {
      ok: steps.length > 0,
      steps,
      authoredAssertion,
      assertKind,
      deterministicAsserts,
      roundsExecuted: result.roundsExecuted,
      reason: result.reason,
    };
  } catch (err) {
    return {
      ok: false, steps: [], authoredAssertion: null, assertKind: 'none', deterministicAsserts: [], roundsExecuted: 0,
      reason: 'author-on-fixture threw', error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (previewSessionId) {
      await sessionService.stopSession(previewSessionId, EVAL_USER_ID).catch(() => { /* best-effort teardown */ });
    }
  }
}
