/**
 * Tests for TestExecutionOrchestratorService.executeTestCasesAsync — the core
 * regression dispatch loop. Untestable until its regression_runs/test_executions
 * queries moved behind the `db/` sublayer. DB is stubbed at the `db/` boundary;
 * all collaborators (executors, dispatchers, WS, queue, credits) are stubbed.
 * No Supabase is mocked directly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/regression/db/regression-run.db', () => ({
  getRunRoutingInfo: jest.fn(),
  getExecutionRefsForRun: jest.fn(),
  getFastAuthByExecIds: jest.fn(),
  updateRunById: jest.fn(),
  updateRunByIdIfActive: jest.fn(),
}));

jest.mock('@/services/testing/regression/db/regression-test-query.db', () => ({
  RegressionTestQueryService: { getSavedTestCase: jest.fn() },
}));

jest.mock('@/services/testing/regression/concurrency-decision', () => ({
  decideMaxMobileInFlight: jest.fn(),
  countMobileTests: jest.fn(() => 0),
  dominantMobilePlatform: jest.fn(() => null),
  envCapMobile: jest.fn(() => 1),
}));

jest.mock('@/services/testing/regression/mobile-test-dispatcher.service', () => ({
  MobileTestDispatcherService: { dispatchMobileTest: jest.fn() },
}));

jest.mock('@/services/testing/regression/web-test-request-builder.service', () => ({
  WebTestRequestBuilderService: { buildTestRequest: jest.fn() },
}));

jest.mock('@/services/testing/regression/regression-report-assembler.service', () => ({
  getProjectWorkspaceMemberIds: jest.fn(),
}));

jest.mock('@/services/testing/executions/execution.service', () => ({
  ExecutionService: { updateStatus: jest.fn() },
}));

jest.mock('@/services/testing/executions/execution-completion-emitter', () => ({
  executionCompletionEmitter: { waitForCompletion: jest.fn() },
}));

jest.mock('@/services/testing/ui/manualTest.service', () => ({
  ManualTestService: { runTest: jest.fn() },
}));

jest.mock('@/services/api/api-config.service', () => ({
  ApiConfigService: { executeWithConfig: jest.fn() },
}));

jest.mock('@/services/core/credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductCreditsForTest: jest.fn() },
}));

jest.mock('@/services/core/token-calculator.service', () => ({
  TokenCalculatorService: { getTestCreditCost: jest.fn(() => 1) },
}));

jest.mock('@/services/core/user-credits.service', () => ({
  UserCreditsService: { addCredits: jest.fn() },
}));

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitRegressionRunProgress: jest.fn() },
}));

jest.mock('@/config/infrastructure/queues', () => ({
  QueueManager: {},
  mobileTestRunQueue: { getJob: jest.fn() },
  mobileTestRunQueueEvents: {},
}));

jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: jest.fn(() => ({})),
}));

jest.mock('@/config/features/regression-scheduling', () => ({
  isRegressionLevelBarrierDisabled: jest.fn(),
}));

import {
  getRunRoutingInfo,
  getExecutionRefsForRun,
  getFastAuthByExecIds,
  updateRunById,
  updateRunByIdIfActive,
} from '@/services/testing/regression/db/regression-run.db';
import { RegressionTestQueryService } from '@/services/testing/regression/db/regression-test-query.db';
import { decideMaxMobileInFlight } from '@/services/testing/regression/concurrency-decision';
import { MobileTestDispatcherService } from '@/services/testing/regression/mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from '@/services/testing/regression/web-test-request-builder.service';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { executionCompletionEmitter } from '@/services/testing/executions/execution-completion-emitter';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { ApiConfigService } from '@/services/api/api-config.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { mobileTestRunQueue } from '@/config/infrastructure/queues';
import { isRegressionLevelBarrierDisabled } from '@/config/features/regression-scheduling';
import { TestExecutionOrchestratorService } from '@/services/testing/regression/test-execution-orchestrator.service';
import type { ExecutableTestCase } from '@/types/testing.types';

const mockGetRouting = getRunRoutingInfo as jest.MockedFunction<typeof getRunRoutingInfo>;
const mockGetExecRefs = getExecutionRefsForRun as jest.MockedFunction<typeof getExecutionRefsForRun>;
const mockGetFastAuth = getFastAuthByExecIds as jest.MockedFunction<typeof getFastAuthByExecIds>;
const mockUpdateRun = updateRunById as jest.MockedFunction<typeof updateRunById>;
const mockUpdateRunIfActive = updateRunByIdIfActive as jest.MockedFunction<typeof updateRunByIdIfActive>;
const mockGetSavedCase = RegressionTestQueryService.getSavedTestCase as jest.MockedFunction<any>;
const mockDecideCap = decideMaxMobileInFlight as jest.MockedFunction<typeof decideMaxMobileInFlight>;
const mockDispatchMobile = MobileTestDispatcherService.dispatchMobileTest as jest.MockedFunction<any>;
const mockBuildWebReq = WebTestRequestBuilderService.buildTestRequest as jest.MockedFunction<any>;
const mockUpdateStatus = ExecutionService.updateStatus as jest.MockedFunction<any>;
const mockWaitForCompletion = executionCompletionEmitter.waitForCompletion as jest.MockedFunction<any>;
const mockRunTest = ManualTestService.runTest as jest.MockedFunction<any>;
const mockExecuteApi = ApiConfigService.executeWithConfig as jest.MockedFunction<any>;
const mockDeductCredits = CreditCostTrackerService.deductCreditsForTest as jest.MockedFunction<any>;
const mockGetJob = mobileTestRunQueue.getJob as jest.MockedFunction<any>;
const mockBarrierDisabled = isRegressionLevelBarrierDisabled as jest.MockedFunction<typeof isRegressionLevelBarrierDisabled>;

function apiTC(over: Partial<ExecutableTestCase> = {}): ExecutableTestCase {
  return { testCaseId: 'api-1', testType: 'api', dependsOn: [], ...over } as ExecutableTestCase;
}
function uiTC(over: Partial<ExecutableTestCase> = {}): ExecutableTestCase {
  return { testCaseId: 'ui-1', testType: 'ui', dependsOn: [], ...over } as ExecutableTestCase;
}

const RUN = 'run-1';
const USER = 'user-1';

async function run(testCases: ExecutableTestCase[], opts?: { failFast?: boolean }) {
  return TestExecutionOrchestratorService.executeTestCasesAsync(
    RUN, testCases, USER, 'manual', {}, undefined, undefined, opts?.failFast ?? false,
  );
}

describe('TestExecutionOrchestratorService.executeTestCasesAsync', () => {
  beforeEach(() => {
    // owner-only progress (project_id null skips workspace-member resolution)
    mockGetRouting.mockResolvedValue({ plan_id: null, project_id: null, user_id: USER });
    mockGetFastAuth.mockResolvedValue([]);
    mockUpdateRun.mockResolvedValue({ error: null });
    mockUpdateRunIfActive.mockResolvedValue({ error: null });
    mockUpdateStatus.mockResolvedValue(undefined);
    mockDecideCap.mockResolvedValue({ cap: 1, reason: 'test', inputs: {} } as any);
    mockDeductCredits.mockResolvedValue({ success: true });
    mockGetJob.mockResolvedValue(null);
    mockWaitForCompletion.mockResolvedValue('passed');
    // Barrier ON by default (matches prod default); individual tests opt in to OFF.
    mockBarrierDisabled.mockReturnValue(false);
  });

  afterEach(() => jest.clearAllMocks());

  it('finalizes the run as failed (if-active) and bails when execution preload errors', async () => {
    mockGetExecRefs.mockResolvedValue({ rows: [], error: { message: 'db down' } });

    await run([apiTC()]);

    expect(mockUpdateRunIfActive).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateRunIfActive.mock.calls[0];
    expect(patch.status).toBe('failed');
    // never reached dispatch / finalize
    expect(mockExecuteApi).not.toHaveBeenCalled();
    expect(mockUpdateRun).not.toHaveBeenCalled();
  });

  it('finalizes an all-API run as completed with correct counts', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [{ id: 'e1', test_case_id: 'api-1', test_type: 'api' }],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec-1', status_code: 200 });

    await run([apiTC()]);

    expect(mockUpdateRun).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateRun.mock.calls[0];
    expect(patch.status).toBe('completed');
    expect((patch.summary as any).passed).toBe(1);
    expect((patch.summary as any).failed).toBe(0);
  });

  it('finalizes an all-API run as failed when an API test fails', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [{ id: 'e1', test_case_id: 'api-1', test_type: 'api' }],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: false, error_message: 'boom' });

    await run([apiTC()]);

    const [, patch] = mockUpdateRun.mock.calls[0];
    expect(patch.status).toBe('failed');
    expect((patch.summary as any).failed).toBe(1);
  });

  it('fail-fast stops dispatch, marks remaining skipped, finalizes failed', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-1', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-2', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: false, error_message: 'boom' });

    await run([apiTC({ testCaseId: 'api-1' }), apiTC({ testCaseId: 'api-2' })], { failFast: true });

    // only the first test was executed before fail-fast tripped
    expect(mockExecuteApi).toHaveBeenCalledTimes(1);
    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect(finalize.status).toBe('failed');
    expect((finalize.summary as any).failFastTriggered).toBe(true);
  });

  it('routes web UI tests through the web builder, not the mobile dispatcher', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [{ id: 'e1', test_case_id: 'ui-1', test_type: 'ui' }],
      error: null,
    });
    mockGetSavedCase.mockResolvedValue({ platform: 'web' });
    mockBuildWebReq.mockResolvedValue({});
    mockRunTest.mockResolvedValue({ success: true, data: { id: 'test-web-1' } });

    await run([uiTC()]);

    expect(mockBuildWebReq).toHaveBeenCalledTimes(1);
    expect(mockRunTest).toHaveBeenCalledTimes(1);
    expect(mockDispatchMobile).not.toHaveBeenCalled();
    // UI runs defer finalize: the run is patched with the dispatched test_ids
    const linkCall = mockUpdateRun.mock.calls.find((c) => Array.isArray((c[1] as any).test_ids));
    expect(linkCall).toBeTruthy();
    expect((linkCall![1] as any).test_ids).toEqual(['test-web-1']);
  });

  it('routes mobile UI tests through the mobile dispatcher, not the web builder', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [{ id: 'e1', test_case_id: 'ui-1', test_type: 'ui' }],
      error: null,
    });
    mockGetSavedCase.mockResolvedValue({ platform: 'mobile_android' });
    mockDispatchMobile.mockResolvedValue({ testId: 'test-mob-1', jobId: 'job-1', appBuildId: null });

    await run([uiTC()]);

    expect(mockDispatchMobile).toHaveBeenCalledTimes(1);
    expect(mockBuildWebReq).not.toHaveBeenCalled();
  });

  it('fails a UI test case with a clear message instead of dispatching when it has an unresolved cross-platform Link Test Case step', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [{ id: 'e1', test_case_id: 'ui-1', test_type: 'ui' }],
      error: null,
    });
    mockGetSavedCase.mockResolvedValue({
      platform: 'mobile_android',
      steps_json: [
        {
          id: 's1',
          type: 'link_test_case',
          options: {
            linkTestCase: {
              linkedTestCaseId: 'other-tc',
              linkedPlatform: 'web',
              inputBindings: [],
              outputBindings: [],
            },
          },
        },
      ],
    });

    await run([uiTC()]);

    // Never reaches the runner/Playwright with the unresolved marker still
    // in steps_json — this orchestrator's per-execution tracking (one
    // testId per execId) doesn't support the segmented dispatch chain a
    // cross-platform link requires (see RegressionRunService.dispatchFirstSegmentAndDetachRest).
    expect(mockDispatchMobile).not.toHaveBeenCalled();
    expect(mockBuildWebReq).not.toHaveBeenCalled();

    const call = mockUpdateStatus.mock.calls.find((c: any[]) => c[0].id === 'e1');
    expect(call![0].status).toBe('failed');
    expect(call![0].errorMessage).toContain('cross-platform Link Test Case step');

    // Regression: when this rejected case is the run's ONLY test case,
    // `uiTestIds` stays empty (never dispatched) and it isn't an API test
    // either, so the "only API tests exist" finalize branch used to compute
    // hasFails from `apiFailed` alone (0) and persist a false 'completed'
    // with a 0/0/0 summary — even though the run's one test case never ran.
    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect(finalize.status).toBe('failed');
    expect((finalize.summary as any).failed).toBe(1);
  });

  it('does not trip fail-fast on the unresolved cross-platform Link Test Case rejection, letting unrelated tests in the batch still dispatch', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'ui-1', test_type: 'ui' },
        { id: 'e2', test_case_id: 'api-1', test_type: 'api' },
      ],
      error: null,
    });
    mockGetSavedCase.mockResolvedValue({
      platform: 'mobile_android',
      steps_json: [
        {
          id: 's1',
          type: 'link_test_case',
          options: {
            linkTestCase: {
              linkedTestCaseId: 'other-tc',
              linkedPlatform: 'web',
              inputBindings: [],
              outputBindings: [],
            },
          },
        },
      ],
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec-1', status_code: 200 });

    // ui-1 (validation-rejected) is dispatched before the unrelated api-1 —
    // same level, stable priority order preserves input order.
    await run([uiTC({ testCaseId: 'ui-1' }), apiTC({ testCaseId: 'api-1' })], { failFast: true });

    // the unrelated api test still ran: a ValidationError must not trip fail-fast
    expect(mockExecuteApi).toHaveBeenCalledTimes(1);
    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect((finalize.summary as any).failFastTriggered).not.toBe(true);
    // Regression: the run overall must still reflect that ui-1 never ran —
    // not tripping fail-fast (so api-1 still dispatches) is a different
    // decision from "the run's aggregate outcome ignores the rejection".
    expect(finalize.status).toBe('failed');
    expect((finalize.summary as any).passed).toBe(1);
    expect((finalize.summary as any).failed).toBe(1);

    const call = mockUpdateStatus.mock.calls.find((c: any[]) => c[0].id === 'e1');
    expect(call![0].status).toBe('failed');
    expect(call![0].errorMessage).toContain('cross-platform Link Test Case step');
  });

  // Empirical check for a code-review finding: does a validation-rejected UI
  // test case's rejection survive when paired with a SECOND UI test case that
  // dispatches successfully (uiTestIds.length > 0 branch — deferred
  // finalization via recomputeRunStatus), not just when paired with an API
  // test case (the immediate-finalize branch, already covered above)?
  it('marks the execution row failed for a validation-rejected UI case even when a sibling UI case dispatches', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'ui-1', test_type: 'ui' },
        { id: 'e2', test_case_id: 'ui-2', test_type: 'ui' },
      ],
      error: null,
    });
    mockGetSavedCase.mockImplementation(async (testCaseId: string) => {
      if (testCaseId === 'ui-1') {
        return {
          platform: 'mobile_android',
          steps_json: [{
            id: 's1',
            type: 'link_test_case',
            options: { linkTestCase: { linkedTestCaseId: 'other-tc', linkedPlatform: 'web', inputBindings: [], outputBindings: [] } },
          }],
        };
      }
      return { platform: 'web' };
    });
    mockBuildWebReq.mockResolvedValue({});
    mockRunTest.mockResolvedValue({ success: true, data: { id: 'test-web-2' } });

    await run([uiTC({ testCaseId: 'ui-1' }), uiTC({ testCaseId: 'ui-2' })]);

    // ui-2 dispatched: this run defers finalization to recomputeRunStatus
    // rather than finalizing synchronously (matches "routes web UI tests..."
    // behavior above) — confirmed by checking test_ids was linked, not a
    // terminal status written here.
    const linkCall = mockUpdateRun.mock.calls.find((c) => Array.isArray((c[1] as any).test_ids));
    expect(linkCall).toBeTruthy();

    // The regression-under-test: does ui-1's execution row still get marked
    // failed here, so recomputeRunStatus's later test_executions-based
    // aggregation (which has no other way to learn about the rejection) sees
    // it as a real failure instead of the row staying stuck 'running'/absent?
    const call = mockUpdateStatus.mock.calls.find((c: any[]) => c[0].id === 'e1');
    expect(call).toBeTruthy();
    expect(call![0].status).toBe('failed');
  });

  it('still trips fail-fast on a genuine dispatch exception (not a ValidationError)', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'ui-1', test_type: 'ui' },
        { id: 'e2', test_case_id: 'api-1', test_type: 'api' },
      ],
      error: null,
    });
    mockGetSavedCase.mockRejectedValue(new Error('db unreachable'));
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec-1', status_code: 200 });

    await run([uiTC({ testCaseId: 'ui-1' }), apiTC({ testCaseId: 'api-1' })], { failFast: true });

    // fail-fast tripped on ui-1's crash — api-1 never dispatched
    expect(mockExecuteApi).not.toHaveBeenCalled();
    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect((finalize.summary as any).failFastTriggered).toBe(true);
  });

  it('surfaces out-of-run dependencies in the run summary instead of swallowing them', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [{ id: 'e1', test_case_id: 'api-1', test_type: 'api' }],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec-1', status_code: 200 });

    // api-1 depends on a test case that is NOT part of this run
    await run([apiTC({ dependsOn: ['outside-the-run'] })]);

    // the external dep must not block dispatch
    expect(mockExecuteApi).toHaveBeenCalledTimes(1);
    const [, patch] = mockUpdateRun.mock.calls.at(-1)!;
    expect((patch.summary as any).missingDependencies).toEqual([
      { testCaseId: 'api-1', missingDependencyIds: ['outside-the-run'] },
    ]);
  });

  it('fails cycle members but skips tests merely blocked by the cycle', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-1', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-2', test_type: 'api' },
        { id: 'e3', test_case_id: 'api-3', test_type: 'api' },
      ],
      error: null,
    });

    // api-1 ↔ api-2 cycle; api-3 depends on api-2 but is not in the cycle
    await run([
      apiTC({ testCaseId: 'api-1', dependsOn: ['api-2'] }),
      apiTC({ testCaseId: 'api-2', dependsOn: ['api-1'] }),
      apiTC({ testCaseId: 'api-3', dependsOn: ['api-2'] }),
    ]);

    expect(mockExecuteApi).not.toHaveBeenCalled();
    const statusByExec = new Map<string, any>(
      mockUpdateStatus.mock.calls.map((c: any[]) => [c[0].id, c[0]]),
    );
    expect(statusByExec.get('e1')!.status).toBe('failed');
    expect(statusByExec.get('e2')!.status).toBe('failed');
    expect(statusByExec.get('e3')!.status).toBe('skipped');
    expect(statusByExec.get('e3')!.errorMessage).toContain('circular dependency chain');
  });

  it('dispatches critical tests before low-priority ones within the same level', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-low', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-crit', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec', status_code: 200 });

    // input order is low-first; dispatch order must be critical-first
    await run([
      apiTC({ testCaseId: 'api-low', priority: 'low' }),
      apiTC({ testCaseId: 'api-crit', priority: 'critical' }),
    ]);

    const dispatched = mockExecuteApi.mock.calls.map((c: any[]) => c[1].test_config_id);
    expect(dispatched).toEqual(['api-crit', 'api-low']);
  });

  it('priority never overrides dependency order: a critical dependent still waits for its low-priority parent', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-parent', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-child', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec', status_code: 200 });

    await run([
      apiTC({ testCaseId: 'api-child', priority: 'critical', dependsOn: ['api-parent'] }),
      apiTC({ testCaseId: 'api-parent', priority: 'low' }),
    ]);

    const dispatched = mockExecuteApi.mock.calls.map((c: any[]) => c[1].test_config_id);
    expect(dispatched).toEqual(['api-parent', 'api-child']);
  });

  it('cascades skips down a dependency chain when the root test fails', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-1', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-2', test_type: 'api' },
        { id: 'e3', test_case_id: 'api-3', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: false, error_message: 'root failed' });

    // chain: api-1 ← api-2 ← api-3
    await run([
      apiTC({ testCaseId: 'api-1' }),
      apiTC({ testCaseId: 'api-2', dependsOn: ['api-1'] }),
      apiTC({ testCaseId: 'api-3', dependsOn: ['api-2'] }),
    ]);

    // only the root was actually executed
    expect(mockExecuteApi).toHaveBeenCalledTimes(1);
    const skips = mockUpdateStatus.mock.calls
      .map((c: any[]) => c[0])
      .filter((p: any) => p.status === 'skipped');
    expect(skips.map((p: any) => p.id).sort()).toEqual(['e2', 'e3']);
    skips.forEach((p: any) => expect(p.errorMessage).toContain('prerequisite'));

    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect(finalize.status).toBe('failed');
    expect((finalize.summary as any).skipped).toBe(2);
  });

  it('omits missingDependencies from the summary when all dependencies are in-run', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-1', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-2', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec', status_code: 200 });

    await run([apiTC({ testCaseId: 'api-1' }), apiTC({ testCaseId: 'api-2', dependsOn: ['api-1'] })]);

    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect((finalize.summary as any).missingDependencies).toBeUndefined();
  });

  it('reports only the out-of-run portion of a mixed dependency list and still honors the in-run part', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-1', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-2', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: true, id: 'apiexec', status_code: 200 });

    // api-2 depends on api-1 (in run) AND ghost-1 (absent)
    await run([
      apiTC({ testCaseId: 'api-1' }),
      apiTC({ testCaseId: 'api-2', dependsOn: ['api-1', 'ghost-1'] }),
    ]);

    // in-run dependency still ordered: parent dispatched before child
    const dispatched = mockExecuteApi.mock.calls.map((c: any[]) => c[1].test_config_id);
    expect(dispatched).toEqual(['api-1', 'api-2']);

    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect((finalize.summary as any).missingDependencies).toEqual([
      { testCaseId: 'api-2', missingDependencyIds: ['ghost-1'] },
    ]);
  });

  it('carries missingDependencies into the fail-fast finalize summary', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'api-1', test_type: 'api' },
        { id: 'e2', test_case_id: 'api-2', test_type: 'api' },
      ],
      error: null,
    });
    mockExecuteApi.mockResolvedValue({ success: false, error_message: 'boom' });

    await run(
      [apiTC({ testCaseId: 'api-1', dependsOn: ['ghost-1'] }), apiTC({ testCaseId: 'api-2' })],
      { failFast: true },
    );

    const finalize = mockUpdateRun.mock.calls.at(-1)![1];
    expect((finalize.summary as any).failFastTriggered).toBe(true);
    expect((finalize.summary as any).missingDependencies).toEqual([
      { testCaseId: 'api-1', missingDependencyIds: ['ghost-1'] },
    ]);
  });

  it('with the level barrier disabled, dependent UI tests dispatch alongside their dependency (no serialization)', async () => {
    mockBarrierDisabled.mockReturnValue(true);
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'ui-1', test_type: 'ui' },
        { id: 'e2', test_case_id: 'ui-2', test_type: 'ui' },
        { id: 'e3', test_case_id: 'ui-3', test_type: 'ui' },
      ],
      error: null,
    });
    mockGetSavedCase.mockResolvedValue({ platform: 'web' });
    mockBuildWebReq.mockResolvedValue({});
    let n = 0;
    mockRunTest.mockImplementation(async () => ({ success: true, data: { id: `test-${++n}` } }));

    // chain ui-1 ← ui-2 ← ui-3 collapses into one level → all three dispatched
    await run([
      uiTC({ testCaseId: 'ui-1' }),
      uiTC({ testCaseId: 'ui-2', dependsOn: ['ui-1'] }),
      uiTC({ testCaseId: 'ui-3', dependsOn: ['ui-2'] }),
    ]);

    expect(mockRunTest).toHaveBeenCalledTimes(3);
    expect(mockUpdateStatus.mock.calls.some((c: any[]) => c[0].status === 'skipped')).toBe(false);
  });

  it('with the barrier ON (default), a failed root UI test skips its dependents instead of dispatching them', async () => {
    mockGetExecRefs.mockResolvedValue({
      rows: [
        { id: 'e1', test_case_id: 'ui-1', test_type: 'ui' },
        { id: 'e2', test_case_id: 'ui-2', test_type: 'ui' },
        { id: 'e3', test_case_id: 'ui-3', test_type: 'ui' },
      ],
      error: null,
    });
    mockGetSavedCase.mockResolvedValue({ platform: 'web' });
    mockBuildWebReq.mockResolvedValue({});
    mockRunTest.mockResolvedValue({ success: true, data: { id: 'test-web-1' } });
    mockWaitForCompletion.mockResolvedValue('failed'); // root (level 0) fails

    await run([
      uiTC({ testCaseId: 'ui-1' }),
      uiTC({ testCaseId: 'ui-2', dependsOn: ['ui-1'] }),
      uiTC({ testCaseId: 'ui-3', dependsOn: ['ui-2'] }),
    ]);

    // only the root was dispatched; dependents were skipped, not run
    expect(mockRunTest).toHaveBeenCalledTimes(1);
    const skipped = mockUpdateStatus.mock.calls
      .map((c: any[]) => c[0])
      .filter((p: any) => p.status === 'skipped');
    expect(skipped.map((p: any) => p.id).sort()).toEqual(['e2', 'e3']);
  });
});
