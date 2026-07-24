/**
 * Deterministic (Tier-2a) scoring for the chat authoring eval.
 *
 * Pure functions — no I/O, no LLM. They answer the structural questions that
 * don't need an app run: did the agent author steps, did it pick the right
 * write tool (edit-in-place vs. create), did it avoid the duplicate-creation
 * bug, are the steps well-formed. The run-on-fixture + LLM-judge signals
 * (first-run pass-rate, false-green) are Tier-2b, added later.
 */

import type { AuthoredVia, CapturedRun, Scenario, ScenarioScore } from './types';

/** Step `type` values the authoring tools accept (mirrors qa.skill.ts enum). */
export const VALID_STEP_TYPES = new Set([
  'type', 'click', 'wait', 'assert', 'navigate', 'select', 'hover', 'scroll',
  'press', 'check', 'uncheck', 'toggle', 'open', 'close', 'ai_check',
  'wait_for', 'upload',
]);

/**
 * Authoring tools whose produced steps the HEADLESS harness cannot capture —
 * they build steps live on a preview session (which replay has none of) and bail
 * at their confirm-gate before writing anything the trace / draftSteps can see.
 * A run that authors via one of these is UNCAPTURABLE (excluded from the
 * pass-rate), not a failure. Instrumenting them fully is Tier-2b work.
 */
export const UNCAPTURABLE_AUTHORING_TOOLS = new Set(['qa_author_test_iteratively']);

/** True if any executed tool this turn is an uncapturable-headless author. */
export function hasUninstrumentedAuthoring(executedToolNames: readonly string[]): boolean {
  return executedToolNames.some((name) => UNCAPTURABLE_AUTHORING_TOOLS.has(name));
}

/** Score one captured run against its scenario. Pure. */
export function scoreCapturedRun(scenario: Scenario, run: CapturedRun): ScenarioScore {
  const reasons: string[] = [];

  // A replay that errored out can't be scored on quality — fail every check.
  if (!run.ok) {
    return {
      scenarioId: scenario.id,
      producedSteps: false,
      toolChoiceCorrect: false,
      noDuplicate: false,
      stepsWellFormed: false,
      grounded: false,
      uncapturable: false,
      passed: false,
      reasons: [`replay error: ${run.error ?? 'unknown'}`],
    };
  }

  const via = run.authoredVia;
  const producedSteps = run.steps.length > 0;
  const authored = producedSteps || via.length > 0;
  const clarified = run.needsClarification === true && !authored;
  const needsCreds = scenario.grounding === 'credentials';

  // ── uncapturable: an ADD-authoring turn used the uninstrumented, live-preview-
  //    only tool (qa_author_test_iteratively) and — as expected headless —
  //    produced nothing we can see and didn't clarify. There it's a legitimate
  //    tool choice the harness can't measure, so exclude it from the pass-rate
  //    instead of false-red-ing it (README gotcha #6).
  //    GATED to add-scope authoring (scope==='add' && expectsSteps) on purpose:
  //    - EDIT scope picking this tool is a real defect (it should update in place;
  //      the tool's later "save" spawns a duplicate) — must FAIL, never be excluded.
  //    - A clarify-expected turn (expectsSteps=false) producing no steps is the
  //      correct PASS shape and is directly observable — score it, don't exclude it.
  //    If it yielded capturable steps or clarified, fall through and score that.
  if (
    run.uninstrumentedAuthoring === true &&
    scenario.scope === 'add' &&
    scenario.expectsSteps &&
    !authored &&
    !clarified
  ) {
    return {
      scenarioId: scenario.id,
      producedSteps: false,
      // Neutral: no wrong tool was used — qa_author_test_iteratively is a
      // legitimate add-path choice; we simply can't capture its steps headless.
      toolChoiceCorrect: true,
      noDuplicate: true,
      stepsWellFormed: true,
      grounded: true,
      uncapturable: true,
      passed: false,
      reasons: [
        'authored via qa_author_test_iteratively — steps are built live on a preview '
        + 'and cannot be captured headless (needs Tier-2b run-on-fixture). Excluded from '
        + 'the pass-rate, NOT a failure.',
      ],
    };
  }

  // ── producedStepsOk: did the turn end the way the request warrants? ──
  let producedStepsOk: boolean;
  if (needsCreds) {
    // A credential request may be satisfied by EITHER asking or authoring
    // (grounding is judged separately below).
    producedStepsOk = clarified || authored;
    if (!producedStepsOk) reasons.push('credential request: neither asked nor authored anything');
  } else if (scenario.expectsSteps) {
    producedStepsOk = producedSteps;
    if (!producedStepsOk) reasons.push('expected authored steps, got none');
  } else {
    producedStepsOk = !producedSteps && (clarified || via.length === 0);
    if (!producedStepsOk) reasons.push('expected a clarification, but the agent authored steps anyway');
  }

  // ── grounded: credential requests must ask or placeholder, never fabricate ──
  // The failure is FABRICATION: any input step with a concrete literal value is
  // an invented credential (no store holds it, the user didn't supply it). A
  // placeholder elsewhere does NOT redeem a fabricated field — check every input
  // step, not just "is there any placeholder". Empty skeletons are acceptable.
  let grounded = true;
  if (needsCreds) {
    // Input-bearing step types only — must stay a subset of VALID_STEP_TYPES
    // (there is no 'fill' type in the qa.skill enum; 'type'/'select' carry values).
    const fabricated = run.steps.some(
      (s) => (s.type === 'type' || s.type === 'select') && s.valueShape === 'literal',
    );
    grounded = clarified || !fabricated;
    if (!grounded) {
      reasons.push('fabricated a concrete credential value instead of asking or using a placeholder — the test cannot actually run');
    }
  }

  // ── toolChoiceCorrect + noDuplicate ──
  const usedUpdate = via.includes('update');
  const usedCreate = via.includes('create');
  const usedDraftOrCreate = via.includes('create') || via.includes('run_draft');

  let toolChoiceCorrect: boolean;
  let noDuplicate: boolean;

  if (!authored) {
    // Nothing authored (asked, or produced nothing) → no wrong tool was used.
    toolChoiceCorrect = true;
    noDuplicate = true;
  } else if (scenario.scope === 'edit') {
    toolChoiceCorrect = usedUpdate && !usedCreate;
    noDuplicate = !usedCreate;
    if (!usedUpdate) reasons.push('edit scope: did not call qa_update_test_case_steps');
    if (usedCreate) reasons.push('edit scope: called qa_create_test_case — DUPLICATE bug');
  } else {
    // add scope
    toolChoiceCorrect = usedDraftOrCreate && !usedUpdate;
    noDuplicate = true; // no bound case to duplicate
    if (!usedDraftOrCreate) reasons.push('add scope: did not draft or create a test case');
    if (usedUpdate) reasons.push('add scope: called qa_update_test_case_steps with no bound case');
  }

  // Authoring on a clarify-only turn (expectsSteps=false, non-credential) is wrong.
  if (!scenario.expectsSteps && !needsCreds && authored) {
    toolChoiceCorrect = false;
    reasons.push(`authored via [${via.join(', ')}] on a clarify-expected turn`);
  }

  // ── stepsWellFormed: only meaningful when steps were authored ──
  let stepsWellFormed: boolean;
  if (!producedSteps) {
    stepsWellFormed = true; // nothing to malform (asking is not a malformed step set)
  } else {
    const malformed = run.steps.filter(
      (s) => !s.type || !VALID_STEP_TYPES.has(s.type) || !s.description || s.description.trim() === '',
    );
    stepsWellFormed = malformed.length === 0;
    if (!stepsWellFormed) reasons.push(`${malformed.length}/${run.steps.length} steps malformed (bad type or empty description)`);
  }

  const passed = producedStepsOk && toolChoiceCorrect && noDuplicate && stepsWellFormed && grounded;

  return {
    scenarioId: scenario.id,
    producedSteps,
    toolChoiceCorrect,
    noDuplicate,
    stepsWellFormed,
    grounded,
    uncapturable: false,
    passed,
    reasons,
  };
}

