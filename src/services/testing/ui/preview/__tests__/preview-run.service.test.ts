/**
 * Preview Run Service Tests
 * Tests for "Run from start" feature
 */

import { PreviewRunService, scheduleCatchUpFrame } from '../preview-run.service';
import { getPreviewVideoStreamRegistry } from '../preview-video-stream.service';
import { IntentTestCaseService } from '../intent-test-case.service';
import { PreviewStepApplyService } from '../preview-step-apply.service';
import { getPreviewSessionService } from '../preview-session.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { waitForPageInteractive } from '../page-interactive.utils';

// Mock dependencies
jest.mock('../intent-test-case.service', () => ({
  IntentTestCaseService: {
    getById: jest.fn(),
    updateStepFromPreviewApply: jest.fn(),
    batchUpdateStepsFromRun: jest.fn(),
  },
}));

jest.mock('../preview-step-apply.service', () => ({
  PreviewStepApplyService: {
    applyStep: jest.fn(),
  },
}));

jest.mock('../preview-session.service', () => ({
  getPreviewSessionService: jest.fn(),
}));

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: {
    emitToUser: jest.fn(),
  },
}));

jest.mock('../page-interactive.utils', () => ({
  waitForPageInteractive: jest.fn().mockResolvedValue({
    ready: true,
    waited: 0,
    elementCount: 5,
    reason: undefined,
  }),
}));

jest.mock('../step-blocker-diagnosis.service', () => ({
  diagnoseStepBlocker: jest.fn().mockResolvedValue(null),
  actOnDiagnosis: jest.fn().mockResolvedValue(false),
}));

