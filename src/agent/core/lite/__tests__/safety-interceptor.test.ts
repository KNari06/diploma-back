/**
 * Tests for SafetyInterceptor — Critic Phase 1 deterministic checks.
 *
 * These tests document the always-on safety contract: every blocking
 * violation must be caught even when no AI Critic runs. They also pin
 * the warn-vs-block severity distinctions.
 */

import { SafetyInterceptor, type SafetyInput } from '../agents/safety-interceptor';
import { buildParsedSnapshot } from '../agents/parsed-snapshot';
import type { LiteElement, LiteSnapshot } from '../lite-types';

function createElement(overrides: Partial<LiteElement>): LiteElement {
  return {
    ref: overrides.ref || 'e0',
    role: overrides.role || 'button',
    name: overrides.name || '',
    tag: overrides.tag || 'button',
    visible: overrides.visible !== undefined ? overrides.visible : true,
    disabled: overrides.disabled || false,
    ...overrides,
  } as LiteElement;
}

function createSnapshot(elements: LiteElement[]): LiteSnapshot {
  return {
    url: 'https://example.com',
    title: 'Test',
    elements,
    timestamp: Date.now(),
  };
}

function buildInput(overrides: Partial<SafetyInput> = {}): SafetyInput {
  const elements = [createElement({ ref: 'e0', name: 'Submit' })];
  const snapshot = createSnapshot(elements);
  return {
    proposedCommand: { action: 'click', ref: 'e0' },
    parsedSnapshot: buildParsedSnapshot(snapshot),
    availableElements: '[BUTTONS]\n  e0: "Submit"\n',
    currentUrl: 'https://example.com',
    hasCredentials: false,
    ...overrides,
  };
}

