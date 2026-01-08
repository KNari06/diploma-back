/**
 * Unit tests for MainLoopService
 * Tests the main loop logic with mocked dependencies (no Playwright)
 */

import {
  createDynamicAction,
  createIntelligentTestConfig,
  createPageContext,
  createPageVisit,
  createTestState,
} from '@/test/mocks';
import { PageVisit, TestState } from '../../types/intelligent-testing.types';
import { MainLoopDependencies, MainLoopService } from '../main-loop.service';

// Mock SafetyGuard
jest.mock('../../safety/safety-guard', () => ({
  SafetyGuard: {
    checkLimits: jest.fn().mockReturnValue({ safe: true }),
  },
}));

// Mock StateTracker
jest.mock('../../safety/state-tracker', () => ({
  StateTracker: {
    detectCycle: jest.fn().mockReturnValue({ cycleDetected: false }),
    recordPageVisit: jest.fn((state: TestState, visit: PageVisit) => ({
      ...state,
      visitedPages: [...state.visitedPages, visit],
      pagesAnalyzed: state.pagesAnalyzed + 1,
    })),
    formatStatistics: jest.fn().mockReturnValue({ pages: 1, actions: 2 }),
  },
}));

// Mock ActionPatternDetector
jest.mock('../../utils/analysis/action-pattern-detector', () => ({
  ActionPatternDetector: {
    detectPatterns: jest.fn().mockReturnValue({ hasPattern: false, patterns: [] }),
  },
}));

// Mock ContextualActionGenerator
jest.mock('../../execution/contextual-action-generator', () => ({
  ContextualActionGenerator: {
    decideNextStep: jest.fn().mockResolvedValue({
      action: 'stop',
      reason: 'Test complete',
      confidence: 0.95,
    }),
  },
}));

// Mock AdaptiveConfigService
jest.mock('../../safety/adaptive-config.service', () => ({
  AdaptiveConfigService: {
    analyzePageContext: jest.fn().mockReturnValue({
      isComplexPage: false,
      errorRate: 0,
      networkSpeed: 'fast',
      hasHeavyJS: false,
    }),
    getThreshold: jest.fn().mockReturnValue(5),
    getTimeout: jest.fn().mockReturnValue(30000),
  },
}));

import { ContextualActionGenerator } from '../../execution/contextual-action-generator';
import { SafetyGuard } from '../../safety/safety-guard';
import { StateTracker } from '../../safety/state-tracker';
import { ActionPatternDetector } from '../../utils/analysis/action-pattern-detector';

const mockSafetyGuard = SafetyGuard as jest.Mocked<typeof SafetyGuard>;
const mockStateTracker = StateTracker as jest.Mocked<typeof StateTracker>;
const mockContextualActionGenerator = ContextualActionGenerator as jest.Mocked<typeof ContextualActionGenerator>;
const mockActionPatternDetector = ActionPatternDetector as jest.Mocked<typeof ActionPatternDetector>;

