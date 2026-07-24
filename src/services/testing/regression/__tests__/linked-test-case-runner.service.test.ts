import {
  LinkedTestCaseRunnerService,
  foldExecutedStepSnapshots,
  type ExecutedStepForVariableFold,
} from '../linked-test-case-runner.service';
import { MAX_LINKED_TEST_CASE_DEPTH } from '../link-resolution.service';
import { RegressionTestQueryService } from '../db/regression-test-query.db';
import { MobileTestDispatcherService } from '../mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from '../web-test-request-builder.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import * as linkResolutionDb from '../db/link-resolution.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { ValidationError } from '@/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../db/regression-test-query.db', () => ({
  RegressionTestQueryService: {
    getSavedTestCase: jest.fn(),
  },
}));

jest.mock('../mobile-test-dispatcher.service', () => ({
  MobileTestDispatcherService: {
    dispatchMobileTest: jest.fn(),
  },
}));

jest.mock('../web-test-request-builder.service', () => ({
  WebTestRequestBuilderService: {
    buildTestRequest: jest.fn(),
  },
}));

jest.mock('@/services/testing/ui/manualTest.service', () => ({
  ManualTestService: {
    runTest: jest.fn(),
  },
}));

jest.mock('../db/link-resolution.db', () => ({
  getTestStatusAndStepsById: jest.fn(),
}));

const mockGetSavedTestCase = RegressionTestQueryService.getSavedTestCase as jest.Mock;
const mockDispatchMobileTest = MobileTestDispatcherService.dispatchMobileTest as jest.Mock;
const mockBuildTestRequest = WebTestRequestBuilderService.buildTestRequest as jest.Mock;
const mockRunTest = ManualTestService.runTest as jest.Mock;
const mockGetTestStatusAndStepsById = linkResolutionDb.getTestStatusAndStepsById as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

const linkStep = (id: string, linkedTestCaseId: string, linkedPlatform: string, overrides: any = {}): IntentStep => ({
  id,
  type: 'link_test_case',
  description: id,
  options: { linkTestCase: { linkedTestCaseId, linkedPlatform: linkedPlatform as any, ...overrides } },
});

