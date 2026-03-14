/**
 * Preview Run Service Tests
 * Tests for "Run from start" feature
 */

import { PreviewRunService } from '../preview-run.service';
import { IntentTestCaseService } from '../intent-test-case.service';
import { PreviewStepApplyService } from '../preview-step-apply.service';
import { getPreviewSessionService } from '../preview-session.service';
import { webSocketService } from '@/websocket/core/websocket.service';

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

describe('PreviewRunService', () => {
  const mockPreviewSessionId = 'session-123';
  const mockIntentTestCaseId = 'testcase-456';
  const mockUserId = 'user-789';

  const mockSessionService = {
    isSessionOwned: jest.fn(),
    getSession: jest.fn(),
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

    // Setup default mocks
    (getPreviewSessionService as jest.Mock).mockReturnValue(mockSessionService);
    mockSessionService.isSessionOwned.mockReturnValue(true);
    mockSessionService.getSession.mockReturnValue({
      page: {
        url: () => 'https://example.com',
        goto: jest.fn().mockResolvedValue(undefined),
        waitForLoadState: jest.fn().mockResolvedValue(undefined),
      },
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
      // Make step 2 fail
      (PreviewStepApplyService.applyStep as jest.Mock)
        .mockResolvedValueOnce({ success: true, appliedStep: mockSteps[0] })
        .mockResolvedValueOnce({ success: false, error: 'Element not found' })
        .mockResolvedValueOnce({ success: true, appliedStep: mockSteps[2] });

      await PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Only first 2 steps should be executed
      expect(PreviewStepApplyService.applyStep).toHaveBeenCalledTimes(2);

      // Verify step 2 failed
      const failCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'fail'
      );
      expect(failCalls).toHaveLength(1);
      expect(failCalls[0][2]).toMatchObject({
        stepId: 'step-2',
        error: 'Element not found',
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

      // Only first step should be executed
      expect(PreviewStepApplyService.applyStep).toHaveBeenCalledTimes(1);

      // Verify steps 2 and 3 skipped
      const skippedCalls = (webSocketService.emitToUser as jest.Mock).mock.calls.filter(
        (call) => call[1] === 'preview:run:step' && call[2].status === 'skipped'
      );
      expect(skippedCalls).toHaveLength(2);

      // Verify completed with cancelled flag
      expect(webSocketService.emitToUser).toHaveBeenCalledWith(
        mockUserId,
        'preview:run:completed',
        expect.objectContaining({
          success: false,
          cancelled: true,
          passedSteps: 1,
          skippedSteps: 2,
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

    it('should throw error if session has no active page', async () => {
      mockSessionService.getSession.mockReturnValue({ page: null });

      await expect(
        PreviewRunService.runSavedSteps(mockPreviewSessionId, mockIntentTestCaseId, mockUserId)
      ).rejects.toThrow('Session has no active page');
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
        .mockResolvedValueOnce({ success: true, appliedStep: mockSteps[2] });

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

      // Cancel immediately
      expect(() => {
        PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId);
      }).not.toThrow();

      await runPromise;
    });

    it('should throw error if no active run', () => {
      expect(() => {
        PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId);
      }).toThrow('No active run for this session');
    });

    it('should throw error if session not owned', async () => {
      // Start run
      const runPromise = PreviewRunService.runSavedSteps(
        mockPreviewSessionId,
        mockIntentTestCaseId,
        mockUserId
      );

      // Try to cancel with different user
      mockSessionService.isSessionOwned.mockReturnValue(false);

      expect(() => {
        PreviewRunService.cancelRun(mockPreviewSessionId, 'other-user');
      }).toThrow('Session not owned by user');

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

      // Cancel
      PreviewRunService.cancelRun(mockPreviewSessionId, mockUserId);

      await runPromise;

      expect(PreviewRunService.isRunning(mockPreviewSessionId)).toBe(false);
    });
  });
});
