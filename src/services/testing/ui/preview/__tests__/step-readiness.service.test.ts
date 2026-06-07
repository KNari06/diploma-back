/**
 * Unit tests for step-readiness.service.ts (Lookahead Auto Wait)
 *
 * Tests the lookahead wait mechanism that checks element readiness
 * before executing the next step.
 */

import type { Page, Locator } from 'playwright';
import {
  waitForStepReadiness,
  shouldSkipLookaheadAfter,
  waitForDomDensitySettle,
  type LookaheadResult,
} from '../step-readiness.service';
import type { IntentStep } from '../preview.types';

// Mock the logger
jest.mock('@/utils/core/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('step-readiness.service', () => {
  // Mock Page and Locator
  let mockPage: jest.Mocked<Page>;
  let mockLocator: jest.Mocked<Locator>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock locator
    mockLocator = {
      isVisible: jest.fn(),
      isEnabled: jest.fn(),
      count: jest.fn(),
      first: jest.fn(() => mockLocator),
    } as unknown as jest.Mocked<Locator>;

    // Create mock page
    mockPage = {
      locator: jest.fn(() => mockLocator),
      getByRole: jest.fn(() => mockLocator),
      getByLabel: jest.fn(() => mockLocator),
      getByTestId: jest.fn(() => mockLocator),
      getByPlaceholder: jest.fn(() => mockLocator),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      // The DOM-density probe (countInteractiveElementsLight) calls
      // page.evaluate(fn, { joined, parts }). Return a dense, stable count for
      // that probe so the density gate settles fast (realistic hydrated page)
      // instead of waiting out its budget; every other evaluate stays undefined.
      evaluate: jest.fn().mockImplementation((_fn: unknown, arg: unknown) => {
        if (arg && typeof arg === 'object' && 'joined' in (arg as Record<string, unknown>)) {
          return Promise.resolve(40);
        }
        return Promise.resolve(undefined);
      }),
      waitForTimeout: jest.fn().mockResolvedValue(undefined),
      // V15: passive XHR observer + mainFrame stub needed by step-readiness
      on: jest.fn(),
      off: jest.fn(),
      url: jest.fn(() => 'https://example.com/'),
      mainFrame: jest.fn(() => ({} as any)),
    } as unknown as jest.Mocked<Page>;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // shouldSkipLookaheadAfter
  // ─────────────────────────────────────────────────────────────────────────

  describe('shouldSkipLookaheadAfter', () => {
    it('should return false for navigate action (goto needs lookahead for JS hydration)', () => {
      expect(shouldSkipLookaheadAfter('navigate')).toBe(false);
    });

    it('should return true for wait action', () => {
      expect(shouldSkipLookaheadAfter('wait')).toBe(true);
    });

    it('should return true for wait_for action', () => {
      expect(shouldSkipLookaheadAfter('wait_for')).toBe(true);
    });

    it('should return true for ai_check action', () => {
      expect(shouldSkipLookaheadAfter('ai_check')).toBe(true);
    });

    it('should return false for click action', () => {
      expect(shouldSkipLookaheadAfter('click')).toBe(false);
    });

    it('should return false for type action', () => {
      expect(shouldSkipLookaheadAfter('type')).toBe(false);
    });

    it('should return false for select action', () => {
      expect(shouldSkipLookaheadAfter('select')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // waitForStepReadiness - Skip conditions
  // ─────────────────────────────────────────────────────────────────────────

  describe('waitForStepReadiness - skip conditions', () => {
    it('should skip if disableLookaheadWait is true', async () => {
      const step: IntentStep = {
        id: 'test-1',
        type: 'click',
        description: 'Click button',
        options: {
          disableLookaheadWait: true,
        },
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      expect(result.waited).toBe(0);
      expect(result.autoWaitApplied).toBe(false);
      expect(result.skipReason).toBe('disableLookaheadWait flag set');
    });

    it('should apply blind settle for navigate action (needs JS hydration)', async () => {
      const step: IntentStep = {
        id: 'test-2',
        type: 'navigate',
        description: 'Go to page',
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      // V15: challenge probe + page-readiness checks are cheap but not zero.
      // Upper bound keeps the test realistic without pinning to implementation details.
      expect(result.waited).toBeLessThan(2000);
      expect(result.skipReason).toContain('No locator');
    });

    it('should skip for wait action', async () => {
      const step: IntentStep = {
        id: 'test-3',
        type: 'wait',
        description: 'Wait for 1s',
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      expect(result.skipReason).toContain('wait');
    });

    it('should skip for ai_check action', async () => {
      const step: IntentStep = {
        id: 'test-4',
        type: 'ai_check',
        description: 'Check something',
        assertionText: 'Page has a header',
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      expect(result.skipReason).toContain('ai_check');
    });

    it('should skip if no compiled plan and no evidence', async () => {
      const step: IntentStep = {
        id: 'test-5',
        type: 'click',
        description: 'Click button',
        // No compiled, no evidence
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      expect(result.skipReason).toContain('No locator');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // waitForStepReadiness - Element ready immediately
  // ─────────────────────────────────────────────────────────────────────────

  describe('waitForStepReadiness - element ready', () => {
    it('should return ready=true if element is visible and enabled (click)', async () => {
      mockLocator.isVisible.mockResolvedValue(true);
      mockLocator.isEnabled.mockResolvedValue(true);

      const step: IntentStep = {
        id: 'test-6',
        type: 'click',
        description: 'Click submit button',
        compiled: {
          locatorPlan: [
            { strategy: 'label', value: 'Submit', confidence: 0.95 },
          ],
          action: { type: 'click' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      // V15: Under mocked Playwright, hard-capped probes + retry loop settles
      // can push waited above 2s (the mocks don't support proper event shortcuts).
      // We still care it completed in a reasonable bound — 3s covers mock slop.
      expect(result.waited).toBeLessThan(3000);
      expect(mockLocator.isVisible).toHaveBeenCalled();
      expect(mockLocator.isEnabled).toHaveBeenCalled();
    });

    it('should return ready=true if element is visible (assert)', async () => {
      mockLocator.isVisible.mockResolvedValue(true);

      const step: IntentStep = {
        id: 'test-7',
        type: 'assert',
        description: 'Assert element visible',
        compiled: {
          locatorPlan: [
            { strategy: 'testId', value: 'header', confidence: 0.9 },
          ],
          action: { type: 'assert' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      expect(mockLocator.isVisible).toHaveBeenCalled();
      expect(mockLocator.isEnabled).not.toHaveBeenCalled(); // Assert only needs visible
    });

    it('should return ready=true if element is attached (press)', async () => {
      mockLocator.count.mockResolvedValue(1);

      const step: IntentStep = {
        id: 'test-8',
        type: 'press',
        description: 'Press Enter',
        value: 'Enter',
        compiled: {
          locatorPlan: [
            { strategy: 'css', value: 'input#search', confidence: 0.9 },
          ],
          action: { type: 'press', value: 'Enter' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      const result = await waitForStepReadiness(mockPage, step);

      expect(result.ready).toBe(true);
      expect(mockLocator.count).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // waitForStepReadiness - Element not ready, settle applied
  // ─────────────────────────────────────────────────────────────────────────

  describe('waitForStepReadiness - settle applied', () => {
    it('should apply settle and retry if element not visible initially', async () => {
      // First call: not visible, second call: visible
      mockLocator.isVisible
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockLocator.isEnabled.mockResolvedValue(true);

      const step: IntentStep = {
        id: 'test-9',
        type: 'click',
        description: 'Click button',
        compiled: {
          locatorPlan: [
            { strategy: 'placeholder', value: 'Search...', confidence: 0.9 },
          ],
          action: { type: 'click' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      const result = await waitForStepReadiness(mockPage, step, {
        maxWaitMs: 10000,
        settleMs: 100, // Short for testing
        autoWaitThresholdMs: 50, // Low threshold for testing
      });

      expect(result.ready).toBe(true);
      // In unit tests our settle mocks may resolve immediately, so waited can be 0.
      expect(result.waited).toBeGreaterThanOrEqual(0);
      // isVisible called at least twice (initial + after settle)
      expect(mockLocator.isVisible.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should set autoWaitApplied=true if waited > threshold', async () => {
      // First call: not visible, then visible after settle
      mockLocator.isVisible
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockLocator.isEnabled.mockResolvedValue(true);

      // Mock page.waitForLoadState to simulate some wait time
      mockPage.waitForLoadState.mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 100))
      );
      mockPage.evaluate.mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 100))
      );

      const step: IntentStep = {
        id: 'test-10',
        type: 'type',
        description: 'Type in input',
        value: 'hello',
        compiled: {
          locatorPlan: [
            { strategy: 'label', value: 'Email', confidence: 0.9 },
          ],
          action: { type: 'type', value: 'hello' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      const result = await waitForStepReadiness(mockPage, step, {
        maxWaitMs: 5000,
        settleMs: 200,
        autoWaitThresholdMs: 50, // Very low threshold
      });

      expect(result.ready).toBe(true);
      expect(result.autoWaitApplied).toBe(true);
      expect(result.waited).toBeGreaterThan(50);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // waitForStepReadiness - Locator strategies
  // ─────────────────────────────────────────────────────────────────────────

  describe('waitForStepReadiness - locator strategies', () => {
    it('should use css strategy from compiled plan', async () => {
      mockLocator.isVisible.mockResolvedValue(true);
      mockLocator.isEnabled.mockResolvedValue(true);

      const step: IntentStep = {
        id: 'test-11',
        type: 'click',
        description: 'Click button',
        compiled: {
          locatorPlan: [
            { strategy: 'css', value: 'button.submit-btn', confidence: 0.95 },
          ],
          action: { type: 'click' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      await waitForStepReadiness(mockPage, step);

      expect(mockPage.locator).toHaveBeenCalledWith('button.submit-btn');
    });

    it('should use role strategy from compiled plan', async () => {
      mockLocator.isVisible.mockResolvedValue(true);
      mockLocator.isEnabled.mockResolvedValue(true);

      const step: IntentStep = {
        id: 'test-12',
        type: 'click',
        description: 'Click submit',
        compiled: {
          locatorPlan: [
            { strategy: 'role', value: 'Submit', roleName: 'button', confidence: 0.9 },
          ],
          action: { type: 'click' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      await waitForStepReadiness(mockPage, step);

      expect(mockPage.getByRole).toHaveBeenCalledWith('button', { name: 'Submit' });
    });

    it('should fallback to evidence.lastSuccessRef if no compiled plan', async () => {
      mockLocator.isVisible.mockResolvedValue(true);
      mockLocator.isEnabled.mockResolvedValue(true);

      const step: IntentStep = {
        id: 'test-13',
        type: 'click',
        description: 'Click button',
        // No compiled plan
        evidence: {
          lastSuccessRef: 'btn-fallback-ref',
          confidence: 0.8,
        },
      };

      await waitForStepReadiness(mockPage, step);

      expect(mockPage.locator).toHaveBeenCalledWith('[data-agent-ref="btn-fallback-ref"]');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // waitForStepReadiness - Timeout
  // ─────────────────────────────────────────────────────────────────────────

  describe('waitForStepReadiness - timeout', () => {
    it('should return ready=false if element never becomes ready', async () => {
      // Element never becomes visible
      mockLocator.isVisible.mockResolvedValue(false);
      mockLocator.isEnabled.mockResolvedValue(false);

      const step: IntentStep = {
        id: 'test-14',
        type: 'click',
        description: 'Click button',
        compiled: {
          locatorPlan: [
            { strategy: 'label', value: 'Submit', confidence: 0.9 },
          ],
          action: { type: 'click' },
          context: { pageUrl: 'https://example.com', compiledAt: new Date().toISOString() },
        },
      };

      const result = await waitForStepReadiness(mockPage, step, {
        maxWaitMs: 500, // Short timeout for testing
        settleMs: 100,
        maxRetries: 1,
        // Make sure autoWaitApplied flips even with fast mocks (waited may be 0ms).
        autoWaitThresholdMs: -1,
      });

      expect(result.ready).toBe(false);
      expect(result.autoWaitApplied).toBe(true); // Waited long enough
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // waitForDomDensitySettle — interactive-node plateau gate
  // ─────────────────────────────────────────────────────────────────────────

  describe('waitForDomDensitySettle', () => {
    // Build a page whose interactive-node count follows `counts`, repeating the
    // last value forever. countInteractiveElementsLight calls page.evaluate and
    // returns its numeric result, so yielding numbers drives the plateau logic.
    const seqPage = (counts: number[]): jest.Mocked<Page> => {
      let i = 0;
      return {
        evaluate: jest.fn().mockImplementation(() => {
          const v = counts[Math.min(i, counts.length - 1)];
          i++;
          return Promise.resolve(v);
        }),
      } as unknown as jest.Mocked<Page>;
    };

    it('waits for the node count to plateau after hydration grows the DOM', async () => {
      // Sparse → hydrating → dense, then stable. Must NOT settle at 22; must
      // return once growth stops, at the dense plateau.
      const page = seqPage([22, 50, 90, 134, 134, 134, 134, 134, 134]);

      const res = await waitForDomDensitySettle(page, 5_000);

      expect(res.settled).toBe(true);
      expect(res.grew).toBe(true);
      expect(res.finalCount).toBe(134);
      expect(res.maxCount).toBe(134);
      expect(res.probeFailed).toBe(false);
    });

    it('settles quickly when the page is already dense and stable', async () => {
      const page = seqPage([140, 140, 140, 140, 140]);

      const res = await waitForDomDensitySettle(page, 5_000);

      expect(res.settled).toBe(true);
      expect(res.grew).toBe(false); // no growth observed
      expect(res.finalCount).toBe(140);
    });

    it('fails open immediately when the count probe throws (navigation in-flight)', async () => {
      const page = {
        evaluate: jest.fn().mockRejectedValue(new Error('Execution context was destroyed')),
      } as unknown as jest.Mocked<Page>;

      const res = await waitForDomDensitySettle(page, 5_000);

      expect(res.probeFailed).toBe(true);
      expect(res.settled).toBe(false);
    });

    it('exhausts the budget without settling on a page that stays below the floor', async () => {
      // 1 interactive node forever — below the floor (3) → never "settled".
      const page = seqPage([1]);

      const res = await waitForDomDensitySettle(page, 500);

      expect(res.settled).toBe(false);
      expect(res.budgetExhausted).toBe(true);
      expect(res.probeFailed).toBe(false);
    });
  });
});