function baseParams(overrides: Partial<Parameters<typeof LinkedTestCaseRunnerService.run>[0]> = {}) {
  return {
    step: linkStep('link1', 'tc-1', 'web'),
    userId: 'user-1',
    trigger: 'manual' as const,
    parentVariableSources: [],
    depth: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LinkedTestCaseRunnerService.run', () => {
  it('throws when the step is not a valid link_test_case step', async () => {
    const step: IntentStep = { id: 's1', type: 'click', description: 'click' };
    await expect(
      LinkedTestCaseRunnerService.run(baseParams({ step })),
    ).rejects.toThrow(/not a valid link_test_case step/);
    expect(mockGetSavedTestCase).not.toHaveBeenCalled();
  });

  it('throws when depth exceeds MAX_LINKED_TEST_CASE_DEPTH', async () => {
    await expect(
      LinkedTestCaseRunnerService.run(baseParams({ depth: MAX_LINKED_TEST_CASE_DEPTH + 1 })),
    ).rejects.toThrow(/exceeds max depth/);
    expect(mockGetSavedTestCase).not.toHaveBeenCalled();
  });

  it('dispatches a web linked test case, polls to completion, and resolves outputBindings', async () => {
    mockGetSavedTestCase.mockResolvedValueOnce({
      id: 'tc-1',
      name: 'Web Linked Case',
      platform: 'web',
      steps_json: [{ id: 's1', type: 'fill', value: '{{link_input.p1}}', description: 'fill' }],
    });
    mockBuildTestRequest.mockResolvedValueOnce({ mocked: true });
    mockRunTest.mockResolvedValueOnce({ success: true, data: { id: 'nested-test-1' } });
    mockGetTestStatusAndStepsById.mockResolvedValue({
      data: { id: 'nested-test-1', status: 'completed', executed_steps: [{ runtimeMeta: { extractedDataSnapshot: { orderId: '12345' } } }] },
      error: null,
    });

    const step = linkStep('link1', 'tc-1', 'web', {
      inputBindings: [{ targetParam: 'p1', valueExpr: '{{extracted.val}}' }],
      outputBindings: [{ alias: 'out1', sourceVariable: 'orderId' }],
    });
    const parentVariableSources = [{ name: 'extracted', lookup: (key: string) => (key === 'extracted.val' ? 'hello' : undefined) }];

    const outcome = await LinkedTestCaseRunnerService.run(baseParams({ step, parentVariableSources }));

    expect(mockBuildTestRequest).toHaveBeenCalledTimes(1);
    const dispatchedCase = mockBuildTestRequest.mock.calls[0][0];
    expect(dispatchedCase.steps_json[0].value).toBe('hello');
    expect(mockDispatchMobileTest).not.toHaveBeenCalled();
    expect(outcome.outputs.get('out1')).toBe('12345');
  });

  it('dispatches a mobile linked test case when the linked case platform is mobile', async () => {
    mockGetSavedTestCase.mockResolvedValueOnce({
      id: 'tc-mobile',
      name: 'Mobile Linked Case',
      platform: 'mobile_android',
      steps_json: [{ id: 's1', type: 'tap', description: 'tap' }],
    });
    mockDispatchMobileTest.mockResolvedValueOnce({ testId: 'nested-mobile-1' });
    mockGetTestStatusAndStepsById.mockResolvedValue({
      data: { id: 'nested-mobile-1', status: 'completed', executed_steps: [{ runtimeMeta: { scratchpadSnapshot: { foo: 'bar' } } }] },
      error: null,
    });

    const step = linkStep('link1', 'tc-mobile', 'mobile_android');
    const outcome = await LinkedTestCaseRunnerService.run(baseParams({ step }));

    expect(mockDispatchMobileTest).toHaveBeenCalledTimes(1);
    expect(mockBuildTestRequest).not.toHaveBeenCalled();
    expect(outcome.outputs.size).toBe(0);
  });

  // Flutter host lane: getSavedTestCase loads the full row (`select('*')`), so a
  // linked case's `host_platform` must survive into the (host-aware) dispatcher.
  // Without it, a run-before dependency of an iOS-hosted Flutter case would
  // silently dispatch on android.
  it('preserves the linked case host_platform into the mobile dispatcher', async () => {
    mockGetSavedTestCase.mockResolvedValueOnce({
      id: 'tc-flutter-ios',
      name: 'Flutter iOS Linked Case',
      platform: 'mobile_flutter',
      host_platform: 'ios',
      steps_json: [{ id: 's1', type: 'tap', description: 'tap' }],
    });
    mockDispatchMobileTest.mockResolvedValueOnce({ testId: 'nested-flutter-1' });
    mockGetTestStatusAndStepsById.mockResolvedValue({
      data: { id: 'nested-flutter-1', status: 'completed', executed_steps: [] },
      error: null,
    });

    const step = linkStep('link1', 'tc-flutter-ios', 'mobile_flutter');
    await LinkedTestCaseRunnerService.run(baseParams({ step }));

    expect(mockDispatchMobileTest).toHaveBeenCalledTimes(1);
    const dispatchedCase = mockDispatchMobileTest.mock.calls[0][0];
    expect(dispatchedCase.host_platform).toBe('ios');
  });

  it('throws a ValidationError when the linked run ends in a failure status', async () => {
    mockGetSavedTestCase.mockResolvedValueOnce({
      id: 'tc-1',
      name: 'Web Linked Case',
      platform: 'web',
      steps_json: [{ id: 's1', type: 'fill', description: 'fill' }],
    });
    mockBuildTestRequest.mockResolvedValueOnce({});
    mockRunTest.mockResolvedValueOnce({ success: true, data: { id: 'nested-test-1' } });
    mockGetTestStatusAndStepsById.mockResolvedValue({
      data: { id: 'nested-test-1', status: 'failed', executed_steps: [] },
      error: null,
    });

    await expect(
      LinkedTestCaseRunnerService.run(baseParams()),
    ).rejects.toThrow(/did not complete successfully/);
  });

  // Regression test for the fix: a link_test_case step's LINKED test case
  // itself contains a cross-platform link_test_case step one level deep.
  // Before the fix, resolveSameProlatformLinks resolved same-platform links
  // in the linked case's own steps but never ran segmentByLinks on the
  // result, so a nested cross-platform marker survived and reached dispatch
  // unresolved instead of being rejected here.
  it('rejects cleanly when the linked test case itself contains a nested cross-platform link', async () => {
    mockGetSavedTestCase.mockResolvedValueOnce({
      id: 'tc-cross',
      name: 'Cross Nested Case',
      platform: 'web',
      steps_json: [
        { id: 's1', type: 'click', description: 'click' },
        linkStep('nested-link', 'tc-mobile-target', 'mobile_android'),
      ],
    });

    const step = linkStep('link1', 'tc-cross', 'web');
    await expect(
      LinkedTestCaseRunnerService.run(baseParams({ step })),
    ).rejects.toThrow(/Cross Nested Case.*cross-platform Link Test Case step/);

    expect(mockBuildTestRequest).not.toHaveBeenCalled();
    expect(mockDispatchMobileTest).not.toHaveBeenCalled();
  });

  // Contrast case: a nested SAME-platform link must keep working (inlined,
  // not rejected) — only a nested CROSS-platform link is unsupported.
  it('still dispatches when the linked test case contains a nested same-platform link', async () => {
    mockGetSavedTestCase.mockImplementation((id: string) => {
      if (id === 'tc-good') {
        return Promise.resolve({
          id: 'tc-good',
          name: 'Good Case',
          platform: 'web',
          steps_json: [linkStep('nested-link2', 'tc-good-inner', 'web')],
        });
      }
      if (id === 'tc-good-inner') {
        return Promise.resolve({
          id: 'tc-good-inner',
          name: 'Good Inner Case',
          platform: 'web',
          steps_json: [{ id: 'inner-step', type: 'click', description: 'inner click' }],
        });
      }
      throw new Error(`unexpected id ${id}`);
    });
    mockBuildTestRequest.mockResolvedValueOnce({});
    mockRunTest.mockResolvedValueOnce({ success: true, data: { id: 'nested-test-1' } });
    mockGetTestStatusAndStepsById.mockResolvedValue({
      data: { id: 'nested-test-1', status: 'completed', executed_steps: [] },
      error: null,
    });

    const step = linkStep('link1', 'tc-good', 'web');
    await expect(LinkedTestCaseRunnerService.run(baseParams({ step }))).resolves.toBeDefined();

    expect(mockBuildTestRequest).toHaveBeenCalledTimes(1);
    const dispatchedCase = mockBuildTestRequest.mock.calls[0][0];
    expect(dispatchedCase.steps_json.some((s: IntentStep) => s.type === 'link_test_case')).toBe(false);
  });

  // Review bug #1: redaction silently corrupting outputBinding values.
  // `readFinalVariables` only ever sees the ALREADY-redacted persisted
  // snapshot (command-executor.ts / mobile-test-run.job.ts mask
  // {{secrets.*}}-derived values to '***' before persisting — Hard
  // invariant #10). Before the fix, an outputBinding sourcing such a key
  // silently resolved to the literal '***' with no error. It must now fail
  // loudly instead.
  describe('outputBinding secrets enforcement', () => {
    it('throws a ValidationError instead of silently resolving a redacted output value', async () => {
      // mockResolvedValue (not -Once): this test calls run() twice below, and
      // a prior test in this file leaves a lingering mockImplementation on
      // mockGetSavedTestCase (jest.clearAllMocks() doesn't clear
      // implementations) — a plain base mock here guards both calls.
      mockGetSavedTestCase.mockResolvedValue({
        id: 'tc-1',
        name: 'Web Linked Case',
        platform: 'web',
        steps_json: [{ id: 's1', type: 'fill', description: 'fill' }],
      });
      mockBuildTestRequest.mockResolvedValue({});
      mockRunTest.mockResolvedValue({ success: true, data: { id: 'nested-test-1' } });
      mockGetTestStatusAndStepsById.mockResolvedValue({
        data: {
          id: 'nested-test-1',
          status: 'completed',
          executed_steps: [
            {
              runtimeMeta: {
                extractedDataSnapshot: { apiToken: '***' },
                redactedSnapshotKeys: ['apiToken'],
              },
            },
          ],
        },
        error: null,
      });

      const step = linkStep('link1', 'tc-1', 'web', {
        outputBindings: [{ alias: 'token', sourceVariable: 'apiToken' }],
      });

      await expect(LinkedTestCaseRunnerService.run(baseParams({ step }))).rejects.toThrow(ValidationError);
      await expect(LinkedTestCaseRunnerService.run(baseParams({ step }))).rejects.toThrow(/secret/i);
    });

    it('resolves normally when the source variable was never redacted', async () => {
      mockGetSavedTestCase.mockResolvedValueOnce({
        id: 'tc-1',
        name: 'Web Linked Case',
        platform: 'web',
        steps_json: [{ id: 's1', type: 'fill', description: 'fill' }],
      });
      mockBuildTestRequest.mockResolvedValueOnce({});
      mockRunTest.mockResolvedValueOnce({ success: true, data: { id: 'nested-test-1' } });
      mockGetTestStatusAndStepsById.mockResolvedValue({
        data: {
          id: 'nested-test-1',
          status: 'completed',
          executed_steps: [{ runtimeMeta: { extractedDataSnapshot: { orderId: 'order-42' } } }],
        },
        error: null,
      });

      const step = linkStep('link1', 'tc-1', 'web', {
        outputBindings: [{ alias: 'order', sourceVariable: 'orderId' }],
      });

      const outcome = await LinkedTestCaseRunnerService.run(baseParams({ step }));
      expect(outcome.outputs.get('order')).toBe('order-42');
    });

    it('rejects on the redacted binding even when a sibling non-secret binding is present', async () => {
      mockGetSavedTestCase.mockResolvedValueOnce({
        id: 'tc-1',
        name: 'Web Linked Case',
        platform: 'web',
        steps_json: [{ id: 's1', type: 'fill', description: 'fill' }],
      });
      mockBuildTestRequest.mockResolvedValueOnce({});
      mockRunTest.mockResolvedValueOnce({ success: true, data: { id: 'nested-test-1' } });
      mockGetTestStatusAndStepsById.mockResolvedValue({
        data: {
          id: 'nested-test-1',
          status: 'completed',
          executed_steps: [
            {
              runtimeMeta: {
                extractedDataSnapshot: { apiToken: '***', orderId: 'order-42' },
                redactedSnapshotKeys: ['apiToken'],
              },
            },
          ],
        },
        error: null,
      });

      const step = linkStep('link1', 'tc-1', 'web', {
        outputBindings: [
          { alias: 'token', sourceVariable: 'apiToken' },
          { alias: 'order', sourceVariable: 'orderId' },
        ],
      });

      await expect(LinkedTestCaseRunnerService.run(baseParams({ step }))).rejects.toThrow(ValidationError);
    });

    it('works for the mobile scratchpadSnapshot shape too', async () => {
      mockGetSavedTestCase.mockResolvedValueOnce({
        id: 'tc-mobile',
        name: 'Mobile Linked Case',
        platform: 'mobile_android',
        steps_json: [{ id: 's1', type: 'tap', description: 'tap' }],
      });
      mockDispatchMobileTest.mockResolvedValueOnce({ testId: 'nested-mobile-1' });
      mockGetTestStatusAndStepsById.mockResolvedValue({
        data: {
          id: 'nested-mobile-1',
          status: 'completed',
          executed_steps: [
            {
              runtimeMeta: {
                scratchpadSnapshot: { authToken: '***' },
                redactedSnapshotKeys: ['authToken'],
              },
            },
          ],
        },
        error: null,
      });

      const step = linkStep('link1', 'tc-mobile', 'mobile_android', {
        outputBindings: [{ alias: 'token', sourceVariable: 'authToken' }],
      });

      await expect(LinkedTestCaseRunnerService.run(baseParams({ step }))).rejects.toThrow(ValidationError);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// foldExecutedStepSnapshots — pure folding logic behind readFinalVariables,
// tested directly (no DB mocking needed).
// ─────────────────────────────────────────────────────────────────────────

describe('foldExecutedStepSnapshots', () => {
  it('returns empty variables/redactedKeys for no steps', () => {
    const { variables, redactedKeys } = foldExecutedStepSnapshots([]);
    expect(variables.size).toBe(0);
    expect(redactedKeys.size).toBe(0);
  });

  it('skips steps with no snapshot', () => {
    const steps: ExecutedStepForVariableFold[] = [{ runtimeMeta: {} }, {}];
    const { variables, redactedKeys } = foldExecutedStepSnapshots(steps);
    expect(variables.size).toBe(0);
    expect(redactedKeys.size).toBe(0);
  });

  it('folds a single scratchpadSnapshot (mobile shape)', () => {
    const steps: ExecutedStepForVariableFold[] = [
      { runtimeMeta: { scratchpadSnapshot: { orderId: 'abc123' } } },
    ];
    const { variables } = foldExecutedStepSnapshots(steps);
    expect(variables.get('orderId')).toBe('abc123');
  });

  it('folds a single extractedDataSnapshot (web shape)', () => {
    const steps: ExecutedStepForVariableFold[] = [
      { runtimeMeta: { extractedDataSnapshot: { orderId: 'xyz789' } } },
    ];
    const { variables } = foldExecutedStepSnapshots(steps);
    expect(variables.get('orderId')).toBe('xyz789');
  });

  it('last write wins across steps for the value', () => {
    const steps: ExecutedStepForVariableFold[] = [
      { runtimeMeta: { scratchpadSnapshot: { orderId: 'first' } } },
      { runtimeMeta: { scratchpadSnapshot: { orderId: 'second' } } },
    ];
    const { variables } = foldExecutedStepSnapshots(steps);
    expect(variables.get('orderId')).toBe('second');
  });

  it('marks a key redacted when its snapshot lists it in redactedSnapshotKeys', () => {
    const steps: ExecutedStepForVariableFold[] = [
      {
        runtimeMeta: {
          scratchpadSnapshot: { apiToken: '***' },
          redactedSnapshotKeys: ['apiToken'],
        },
      },
    ];
    const { variables, redactedKeys } = foldExecutedStepSnapshots(steps);
    expect(variables.get('apiToken')).toBe('***');
    expect(redactedKeys.has('apiToken')).toBe(true);
  });

  it('un-marks a key when a LATER step re-writes it with a non-secret value', () => {
    const steps: ExecutedStepForVariableFold[] = [
      {
        runtimeMeta: {
          scratchpadSnapshot: { token: '***' },
          redactedSnapshotKeys: ['token'],
        },
      },
      { runtimeMeta: { scratchpadSnapshot: { token: 'plain-value' } } },
    ];
    const { variables, redactedKeys } = foldExecutedStepSnapshots(steps);
    expect(variables.get('token')).toBe('plain-value');
    expect(redactedKeys.has('token')).toBe(false);
  });

  it('re-marks a key when a LATER step re-writes it with another secret', () => {
    const steps: ExecutedStepForVariableFold[] = [
      { runtimeMeta: { scratchpadSnapshot: { token: 'plain-value' } } },
      {
        runtimeMeta: {
          scratchpadSnapshot: { token: '***' },
          redactedSnapshotKeys: ['token'],
        },
      },
    ];
    const { variables, redactedKeys } = foldExecutedStepSnapshots(steps);
    expect(variables.get('token')).toBe('***');
    expect(redactedKeys.has('token')).toBe(true);
  });

  it('tracks independent keys across mixed steps correctly', () => {
    const steps: ExecutedStepForVariableFold[] = [
      {
        runtimeMeta: {
          scratchpadSnapshot: { secretVar: 'x', plainVar: 'y' },
          redactedSnapshotKeys: ['secretVar'],
        },
      },
    ];
    const { variables, redactedKeys } = foldExecutedStepSnapshots(steps);
    expect(variables.get('secretVar')).toBe('x');
    expect(variables.get('plainVar')).toBe('y');
    expect(redactedKeys.has('secretVar')).toBe(true);
    expect(redactedKeys.has('plainVar')).toBe(false);
  });
});
