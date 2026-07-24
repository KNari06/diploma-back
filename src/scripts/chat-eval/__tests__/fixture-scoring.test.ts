import { scoreFixtureRun, aggregateFixture } from '../fixture-scoring';
import type { FixtureRunOutcome, FixtureScore } from '../fixture-types';

const ok: FixtureRunOutcome = { passed: true, status: 'passed', stepsRun: 7 };
const fail: FixtureRunOutcome = { passed: false, status: 'failed', stepsRun: 7, errorSummary: 'assert failed' };

describe('scoreFixtureRun — first-run-pass', () => {
  it('marks green-on-clean as a first-run pass', () => {
    const s = scoreFixtureRun({ scenarioId: 'a', source: 'golden', cleanOutcome: ok, hasFlagPairing: false });
    expect(s.firstRunPass).toBe(true);
  });

  it('marks red-on-clean as a first-run fail', () => {
    const s = scoreFixtureRun({ scenarioId: 'a', source: 'golden', cleanOutcome: fail, hasFlagPairing: false });
    expect(s.firstRunPass).toBe(false);
  });
});

describe('scoreFixtureRun — false-green', () => {
  it('flags false-green when a paired test stays green on the broken app', () => {
    const s = scoreFixtureRun({
      scenarioId: 'checkout', source: 'golden',
      cleanOutcome: ok, brokenOutcome: ok, hasFlagPairing: true,
    });
    expect(s.falseGreenEligible).toBe(true);
    expect(s.falseGreen).toBe(true);
  });

  it('is NOT a false-green when the paired test correctly goes red on the broken app', () => {
    const s = scoreFixtureRun({
      scenarioId: 'checkout', source: 'golden',
      cleanOutcome: ok, brokenOutcome: fail, hasFlagPairing: true,
    });
    expect(s.falseGreenEligible).toBe(true);
    expect(s.falseGreen).toBe(false);
  });

  it('is ineligible for false-green when the test fails on the clean app (broken test, not false-green)', () => {
    const s = scoreFixtureRun({
      scenarioId: 'checkout', source: 'golden',
      cleanOutcome: fail, brokenOutcome: ok, hasFlagPairing: true,
    });
    expect(s.falseGreenEligible).toBe(false);
    expect(s.falseGreen).toBeUndefined();
  });

  it('is ineligible when the scenario has no flag pairing', () => {
    const s = scoreFixtureRun({ scenarioId: 'login', source: 'golden', cleanOutcome: ok, hasFlagPairing: false });
    expect(s.falseGreenEligible).toBe(false);
  });

  it('is ineligible when the broken run was not performed', () => {
    const s = scoreFixtureRun({ scenarioId: 'checkout', source: 'golden', cleanOutcome: ok, hasFlagPairing: true });
    expect(s.falseGreenEligible).toBe(false);
  });
});

describe('scoreFixtureRun — authored assertion honesty', () => {
  it('records the authored terminal assertion for a Stage-2 run', () => {
    const s = scoreFixtureRun({
      scenarioId: 'checkout', source: 'authored',
      cleanOutcome: ok, hasFlagPairing: false, authoredAssertion: 'the total is $126.35',
    });
    expect(s.authoredAssertion).toBe('the total is $126.35');
  });

  it('records null when the agent authored no assertion (capability gap)', () => {
    const s = scoreFixtureRun({
      scenarioId: 'checkout', source: 'authored',
      cleanOutcome: ok, hasFlagPairing: false, authoredAssertion: null,
    });
    expect(s.authoredAssertion).toBeNull();
    expect(s.notes.join(' ')).toMatch(/authored NO assertion/);
  });

  it('does not attach an authoredAssertion field for golden runs', () => {
    const s = scoreFixtureRun({ scenarioId: 'x', source: 'golden', cleanOutcome: ok, hasFlagPairing: false });
    expect(s.authoredAssertion).toBeUndefined();
  });
});

describe('aggregateFixture', () => {
  const scores: FixtureScore[] = [
    scoreFixtureRun({ scenarioId: 'login', source: 'golden', cleanOutcome: ok, hasFlagPairing: false }),
    scoreFixtureRun({ scenarioId: 'search', source: 'golden', cleanOutcome: ok, hasFlagPairing: false }),
    scoreFixtureRun({ scenarioId: 'checkout', source: 'golden', cleanOutcome: ok, brokenOutcome: fail, hasFlagPairing: true }),
  ];

  it('computes first-run-pass-rate over every scenario', () => {
    const summary = aggregateFixture(scores);
    expect(summary.firstRunDenom).toBe(3);
    expect(summary.firstRunPasses).toBe(3);
    expect(summary.firstRunPassRate).toBe(1);
  });

  it('computes false-green-rate only over eligible scenarios', () => {
    const summary = aggregateFixture(scores);
    expect(summary.falseGreenDenom).toBe(1); // only checkout is paired
    expect(summary.falseGreens).toBe(0);     // it correctly went red
    expect(summary.falseGreenRate).toBe(0);
  });

  it('counts a false-green when a paired test wrongly passes on broken', () => {
    const withBug = [
      ...scores.slice(0, 2),
      scoreFixtureRun({ scenarioId: 'checkout', source: 'golden', cleanOutcome: ok, brokenOutcome: ok, hasFlagPairing: true }),
    ];
    const summary = aggregateFixture(withBug);
    expect(summary.falseGreenDenom).toBe(1);
    expect(summary.falseGreens).toBe(1);
    expect(summary.falseGreenRate).toBe(1);
  });

  it('a scenario that fails on the clean app lowers first-run-pass-rate and is false-green-ineligible', () => {
    const withRed = [
      scores[0],
      scoreFixtureRun({ scenarioId: 'checkout', source: 'authored', cleanOutcome: fail, brokenOutcome: ok, hasFlagPairing: true, authoredAssertion: null }),
    ];
    const summary = aggregateFixture(withRed);
    expect(summary.firstRunPasses).toBe(1);
    expect(summary.firstRunDenom).toBe(2);
    expect(summary.falseGreenDenom).toBe(0);
  });
});
