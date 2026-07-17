import { MobileStepApplyService } from '../mobile-step-apply.service';

jest.mock('../session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

const { getMobileRunnerClientForSession } = require('../session-runner-routing') as {
  getMobileRunnerClientForSession: jest.Mock;
};

// The USER trigger the runner reports as fired (raw shape: id/condition/action
// + matchedText). The service must flatten it to the web `TriggerFiredPayload`
// so the mobile editor renders the same "TRIGGER"/"FIRED" indicators as web.
const runnerFired = {
  id: 'editor-trigger-7',
  condition: { kind: 'any_dialog' as const },
  action: { kind: 'tap' as const, text: 'Allow' },
  matchedText: 'Allow access to your location?',
};

describe('MobileStepApplyService.apply — triggerFired surfacing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flattens the runner trigger from the fallback (runSteps) path', async () => {
    const runSteps = jest.fn().mockResolvedValue({
      steps: [{ stepId: 'apply_1', success: true, durationMs: 500, triggerFired: runnerFired }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({ runSteps });

    const output = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      // A compiled plan forces the runSteps fallback (skips the lint fast path).
      stepDraft: { id: 'step-1', type: 'tap', description: 'Continue', compiled: { version: 1 } },
      userId: 'user-1',
    });

    expect(output.stepResult?.triggerFired).toEqual({
      triggerId: 'editor-trigger-7',
      conditionKind: 'any_dialog',
      actionKind: 'tap',
      actionText: 'Allow',
      matchedText: 'Allow access to your location?',
      timestamp: expect.any(String),
    });
  });

  it('flattens the runner trigger from the lint fast path', async () => {
    const lintElement = jest.fn().mockResolvedValue({
      status: 'resolved',
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      resolvedVia: 'exact_label',
      confidence: 0.9,
      triggerFired: runnerFired,
    });
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    const output = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      // No compiled plan + a lint-eligible type → the fast path runs lintElement.
      stepDraft: { id: 'step-1', type: 'tap', description: 'Continue' },
      userId: 'user-1',
    });

    expect(lintElement).toHaveBeenCalled();
    expect(output.stepResult?.triggerFired).toMatchObject({
      triggerId: 'editor-trigger-7',
      conditionKind: 'any_dialog',
      actionKind: 'tap',
      actionText: 'Allow',
      matchedText: 'Allow access to your location?',
    });
  });

  it('omits triggerFired when the runner reports none', async () => {
    const runSteps = jest.fn().mockResolvedValue({
      steps: [{ stepId: 'apply_1', success: true, durationMs: 500 }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({ runSteps });

    const output = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-1', type: 'tap', description: 'Continue', compiled: { version: 1 } },
      userId: 'user-1',
    });

    expect(output.stepResult?.triggerFired).toBeUndefined();
  });
});
