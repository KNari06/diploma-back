/**
 * Deterministic scorer tests — the verifiable core of the chat authoring eval.
 * Pure functions, no I/O, no LLM.
 */

import { aggregate, authoredViaFromTraceSource, hasUninstrumentedAuthoring, scoreCapturedRun } from '../scoring';
import type { CapturedRun, Scenario, ScenarioScore } from '../types';

const editScenario: Scenario = {
  id: 'edit-x', name: 'edit', scope: 'edit', userMessage: 'update it',
  boundTestCaseName: 'Login', expectsSteps: true,
};
const addScenario: Scenario = {
  id: 'add-x', name: 'add', scope: 'add', userMessage: 'create a login test', expectsSteps: true,
};
const clarifyScenario: Scenario = {
  id: 'vague-x', name: 'vague', scope: 'add', userMessage: 'test the thing', expectsSteps: false,
};

function run(partial: Partial<CapturedRun>): CapturedRun {
  return { scenarioId: 'x', ok: true, authoredVia: [], steps: [], ...partial };
}

const okSteps = [{ type: 'click', description: 'click login' }, { type: 'type', description: 'type email' }];

describe('scoreCapturedRun — edit scope', () => {
  it('passes when the agent updates in place with well-formed steps', () => {
    const s = scoreCapturedRun(editScenario, run({ authoredVia: ['update'], steps: okSteps }));
    expect(s.passed).toBe(true);
    expect(s.toolChoiceCorrect).toBe(true);
    expect(s.noDuplicate).toBe(true);
  });

  it('fails and flags the duplicate bug when it creates instead of updates', () => {
    const s = scoreCapturedRun(editScenario, run({ authoredVia: ['create'], steps: okSteps }));
    expect(s.passed).toBe(false);
    expect(s.noDuplicate).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/DUPLICATE/i);
  });

  it('fails when no steps were authored', () => {
    const s = scoreCapturedRun(editScenario, run({ authoredVia: [], steps: [] }));
    expect(s.passed).toBe(false);
    expect(s.producedSteps).toBe(false);
  });
});

describe('scoreCapturedRun — add scope', () => {
  it('passes when the agent drafts a new test', () => {
    const s = scoreCapturedRun(addScenario, run({ authoredVia: ['run_draft'], steps: okSteps }));
    expect(s.passed).toBe(true);
  });

  it('passes when the agent creates directly', () => {
    const s = scoreCapturedRun(addScenario, run({ authoredVia: ['create'], steps: okSteps }));
    expect(s.toolChoiceCorrect).toBe(true);
  });

  it('fails when it updates with no bound case', () => {
    const s = scoreCapturedRun(addScenario, run({ authoredVia: ['update'], steps: okSteps }));
    expect(s.passed).toBe(false);
    expect(s.toolChoiceCorrect).toBe(false);
  });
});

describe('scoreCapturedRun — uninstrumented authoring (qa_author_test_iteratively blind spot)', () => {
  it('marks the run uncapturable (not failed) when it authored via the live-preview tool and produced nothing', () => {
    const s = scoreCapturedRun(addScenario, run({ uninstrumentedAuthoring: true, authoredVia: [], steps: [] }));
    expect(s.uncapturable).toBe(true);
    expect(s.passed).toBe(false);
    // Neutral sub-checks — it's a valid tool choice we simply can't measure.
    expect(s.toolChoiceCorrect).toBe(true);
    expect(s.noDuplicate).toBe(true);
    expect(s.reasons.join(' ')).toMatch(/qa_author_test_iteratively|Tier-2b/);
  });

  it('also covers the credential add-login-happy shape (grounding=credentials)', () => {
    const credScenario: Scenario = {
      id: 'login-x', name: 'login', scope: 'add', userMessage: 'create a login test',
      expectsSteps: true, grounding: 'credentials',
    };
    const s = scoreCapturedRun(credScenario, run({ uninstrumentedAuthoring: true, authoredVia: [], steps: [] }));
    expect(s.uncapturable).toBe(true);
    expect(s.passed).toBe(false);
  });

  it('scores normally (does NOT mark uncapturable) when the tool also yielded capturable steps', () => {
    const s = scoreCapturedRun(addScenario, run({ uninstrumentedAuthoring: true, authoredVia: ['run_draft'], steps: okSteps }));
    expect(s.uncapturable).toBe(false);
    expect(s.passed).toBe(true);
  });

  it('scores as a clarification (not uncapturable) when the agent asked instead', () => {
    const s = scoreCapturedRun(clarifyScenario, run({ uninstrumentedAuthoring: true, needsClarification: true, authoredVia: [], steps: [] }));
    expect(s.uncapturable).toBe(false);
    expect(s.passed).toBe(true);
  });

  it('does NOT exclude an EDIT scenario that wrongly routed to the tool — it must fail (duplicate-bug risk, not uncapturable)', () => {
    const s = scoreCapturedRun(editScenario, run({ uninstrumentedAuthoring: true, authoredVia: [], steps: [] }));
    expect(s.uncapturable).toBe(false);
    expect(s.passed).toBe(false); // edit turn produced no in-place update → real fail
    expect(s.reasons.join(' ')).toMatch(/got none/);
  });

  it('does NOT exclude a clarify-expected add turn that bailed through the tool — no steps is the correct PASS shape', () => {
    // clarifyScenario is scope 'add', expectsSteps false; agent poked the tool, produced nothing, did not clarify.
    const s = scoreCapturedRun(clarifyScenario, run({ uninstrumentedAuthoring: true, needsClarification: false, authoredVia: [], steps: [] }));
    expect(s.uncapturable).toBe(false);
    expect(s.passed).toBe(true);
  });
});

