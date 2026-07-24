/**
 * Types for Tier-2b (run-on-fixture) of the chat authoring eval.
 *
 * Tier-2a (types.ts) scores authored step STRUCTURE headlessly. Tier-2b actually
 * RUNS authored web tests against a controlled fixture app to produce the two
 * north-star numbers rung-1 could not: first-run-pass-rate (green on a healthy
 * app) and false-green-rate (wrongly green on a deliberately-broken app).
 *
 * Kept separate from types.ts so the cheap, CI-safe Tier-2a corpus/types stay
 * untouched. See claude-plans/tier2b-run-on-fixture-web-20260724.md.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

/**
 * A Tier-2b scenario. Carries BOTH a hand-seeded `goldenSteps` set (Stage 1 —
 * deterministic proof of the rig, pinned cssSelectors, zero LLM) AND a natural-
 * language `goal` for Stage 2 (the agent authors against the live fixture).
 */
export interface FixtureScenario {
  id: string;
  name: string;
  /** NL goal handed to `EditorIterativeAuthorService.authorTest` (Stage 2). */
  goal: string;
  /** Fixture path the flow starts on — preview navigates here; replay `goto`s here. */
  startPath: string;
  /** Credentials surfaced to the authoring Planner (fixture demo creds), never frozen into plans. */
  credentials?: { username: string; password: string };
  /** Hand-seeded golden steps (Stage 1). Every step pins `options.cssSelector`. */
  goldenSteps: IntentStep[];
  /**
   * False-green pairing: the flag that SHOULD turn a correct test RED, and why.
   * Absent → the scenario contributes to first-run-pass-rate only (no false-green).
   */
  breaksUnderFlag?: { flagId: string; whyItShouldFail: string };
}

/** Outcome of replaying one step set against the fixture in one flag state. */
export interface FixtureRunOutcome {
  /** `executePlaywrightTest` success verdict. */
  passed: boolean;
  status: string;
  stepsRun: number;
  /** First fatal step error, for triage. */
  errorSummary?: string;
}

/** How a scored step set reached the runner. */
export type FixtureSource = 'golden' | 'authored';

/** Per-scenario Tier-2b verdict for one source (golden or agent-authored). */
export interface FixtureScore {
  scenarioId: string;
  source: FixtureSource;
  /** Green on the clean app. This is the clean first-run-pass signal. */
  firstRunPass: boolean;
  /**
   * True when the test wrongly stayed green on the BROKEN app (the false-green
   * bug). Only defined when `falseGreenEligible`.
   */
  falseGreen?: boolean;
  /** Eligible for a false-green verdict: has a flag pairing AND passed clean AND was run broken. */
  falseGreenEligible: boolean;
  /**
   * Stage-2 only — the terminal assertion text the agent actually authored
   * (`ai_check.assertionText`), or null if it authored NO assertion. This is the
   * honesty check: the iterative-author engine emits at most one terminal
   * LLM-judged evidence string, so we report what it was rather than trust a
   * clean false-green number (plan §5).
   */
  authoredAssertion?: string | null;
  cleanOutcome: FixtureRunOutcome;
  brokenOutcome?: FixtureRunOutcome;
  notes: string[];
}

/** Aggregate over scored scenarios. */
export interface FixtureSummary {
  /** passes / runnable-scenarios (a scenario that failed to author/produce steps counts as a red). */
  firstRunPassRate: number;
  firstRunDenom: number;
  firstRunPasses: number;
  /** falseGreens / false-green-eligible scenarios. */
  falseGreenRate: number;
  falseGreenDenom: number;
  falseGreens: number;
  perScenario: FixtureScore[];
}
