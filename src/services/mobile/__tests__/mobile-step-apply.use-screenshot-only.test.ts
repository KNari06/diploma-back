import { MobileStepApplyService } from '../mobile-step-apply.service';

jest.mock('../session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

const { getMobileRunnerClientForSession } = require('../session-runner-routing') as {
  getMobileRunnerClientForSession: jest.Mock;
};

/**
 * "Use screenshot to find element" (`options.useScreenshotOnly`) must reach the
 * runner from the APPLY path, not just from Find.
 *
 * The editor's Apply *and* its Run loop both come through this service, and for
 * a step with no compiled plan the lint call below IS the resolution. Dropping
 * the flag here is what made the toggle inert: a "gear icon" tap on JanaPost
 * resolved by text to the language button beside it and opened the wrong screen.
 */
describe('MobileStepApplyService.apply — useScreenshotOnly forwarding', () => {
  const lintResolved = {
    status: 'resolved',
    boundingBox: { x: 100, y: 200, width: 60, height: 60 },
    resolvedVia: 'vision_coordinates',
    confidence: 0.9,
    visionMode: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards useScreenshotOnly to the runner lint call', async () => {
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: {
        id: 'step-1',
        type: 'tap',
        description: 'settings icon on the right top side, gear icon settings',
        options: { useScreenshotOnly: true },
      },
      userId: 'user-1',
    });

    expect(lintElement).toHaveBeenCalledWith(
      'sess-1',
      'settings icon on the right top side, gear icon settings',
      'tap',
      undefined,
      expect.objectContaining({ useScreenshotOnly: true }),
    );
  });

  it('reports useScreenshotOnly false when the step has no such option', async () => {
    const lintElement = jest.fn().mockResolvedValue({ ...lintResolved, visionMode: false });
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-1', type: 'tap', description: 'Continue' },
      userId: 'user-1',
    });

    expect(lintElement).toHaveBeenCalledWith(
      'sess-1',
      'Continue',
      'tap',
      undefined,
      expect.objectContaining({ useScreenshotOnly: false }),
    );
  });

  it('stamps _useScreenshotOnly on the dispatched command so the coordinate re-validation stays vision-led', async () => {
    // Vision coords are always demoted below the runner's trust threshold, so
    // the runner re-resolves before tapping. Without this flag on the command
    // that re-resolve falls back to text and re-picks the wrong element.
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: {
        id: 'step-1',
        type: 'tap',
        description: 'gear icon settings',
        options: { useScreenshotOnly: true },
      },
      userId: 'user-1',
    });

    const [, commands] = executeBatchCommands.mock.calls[0];
    expect(commands[0]).toMatchObject({ type: 'tap', _useScreenshotOnly: true });
  });

  it('gives the dispatch a resolve budget, not the 30s default', async () => {
    // This request covers a runner-side re-resolve AND the post-action
    // stability wait, not just a dispatch. Measured live on JanaPost TC-13:
    // the tap landed ~2s in, then ~28s of Flutter inspector-tree polling — so
    // on the 30s default the client abandoned a request the runner had already
    // completed, and the catch below re-ran the step against the screen the
    // first tap had navigated to (a second tap, on the Settings back arrow).
    const { RESOLVE_DISPATCH_TIMEOUT_MS } = jest.requireActual('../mobile-runner-client');
    const lintElement = jest.fn().mockResolvedValue(lintResolved);
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: {
        id: 'step-1',
        type: 'tap',
        description: 'gear icon settings',
        options: { useScreenshotOnly: true },
      },
      userId: 'user-1',
    });

    const [, , opts] = executeBatchCommands.mock.calls[0];
    expect(opts).toMatchObject({ timeoutMs: RESOLVE_DISPATCH_TIMEOUT_MS });
  });

  it('leaves the dispatched command unflagged for an ordinary step', async () => {
    const lintElement = jest.fn().mockResolvedValue({ ...lintResolved, visionMode: false });
    const executeBatchCommands = jest.fn().mockResolvedValue({ results: [{ success: true }] });
    getMobileRunnerClientForSession.mockResolvedValue({ lintElement, executeBatchCommands });

    await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-1', type: 'tap', description: 'Continue' },
      userId: 'user-1',
    });

    const [, commands] = executeBatchCommands.mock.calls[0];
    expect(commands[0]).not.toHaveProperty('_useScreenshotOnly');
  });
});
