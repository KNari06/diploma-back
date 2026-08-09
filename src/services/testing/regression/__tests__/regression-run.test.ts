/**
 * Tests for RegressionRunService — run creation and routing. Untestable
 * until its regression_runs + test-case-resolution queries moved behind the
 * `db/` sublayer. DB is stubbed at the `db/` boundary; collaborators (executors,
 * dispatchers, credits, orchestrator) are stubbed. No Supabase mocked directly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/services/testing/regression/db/regression-run.db', () => ({
  insertRun: jest.fn(),
  updateRunById: jest.fn(),
  listRunsByProject: jest.fn(),
  getRunExecutionStatsRows: jest.fn(),
}));

jest.mock('@/services/testing/regression/db/regression-test-query.db', () => ({
  RegressionTestQueryService: {
    getSavedTestCase: jest.fn(),
    getUiStepCountRows: jest.fn(),
    getUiTestCasesByPriority: jest.fn(),
    getApiTestConfigsByProjectAndPriority: jest.fn(),
  },
}));

jest.mock('@/services/testing/regression/db/regression.db', () => ({
  getProjectForAccess: jest.fn(),
}));

jest.mock('@/services/core/credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { checkCreditsForTest: jest.fn() },
}));

jest.mock('@/services/core/token-calculator.service', () => ({
  TokenCalculatorService: { getTestCreditCost: jest.fn(() => 1) },
}));

jest.mock('@/jobs/ai-analysis.job', () => ({ BUG_REPORT_CREDITS: 5 }));

jest.mock('@/services/core/workspace-access.service', () => ({
  WorkspaceAccessService: { getRole: jest.fn() },
}));

jest.mock('@/services/storage/mobile-app-storage.service', () => ({
  MobileAppStorageService: { getBuildById: jest.fn() },
}));

jest.mock('@/utils/core/redis-cache', () => ({ cache: { delByPattern: jest.fn() } }));

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitRegressionRunProgress: jest.fn() },
}));

jest.mock('@/services/testing/executions/execution.service', () => ({
  ExecutionService: { createBatch: jest.fn() },
}));

jest.mock('@/services/testing/plans/regression-plan.service', () => ({
  RegressionPlanService: { getById: jest.fn(), expandPlan: jest.fn(), getItems: jest.fn() },
}));

jest.mock('@/services/testing/ui/manualTest.service', () => ({
  ManualTestService: { runTest: jest.fn() },
}));

jest.mock('@/services/testing/ui/preview/intent-test-case.service', () => ({
  IntentTestCaseService: { collectPreconditionSteps: jest.fn(async () => []) },
}));

jest.mock('@/services/testing/regression/regression-report-assembler.service', () => ({
  RegressionReportAssemblerService: {
    buildFullReport: jest.fn(),
    buildPublicReport: jest.fn(),
    batchGetTestResults: jest.fn(),
  },
  getProjectWorkspaceMemberIds: jest.fn(),
}));

jest.mock('@/services/testing/regression/mobile-test-dispatcher.service', () => ({
  MobileTestDispatcherService: { dispatchMobileTest: jest.fn() },
}));

jest.mock('@/services/testing/regression/web-test-request-builder.service', () => ({
  WebTestRequestBuilderService: { buildTestRequest: jest.fn() },
}));

jest.mock('@/services/testing/regression/test-execution-orchestrator.service', () => ({
  TestExecutionOrchestratorService: { executeTestCasesAsync: jest.fn() },
}));

import {
  insertRun,
  updateRunById,
} from '@/services/testing/regression/db/regression-run.db';
import { RegressionTestQueryService } from '@/services/testing/regression/db/regression-test-query.db';
import { getProjectForAccess } from '@/services/testing/regression/db/regression.db';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { MobileTestDispatcherService } from '@/services/testing/regression/mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from '@/services/testing/regression/web-test-request-builder.service';
import { TestExecutionOrchestratorService } from '@/services/testing/regression/test-execution-orchestrator.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { ValidationError, NotFoundError, InsufficientCreditsError } from '@/types';

const mockInsertRun = insertRun as jest.MockedFunction<typeof insertRun>;
const mockUpdateRun = updateRunById as jest.MockedFunction<typeof updateRunById>;
const mockGetSavedCase = RegressionTestQueryService.getSavedTestCase as jest.MockedFunction<any>;
const mockGetStepRows = RegressionTestQueryService.getUiStepCountRows as jest.MockedFunction<any>;
const mockGetByPriority = RegressionTestQueryService.getUiTestCasesByPriority as jest.MockedFunction<any>;
const mockGetApiByPriority = RegressionTestQueryService.getApiTestConfigsByProjectAndPriority as jest.MockedFunction<any>;
const mockGetProjectAccess = getProjectForAccess as jest.MockedFunction<typeof getProjectForAccess>;
const mockCheckCredits = CreditCostTrackerService.checkCreditsForTest as jest.MockedFunction<any>;
const mockCreateBatch = ExecutionService.createBatch as jest.MockedFunction<any>;
const mockRunTest = ManualTestService.runTest as jest.MockedFunction<any>;
const mockDispatchMobile = MobileTestDispatcherService.dispatchMobileTest as jest.MockedFunction<any>;
const mockBuildWebReq = WebTestRequestBuilderService.buildTestRequest as jest.MockedFunction<any>;
const mockExecuteAsync = TestExecutionOrchestratorService.executeTestCasesAsync as jest.MockedFunction<any>;

const USER = 'user-1';

describe('RegressionRunService.runSavedTestCase', () => {
  beforeEach(() => {
    mockGetStepRows.mockResolvedValue([]);
    mockCheckCredits.mockResolvedValue({ available: 1000, effectiveAvailable: 1000 });
    mockInsertRun.mockResolvedValue({ data: { id: 'run-1' }, error: null });
    mockUpdateRun.mockResolvedValue({ error: null });
  });
  afterEach(() => jest.clearAllMocks());

  it('creates a running run row with the intent_test_case_id and links the test_id (web)', async () => {
    mockGetSavedCase.mockResolvedValue({ project_id: 'proj-1', platform: 'web' });
    mockBuildWebReq.mockResolvedValue({});
    mockRunTest.mockResolvedValue({ success: true, data: { id: 'test-1' } });

    const result = await RegressionRunService.runSavedTestCase({
      savedTestCaseId: 'tc-1', userId: USER, trigger: 'manual',
    });

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({ intent_test_case_id: 'tc-1', project_id: 'proj-1', status: 'running' }),
    );
    expect(mockUpdateRun).toHaveBeenCalledWith('run-1', { test_id: 'test-1' });
    expect(mockDispatchMobile).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: 'run-1', testId: 'test-1' });
  });

  it('routes mobile test cases to the mobile dispatcher', async () => {
    mockGetSavedCase.mockResolvedValue({ project_id: 'proj-1', platform: 'mobile_android' });
    mockDispatchMobile.mockResolvedValue({ testId: 'test-m' });

    const result = await RegressionRunService.runSavedTestCase({
      savedTestCaseId: 'tc-1', userId: USER, trigger: 'manual',
    });

    expect(mockDispatchMobile).toHaveBeenCalledTimes(1);
    expect(mockBuildWebReq).not.toHaveBeenCalled();
    expect(result.testId).toBe('test-m');
  });

  it('marks the run failed and rethrows when dispatch fails', async () => {
    mockGetSavedCase.mockResolvedValue({ project_id: 'proj-1', platform: 'web' });
    mockBuildWebReq.mockResolvedValue({});
    mockRunTest.mockResolvedValue({ success: false });

    await expect(
      RegressionRunService.runSavedTestCase({ savedTestCaseId: 'tc-1', userId: USER, trigger: 'manual' }),
    ).rejects.toThrow();

    expect(mockUpdateRun).toHaveBeenCalledWith(
      'run-1', expect.objectContaining({ status: 'failed' }),
    );
  });
});

describe('RegressionRunService.runByPriority', () => {
  beforeEach(() => {
    mockGetProjectAccess.mockResolvedValue({ user_id: USER, workspace_id: null });
    mockGetStepRows.mockResolvedValue([]);
    mockCheckCredits.mockResolvedValue({ available: 1000, effectiveAvailable: 1000 });
    mockGetApiByPriority.mockResolvedValue([]);
    mockInsertRun.mockResolvedValue({ data: { id: 'run-1' }, error: null });
    mockCreateBatch.mockResolvedValue([{ id: 'e1' }]);
    mockExecuteAsync.mockResolvedValue(undefined);
  });
  afterEach(() => jest.clearAllMocks());

  it('throws NotFoundError when the project is not accessible', async () => {
    mockGetProjectAccess.mockResolvedValue(null);

    await expect(
      RegressionRunService.runByPriority({ projectId: 'proj-1', priority: 'high', userId: USER, trigger: 'manual' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ValidationError when no test cases match the priority', async () => {
    mockGetByPriority.mockResolvedValue([]);

    await expect(
      RegressionRunService.runByPriority({ projectId: 'proj-1', priority: 'high', userId: USER, trigger: 'manual' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('creates a running run and dispatches async execution', async () => {
    mockGetByPriority.mockResolvedValue([
      { id: 'tc-1', flow_id: null, depends_on: [], platform: 'web' },
    ]);

    const result = await RegressionRunService.runByPriority({
      projectId: 'proj-1', priority: 'high', userId: USER, trigger: 'manual',
    });

    expect(mockInsertRun).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'proj-1', status: 'running' }),
    );
    expect(mockExecuteAsync).toHaveBeenCalledTimes(1);
    expect(result.totalTests).toBe(1);
  });

  // The pre-flight gates on effectiveAvailable (balance + grace_limit), matching
  // the runtime per-step deduction. A grace-eligible user whose raw balance is
  // below the plan estimate but whose balance+grace covers it must NOT be
  // rejected up-front (would otherwise be a false "insufficient credits").
  it('passes pre-flight when grace headroom covers the estimate (available < required <= effectiveAvailable)', async () => {
    mockGetByPriority.mockResolvedValue([
      { id: 'tc-1', flow_id: null, depends_on: [], platform: 'web' },
    ]);
    // 9 steps + 1 initial goto = 10 step credits, + 1 UI case × 5 bug-report = 15 required
    mockGetStepRows.mockResolvedValue([
      { id: 'tc-1', steps_json: new Array(9).fill({}), setup_steps: [], teardown_steps: [] },
    ]);
    // Raw balance 0 would fail the old gate; grace lifts effectiveAvailable to 100.
    mockCheckCredits.mockResolvedValue({ available: 0, effectiveAvailable: 100 });

    const result = await RegressionRunService.runByPriority({
      projectId: 'proj-1', priority: 'high', userId: USER, trigger: 'manual',
    });

    expect(mockExecuteAsync).toHaveBeenCalledTimes(1);
    expect(result.totalTests).toBe(1);
  });

  it('throws InsufficientCreditsError when even grace headroom cannot cover the estimate', async () => {
    mockGetByPriority.mockResolvedValue([
      { id: 'tc-1', flow_id: null, depends_on: [], platform: 'web' },
    ]);
    // Same 15 required, but effectiveAvailable only 2.
    mockGetStepRows.mockResolvedValue([
      { id: 'tc-1', steps_json: new Array(9).fill({}), setup_steps: [], teardown_steps: [] },
    ]);
    mockCheckCredits.mockResolvedValue({ available: 2, effectiveAvailable: 2 });

    await expect(
      RegressionRunService.runByPriority({ projectId: 'proj-1', priority: 'high', userId: USER, trigger: 'manual' }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(mockExecuteAsync).not.toHaveBeenCalled();
  });

  // Regression guard: a link_test_case step is ONE entry in steps_json, but
  // inlines the ENTIRE linked test case at dispatch time. Before this fix the
  // pre-flight only ever saw "1 step" here and would have passed this exact
  // scenario (1 + 1 goto + 5 bug-report = 7 required, well under 10
  // available) — a user could get a green light and then run out of credits
  // mid-run once the linked case's 50 steps actually executed.
  it('expands a same-platform link_test_case step to the linked case\'s own step count before gating credits', async () => {
    mockGetByPriority.mockResolvedValue([
      { id: 'tc-1', flow_id: null, depends_on: [], platform: 'web' },
    ]);
    mockGetStepRows.mockImplementation(async (ids: string[]) => {
      if (ids.includes('tc-1')) {
        return [{
          id: 'tc-1',
          steps_json: [{
            id: 'link1',
            type: 'link_test_case',
            options: { linkTestCase: { linkedTestCaseId: 'linked-tc', linkedPlatform: 'web' } },
          }],
          setup_steps: [],
          teardown_steps: [],
        }];
      }
      if (ids.includes('linked-tc')) {
        return [{ id: 'linked-tc', steps_json: new Array(50).fill({}) }];
      }
      return [];
    });
    // Expanded: 50 linked steps + 1 goto = 51 UI step credits + 1 UI case ×
    // 5 bug-report = 56 required. effectiveAvailable 10 must NOT be enough.
    mockCheckCredits.mockResolvedValue({ available: 10, effectiveAvailable: 10 });

    await expect(
      RegressionRunService.runByPriority({ projectId: 'proj-1', priority: 'high', userId: USER, trigger: 'manual' }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    expect(mockExecuteAsync).not.toHaveBeenCalled();
    // proves the linked case's own row was actually fetched, not assumed
    expect(mockGetStepRows).toHaveBeenCalledWith(['linked-tc']);
  });
});