describe('scoreCapturedRun — clarification (no steps expected)', () => {
  it('passes when the agent clarifies instead of authoring', () => {
    const s = scoreCapturedRun(clarifyScenario, run({ authoredVia: [], steps: [], needsClarification: true }));
    expect(s.passed).toBe(true);
  });

  it('fails when the agent authors steps anyway', () => {
    const s = scoreCapturedRun(clarifyScenario, run({ authoredVia: ['run_draft'], steps: okSteps }));
    expect(s.passed).toBe(false);
  });
});

describe('scoreCapturedRun — credential grounding (no store exists)', () => {
  const credScenario: Scenario = {
    id: 'login-x', name: 'login', scope: 'add', userMessage: 'create a login test',
    expectsSteps: true, grounding: 'credentials',
  };

  it('fails when the agent fabricates a credential value instead of asking', () => {
    const s = scoreCapturedRun(credScenario, run({
      authoredVia: ['run_draft'],
      steps: [
        { type: 'type', description: 'type a valid email', valueShape: 'literal' },
        { type: 'type', description: 'type a valid password', valueShape: 'empty' },
        { type: 'click', description: 'click login', valueShape: 'empty' },
      ],
    }));
    expect(s.grounded).toBe(false);
    expect(s.passed).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/cannot actually run|fabricated/i);
  });

  it('fails on a fabricated field even when another field uses a placeholder (the real add-login-happy shape)', () => {
    const s = scoreCapturedRun(credScenario, run({
      authoredVia: ['run_draft'],
      steps: [
        { type: 'type', description: 'type a valid email', valueShape: 'literal' },      // fabricated
        { type: 'type', description: 'type a valid password', valueShape: 'placeholder' }, // parameterized
        { type: 'click', description: 'click sign in', valueShape: 'empty' },
      ],
    }));
    expect(s.grounded).toBe(false);
    expect(s.passed).toBe(false);
  });

  it('passes when all input steps are empty skeletons (no fabrication)', () => {
    const s = scoreCapturedRun(credScenario, run({
      authoredVia: ['run_draft'],
      steps: [
        { type: 'type', description: 'type the email', valueShape: 'empty' },
        { type: 'type', description: 'type the password', valueShape: 'empty' },
      ],
    }));
    expect(s.grounded).toBe(true);
    expect(s.passed).toBe(true);
  });

  it('passes when the agent asks for the credentials (clarifies)', () => {
    const s = scoreCapturedRun(credScenario, run({ needsClarification: true, authoredVia: [], steps: [] }));
    expect(s.grounded).toBe(true);
    expect(s.passed).toBe(true);
  });

  it('passes when the agent parameterizes the credential with a placeholder', () => {
    const s = scoreCapturedRun(credScenario, run({
      authoredVia: ['run_draft'],
      steps: [
        { type: 'type', description: 'type the email', valueShape: 'placeholder' },
        { type: 'click', description: 'click login', valueShape: 'empty' },
      ],
    }));
    expect(s.grounded).toBe(true);
    expect(s.passed).toBe(true);
  });
});