describe('PreviewRunService', () => {
  const mockPreviewSessionId = 'session-123';
  const mockIntentTestCaseId = 'testcase-456';
  const mockUserId = 'user-789';

  const mockSessionService = {
    isSessionOwned: jest.fn(),
    getSession: jest.fn(),
    setDialogMode: jest.fn(),
    isRecording: jest.fn().mockReturnValue(false),
    setContextData: jest.fn(),
    getRecordingStartUrl: jest.fn().mockReturnValue(null),
  };

  const mockSteps = [
    {
      id: 'step-1',
      type: 'click',
      elementDescription: 'Submit button',
    },
    {
      id: 'step-2',
      type: 'type',
      elementDescription: 'Email input',
      value: 'test@example.com',
    },
    {
      id: 'step-3',
      type: 'ai_check',
      assertionText: 'Form submitted successfully',
    },
  ];

  beforeEach(() => {
    // Reset mocks (incl. mockImplementationOnce queues) to avoid cross-test leakage
    jest.resetAllMocks();
    // Ensure no cross-test leakage from module-scoped activeRuns map
    PreviewRunService.__dangerousClearRunsForTests();

    // Restore module-level mocks cleared by resetAllMocks
    (waitForPageInteractive as jest.Mock).mockResolvedValue({
      ready: true,
      waited: 0,
      elementCount: 5,
      reason: undefined,
    });

    // Setup default mocks
    (getPreviewSessionService as jest.Mock).mockReturnValue(mockSessionService);
    mockSessionService.isSessionOwned.mockReturnValue(true);
    const mockPage = {
      url: () => 'https://example.com',
      goto: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue(null),
      on: jest.fn(),
      off: jest.fn(),
      isClosed: jest.fn().mockReturnValue(false),
      context: jest.fn().mockReturnValue({
        cookies: jest.fn().mockResolvedValue([]),
        clearCookies: jest.fn().mockResolvedValue(undefined),
      }),
    };
    mockSessionService.getSession.mockReturnValue({
      page: mockPage,
      pages: [mockPage],
      activeTabIndex: 0,
      lastSnapshotEmit: 0,
      lastPageSignature: '',
      lastScreenshotEmitAt: 0,
    });

    (IntentTestCaseService.getById as jest.Mock).mockResolvedValue({
      id: mockIntentTestCaseId,
      startUrl: 'https://example.com/start',
      stepsJson: mockSteps,
    });

    (PreviewStepApplyService.applyStep as jest.Mock).mockResolvedValue({
      success: true,
      appliedStep: mockSteps[0],
    });

    (webSocketService.emitToUser as jest.Mock).mockImplementation(() => {});
  });

  describe('runSavedSteps', () => {
    it('should execute steps in order and emit progress events', async () => {
      await PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Verify started event
      expect(webSocketService.emitToUser).toHaveBeenCalledWith(
        mockUserId,
        'preview:run:started',
        expect.objectContaining({
          previewSessionId: mockPreviewSessionId,
          totalSteps: 3,
        })
      );

      // Verify each step was executed
      expect(PreviewStepApplyService.applyStep).toHaveBeenCalledTimes(3);

      // Verify step progress events (running + pass for each step)
      const runningCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'running'
      );
      expect(runningCalls).toHaveLength(3);

      const passCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'pass'
      );
      expect(passCalls).toHaveLength(3);

      // Verify completed event
      expect(webSocketService.emitToUser).toHaveBeenCalledWith(
        mockUserId,
        'preview:run:completed',
        expect.objectContaining({
          previewSessionId: mockPreviewSessionId,
          success: true,
          totalSteps: 3,
          passedSteps: 3,
          failedSteps: 0,
          skippedSteps: 0,
        })
      );
    });

    it('should stop on first failure and skip remaining steps', async () => {
      // Make step 2 fail both initial attempt and retry (service retries non-ai_check steps)
      (PreviewStepApplyService.applyStep as jest.Mock)
        .mockResolvedValueOnce({ success: true, appliedStep: mockSteps[0] })
        .mockResolvedValueOnce({ success: false, error: 'Element not found' })
        .mockResolvedValueOnce({ success: false, error: 'Element not found' }); // retry

      await PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // step-1 + step-2 initial + step-2 retry = 3 total; step-3 skipped
      expect(PreviewStepApplyService.applyStep).toHaveBeenCalledTimes(3);

      // Verify step 2 failed
      const failCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'fail'
      );
      expect(failCalls).toHaveLength(1);
      expect(failCalls[0][2]).toMatchObject({
        stepId: 'step-2',
        error: expect.stringContaining('Element not found'),
      });

      // Verify step 3 skipped
      const skippedCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'skipped'
      );
      expect(skippedCalls).toHaveLength(1);
      expect(skippedCalls[0][2]).toMatchObject({
        stepId: 'step-3',
      });

      // Verify completed with failure
      expect(webSocketService.emitToUser).toHaveBeenCalledWith(
        mockUserId,
        'preview:run:completed',
        expect.objectContaining({
          success: false,
          passedSteps: 1,
          failedSteps: 1,
          skippedSteps: 1,
        })
      );
    });

    it('should handle cancellation and skip remaining steps', async () => {
      // Setup: cancel while first step is "in flight"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let resolveFirst: any = null;
      (PreviewStepApplyService.applyStep as jest.Mock)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValue({ success: true, appliedStep: mockSteps[1] });

      const runPromise = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Ensure first step started (avoid flakiness; don't assert before cleanup)
      for (let i = 0; i < 10; i++) {
        if ((PreviewStepApplyService.applyStep as jest.Mock).mock.calls.length >= 1) break;
        await new Promise<void>((r) => setImmediate(r));
      }

      // Cancel before first step resolves
      PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId);

      // Resolve first step
      if (typeof resolveFirst === 'function') {
        resolveFirst({ success: true, appliedStep: mockSteps[0] });
      }

      await runPromise;

      // applyStep was called once for step-1 (even though the result was aborted)
      expect(PreviewStepApplyService.applyStep).toHaveBeenCalledTimes(1);

      // All 3 steps are skipped: step-1 was in-flight when abort fired,
      // so the AbortError path emits step-1 as skipped too
      const skippedCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'skipped'
      );
      expect(skippedCalls).toHaveLength(3);

      // Verify completed with cancelled flag
      expect(webSocketService.emitToUser).toHaveBeenCalledWith(
        mockUserId,
        'preview:run:completed',
        expect.objectContaining({
          success: false,
          cancelled: true,
          passedSteps: 0,
          skippedSteps: 3,
        })
      );
    });

    it('should throw error if session not owned', async () => {
      mockSessionService.isSessionOwned.mockReturnValue(false);

      await expect(
        PreviewRunService.runSavedSteps(mockPreviewSessionId, mockIntentTestCaseId, mockUserId)
      ).rejects.toThrow('Session not owned by user');
    });

    it('should throw error if test case not found', async () => {
      (IntentTestCaseService.getById as jest.Mock).mockResolvedValue(null);

      await expect(
        PreviewRunService.runSavedSteps(mockPreviewSessionId, mockIntentTestCaseId, mockUserId)
      ).rejects.toThrow('Test case not found or has no saved steps');
    });

    it('should throw error if no steps to run', async () => {
      (IntentTestCaseService.getById as jest.Mock).mockResolvedValue({
        id: mockIntentTestCaseId,
        stepsJson: [],
      });

      await expect(
        PreviewRunService.runSavedSteps(mockPreviewSessionId, mockIntentTestCaseId, mockUserId)
      ).rejects.toThrow('No steps to run');
    });

    it('should return failed summary if session has no active page', async () => {
      mockSessionService.getSession.mockReturnValue({ page: null });

      // The run loop now captures inner errors and returns them in the summary
      // (instead of throwing), so chat tools / AI agents can read the failure.
      const summary = await PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId,
      );

      expect(summary.success).toBe(false);
      expect(summary.firstError).toMatch(/Session has no active page/);
    });

    it('should throw error if run already in progress', async () => {
      // Start first run (don't await)
      const firstRun = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Try to start second run
      await expect(
        PreviewRunService.runSavedSteps(mockPreviewSessionId, mockIntentTestCaseId, mockUserId)
      ).rejects.toThrow('Run already in progress for this session');

      // Wait for first run to complete
      await firstRun;
    });

    it('should batch-persist enriched steps on success (best-effort)', async () => {
      const enrichedStep = {
        ...mockSteps[0],
        compiled: { /* mock compiled plan */ },
        evidence: { /* mock evidence */ },
      };
      (PreviewStepApplyService.applyStep as jest.Mock).mockResolvedValue({
        success: true,
        appliedStep: enrichedStep,
      });

      await PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Verify batch persistence was called once (not per-step)
      expect(IntentTestCaseService.batchUpdateStepsFromRun).toHaveBeenCalledTimes(1);
      expect(IntentTestCaseService.batchUpdateStepsFromRun).toHaveBeenCalledWith(
        expect.objectContaining({
          intentTestCaseId: mockIntentTestCaseId,
          enrichedSteps: expect.any(Map),
        })
      );
      // Per-step persist should NOT be called
      expect(IntentTestCaseService.updateStepFromPreviewApply).not.toHaveBeenCalled();
    });

    it('should batch-persist even on partial failure (step 2 fails)', async () => {
      const enrichedStep1 = {
        ...mockSteps[0],
        compiled: { /* mock compiled plan */ },
      };
      (PreviewStepApplyService.applyStep as jest.Mock)
        .mockResolvedValueOnce({ success: true, appliedStep: enrichedStep1 })
        .mockResolvedValueOnce({ success: false, error: 'Element not found' })
        .mockResolvedValueOnce({ success: false, error: 'Element not found' }); // retry

      await PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Batch persist should still be called with step 1's enriched data
      expect(IntentTestCaseService.batchUpdateStepsFromRun).toHaveBeenCalledTimes(1);
      const callArgs = (IntentTestCaseService.batchUpdateStepsFromRun as jest.Mock).mock.calls[0][0];
      expect(callArgs.enrichedSteps.size).toBe(1);
      expect(callArgs.enrichedSteps.has('step-1')).toBe(true);
    });

    it('should continue on batch persistence error (best-effort)', async () => {
      (PreviewStepApplyService.applyStep as jest.Mock).mockResolvedValue({
        success: true,
        appliedStep: mockSteps[0],
      });

      (IntentTestCaseService.batchUpdateStepsFromRun as jest.Mock).mockRejectedValue(
        new Error('Database error')
      );

      // Should not throw
      await expect(
        PreviewRunService.runSavedSteps(mockPreviewSessionId, mockIntentTestCaseId, mockUserId)
      ).resolves.not.toThrow();
    });
  });

  describe('cancelRun', () => {
    it('should cancel active run', async () => {
      // Start run (don't await)
      const runPromise = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Wait for run to register in activeRuns (DB call is async before runStepsOnPreview)
      await new Promise<void>((r) => setImmediate(r));

      // Cancel immediately
      expect(() => {
        PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId);
      }).not.toThrow();

      await runPromise;
    });

    it('returns false (idempotent no-op) if no active run', () => {
      // Cancelling with nothing running is a normal close-time cleanup, not an
      // error — it must not throw and should report "nothing cancelled".
      expect(PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId)).toBe(false);
    });

    it('should throw error if session not owned', async () => {
      // Start run
      const runPromise = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Wait for run to register in activeRuns
      await new Promise<void>((r) => setImmediate(r));

      // Try to cancel with different user
      mockSessionService.isSessionOwned.mockReturnValue(false);

      expect(() => {
        PreviewRunService.cancelRun(mockPreviewSessionId, 'other-user');
      }).toThrow('Session not owned by user');

      // Restore mock so run can complete cleanly
      mockSessionService.isSessionOwned.mockReturnValue(true);
      await runPromise;
    });
  });

  describe('isRunning', () => {
    it('should return true when run is active', async () => {
      // Start run (don't await)
      const runPromise = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Wait for run to register in activeRuns (DB call is async before runStepsOnPreview)
      await new Promise<void>((r) => setImmediate(r));

      // Should be running
      expect(PreviewRunService.isRunning(mockPreviewSessionId)).toBe(true);

      await runPromise;

      // Should not be running after completion
      expect(PreviewRunService.isRunning(mockPreviewSessionId)).toBe(false);
    });

    it('should return false when no run active', () => {
      expect(PreviewRunService.isRunning(mockPreviewSessionId)).toBe(false);
    });

    it('should return false after cancellation', async () => {
      // Start run
      const runPromise = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Wait for run to register in activeRuns
      await new Promise<void>((r) => setImmediate(r));

      // Cancel
      PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId);

      await runPromise;

      expect(PreviewRunService.isRunning(mockPreviewSessionId)).toBe(false);
    });
  });
});