/** Per-scenario aggregate across N repeated runs (agent is stochastic). */
export interface ScenarioAggregate {
  scenarioId: string;
  runs: number;          // capturable runs only — the pass-rate denominator
  passes: number;
  passRate: number;      // passes / runs (0 when runs === 0, i.e. all uncapturable)
  /** Runs excluded from the denominator (uninstrumented-tool blind spot). */
  uncapturableRuns: number;
  flaky: boolean;        // passed some capturable runs but not all
  sampleReasons: string[]; // reasons from the first failing run, for triage
}

/** Overall aggregate across every scenario × N. */
export interface EvalSummary {
  totalRuns: number;     // capturable runs only
  totalPasses: number;
  passRate: number;
  /** Total runs dropped from the pass-rate as uncapturable (see ScenarioScore). */
  totalUncapturable: number;
  perScenario: ScenarioAggregate[];
  /** Scenarios that passed some-but-not-all runs — agent flakiness. */
  flakyScenarioIds: string[];
}

/** Aggregate scored runs (grouped by scenario) into pass-rate + flakiness. */
export function aggregate(
  scored: Array<{ scenarioId: string; score: ScenarioScore }>,
): EvalSummary {
  const byScenario = new Map<string, ScenarioScore[]>();
  for (const { scenarioId, score } of scored) {
    const list = byScenario.get(scenarioId) ?? [];
    list.push(score);
    byScenario.set(scenarioId, list);
  }

  const perScenario: ScenarioAggregate[] = [];
  for (const [scenarioId, scores] of byScenario) {
    // Uncapturable runs are neither pass nor fail — drop them from the
    // denominator so a valid-but-unmeasurable tool choice can't sink the rate.
    const capturable = scores.filter((s) => !s.uncapturable);
    const uncapturableRuns = scores.length - capturable.length;
    const passes = capturable.filter((s) => s.passed).length;
    const runs = capturable.length;
    const flaky = passes > 0 && passes < runs;
    const firstFail = capturable.find((s) => !s.passed);
    perScenario.push({
      scenarioId,
      runs,
      passes,
      passRate: runs > 0 ? passes / runs : 0,
      uncapturableRuns,
      flaky,
      sampleReasons: firstFail?.reasons ?? [],
    });
  }

  const totalUncapturable = scored.filter((s) => s.score.uncapturable).length;
  const totalRuns = scored.length - totalUncapturable;
  const totalPasses = scored.filter((s) => s.score.passed).length;

  return {
    totalRuns,
    totalPasses,
    passRate: totalRuns > 0 ? totalPasses / totalRuns : 0,
    totalUncapturable,
    perScenario,
    flakyScenarioIds: perScenario.filter((s) => s.flaky).map((s) => s.scenarioId),
  };
}

/** Map a writeSteps trace `source` to the tool that authored the steps. */
export function authoredViaFromTraceSource(source: string): AuthoredVia | null {
  switch (source) {
    case 'saved': return 'create';
    case 'updated': return 'update';
    case 'run': return 'run_draft';
    default: return null;
  }
}
