/**
 * Pure function — fixture in, fixture out, no mocks (testing.md's rule for
 * pure utilities).
 */
import { computeReleaseVerdict, applyVisualAnomalySoftening, RELEASE_VERDICT_RULESET_VERSION } from '../release-verdict.util';
import type { EnrichedBug, HealthSummary, RunReportSummary } from '@/types/testing.types';

function bug(overrides: Partial<EnrichedBug> = {}): EnrichedBug {
  return {
    id: 'bug-1',
    title: 'Something broke',
    severity: 'medium',
    category: 'functional',
    testCaseId: 'tc-1',
    testCaseName: 'Test case',
    executionId: 'exec-1',
    steps: [],
    expected: '',
    actual: '',
    recommendation: '',
    ...overrides,
  };
}

function health(findings: HealthSummary['findings'] = []): HealthSummary {
  return { totalChecks: findings.length, passed: 0, warnings: 0, failures: 0, findings };
}

/** Default: a clean completed run — 1 passed, 0 failed. */
function summary(overrides: Partial<RunReportSummary> = {}): RunReportSummary {
  return {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    flaky: 0,
    totalBugs: 0,
    bySeverity: {},
    byCategory: {},
    platformBreakdown: {
      web: { total: 1, passed: 1, failed: 0 },
      mobile: { total: 0, passed: 0, failed: 0 },
      api: { total: 0, passed: 0, failed: 0 },
    },
    ...overrides,
  };
}

describe('computeReleaseVerdict', () => {
  it('returns ready when there are no bugs, no health-check failures, and the run completed cleanly', () => {
    const verdict = computeReleaseVerdict([], health(), 'completed', summary());
    expect(verdict.status).toBe('ready');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.rulesetVersion).toBe(RELEASE_VERDICT_RULESET_VERSION);
  });

  it('returns ready_with_warnings when only medium/low bugs exist', () => {
    const verdict = computeReleaseVerdict([bug({ severity: 'low' })], health(), 'completed', summary());
    expect(verdict.status).toBe('ready_with_warnings');
    expect(verdict.reasons).toEqual([]);
  });

  it('returns not_ready with a CRITICAL_BUG reason for a critical bug', () => {
    const verdict = computeReleaseVerdict([bug({ id: 'b1', severity: 'critical', title: 'Login broken' })], health(), 'completed', summary());
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toEqual([
      { code: 'CRITICAL_BUG', label: 'critical bug: Login broken', refType: 'bug', refId: 'b1' },
    ]);
  });

  it('returns not_ready with a HIGH_BUG reason for a high-severity bug', () => {
    const verdict = computeReleaseVerdict([bug({ id: 'b2', severity: 'high' })], health(), 'completed', summary());
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons[0].code).toBe('HIGH_BUG');
  });

  it('returns not_ready when a health check finding has severity "fail"', () => {
    const verdict = computeReleaseVerdict([], health([
      { category: 'console_errors', severity: 'fail', message: 'JS error on load' },
    ]), 'completed', summary());
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toEqual([
      { code: 'HEALTH_CHECK_FAILED', label: 'JS error on load', refType: 'health_check', refId: 'console_errors' },
    ]);
  });

  it('ignores health check findings with severity "warning" or "pass"', () => {
    const verdict = computeReleaseVerdict([], health([
      { category: 'network_errors', severity: 'warning', message: 'Slow request' },
      { category: 'broken_images', severity: 'pass', message: 'No broken images' },
    ]), 'completed', summary());
    expect(verdict.status).toBe('ready');
    expect(verdict.reasons).toEqual([]);
  });

  it('handles a missing healthSummary (undefined) without throwing', () => {
    expect(() => computeReleaseVerdict([bug({ severity: 'low' })], undefined, 'completed', summary())).not.toThrow();
    expect(computeReleaseVerdict([], undefined, 'completed', summary()).status).toBe('ready');
  });

  // Caught by live testing, 2026-07-08 — see release-verdict.util.ts's header
  // comment: a run whose executions failed, or that never completed, must
  // never show "ready" just because no AI-detected bug happened to exist.
  describe('run outcome (independent of AI-detected bugs)', () => {
    it('returns not_ready when summary.failed > 0, even with zero AI-detected bugs', () => {
      const verdict = computeReleaseVerdict([], health(), 'completed', summary({ total: 2, passed: 1, failed: 1 }));
      expect(verdict.status).toBe('not_ready');
      expect(verdict.reasons).toEqual([
        { code: 'TEST_EXECUTION_FAILED', label: '1 of 2 test execution(s) failed', refType: 'execution', refId: 'run' },
      ]);
    });

    it('returns not_ready when the run status is "failed" even with zero bugs and zero failed executions (the exact case caught live)', () => {
      const verdict = computeReleaseVerdict([], health(), 'failed', summary({ total: 0, passed: 0, failed: 0 }));
      expect(verdict.status).toBe('not_ready');
      expect(verdict.reasons).toEqual([
        { code: 'RUN_DID_NOT_COMPLETE', label: 'Run status: failed', refType: 'execution', refId: 'run' },
      ]);
    });

    it('returns not_ready when the run status is "cancelled"', () => {
      const verdict = computeReleaseVerdict([], health(), 'cancelled', summary({ total: 0, passed: 0, failed: 0 }));
      expect(verdict.status).toBe('not_ready');
      expect(verdict.reasons[0].code).toBe('RUN_DID_NOT_COMPLETE');
    });

    it('prefers the TEST_EXECUTION_FAILED reason over RUN_DID_NOT_COMPLETE when both would apply (no duplicate reasons)', () => {
      const verdict = computeReleaseVerdict([], health(), 'failed', summary({ total: 2, passed: 1, failed: 1 }));
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0].code).toBe('TEST_EXECUTION_FAILED');
    });

    it('combines a bug reason with an execution-failure reason when both are present', () => {
      const verdict = computeReleaseVerdict(
        [bug({ id: 'b1', severity: 'critical' })],
        health(),
        'completed',
        summary({ total: 2, passed: 1, failed: 1 }),
      );
      expect(verdict.status).toBe('not_ready');
      expect(verdict.reasons.map((r) => r.code).sort()).toEqual(['CRITICAL_BUG', 'TEST_EXECUTION_FAILED']);
    });

    it('does not flag a "running" (non-terminal) status as a failure to complete', () => {
      const verdict = computeReleaseVerdict([], health(), 'running', summary({ total: 0, passed: 0, failed: 0 }));
      expect(verdict.status).toBe('ready');
    });
  });
});

