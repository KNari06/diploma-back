import { MobileStepApplyService } from '../mobile-step-apply.service';

jest.mock('../session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

const { getMobileRunnerClientForSession } = require('../session-runner-routing') as {
  getMobileRunnerClientForSession: jest.Mock;
};

/**
 * The lint fast path falls back to the full `runSteps` pipeline when it can't
 * complete. That fallback is correct ONLY while nothing has reached the device.
 *
 * Once `executeBatchCommands` has been called, the tap/type is already on its
 * way to the app. A throw after that point is overwhelmingly a TIMEOUT while
 * the runner was still waiting for the screen to settle — not evidence the
 * action failed. Re-running it through `runSteps` re-RESOLVES the same intent
 * against the screen the first action just navigated to, producing a second,
 * different action.
 *
 * Live on JanaPost TC-32 (2026-08-07), one authored step:
 *   21:05:19  tapByText "FAQ" -> HIT              (lint path; landed)
 *   ~29s Flutter settle; the 30s dispatch timeout expires
 *   21:05:45  falling back to runSteps
 *   21:05:54  tapByText "Қолданбаны негізгі пайдалану" -> HIT
 *   21:05:57  run-steps: 1/1 passed
 * One step, two taps, two screens, reported PASSED. The run then failed two
 * steps later looking for a search field that only existed on the screen the
 * FIRST tap had correctly reached.
 */
describe('MobileStepApplyService.apply — no runSteps retry after the device was driven', () => {
  const lintResolved = {
    status: 'resolved',
    boundingBox: { x: 100, y: 200, width: 60, height: 60 },
    resolvedVia: 'lint',
    confidence: 0.95,
  };

  beforeEach(() => jest.clearAllMocks());

  it('fails the step instead of re-dispatching when the batch call throws after dispatch', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockRejectedValue(new Error('Request timed out after 90000ms'));
    const runSteps = jest.fn();
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands, runSteps });

    const result = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-2', type: 'tap', description: 'FAQ entry in Profile / Гид section' },
      userId: 'user-1',
    });

    expect(result.status).toBe('failed');
    // The whole point: the second dispatch never happens.
    expect(runSteps).not.toHaveBeenCalled();
    expect(executeBatchCommands).toHaveBeenCalledTimes(1);
  });

  it('says the action may already have landed rather than blaming the element', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockRejectedValue(new Error('Request timed out'));
    getMobileRunnerClientForSession.mockResolvedValue({
      lintElement, executeBatchCommands, runSteps: jest.fn(),
    });

    const result = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-2', type: 'tap', description: 'FAQ entry' },
      userId: 'user-1',
    });

    expect(result.stepResult?.error).toMatch(/may already have taken effect/i);
    expect(result.stepResult?.error).toMatch(/NOT retried/i);
  });

  it('STILL falls back to runSteps when the lint call itself throws — nothing was dispatched', async () => {
    const lintElement = jest.fn().mockRejectedValue(new Error('lint exploded'));
    const executeBatchCommands = jest.fn();
    const runSteps = jest.fn().mockResolvedValue({
      results: [{ stepId: 'step-2', success: true, durationMs: 10 }],
      passed: 1, failed: 0,
    });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands, runSteps });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-2', type: 'tap', description: 'FAQ entry' },
      userId: 'user-1',
    });

    // The fallback exists for exactly this case and must keep working.
    expect(executeBatchCommands).not.toHaveBeenCalled();
    expect(runSteps).toHaveBeenCalled();
  });

  it('gives the dispatch a settle-aware budget, not the 30s client default', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({
      lintElement, executeBatchCommands, runSteps: jest.fn(),
    });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-2', type: 'tap', description: 'FAQ entry' },
      userId: 'user-1',
    });

    // A JanaPost navigation settle alone is ~30s; the default expired mid-settle.
    const opts = executeBatchCommands.mock.calls[0]?.[2] ?? {};
    expect(opts.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
