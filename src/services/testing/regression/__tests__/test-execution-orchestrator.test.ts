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
});