describe('applyVisualAnomalySoftening', () => {
  const readyVerdict = computeReleaseVerdict([], health(), 'completed', summary());

  it('softens a ready verdict to ready_with_warnings for a qualifying anomaly', () => {
    const softened = applyVisualAnomalySoftening(readyVerdict, [
      { id: 'va-1', category: 'placeholder_text', description: 'Lorem ipsum on checkout', confidence: 0.9 },
    ]);
    expect(softened.status).toBe('ready_with_warnings');
    expect(softened.reasons).toHaveLength(1);
    expect(softened.reasons[0].refType).toBe('visual_anomaly');
  });

  it('does not soften when confidence is below 0.7', () => {
    const softened = applyVisualAnomalySoftening(readyVerdict, [
      { id: 'va-1', category: 'placeholder_text', description: 'Maybe lorem ipsum', confidence: 0.5 },
    ]);
    expect(softened.status).toBe('ready');
  });

  it('does not soften for category "other"', () => {
    const softened = applyVisualAnomalySoftening(readyVerdict, [
      { id: 'va-1', category: 'other', description: 'Something odd', confidence: 0.95 },
    ]);
    expect(softened.status).toBe('ready');
  });

  it('never changes an already not_ready verdict', () => {
    const notReady = computeReleaseVerdict([bug({ severity: 'critical' })], health(), 'completed', summary());
    const softened = applyVisualAnomalySoftening(notReady, [
      { id: 'va-1', category: 'broken_image', description: 'Missing hero image', confidence: 0.99 },
    ]);
    expect(softened).toBe(notReady);
  });

  it('never changes ready_with_warnings — only ready can be softened further down', () => {
    const warned = computeReleaseVerdict([bug({ severity: 'low' })], health(), 'completed', summary());
    const softened = applyVisualAnomalySoftening(warned, [
      { id: 'va-1', category: 'broken_image', description: 'Missing hero image', confidence: 0.99 },
    ]);
    expect(softened).toBe(warned);
  });

  it('is a no-op when there are no qualifying anomalies', () => {
    const softened = applyVisualAnomalySoftening(readyVerdict, []);
    expect(softened).toBe(readyVerdict);
  });
});