// Sibling describe (NOT nested) so the outer resetAllMocks/fake-timer-free
// beforeEach does not run for these — the catch-up helper needs fake timers.
describe('scheduleCatchUpFrame (Run picture-sync late-paint catch-up)', () => {
  let injectSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    // Spy on the real registry singleton — injectSyncFrame is the guarded
    // screenshot the helper must invoke (and only once, after the delay).
    injectSpy = jest
      .spyOn(getPreviewVideoStreamRegistry(), 'injectSyncFrame')
      .mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    injectSpy.mockRestore();
  });

  it('does not push a frame before the delay elapses', () => {
    scheduleCatchUpFrame('sess-1', 600);
    expect(injectSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(599);
    expect(injectSpy).not.toHaveBeenCalled();
  });

  it('pushes exactly one catch-up frame for the session once the delay elapses', () => {
    scheduleCatchUpFrame('sess-2', 600);
    jest.advanceTimersByTime(600);
    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(injectSpy).toHaveBeenCalledWith('sess-2');
  });

  it('swallows an injectSyncFrame rejection (fire-and-forget, no throw)', async () => {
    injectSpy.mockRejectedValueOnce(new Error('stream gone'));
    expect(() => {
      scheduleCatchUpFrame('sess-3', 600);
      jest.advanceTimersByTime(600);
    }).not.toThrow();
    // Flush the rejected promise's .catch so it never surfaces as unhandled.
    await Promise.resolve();
    expect(injectSpy).toHaveBeenCalledTimes(1);
  });
});