describe('scoreCapturedRun — step shape + errors', () => {
  it('fails when a step has an unknown type or empty description', () => {
    const bad = [{ type: 'frobnicate', description: 'x' }, { type: 'click', description: '  ' }];
    const s = scoreCapturedRun(editScenario, run({ authoredVia: ['update'], steps: bad }));
    expect(s.stepsWellFormed).toBe(false);
    expect(s.passed).toBe(false);
  });

  it('fails every check when the replay errored', () => {
    const s = scoreCapturedRun(editScenario, run({ ok: false, error: 'boom' }));
    expect(s.passed).toBe(false);
    expect(s.reasons.join(' ')).toMatch(/boom/);
  });
});

describe('aggregate', () => {
  function scoreFor(id: string, passed: boolean): ScenarioScore {
    return { scenarioId: id, producedSteps: passed, toolChoiceCorrect: passed, noDuplicate: true, stepsWellFormed: passed, grounded: true, uncapturable: false, passed, reasons: passed ? [] : ['nope'] };
  }
  function uncapturableFor(id: string): ScenarioScore {
    return { scenarioId: id, producedSteps: false, toolChoiceCorrect: true, noDuplicate: true, stepsWellFormed: true, grounded: true, uncapturable: true, passed: false, reasons: ['uncapturable'] };
  }

  it('computes per-scenario and overall pass-rate', () => {
    const summary = aggregate([
      { scenarioId: 'a', score: scoreFor('a', true) },
      { scenarioId: 'a', score: scoreFor('a', true) },
      { scenarioId: 'b', score: scoreFor('b', false) },
      { scenarioId: 'b', score: scoreFor('b', false) },
    ]);
    expect(summary.totalRuns).toBe(4);
    expect(summary.totalPasses).toBe(2);
    expect(summary.passRate).toBe(0.5);
    expect(summary.perScenario.find((s) => s.scenarioId === 'a')!.passRate).toBe(1);
    expect(summary.perScenario.find((s) => s.scenarioId === 'b')!.passRate).toBe(0);
  });

  it('flags a scenario that passed some-but-not-all runs as flaky', () => {
    const summary = aggregate([
      { scenarioId: 'c', score: scoreFor('c', true) },
      { scenarioId: 'c', score: scoreFor('c', false) },
    ]);
    expect(summary.flakyScenarioIds).toEqual(['c']);
  });

  it('excludes uncapturable runs from the pass-rate denominator', () => {
    const summary = aggregate([
      { scenarioId: 'd', score: scoreFor('d', true) },
      { scenarioId: 'd', score: uncapturableFor('d') },
      { scenarioId: 'd', score: uncapturableFor('d') },
    ]);
    const d = summary.perScenario.find((s) => s.scenarioId === 'd')!;
    expect(d.runs).toBe(1);            // only the capturable run counts
    expect(d.passes).toBe(1);
    expect(d.passRate).toBe(1);
    expect(d.uncapturableRuns).toBe(2);
    expect(d.flaky).toBe(false);       // 1/1 is not flaky
    expect(summary.totalRuns).toBe(1);
    expect(summary.totalUncapturable).toBe(2);
    expect(summary.passRate).toBe(1);
  });

  it('reports n/a (runs=0) when every run of a scenario is uncapturable', () => {
    const summary = aggregate([
      { scenarioId: 'e', score: uncapturableFor('e') },
      { scenarioId: 'e', score: uncapturableFor('e') },
    ]);
    const e = summary.perScenario.find((s) => s.scenarioId === 'e')!;
    expect(e.runs).toBe(0);
    expect(e.passRate).toBe(0);        // 0 capturable → 0, reporter renders as n/a
    expect(e.uncapturableRuns).toBe(2);
    expect(summary.totalRuns).toBe(0);
    expect(summary.totalUncapturable).toBe(2);
  });
});

describe('hasUninstrumentedAuthoring', () => {
  it('detects qa_author_test_iteratively among executed tools', () => {
    expect(hasUninstrumentedAuthoring(['qa_run_draft_steps', 'qa_author_test_iteratively'])).toBe(true);
  });
  it('is false for only-instrumented tools', () => {
    expect(hasUninstrumentedAuthoring(['qa_create_test_case', 'qa_update_test_case_steps'])).toBe(false);
  });
  it('is false for an empty tool list', () => {
    expect(hasUninstrumentedAuthoring([])).toBe(false);
  });
});

describe('authoredViaFromTraceSource', () => {
  it('maps trace sources to tool labels', () => {
    expect(authoredViaFromTraceSource('saved')).toBe('create');
    expect(authoredViaFromTraceSource('updated')).toBe('update');
    expect(authoredViaFromTraceSource('run')).toBe('run_draft');
    expect(authoredViaFromTraceSource('bogus')).toBeNull();
  });
});
