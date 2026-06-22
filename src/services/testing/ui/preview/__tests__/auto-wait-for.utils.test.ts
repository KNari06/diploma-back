/**
 * Unit tests for auto-wait-for.utils
 * Tests URL normalization and auto-injection of wait_for steps
 */

import { normalizeUrlForComparison, injectAutoWaitForSteps } from '../auto-wait-for.utils';
import type { IntentStep } from '../preview.types';

describe('normalizeUrlForComparison', () => {
  it('should strip query params', () => {
    expect(normalizeUrlForComparison('https://example.com/page?foo=bar')).toBe('https://example.com/page');
  });

  it('should strip hash', () => {
    expect(normalizeUrlForComparison('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('should strip trailing slash', () => {
    expect(normalizeUrlForComparison('https://example.com/page/')).toBe('https://example.com/page');
  });

  it('should normalize complex URL', () => {
    expect(normalizeUrlForComparison('https://example.com/checkout/?utm=123#step2')).toBe('https://example.com/checkout');
  });

  it('should handle invalid URL gracefully', () => {
    expect(normalizeUrlForComparison('not-a-url')).toBe('not-a-url');
  });

  it('should handle empty string', () => {
    expect(normalizeUrlForComparison('')).toBe('');
  });
});

describe('injectAutoWaitForSteps', () => {
  // Helper to create step with compiled pageUrl
  const createStep = (
    id: string,
    type: IntentStep['type'],
    pageUrl?: string
  ): IntentStep => ({
    id,
    type,
    description: `Step ${id}`,
    ...(pageUrl && {
      compiled: {
        locatorPlan: [],
        action: { type },
        context: { pageUrl, compiledAt: new Date().toISOString() },
      },
    }),
  });

  describe('basic injection', () => {
    it('should inject wait_for when URLs differ', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('1');
      expect(result[1].type).toBe('wait_for');
      expect(result[1].options?.urlMatcher?.changedFrom).toBe('https://example.com/page1');
      expect(result[2].id).toBe('2');
    });

    it('should NOT inject when URLs are the same', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page'),
        createStep('2', 'type', 'https://example.com/page'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
      expect(result.every(s => s.type !== 'wait_for')).toBe(true);
    });

    it('should NOT inject when URLs differ only by query/hash', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page?a=1'),
        createStep('2', 'type', 'https://example.com/page?b=2#section'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });
  });

  describe('skip conditions', () => {
    it('should NOT inject after navigate step', () => {
      const steps: IntentStep[] = [
        createStep('1', 'navigate', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });

    it('should NOT inject after wait step', () => {
      const steps: IntentStep[] = [
        createStep('1', 'wait', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });

    it('should NOT inject after wait_for step', () => {
      const steps: IntentStep[] = [
        createStep('1', 'wait_for', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });

    it('should NOT inject after ai_check step', () => {
      const steps: IntentStep[] = [
        createStep('1', 'ai_check', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });

    it('should NOT inject if next step is already wait_for', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page1'),
        createStep('2', 'wait_for', 'https://example.com/page2'),
        createStep('3', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(3);
      // Only the existing wait_for, no new ones
      expect(result.filter(s => s.type === 'wait_for')).toHaveLength(1);
    });
  });

  describe('missing pageUrl', () => {
    it('should NOT inject when prev step has no pageUrl', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click'), // No pageUrl
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });

    it('should NOT inject when next step has no pageUrl', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page1'),
        createStep('2', 'type'), // No pageUrl
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty input', () => {
      expect(injectAutoWaitForSteps([])).toEqual([]);
    });

    it('should return same array for single step', () => {
      const steps: IntentStep[] = [createStep('1', 'click', 'https://example.com')];
      expect(injectAutoWaitForSteps(steps)).toEqual(steps);
    });

    it('should handle null/undefined gracefully', () => {
      expect(injectAutoWaitForSteps(null as any)).toEqual(null);
      expect(injectAutoWaitForSteps(undefined as any)).toEqual(undefined);
    });

    it('should generate unique IDs for injected steps', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
        createStep('3', 'click', 'https://example.com/page2'),
        createStep('4', 'type', 'https://example.com/page3'),
      ];

      const result = injectAutoWaitForSteps(steps);
      const injectedSteps = result.filter(s => s.type === 'wait_for');

      expect(injectedSteps).toHaveLength(2);
      expect(injectedSteps[0].id).not.toBe(injectedSteps[1].id);
      // UUIDs should be valid format
      expect(injectedSteps[0].id).toMatch(/^[a-f0-9-]{36}$/);
      expect(injectedSteps[1].id).toMatch(/^[a-f0-9-]{36}$/);
    });
  });

  describe('multiple navigations', () => {
    it('should inject multiple wait_for steps for multiple navigations', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
        createStep('3', 'click', 'https://example.com/page2'),
        createStep('4', 'type', 'https://example.com/page3'),
      ];

      const result = injectAutoWaitForSteps(steps);

      expect(result).toHaveLength(6); // 4 original + 2 injected
      expect(result[1].type).toBe('wait_for');
      expect(result[1].options?.urlMatcher?.changedFrom).toBe('https://example.com/page1');
      expect(result[4].type).toBe('wait_for');
      expect(result[4].options?.urlMatcher?.changedFrom).toBe('https://example.com/page2');
    });
  });

  describe('injected step properties', () => {
    it('should have correct properties on injected step', () => {
      const steps: IntentStep[] = [
        createStep('1', 'click', 'https://example.com/page1'),
        createStep('2', 'type', 'https://example.com/page2'),
      ];

      const result = injectAutoWaitForSteps(steps);
      const injected = result[1];

      expect(injected.type).toBe('wait_for');
      expect(injected.description).toBe('Auto: wait for URL change');
      expect(injected.options?.urlMatcher?.changedFrom).toBe('https://example.com/page1');
      // 5000ms since the March 2026 navigation-handling change (commit 25bee1cc).
      expect(injected.options?.urlMatcher?.timeoutMs).toBe(5000);
    });
  });
});
