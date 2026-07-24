/**
 * Pure (Tier-2b) scoring for the run-on-fixture eval.
 *
 * No I/O, no LLM, no browser — given the clean/broken run outcomes it computes
 * per-scenario verdicts and the two aggregate numbers. Mirrors the pure-core
 * split scoring.ts already uses so the metric math is unit-testable without the
 * heavy runner. See claude-plans/tier2b-run-on-fixture-web-20260724.md §5.
 */

import type { FixtureRunOutcome, FixtureScore, FixtureSource, FixtureSummary } from './fixture-types';
import type { AuthoredAssertKind } from './author-on-fixture';

export interface ScoreFixtureRunInput {
  scenarioId: string;
  source: FixtureSource;
  cleanOutcome: FixtureRunOutcome;
  /** Present only when the scenario has a `breaksUnderFlag` pairing. */
  brokenOutcome?: FixtureRunOutcome;
  /** True when the scenario declares a false-green pairing. */
  hasFlagPairing: boolean;
  /** Stage-2 only — the assertion the agent authored (null = none). */
  authoredAssertion?: string | null;
  /** Stage-2 only — which kind of assertion the agent authored (rung-3 run-proof). */
  assertKind?: AuthoredAssertKind;
}

/**
 * Score one scenario's fixture run.
 *
 * first-run-pass = green on clean.
 * false-green    = green on broken (bug) — but only MEANINGFUL when the test was
 *                  a valid test to begin with (passed clean) and was actually run
 *                  broken. A test that fails on clean is just broken, not
 *                  false-green-measurable, so it's ineligible.
 */
export function scoreFixtureRun(input: ScoreFixtureRunInput): FixtureScore {
  const { scenarioId, source, cleanOutcome, brokenOutcome, hasFlagPairing, authoredAssertion, assertKind } = input;
  const notes: string[] = [];

  const firstRunPass = cleanOutcome.passed;
  if (!firstRunPass) {
    notes.push(`did not pass on the clean app: ${cleanOutcome.errorSummary ?? cleanOutcome.status}`);
  }

  // False-green is only measurable on a test that (a) has a paired bug, (b) is a
  // valid test (green on clean), and (c) was actually replayed on the broken app.
  const falseGreenEligible = hasFlagPairing && firstRunPass && brokenOutcome !== undefined;
  let falseGreen: boolean | undefined;
  if (falseGreenEligible && brokenOutcome) {
    falseGreen = brokenOutcome.passed === true;
    notes.push(
      falseGreen
        ? 'FALSE-GREEN: stayed green on the broken app — the test did not actually verify the broken behavior.'
        : 'correctly went red on the broken app.',
    );
  } else if (hasFlagPairing && !firstRunPass) {
    notes.push('false-green not measurable: test failed on the clean app (broken test, not a false-green).');
  }

  if (source === 'authored') {
    if (assertKind === 'deterministic') {
      notes.push(`authored a DETERMINISTIC assertion: ${authoredAssertion} — a real value-check, not an LLM self-judge (rung-3 capability).`);
    } else if (assertKind === 'ai_check') {
      notes.push(`authored only a terminal LLM-judged assertion: "${authoredAssertion}" — no deterministic value-check.`);
    } else {
      notes.push('authored NO assertion — the iterative-author engine emitted no check (capability gap; plan §5).');
    }
  }

  return {
    scenarioId,
    source,
    firstRunPass,
    falseGreen,
    falseGreenEligible,
    authoredAssertion: source === 'authored' ? (authoredAssertion ?? null) : undefined,
    cleanOutcome,
    brokenOutcome,
    notes,
  };
}

/** Aggregate scored scenarios into first-run-pass-rate + false-green-rate. */
export function aggregateFixture(scores: FixtureScore[]): FixtureSummary {
  const firstRunDenom = scores.length;
  const firstRunPasses = scores.filter((s) => s.firstRunPass).length;

  const eligible = scores.filter((s) => s.falseGreenEligible);
  const falseGreenDenom = eligible.length;
  const falseGreens = eligible.filter((s) => s.falseGreen === true).length;

  return {
    firstRunPassRate: firstRunDenom > 0 ? firstRunPasses / firstRunDenom : 0,
    firstRunDenom,
    firstRunPasses,
    falseGreenRate: falseGreenDenom > 0 ? falseGreens / falseGreenDenom : 0,
    falseGreenDenom,
    falseGreens,
    perScenario: scores,
  };
}
