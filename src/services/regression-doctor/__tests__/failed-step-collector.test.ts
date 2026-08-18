/**
 * Unit tests for evidence collection, mocked at the `db/` boundary.
 *
 * Most of these encode a refusal. The collector's job is to hand the agent
 * failures it can actually reason about and to drop everything else loudly —
 * a finding pointed at the wrong step is worse than no finding.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

jest.mock('../db/regression-doctor.db');

import * as db from '../db/regression-doctor.db';
import { collectFailedSteps as collect } from '../failed-step-collector';

// The retry schedule is real wall-clock time in production; tests inject a
// no-op so the "trace never arrived" path costs nothing to prove.
const collectFailedSteps = (runId: string) => collect(runId, { sleep: async () => {} });

const mockDb = db as jest.Mocked<typeof db>;

const stepEvent = (over: {
  step: number;
  stepId?: string;
  success?: boolean;
  action?: string;
  screenshot?: string;
  explanation?: string;
}) => ({
  type: 'step_completed',
  data: {
    step: over.step,
    action: over.action ?? 'click',
    success: over.success ?? true,
    stepDescription: `step ${over.step}`,
    runtimeMeta: {
      stepId: over.stepId ?? `step-${over.step}`,
      runtimeStatus: over.success === false ? 'failed' : 'executed',
      failedReason: over.success === false ? 'element_not_found' : undefined,
      failureExplanation: over.explanation,
      stepScreenshotUrl: over.screenshot,
      scratchpadSnapshot: { current_app: 'com.example.app' },
    },
  },
});

const steps: IntentStep[] = [
  { id: 'step-1', type: 'click', description: 'first' } as IntentStep,
  { id: 'step-2', type: 'click', description: 'second' } as IntentStep,
  { id: 'step-3', type: 'ai_check', description: 'third' } as IntentStep,
];

const testRow = (over: Partial<db.TestRunRow> = {}): db.TestRunRow => ({
  id: 'test-1',
  status: 'failed',
  executed_steps: [
    stepEvent({ step: 1, stepId: 'step-1', screenshot: 'https://cdn/ok-1.webp' }),
    stepEvent({
      step: 2,
      stepId: 'step-2',
      success: false,
      screenshot: 'https://cdn/fail-2.webp',
      explanation: 'the entry is not on screen',
    }),
  ],
  ...over,
});

const testCaseRow = (over: Partial<db.TestCaseRow> = {}): db.TestCaseRow => ({
  id: 'tc-1',
  name: 'TC-32 FAQ search',
  platform: 'mobile_flutter',
  project_id: 'project-1',
  user_id: 'user-1',
  is_negative: false,
  steps_json: steps,
  updated_at: '2026-08-13T10:00:00Z',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.getFailedTestIdsForRun.mockResolvedValue([
    { testId: 'test-1', testCaseId: 'tc-1', status: 'failed', errorMessage: null },
  ]);
  mockDb.getTestsByIds.mockResolvedValue([testRow()]);
  mockDb.getTestCasesByIds.mockResolvedValue([testCaseRow()]);
  mockDb.getAiSummaries.mockResolvedValue(new Map());
  mockDb.getExecutedSteps.mockResolvedValue(null);
});

describe('evidence', () => {
  it('reports the first failing step with its authored counterpart', async () => {
    const { evidence } = await collectFailedSteps('run-1');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      testCaseId: 'tc-1',
      stepId: 'step-2',
      stepIndex: 1,
      platform: 'mobile_flutter',
      failedReason: 'element_not_found',
      failureExplanation: 'the entry is not on screen',
      failScreenshotUrl: 'https://cdn/fail-2.webp',
      currentApp: 'com.example.app',
    });
    expect(evidence[0].step.description).toBe('second');
  });

  it('carries the screenshot of the last step that succeeded', async () => {
    // "What it looked like a moment earlier" is often what distinguishes a
    // renamed control from a screen that never loaded.
    const { evidence } = await collectFailedSteps('run-1');
    expect(evidence[0].priorScreenshotUrl).toBe('https://cdn/ok-1.webp');
  });

  it('includes neighbouring steps for flow context', async () => {
    const { evidence } = await collectFailedSteps('run-1');
    expect(evidence[0].precedingSteps.map((s) => s.id)).toEqual(['step-1']);
    expect(evidence[0].followingStep?.id).toBe('step-3');
  });

  it('takes the FIRST failure, not the last — later steps fail downstream of it', async () => {
    mockDb.getTestsByIds.mockResolvedValue([
      testRow({
        executed_steps: [
          stepEvent({ step: 1, stepId: 'step-1', success: false }),
          stepEvent({ step: 2, stepId: 'step-2', success: false }),
        ],
      }),
    ]);
    const { evidence } = await collectFailedSteps('run-1');
    expect(evidence[0].stepId).toBe('step-1');
  });

  it('treats a failed runtimeStatus as a failure even when success is absent', async () => {
    mockDb.getTestsByIds.mockResolvedValue([
      testRow({
        executed_steps: [
          {
            type: 'step_completed',
            data: {
              step: 1,
              action: 'ai_check',
              stepDescription: 'third',
              runtimeMeta: { stepId: 'step-3', runtimeStatus: 'failed' },
            },
          },
        ],
      }),
    ]);
    const { evidence } = await collectFailedSteps('run-1');
    expect(evidence[0].stepId).toBe('step-3');
  });
});

describe('refusals', () => {
  const expectSkip = async (reason: string) => {
    const { evidence, skipped } = await collectFailedSteps('run-1');
    expect(evidence).toHaveLength(0);
    expect(skipped[0].reason).toBe(reason);
  };

  it('skips a run that produced no steps at all, keeping the setup error', async () => {
    // Died acquiring a session / installing the app — there is no step to fix.
    // The reason lives on `test_executions`; `tests` has no error column.
    mockDb.getFailedTestIdsForRun.mockResolvedValue([
      { testId: 'test-1', testCaseId: 'tc-1', status: 'failed', errorMessage: 'device busy' },
    ]);
    mockDb.getTestsByIds.mockResolvedValue([testRow({ executed_steps: [] })]);

    const { evidence, skipped } = await collectFailedSteps('run-1');

    expect(evidence).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: 'no_executed_steps', detail: 'device busy' });
  });

  it('skips a negative test case — it fails by design', async () => {
    mockDb.getTestCasesByIds.mockResolvedValue([testCaseRow({ is_negative: true })]);
    await expectSkip('negative_test');
  });

  it('skips an execution with no authored test case behind it', async () => {
    // `test_executions.test_case_id` is the only link between a run and the
    // authored case — `tests` carries no reference back to it.
    mockDb.getFailedTestIdsForRun.mockResolvedValue([
      { testId: 'test-1', testCaseId: null, status: 'failed', errorMessage: null },
    ]);
    await expectSkip('no_test_case');
  });

  it('skips an inlined precondition step — it belongs to another test case', async () => {
    mockDb.getTestsByIds.mockResolvedValue([
      testRow({
        executed_steps: [stepEvent({ step: 1, stepId: 'pre_tc-other_step-9', success: false })],
      }),
    ]);
    await expectSkip('injected_step');
  });

  it('skips a linked-test-case step — likewise not ours to patch', async () => {
    mockDb.getTestsByIds.mockResolvedValue([
      testRow({
        executed_steps: [stepEvent({ step: 1, stepId: 'link_tc-other_step-3', success: false })],
      }),
    ]);
    await expectSkip('injected_step');
  });

  it('skips a runtime step id that is not in the test case, rather than guessing by position', async () => {
    // Resource-prologue steps (login / install / permissions) land here.
    mockDb.getTestsByIds.mockResolvedValue([
      testRow({
        executed_steps: [stepEvent({ step: 1, stepId: 'runner-prologue-1', success: false })],
      }),
    ]);
    await expectSkip('step_not_in_test_case');
  });

  it('skips a trace where nothing is marked failed', async () => {
    mockDb.getTestsByIds.mockResolvedValue([
      testRow({ executed_steps: [stepEvent({ step: 1, stepId: 'step-1' })] }),
    ]);
    await expectSkip('no_failed_step');
  });

  it('skips a test case that was deleted after the run', async () => {
    mockDb.getTestCasesByIds.mockResolvedValue([]);
    await expectSkip('test_case_missing');
  });
});

describe('the finalize race', () => {
  it('re-reads a test whose trace has not landed yet', async () => {
    // The completion hook enqueues the job while the trace is still being
    // drained from Redis to Postgres.
    mockDb.getTestsByIds.mockResolvedValue([testRow({ executed_steps: [] })]);
    mockDb.getExecutedSteps.mockResolvedValue([
      stepEvent({ step: 2, stepId: 'step-2', success: false }),
    ]);

    const { evidence } = await collectFailedSteps('run-1');

    expect(mockDb.getExecutedSteps).toHaveBeenCalledWith('test-1');
    expect(evidence[0].stepId).toBe('step-2');
  });

  it('does not re-read tests whose trace is already there', async () => {
    await collectFailedSteps('run-1');
    expect(mockDb.getExecutedSteps).not.toHaveBeenCalled();
  });

  it('gives up gracefully when the trace never arrives', async () => {
    mockDb.getTestsByIds.mockResolvedValue([testRow({ executed_steps: [] })]);
    mockDb.getExecutedSteps.mockResolvedValue([]);

    const { evidence, skipped } = await collectFailedSteps('run-1');

    expect(evidence).toHaveLength(0);
    expect(skipped[0].reason).toBe('no_executed_steps');
  });
});

describe('batching', () => {
  it('loads test cases in one query, not one per test', async () => {
    mockDb.getFailedTestIdsForRun.mockResolvedValue([
      { testId: 'test-1', testCaseId: 'tc-1', status: 'failed', errorMessage: null },
      { testId: 'test-2', testCaseId: 'tc-2', status: 'failed', errorMessage: null },
    ]);
    mockDb.getTestsByIds.mockResolvedValue([testRow(), testRow({ id: 'test-2' })]);
    mockDb.getTestCasesByIds.mockResolvedValue([testCaseRow(), testCaseRow({ id: 'tc-2' })]);

    const { evidence } = await collectFailedSteps('run-1');

    expect(evidence).toHaveLength(2);
    expect(mockDb.getTestCasesByIds).toHaveBeenCalledTimes(1);
    expect(mockDb.getTestCasesByIds).toHaveBeenCalledWith(['tc-1', 'tc-2']);
  });
});

/**
 * A failed execution that never produced a `tests` row — a case saved with no
 * steps, or a validation error before dispatch — used to be filtered out inside
 * the query. It was then counted nowhere: not in the evidence, not in the
 * skips. Live on run 0f8bfe63 that hid 6 of 21 failures, so the report could
 * not reconcile its own numbers.
 */
describe('failures that never produced a test run', () => {
  it('accounts for an execution with no testId instead of dropping it', async () => {
    mockDb.getFailedTestIdsForRun.mockResolvedValue([
      { testId: '', testCaseId: 'tc-empty', status: 'failed', errorMessage: 'has no steps' },
    ]);

    const { evidence, skipped } = await collectFailedSteps('run-1');

    expect(evidence).toHaveLength(0);
    expect(skipped).toEqual([
      { testId: '', testCaseId: 'tc-empty', reason: 'no_test_run', detail: 'has no steps' },
    ]);
  });

  it('does not look up traces when every failure lacks a test run', async () => {
    mockDb.getFailedTestIdsForRun.mockResolvedValue([
      { testId: '', testCaseId: 'tc-a', status: 'failed', errorMessage: null },
      { testId: '', testCaseId: 'tc-b', status: 'failed', errorMessage: null },
    ]);

    const { skipped } = await collectFailedSteps('run-1');

    expect(skipped.map((s) => s.reason)).toEqual(['no_test_run', 'no_test_run']);
    expect(mockDb.getTestsByIds).not.toHaveBeenCalled();
  });
});