describe('MainLoopService', () => {
  let mockDeps: MainLoopDependencies;
  let testState: TestState;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset all mocks to defaults
    mockSafetyGuard.checkLimits.mockReturnValue({ safe: true });
    mockStateTracker.detectCycle.mockReturnValue({ cycleDetected: false, suggestion: '' });
    mockActionPatternDetector.detectPatterns.mockReturnValue({ hasPattern: false, patterns: [], shouldStop: false });
    mockContextualActionGenerator.decideNextStep.mockResolvedValue({
      action: 'stop',
      reason: 'Test complete',
      confidence: 0.95,
    });

    testState = createTestState();

    // Create mock page
    const mockPage = {
      url: jest.fn().mockReturnValue('https://example.com'),
      title: jest.fn().mockResolvedValue('Test Page'),
      $eval: jest.fn().mockResolvedValue(''),
      goBack: jest.fn().mockResolvedValue(null),
      goto: jest.fn().mockResolvedValue(null),
      waitForTimeout: jest.fn().mockResolvedValue(null),
      reload: jest.fn().mockResolvedValue(null),
    };

    mockDeps = {
      page: mockPage as any,
      config: createIntelligentTestConfig(),
      getState: jest.fn(() => testState),
      setState: jest.fn((newState: TestState) => {
        testState = newState;
      }),
      testId: 'test-123',
      userId: 'user-456',
      graphBuilder: undefined,
      costManager: undefined,
      consecutiveEmptyPages: { value: 0 },
      checkTestCancelled: jest.fn().mockResolvedValue(false),
      analyzePage: jest.fn().mockResolvedValue(createPageContext()),
      generateActions: jest.fn().mockResolvedValue({
        actions: [createDynamicAction()],
        reasoning: 'Testing',
        confidence: 0.9,
      }),
      executeActions: jest.fn().mockResolvedValue(createPageVisit()),
      emitEvent: jest.fn(),
      emitGraphUpdate: jest.fn(),
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Basic execution flow
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - basic flow', () => {
    it('should complete normally when decision is stop', async () => {
      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'Goal achieved',
        confidence: 0.95,
      });

      const wasCancelled = await MainLoopService.execute(mockDeps);

      expect(wasCancelled).toBe(false);
      expect(mockDeps.analyzePage).toHaveBeenCalled();
      expect(mockDeps.generateActions).toHaveBeenCalled();
      expect(mockDeps.executeActions).toHaveBeenCalled();
    });

    it('should return true when test is cancelled', async () => {
      (mockDeps.checkTestCancelled as jest.Mock).mockResolvedValue(true);

      const wasCancelled = await MainLoopService.execute(mockDeps);

      expect(wasCancelled).toBe(true);
    });

    it('should stop when safety limits exceeded', async () => {
      mockSafetyGuard.checkLimits.mockReturnValue({
        safe: false,
        reason: 'Max pages exceeded',
      });

      const wasCancelled = await MainLoopService.execute(mockDeps);

      expect(wasCancelled).toBe(false);
      expect(mockDeps.emitEvent).toHaveBeenCalledWith('test_warning', expect.objectContaining({
        message: expect.stringContaining('Max pages exceeded'),
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Empty pages handling
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - empty pages', () => {
    it('should increment empty pages counter for pages with no interactive elements', async () => {
      const emptyContext = createPageContext({
        vision: {
          pageType: 'unknown',
          description: 'Empty page',
          elements: [],
          suggestions: [],
        },
        dom: {
          forms: [],
          buttons: [],
          links: [],
          inputs: [],
        },
      });

      (mockDeps.analyzePage as jest.Mock).mockResolvedValue(emptyContext);
      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'No interactive elements',
        confidence: 0.9,
      });

      await MainLoopService.execute(mockDeps);

      expect(mockDeps.consecutiveEmptyPages.value).toBeGreaterThan(0);
    });

    it('should reset empty pages counter when page has elements', async () => {
      mockDeps.consecutiveEmptyPages.value = 3;

      // Page with elements
      (mockDeps.analyzePage as jest.Mock).mockResolvedValue(createPageContext());

      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'Complete',
        confidence: 0.9,
      });

      await MainLoopService.execute(mockDeps);

      expect(mockDeps.consecutiveEmptyPages.value).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle detection
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - cycle detection', () => {
    it('should emit warning when cycle is detected', async () => {
      mockStateTracker.detectCycle.mockReturnValue({
        cycleDetected: true,
        repeatedUrl: 'https://example.com',
        visitCount: 2,
        suggestion: 'Try different actions',
      });

      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'Cycle detected',
        confidence: 0.9,
      });

      await MainLoopService.execute(mockDeps);

      expect(mockDeps.emitEvent).toHaveBeenCalledWith('test_warning', expect.objectContaining({
        message: 'Try different actions',
      }));
    });

    it('should stop when cycle count exceeds threshold', async () => {
      mockStateTracker.detectCycle.mockReturnValue({
        cycleDetected: true,
        repeatedUrl: 'https://example.com',
        visitCount: 10,
        suggestion: 'Too many cycles',
      });

      await MainLoopService.execute(mockDeps);

      // Should have stopped due to cycle
      expect(mockDeps.emitEvent).toHaveBeenCalledWith('test_warning', expect.any(Object));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Action patterns
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - action patterns', () => {
    it('should emit warnings for detected patterns', async () => {
      mockActionPatternDetector.detectPatterns.mockReturnValue({
        hasPattern: true,
        shouldStop: false,
        patterns: [
          {
            type: 'repeated_action',
            severity: 'medium',
            description: 'Same action repeated 3 times',
            suggestion: 'Try different actions',
            actions: [],
          },
        ],
        reason: undefined,
      });

      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'Done',
        confidence: 0.9,
      });

      await MainLoopService.execute(mockDeps);

      expect(mockDeps.emitEvent).toHaveBeenCalledWith('test_warning', expect.objectContaining({
        message: expect.stringContaining('repeated_action'),
      }));
    });

    it('should stop when critical pattern detected', async () => {
      mockActionPatternDetector.detectPatterns.mockReturnValue({
        hasPattern: true,
        shouldStop: true,
        patterns: [
          {
            type: 'stuck',
            severity: 'critical',
            description: 'Stuck in loop detected',
            suggestion: 'Stop the test',
            actions: [],
          },
        ],
        reason: 'Stuck in loop detected',
      });

      await MainLoopService.execute(mockDeps);

      expect(mockDeps.emitEvent).toHaveBeenCalledWith('test_stopped', expect.objectContaining({
        reason: 'Stuck in loop detected',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // No actions generated
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - no actions', () => {
    it('should decide next step when no actions generated', async () => {
      (mockDeps.generateActions as jest.Mock).mockResolvedValue({
        actions: [],
        reasoning: 'No actions possible',
        confidence: 0.5,
      });

      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'No actions available',
        confidence: 0.9,
      });

      await MainLoopService.execute(mockDeps);

      expect(mockContextualActionGenerator.decideNextStep).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // URL changes
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - URL changes', () => {
    it('should continue to next iteration when URL changes', async () => {
      let callCount = 0;

      // First call: URL is example.com
      // After actions: URL changed to example.com/new
      (mockDeps.getState as jest.Mock).mockImplementation(() => {
        return {
          ...testState,
          currentUrl: callCount > 1 ? 'https://example.com/new' : 'https://example.com',
        };
      });

      (mockDeps.analyzePage as jest.Mock).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return createPageContext({ url: 'https://example.com' });
        }
        return createPageContext({ url: 'https://example.com/new' });
      });

      // Stop on second iteration
      (mockDeps.checkTestCancelled as jest.Mock).mockImplementation(async () => {
        return callCount >= 2;
      });

      await MainLoopService.execute(mockDeps);

      // Should have analyzed page at least once
      expect(mockDeps.analyzePage).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error handling
  // ═══════════════════════════════════════════════════════════════════════════
  describe('execute - error handling', () => {
    it('should continue despite iteration error', async () => {
      let errorThrown = false;

      (mockDeps.analyzePage as jest.Mock).mockImplementation(async () => {
        if (!errorThrown) {
          errorThrown = true;
          throw new Error('Analysis failed');
        }
        return createPageContext();
      });

      // Stop after a few iterations to prevent infinite loop
      let iterations = 0;
      (mockDeps.checkTestCancelled as jest.Mock).mockImplementation(async () => {
        iterations++;
        return iterations >= 3;
      });

      await MainLoopService.execute(mockDeps);

      // Should have added error to state
      expect(mockDeps.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              message: 'Analysis failed',
            }),
          ]),
        })
      );
    });

    it('should stop after too many errors', async () => {
      // Add many errors to state
      testState.errors = Array(10).fill(null).map((_, i) => ({
        message: `Error ${i}`,
        timestamp: Date.now() - i * 1000,
      }));

      // Force another error
      (mockDeps.analyzePage as jest.Mock).mockRejectedValue(new Error('Yet another error'));

      await MainLoopService.execute(mockDeps);

      // Should have stopped (not infinite loop)
      expect(mockDeps.analyzePage).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Decision handling - basic tests
  // ═══════════════════════════════════════════════════════════════════════════
  describe('decision handling', () => {
    it('should handle stop decision and exit loop', async () => {
      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'Goal achieved',
        confidence: 0.95,
      });

      const wasCancelled = await MainLoopService.execute(mockDeps);

      expect(wasCancelled).toBe(false);
      // Should have called decideNextStep at least once
      expect(mockContextualActionGenerator.decideNextStep).toHaveBeenCalled();
    });

    it('should emit test_progress event with decision info', async () => {
      mockContextualActionGenerator.decideNextStep.mockResolvedValue({
        action: 'stop',
        reason: 'Testing complete',
        confidence: 0.9,
        metadata: { progress: 100, riskLevel: 'low' },
      });

      await MainLoopService.execute(mockDeps);

      expect(mockDeps.emitEvent).toHaveBeenCalledWith('test_progress', expect.objectContaining({
        action: 'stop',
        reason: 'Testing complete',
        confidence: 0.9,
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // about: URL handling
  // ═══════════════════════════════════════════════════════════════════════════
  describe('about: URL handling', () => {
    it('should stop if page is on about:blank after analysis', async () => {
      // Reset safety guard to return safe (so loop doesn't exit early)
      mockSafetyGuard.checkLimits.mockReturnValue({ safe: true });

      (mockDeps.analyzePage as jest.Mock).mockResolvedValue(
        createPageContext({ url: 'about:blank' })
      );

      await MainLoopService.execute(mockDeps);

      // Check that warning was emitted (the loop should have stopped)
      // The emitEvent call should have been made with test_warning
      const warningCalls = (mockDeps.emitEvent as jest.Mock).mock.calls.filter(
        call => call[0] === 'test_warning' && call[1]?.message?.includes('about:')
      );

      expect(warningCalls.length).toBeGreaterThan(0);
    });
  });
});
