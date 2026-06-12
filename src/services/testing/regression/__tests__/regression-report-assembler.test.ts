/**
 * Tests for RegressionReportAssemblerService — the run-report assembly that
 * was untestable until its Supabase queries moved behind the `db/` sublayer.
 * DB reads are stubbed at the `db/` boundary; service collaborators
 * (ExecutionService, report generator, health aggregator) are stubbed too.
 * No Supabase is mocked directly, per the repo's mock-boundary rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/regression/db/regression-report.db', () => ({
  getRunWithOwnership: jest.fn(),
  getRunByShareToken: jest.fn(),
  getTestCaseNamesByIds: jest.fn(),
  getTestResultsByTestIds: jest.fn(),
  getMobileTestResultsByTestIds: jest.fn(),
  getExecutedStepsByTestIds: jest.fn(),
  getNegativeMetaByIds: jest.fn(),
  getTestCasePhaseInfoByIds: jest.fn(),
}));

jest.mock('@/services/testing/regression/db/regression.db', () => ({
  getProjectWorkspaceId: jest.fn(),
  getActiveWorkspaceMemberIds: jest.fn(),
}));

jest.mock('@/services/testing/executions/execution.service', () => ({
  ExecutionService: { getStats: jest.fn(), getByRunId: jest.fn() },
}));

jest.mock('@/services/testing/results/test-report-generator.service', () => ({
  TestReportGeneratorService: { batchGetReportsByTestIds: jest.fn() },
}));

jest.mock('@/services/testing/regression/health-check-aggregator.service', () => ({
  HealthCheckAggregatorService: {
    aggregateFromTestResult: jest.fn(),
    buildHealthSummary: jest.fn(),
  },
}));

import {
  getTestCaseNamesByIds,
  getTestResultsByTestIds,
  getMobileTestResultsByTestIds,
  getExecutedStepsByTestIds,
  getNegativeMetaByIds,
  getTestCasePhaseInfoByIds,
} from '@/services/testing/regression/db/regression-report.db';
import {
  getProjectWorkspaceId,
  getActiveWorkspaceMemberIds,
} from '@/services/testing/regression/db/regression.db';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import { HealthCheckAggregatorService } from '@/services/testing/regression/health-check-aggregator.service';
import {
  RegressionReportAssemblerService,
  getProjectWorkspaceMemberIds,
} from '@/services/testing/regression/regression-report-assembler.service';
import type { TestExecution, ExecutionStats } from '@/types/testing.types';

const mockGetTestCaseNames = getTestCaseNamesByIds as jest.MockedFunction<typeof getTestCaseNamesByIds>;
const mockGetTestResults = getTestResultsByTestIds as jest.MockedFunction<typeof getTestResultsByTestIds>;
const mockGetMobileTestResults = getMobileTestResultsByTestIds as jest.MockedFunction<typeof getMobileTestResultsByTestIds>;
const mockGetExecutedSteps = getExecutedStepsByTestIds as jest.MockedFunction<typeof getExecutedStepsByTestIds>;
const mockGetNegativeMeta = getNegativeMetaByIds as jest.MockedFunction<typeof getNegativeMetaByIds>;
const mockGetPhaseInfo = getTestCasePhaseInfoByIds as jest.MockedFunction<typeof getTestCasePhaseInfoByIds>;
const mockGetWorkspaceId = getProjectWorkspaceId as jest.MockedFunction<typeof getProjectWorkspaceId>;
const mockGetMembers = getActiveWorkspaceMemberIds as jest.MockedFunction<typeof getActiveWorkspaceMemberIds>;
const mockGetStats = ExecutionService.getStats as jest.MockedFunction<typeof ExecutionService.getStats>;
const mockGetByRunId = ExecutionService.getByRunId as jest.MockedFunction<typeof ExecutionService.getByRunId>;
const mockBatchReports = TestReportGeneratorService.batchGetReportsByTestIds as jest.MockedFunction<
  typeof TestReportGeneratorService.batchGetReportsByTestIds
>;
const mockBuildHealthSummary = HealthCheckAggregatorService.buildHealthSummary as jest.MockedFunction<
  typeof HealthCheckAggregatorService.buildHealthSummary
>;
const mockAggHealth = HealthCheckAggregatorService.aggregateFromTestResult as jest.MockedFunction<
  typeof HealthCheckAggregatorService.aggregateFromTestResult
>;

function makeExec(over: Partial<TestExecution> = {}): TestExecution {
  return {
    id: 'exec-1',
    runId: 'run-1',
    testType: 'ui',
    testCaseId: 'tc-1',
    status: 'passed',
    durationMs: 100,
    result: { testId: 'test-1' },
    browser: 'chrome',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as TestExecution;
}

function makeStats(over: Partial<ExecutionStats> = {}): ExecutionStats {
  return {
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    running: 0,
    cancelled: 0,
    passRate: 100,
    ...over,
  };
}

const baseRun = {
  id: 'run-1',
  plan_id: 'plan-1',
  regression_plans: { name: 'Smoke' },
  trigger: 'manual',
  started_at: '2026-01-01T00:00:00Z',
  completed_at: '2026-01-01T00:01:00Z',
  status: 'completed',
};

describe('RegressionReportAssemblerService.assembleReport', () => {
  beforeEach(() => {
    // Sensible empty defaults; individual tests override what they assert on.
    mockGetTestCaseNames.mockResolvedValue([]);
    mockGetTestResults.mockResolvedValue([]);
    mockGetMobileTestResults.mockResolvedValue([]);
    mockGetExecutedSteps.mockResolvedValue([]);
    mockGetNegativeMeta.mockResolvedValue([]);
    mockGetPhaseInfo.mockResolvedValue([]);
    mockBatchReports.mockResolvedValue([]);
    mockAggHealth.mockReturnValue(undefined as any);
    mockBuildHealthSummary.mockReturnValue(undefined as any);
    mockGetStats.mockResolvedValue(makeStats());
    mockGetByRunId.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  it('aggregates bug counts by severity and category from ai_summary', async () => {
    mockGetStats.mockResolvedValue(makeStats({ total: 1, passed: 0, failed: 1 }));
    mockGetByRunId.mockResolvedValue([makeExec({ status: 'failed' })]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetTestResults.mockResolvedValue([
      {
        test_id: 'test-1',
        ai_summary: {
          bugs: [
            { title: 'Crash', severity: 'critical', category: 'functional' },
            { title: 'Slow', severity: 'low', category: 'performance' },
            { title: 'Weird color', severity: 'unknown', category: 'bogus' }, // → defaults
          ],
        },
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    expect(report.summary.totalBugs).toBe(3);
    expect(report.summary.bySeverity).toEqual({ critical: 1, low: 1, medium: 1 });
    expect(report.summary.byCategory).toEqual({ functional: 2, performance: 1 });
    expect(report.bugs).toHaveLength(3);
  });

  it('reconstructs setup/main/teardown phases by executed-step index', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetPhaseInfo.mockResolvedValue([
      { id: 'tc-1', setup_steps: ['s'], steps_json: ['m'], teardown_steps: ['t'], priority: 'high' },
    ]);
    mockGetExecutedSteps.mockResolvedValue([
      {
        id: 'test-1',
        executed_steps: [
          { type: 'step_completed', data: { success: true, step: 'open' } },
          { type: 'step_completed', data: { success: true, step: 'act' } },
          { type: 'step_completed', data: { success: true, step: 'cleanup' } },
        ],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    const phases = report.executions[0].steps.map((s) => (s as any).phase);
    expect(phases).toEqual(['setup', 'main', 'teardown']);
    expect(report.executions[0].priority).toBe('high');
  });

  it('omits phase for legacy cases with no setup/teardown steps', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetPhaseInfo.mockResolvedValue([
      { id: 'tc-1', setup_steps: [], steps_json: ['m'], teardown_steps: [], priority: null },
    ]);
    mockGetExecutedSteps.mockResolvedValue([
      { id: 'test-1', executed_steps: [{ type: 'step_completed', data: { success: true } }] },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    expect((report.executions[0].steps[0] as any).phase).toBeUndefined();
    expect(report.executions[0].priority).toBeNull();
  });

  it('collapses duplicate step indices (retry / double-append), keeping the last event', async () => {
    // The Redis buffer accumulates every attempt's steps in order. A retried
    // run (or a transient worker/API double-append during deploy) leaves two
    // events for the same step index. The report must show one step per index,
    // reflecting the FINAL attempt's outcome — not a doubled timeline.
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetExecutedSteps.mockResolvedValue([
      {
        id: 'test-1',
        executed_steps: [
          // attempt 0 — both steps failed
          { type: 'step_completed', data: { success: false, step: 0, stepDescription: 'open (a0)' } },
          { type: 'step_completed', data: { success: false, step: 1, stepDescription: 'click (a0)' } },
          // attempt 1 (retry) — both passed
          { type: 'step_completed', data: { success: true, step: 0, stepDescription: 'open (a1)' } },
          { type: 'step_completed', data: { success: true, step: 1, stepDescription: 'click (a1)' } },
        ],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    const steps = report.executions[0].steps;
    expect(steps).toHaveLength(2); // not 4
    expect(steps.map((s) => s.description)).toEqual(['open (a1)', 'click (a1)']);
    expect(steps.map((s) => s.status)).toEqual(['passed', 'passed']); // final attempt wins
  });

  it('surfaces a job-level failure reason and marks it an environment issue (test never ran)', async () => {
    mockGetStats.mockResolvedValue(makeStats({ total: 1, passed: 0, failed: 1 }));
    mockGetByRunId.mockResolvedValue([makeExec({ status: 'failed', platform: 'mobile_flutter' })]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Bank-2' }]);
    // The mobile job persisted a device-attach failure (FLUTTER_NOT_DETECTED).
    // The test never ran, so there are no executed steps.
    mockGetMobileTestResults.mockResolvedValue([
      {
        test_id: 'test-1',
        errors: [{ type: 'job_failure', code: 'FLUTTER_NOT_DETECTED', message: 'agent failed to attach' }],
        metadata: { failureLayer: 'job', errorCode: 'FLUTTER_NOT_DETECTED', errorMessage: 'agent failed to attach' },
      },
    ]);
    // The health aggregator would emit a green "no console errors" finding —
    // the assembler must NOT call it for a test that never ran.
    mockAggHealth.mockReturnValue({
      findings: [{ category: 'console_errors', severity: 'pass', message: 'No console errors' }],
      checkedAt: 'x',
    } as any);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    const exec = report.executions[0];
    expect(exec.failureReason).toMatchObject({
      code: 'FLUTTER_NOT_DETECTED',
      category: 'environment',
      layer: 'job',
      message: 'agent failed to attach',
    });
    expect(exec.failureReason?.label).toBeTruthy();
    expect(exec.failureReason?.remediation).toBeTruthy();
    // Environment failure → classified as such even without an AI verdict.
    expect(exec.failureClassification).toBe('environment');
    // Misleading green health chips are suppressed for a non-started test.
    expect(exec.healthChecks).toBeUndefined();
    expect(mockAggHealth).not.toHaveBeenCalled();
  });

  it('does not attach a failureReason for a normal step-level failure', async () => {
    mockGetStats.mockResolvedValue(makeStats({ total: 1, passed: 0, failed: 1 }));
    mockGetByRunId.mockResolvedValue([makeExec({ status: 'failed' })]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetTestResults.mockResolvedValue([{ test_id: 'test-1', ai_summary: { bugs: [] } }]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    expect(report.executions[0].failureReason).toBeUndefined();
  });

  it('splits negative executions into a separate negativeSummary', async () => {
    mockGetStats.mockResolvedValue(makeStats({ total: 2, passed: 1, failed: 1 }));
    mockGetByRunId.mockResolvedValue([
      makeExec({ id: 'pos', testCaseId: 'tc-pos', status: 'passed', result: { testId: 'test-pos' } }),
      makeExec({ id: 'neg', testCaseId: 'tc-neg', status: 'failed', isNegative: true, result: { testId: 'test-neg' } }),
    ]);
    mockGetTestCaseNames.mockResolvedValue([
      { id: 'tc-pos', name: 'Positive' },
      { id: 'tc-neg', name: 'Negative' },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    expect(report.executions).toHaveLength(1); // positive only
    expect(report.negativeSummary).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 });
    expect(report.negativeExecutions).toHaveLength(1);
  });

  it('buckets platformBreakdown by platform string and api-by-absent-steps', async () => {
    mockGetStats.mockResolvedValue(makeStats({ total: 3, passed: 3 }));
    mockGetByRunId.mockResolvedValue([
      makeExec({ id: 'web', testCaseId: 'tc-web', platform: 'web', result: { testId: 'test-web' } }),
      makeExec({ id: 'mob', testCaseId: 'tc-mob', platform: 'mobile_android', result: { testId: 'test-mob' } }),
      makeExec({ id: 'api', testCaseId: 'tc-api', testType: 'api', result: {} }), // no testId → no steps → api
    ]);
    mockGetTestCaseNames.mockResolvedValue([
      { id: 'tc-web', name: 'Web' },
      { id: 'tc-mob', name: 'Mob' },
      { id: 'tc-api', name: 'Api' },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    expect(report.summary.platformBreakdown.web.total).toBe(1);
    expect(report.summary.platformBreakdown.mobile.total).toBe(1);
    expect(report.summary.platformBreakdown.api.total).toBe(1);
  });

  it('surfaces mobile artifacts from mobile_test_results (separate table from web)', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Bank' }]);
    // Web table empty; the result lives in mobile_test_results.
    mockGetMobileTestResults.mockResolvedValue([
      {
        test_id: 'test-1',
        screenshot: 'https://cdn/mobile-final.webp',
        network_logs: [{ method: 'GET', url: 'https://api', status: 200 }],
        logs: ['hello'],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });
    const exec = report.executions[0];

    expect(exec.artifacts.screenshots.map((s) => s.url)).toContain('https://cdn/mobile-final.webp');
    expect(exec.artifacts.networkLogs).toHaveLength(1);
    expect(exec.artifacts.consoleLogs).toEqual(['hello']);
  });

  it('leads the gallery with the "Step 0" initial screenshot from mobile metadata', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Bank' }]);
    mockGetMobileTestResults.mockResolvedValue([
      {
        test_id: 'test-1',
        screenshot: 'https://cdn/mobile-final.webp',
        metadata: { platform: 'mobile', initialScreenshot: 'https://cdn/step-0-initial.webp' },
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });
    const exec = report.executions[0];

    // Initial screenshot is first, labeled "Step 0", ahead of the final shot.
    expect(exec.artifacts.screenshots[0]).toMatchObject({
      url: 'https://cdn/step-0-initial.webp',
      stepName: 'Step 0: Initial screen',
    });
    expect(exec.artifacts.screenshots.map((s) => s.url)).toEqual([
      'https://cdn/step-0-initial.webp',
      'https://cdn/mobile-final.webp',
    ]);
  });

  // ── Per-step screenshots (runtimeMeta.stepScreenshotUrl) ──
  // The feature captures a screenshot after EVERY step (web + mobile) and
  // threads the URL through runtimeMeta.stepScreenshotUrl. The assembler must
  // surface it in the Screenshots artifact list — NOT the bug-screenshot list —
  // and onto the step itself, deduped against the final test_results screenshot.

  it('routes stepScreenshotUrl into screenshots[] (exec + run) with a descriptive label, not bugScreenshots', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetExecutedSteps.mockResolvedValue([
      {
        id: 'test-1',
        executed_steps: [
          { type: 'step_completed', ts: '2026-06-05T20:59:14.000Z', data: { success: true, step: 0, stepDescription: 'open', runtimeMeta: { stepScreenshotUrl: 'https://cdn/step-0.webp' } } },
          { type: 'step_completed', ts: '2026-06-05T20:59:16.000Z', data: { success: true, step: 1, stepDescription: 'click', runtimeMeta: { stepScreenshotUrl: 'https://cdn/step-1.webp' } } },
        ],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    const exec = report.executions[0];
    // onto each step (inline timeline still gets the bare URL)
    expect(exec.steps.map((s) => (s as any).screenshot)).toEqual([
      'https://cdn/step-0.webp',
      'https://cdn/step-1.webp',
    ]);
    // into the execution + run-level Screenshots artifact list, as labeled objects
    expect(exec.artifacts.screenshots.map((s) => s.url)).toEqual(['https://cdn/step-0.webp', 'https://cdn/step-1.webp']);
    expect(exec.artifacts.screenshots[0]).toMatchObject({
      url: 'https://cdn/step-0.webp',
      stepName: 'Step 1: open',
      status: 'passed',
    });
    expect(typeof exec.artifacts.screenshots[0].timestamp).toBe('string'); // HH:MM:SS
    expect(report.artifactsSummary.screenshots.map((s) => s.url)).toEqual(['https://cdn/step-0.webp', 'https://cdn/step-1.webp']);
    // NOT the bug-screenshot list (those are failure-only)
    expect(exec.artifacts.bugScreenshots).toEqual([]);
  });

  it('keeps the per-step screenshot separate from the failure bug screenshot', async () => {
    mockGetStats.mockResolvedValue(makeStats({ total: 1, passed: 0, failed: 1 }));
    mockGetByRunId.mockResolvedValue([makeExec({ status: 'failed' })]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetExecutedSteps.mockResolvedValue([
      {
        id: 'test-1',
        executed_steps: [
          {
            type: 'step_completed',
            data: {
              success: false,
              step: 0,
              stepDescription: 'click',
              runtimeMeta: {
                stepScreenshotUrl: 'https://cdn/step-0.webp',
                bugScreenshotUrl: 'https://cdn/bug-0.png',
              },
            },
          },
        ],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });
    const exec = report.executions[0];

    // step screenshot → screenshots[]; bug screenshot → bugScreenshots[] (no cross-contamination)
    expect(exec.artifacts.screenshots.map((s) => s.url)).toEqual(['https://cdn/step-0.webp']);
    expect(exec.artifacts.screenshots[0]).toMatchObject({ stepName: 'Step 1: click', status: 'failed' });
    expect(exec.artifacts.bugScreenshots).toEqual(['https://cdn/bug-0.png']);
    expect((exec.steps[0] as any).screenshot).toBe('https://cdn/step-0.webp');
    expect(exec.steps[0].error?.screenshot).toBe('https://cdn/bug-0.png');
  });

  it('dedupes a per-step screenshot already present as the final test_results screenshot', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetTestResults.mockResolvedValue([{ test_id: 'test-1', screenshot: 'https://cdn/final.webp' }]);
    mockGetExecutedSteps.mockResolvedValue([
      {
        id: 'test-1',
        executed_steps: [
          { type: 'step_completed', data: { success: true, step: 0, runtimeMeta: { stepScreenshotUrl: 'https://cdn/final.webp' } } },
          { type: 'step_completed', data: { success: true, step: 1, runtimeMeta: { stepScreenshotUrl: 'https://cdn/step-1.webp' } } },
        ],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    // 'final.webp' came from test_results.screenshot; the matching step URL is not added twice
    const exec = report.executions[0];
    expect(exec.artifacts.screenshots.map((s) => s.url)).toEqual(['https://cdn/final.webp', 'https://cdn/step-1.webp']);
    expect(exec.artifacts.screenshots[0].stepName).toBe('Final screenshot');
  });

  it('skips a base64 stepScreenshotUrl from the screenshots artifact list', async () => {
    mockGetByRunId.mockResolvedValue([makeExec()]);
    mockGetTestCaseNames.mockResolvedValue([{ id: 'tc-1', name: 'Login' }]);
    mockGetExecutedSteps.mockResolvedValue([
      {
        id: 'test-1',
        executed_steps: [
          { type: 'step_completed', data: { success: true, step: 0, runtimeMeta: { stepScreenshotUrl: 'data:image/png;base64,AAAA' } } },
        ],
      },
    ]);

    const report = await RegressionReportAssemblerService.assembleReport({ ...baseRun });

    // base64 never lands in the artifact list (would bloat/break the UI)
    expect(report.executions[0].artifacts.screenshots).toEqual([]);
  });
});

describe('getProjectWorkspaceMemberIds', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns just the owner when the project has no workspace', async () => {
    mockGetWorkspaceId.mockResolvedValue(null);

    const ids = await getProjectWorkspaceMemberIds('proj-1', 'owner-1');

    expect(ids).toEqual(['owner-1']);
    expect(mockGetMembers).not.toHaveBeenCalled();
  });

  it('merges active members with the owner and dedups', async () => {
    mockGetWorkspaceId.mockResolvedValue('ws-1');
    mockGetMembers.mockResolvedValue(['owner-1', 'member-2', 'member-3']);

    const ids = await getProjectWorkspaceMemberIds('proj-1', 'owner-1');

    expect(ids.sort()).toEqual(['member-2', 'member-3', 'owner-1']);
  });

  it('falls back to [ownerId] when a db call throws', async () => {
    mockGetWorkspaceId.mockRejectedValue(new Error('db down'));

    const ids = await getProjectWorkspaceMemberIds('proj-1', 'owner-1');

    expect(ids).toEqual(['owner-1']);
  });
});
