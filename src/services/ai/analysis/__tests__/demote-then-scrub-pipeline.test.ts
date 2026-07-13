import { AIService } from '@/services/ai/analysis/test-results.service';
import type { TestResult, AISummary } from '@/types';

/**
 * demoteAdvisoryAccessibilityBugs and scrubHallucinatedBugs are each unit
 * tested in isolation (see the sibling *.test.ts files), but analyzeTestResults
 * chains them (demoted → scrubHallucinatedBugs(testResult, demoted)) and that
 * chained interaction had a bug no isolated test could catch: scrub used to
 * wipe a high/critical accessibility bug that demote had just decided to keep.
 * These tests call both private methods in the same order analyzeTestResults
 * does, without going through analyzeTestResults itself (its generateAnalysis
 * step makes a real OpenAI call with no injectable seam to mock here).
 */
const svc = new AIService() as any;
const runPipeline = (analysis: AISummary, testResult: TestResult): AISummary =>
  svc.scrubHallucinatedBugs(testResult, svc.demoteAdvisoryAccessibilityBugs(analysis));

const mkResult = (over: Partial<TestResult> = {}): TestResult =>
  ({
    id: 'r1', testId: 't1', browser: 'chromium' as any, status: 'completed',
    logs: [], networkLogs: [], errors: [], createdAt: new Date(), ...over,
  }) as TestResult;

const mkAnalysis = (
  bugs: Array<{ title: string; severity: string; category: string }>,
  overrides: Partial<AISummary> = {},
): AISummary =>
  ({
    summary: 's', bugs: bugs as any, recommendations: ['keep me'],
    severity: 'high', confidence: 80, generatedAt: new Date(),
    ...overrides,
  }) as AISummary;

describe('demoteAdvisoryAccessibilityBugs -> scrubHallucinatedBugs pipeline', () => {
  it('a critical accessibility bug survives BOTH stages on a console/network-quiet clean run', () => {
    const out = runPipeline(
      mkAnalysis([
        { title: 'Keyboard focus trap blocks checkout for screen reader users', severity: 'critical', category: 'accessibility' },
      ]),
      mkResult(), // status:'completed', errors:[], networkLogs:[] — no real signal for scrub
    );
    expect(out.bugs).toHaveLength(1);
    expect(out.bugs[0].title).toBe('Keyboard focus trap blocks checkout for screen reader users');
  });

  it('a low-severity accessibility bug is demoted and the run ends up fully clean (bugs:[], severity:low)', () => {
    const out = runPipeline(
      mkAnalysis([{ title: 'Missing <main> landmark region', severity: 'low', category: 'accessibility' }]),
      mkResult(),
    );
    expect(out.bugs).toEqual([]);
    expect(out.severity).toBe('low');
    expect(out.recommendations).toContain('Missing <main> landmark region');
  });

  it('a demoted-to-empty run clears a real_bug failureClassification through both stages', () => {
    const out = runPipeline(
      mkAnalysis(
        [{ title: '2 buttons without accessible name', severity: 'low', category: 'accessibility' }],
        { failureClassification: 'real_bug', classificationEvidence: ['missing accessible names on 2 buttons'] },
      ),
      mkResult(),
    );
    expect(out.bugs).toEqual([]);
    expect(out.failureClassification).toBeNull();
    expect(out.classificationEvidence).toEqual([]);
  });

  it('a real functional bug survives both stages untouched, accessibility noise is demoted alongside it', () => {
    const out = runPipeline(
      mkAnalysis([
        { title: 'Checkout submission fails with 500 error', severity: 'critical', category: 'functional' },
        { title: '2 buttons without accessible name', severity: 'low', category: 'accessibility' },
      ]),
      mkResult({ networkLogs: [{ url: '/api/checkout', method: 'POST', status: 500 } as any] }),
    );
    expect(out.bugs).toHaveLength(1);
    expect(out.bugs[0].title).toBe('Checkout submission fails with 500 error');
    expect(out.recommendations).toContain('2 buttons without accessible name');
  });

  it('an invented low-severity functional bug is still scrubbed on a clean run (regression guard)', () => {
    const out = runPipeline(
      mkAnalysis([{ title: 'invented low-severity console warning', severity: 'low', category: 'functional' }]),
      mkResult(),
    );
    expect(out.bugs).toEqual([]);
    expect(out.severity).toBe('low');
  });
});
