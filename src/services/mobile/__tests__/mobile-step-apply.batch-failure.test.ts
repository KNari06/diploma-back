import { MobileStepApplyService } from '../mobile-step-apply.service';

jest.mock('../session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

const { getMobileRunnerClientForSession } = require('../session-runner-routing') as {
  getMobileRunnerClientForSession: jest.Mock;
};

/**
 * A failed command inside the runner batch must fail the STEP.
 *
 * CLAUDE.md Hard invariant #18: the runner signals a command failure only in
 * the response BODY — `executeBatch` turns a thrown handler into
 * `{ success: false, error }` and the route answers HTTP 200 either way. This
 * method already read `batch.results`, but only to harvest
 * `transitionDetected`; it never looked at `success`, and returned
 * `status: 'passed'` regardless.
 *
 * A `type` step is dispatched as [tap, type_text]. When the focus tap fails the
 * batch stops there and the type_text is never sent — so the author sees a green
 * step over a field that never changed. Live on Klara (2026-08-28), the editor
 * Run's own copy of this logic did exactly that and a six-step test reported
 * 6/6 passed with the app still on the login screen.
 */
describe('MobileStepApplyService.apply — a failed command inside the batch', () => {
  const lintResolved = {
    status: 'resolved',
    boundingBox: { x: 70, y: 968, width: 1300, height: 259 },
    resolvedVia: 'llm',
    confidence: 0.95,
  };

  const typeStep = {
    id: 'step-4',
    type: 'type',
    value: '99900010011',
    description: 'Phone number',
    options: { replaceContent: true },
  };

  beforeEach(() => jest.clearAllMocks());

  it('fails the step when the focus tap failed and the type never ran', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    // What the runner actually returned live: one result, for the tap, failed.
    const executeBatchCommands = jest.fn().mockResolvedValue({
      results: [{ success: false, error: 'tap: finder found nothing and no coordinate fallback' }],
    });
    const runSteps = jest.fn();
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands, runSteps });

    const result = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: typeStep,
      userId: 'user-1',
    });

    expect(result.status).toBe('failed');
    expect(result.stepResult?.success).toBe(false);
    expect(result.stepResult?.error).toMatch(/finder found nothing/i);
    // Nothing may be re-dispatched: the device was already driven.
    expect(runSteps).not.toHaveBeenCalled();
  });

  it('does not persist an applied step for a failed batch', async () => {
    // `appliedStep` is what teaches the system the step is good — a compiled
    // plan, binding hints, and `expectsTransition`. Recording it for a step that
    // did not run would pin the wrong locator AND the wrong expectation.
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({
      results: [{ success: false, error: 'tap: finder found nothing and no coordinate fallback' }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({
      lintElement, executeBatchCommands, runSteps: jest.fn(),
    });

    const result = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: typeStep,
      userId: 'user-1',
    });

    expect(result.appliedStep).toBeUndefined();
  });

  it('still passes when every command in the batch succeeded', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({
      results: [{ success: true }, { success: true, transitionDetected: true }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({
      lintElement, executeBatchCommands, runSteps: jest.fn(),
    });

    const result = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: typeStep,
      userId: 'user-1',
    });

    expect(result.status).toBe('passed');
    expect(result.stepResult?.success).toBe(true);
  });

  it('does not invent a failure when the response carries no results array', async () => {
    // The helper is policy-free: it reports what the body says, and an
    // unreadable body says nothing. An older runner must not turn every step red.
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({});
    getMobileRunnerClientForSession.mockResolvedValue({
      lintElement, executeBatchCommands, runSteps: jest.fn(),
    });

    const result = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: typeStep,
      userId: 'user-1',
    });

    expect(result.status).toBe('passed');
  });
});