describe('SafetyInterceptor.check', () => {
  describe('hallucination check', () => {
    it('returns safe for a valid existing ref', () => {
      const result = SafetyInterceptor.check(buildInput());

      expect(result.safe).toBe(true);
      expect(result.refExists).toBe(true);
      expect(result.policyViolations).toHaveLength(0);
    });

    it('returns unsafe for a hallucinated ref', () => {
      const result = SafetyInterceptor.check(buildInput({
        proposedCommand: { action: 'click', ref: 'e99' },
      }));

      expect(result.safe).toBe(false);
      expect(result.refExists).toBe(false);
      expect(result.reason).toContain('e99');
      expect(result.policyViolations[0].severity).toBe('block');
    });

    it('allows actions without ref (wait, press)', () => {
      const result = SafetyInterceptor.check(buildInput({
        proposedCommand: { action: 'wait' },
      }));

      expect(result.safe).toBe(true);
      expect(result.refExists).toBe(true);
    });

    it('falls back to regex when parsedSnapshot is absent', () => {
      const result = SafetyInterceptor.check(buildInput({
        parsedSnapshot: undefined,
        availableElements: '[BUTTONS]\n  e0: "Submit"\n',
      }));

      expect(result.safe).toBe(true);
      expect(result.refExists).toBe(true);
    });

    it('regex fallback also catches hallucinations', () => {
      const result = SafetyInterceptor.check(buildInput({
        parsedSnapshot: undefined,
        availableElements: '[BUTTONS]\n  e0: "Submit"\n',
        proposedCommand: { action: 'click', ref: 'e99' },
      }));

      expect(result.safe).toBe(false);
      expect(result.refExists).toBe(false);
    });
  });

  describe('forbidden actions (recovery mode only)', () => {
    it('blocks an action that matches forbiddenActions in recovery mode', () => {
      const result = SafetyInterceptor.check(buildInput({
        blackboard: {
          recoveryMode: true,
          recoveryTier: 1,
          forbiddenActions: [{ action: 'click', ref: 'e0' }],
          knownGoodUrls: [],
          backtrackFailures: 0,
          interventionCount: 1,
          stateHash: 'x',
          stateHashRepeatCount: 0,
          hardBacktrack: false,
          wrongPageCount: 0,
          jaccardSimilarity: 0,
          softLoopCount: 0,
        },
      }));

      expect(result.safe).toBe(false);
      expect(result.reason).toContain('SUPERVISOR');
    });

    it('does NOT block forbidden action when NOT in recovery mode', () => {
      const result = SafetyInterceptor.check(buildInput({
        blackboard: {
          recoveryMode: false,
          recoveryTier: 0,
          forbiddenActions: [{ action: 'click', ref: 'e0' }],
          knownGoodUrls: [],
          backtrackFailures: 0,
          interventionCount: 0,
          stateHash: 'x',
          stateHashRepeatCount: 0,
          hardBacktrack: false,
          wrongPageCount: 0,
          jaccardSimilarity: 0,
          softLoopCount: 0,
        },
      }));

      expect(result.safe).toBe(true);
    });
  });

  describe('Policy 7: covered element', () => {
    it('blocks click on a covered element', () => {
      const result = SafetyInterceptor.check(buildInput({
        coveredElements: ['e0'],
      }));

      expect(result.safe).toBe(false);
      expect(result.reason).toContain('covered');
      expect(result.policyViolations[0].severity).toBe('block');
    });
  });

  describe('Policy 4: PII leak', () => {
    it('blocks fill with credit-card-shaped value when not marked sensitive', () => {
      const result = SafetyInterceptor.check(buildInput({
        proposedCommand: {
          action: 'fill',
          ref: 'e0',
          value: '4111-1111-1111-1111',
          isSensitive: false,
        },
      }));

      expect(result.safe).toBe(false);
      expect(result.policyViolations.some(v => v.type === 'pii_leak' && v.severity === 'block')).toBe(true);
    });

    it('blocks fill with SSN-shaped value', () => {
      const result = SafetyInterceptor.check(buildInput({
        proposedCommand: {
          action: 'fill',
          ref: 'e0',
          value: '123-45-6789',
          isSensitive: false,
        },
      }));

      expect(result.safe).toBe(false);
      expect(result.policyViolations.some(v => v.type === 'pii_leak')).toBe(true);
    });
  });

  describe('Policy 3: insecure HTTP credentials (warn only)', () => {
    it('warns but allows credential fill on HTTP', () => {
      const result = SafetyInterceptor.check(buildInput({
        currentUrl: 'http://example.com',
        hasCredentials: true,
        proposedCommand: { action: 'fill', ref: 'e0', isSensitive: true, value: 'secret' },
      }));

      expect(result.safe).toBe(true); // warn, not block
      expect(result.policyViolations.some(v => v.severity === 'warn' && v.type === 'password_exposure')).toBe(true);
    });
  });

  describe('Policy 2: external domain navigation (warn only)', () => {
    it('warns but allows goto to external domain', () => {
      const result = SafetyInterceptor.check(buildInput({
        proposedCommand: { action: 'goto', url: 'https://other.com/path' },
        currentUrl: 'https://example.com',
      }));

      expect(result.safe).toBe(true);
      expect(result.policyViolations.some(v => v.type === 'external_navigation')).toBe(true);
    });
  });

  describe('Policy 6: click during loading (warn only)', () => {
    it('warns but allows click while page is loading', () => {
      const result = SafetyInterceptor.check(buildInput({
        isPageLoading: true,
      }));

      expect(result.safe).toBe(true);
      expect(result.policyViolations.some(v => v.type === 'unsafe_action')).toBe(true);
    });
  });

  describe('vision conflicts', () => {
    it('blocks click on element marked as covered in vision conflicts', () => {
      const result = SafetyInterceptor.check(buildInput({
        visionConflicts: [
          { domRef: 'e0', issue: 'covered', domName: 'Submit', visionText: 'Submit', note: 'covered by overlay' },
        ],
      }));

      expect(result.safe).toBe(false);
      expect(result.policyViolations.some(v => v.severity === 'block')).toBe(true);
    });

    it('warns but allows click on element marked as disabled in vision conflicts', () => {
      const result = SafetyInterceptor.check(buildInput({
        visionConflicts: [
          { domRef: 'e0', issue: 'disabled', domName: 'Submit', visionText: 'Submit', note: 'element is disabled' },
        ],
      }));

      expect(result.safe).toBe(true);
      expect(result.policyViolations.some(v => v.severity === 'warn')).toBe(true);
    });
  });
});
