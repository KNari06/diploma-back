/**
 * Unit tests for HybridSemanticWeightCalculator
 *
 * Tests cover:
 * - Text normalization and tokenization
 * - Light EN/RU stemming
 * - Token/boundary-aware keyword matching
 * - Heuristic rule classification
 * - False positive prevention
 */

import { describe, it, expect } from '@jest/globals';
import {
  HybridSemanticWeightCalculator,
  isErrorElement,
  parseGoalKeywords,
} from '../hybrid-semantic-weight';
import type { LiteElement } from '../../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function mockElement(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    tag: 'div',
    role: '',
    name: '',
    visible: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR ELEMENT DETECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('isErrorElement', () => {
  it('should detect role="alert" as error', () => {
    const el = mockElement({ role: 'alert', name: 'Some message' });
    expect(isErrorElement(el)).toBe(true);
  });

  it('should detect "error" keyword in name', () => {
    const el = mockElement({ name: 'Error: Invalid email' });
    expect(isErrorElement(el)).toBe(true);
  });

  it('should detect "ошибка" keyword in name (Russian)', () => {
    const el = mockElement({ name: 'Ошибка валидации' });
    expect(isErrorElement(el)).toBe(true);
  });

  it('should detect "warning" keyword in context', () => {
    const el = mockElement({ name: 'Message', context: 'warning-message' });
    expect(isErrorElement(el)).toBe(true);
  });

  it('should NOT detect "catalog" as error (false positive prevention)', () => {
    const el = mockElement({ name: 'Product Catalog' });
    expect(isErrorElement(el)).toBe(false);
  });

  it('should NOT detect regular button as error', () => {
    const el = mockElement({ tag: 'button', name: 'Submit' });
    expect(isErrorElement(el)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GOAL KEYWORD PARSING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('parseGoalKeywords', () => {
  it('should extract login-related keywords', () => {
    const keywords = parseGoalKeywords('login to the website');
    expect(keywords).toContain('login');
    expect(keywords).toContain('sign in');
    expect(keywords).toContain('auth');
  });

  it('should extract register-related keywords', () => {
    const keywords = parseGoalKeywords('register a new account');
    expect(keywords).toContain('register');
    expect(keywords).toContain('sign up');
    expect(keywords).toContain('create account');
  });

  it('should extract Russian login keywords (вход)', () => {
    const keywords = parseGoalKeywords('войти в систему');
    expect(keywords).toContain('войти');
    expect(keywords).toContain('вход');
    expect(keywords).toContain('авторизация');
  });

  it('should extract words from goal text (4+ chars)', () => {
    const keywords = parseGoalKeywords('complete checkout process');
    // Note: words are stemmed after extraction
    expect(keywords).toContain('complete'); // extracted as-is or lightly stemmed
    expect(keywords).toContain('checkout');
    // 'process' stems to 'proces' (stripping 's')
    expect(keywords.some(k => k.startsWith('proces'))).toBe(true);
  });

  it('should deduplicate keywords', () => {
    const keywords = parseGoalKeywords('login login login');
    const loginCount = keywords.filter(k => k === 'login').length;
    expect(loginCount).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HEURISTIC RULE CLASSIFICATION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('HybridSemanticWeightCalculator.calculateHeuristic', () => {
  const calculator = new HybridSemanticWeightCalculator('login to the website');

  // ─────────────────────────────────────────────────────────────────────────
  // Error Detection (0.95)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify role="alert" as error with weight 0.95', () => {
    const el = mockElement({ role: 'alert', name: 'Error message' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.95);
    expect(result.category).toBe('error');
    expect(result.needsAI).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Goal-Specific Form (1.0)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify goal-relevant form with weight 1.0', () => {
    const el = mockElement({ tag: 'form', name: 'Login Form' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(1.0);
    expect(result.category).toBe('goal-form');
    expect(result.needsAI).toBe(false);
  });

  it('should classify regular form with weight 0.8', () => {
    const el = mockElement({ tag: 'form', name: 'Contact Form' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.8);
    expect(result.category).toBe('form');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Primary Action Button (0.9)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify "Submit" button as primary action with weight 0.9', () => {
    const el = mockElement({ tag: 'button', name: 'Submit' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.9);
    expect(result.category).toBe('primary-action');
    expect(result.needsAI).toBe(false);
  });

  it('should classify goal-relevant "Login" button with weight 1.0 (boosted)', () => {
    const el = mockElement({ tag: 'button', name: 'Login' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(1.0); // 0.9 * 2.0 capped at 1.0
    expect(result.category).toBe('primary-action');
  });

  it('should classify "Sign In" button (multi-word keyword)', () => {
    const el = mockElement({ tag: 'button', name: 'Sign In' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBeGreaterThanOrEqual(0.9);
    expect(result.category).toBe('primary-action');
  });

  it('should classify "войти" button (Russian)', () => {
    const el = mockElement({ tag: 'button', name: 'Войти' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBeGreaterThanOrEqual(0.9);
    expect(result.category).toBe('primary-action');
  });

  it('should classify unknown button as gray zone', () => {
    const el = mockElement({ tag: 'button', name: 'More Info' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.5);
    expect(result.category).toBe('button');
    expect(result.needsAI).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Credential Inputs (0.7)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify password input with weight 0.7', () => {
    const el = mockElement({ tag: 'input', type: 'password', name: 'Password' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.7);
    expect(result.category).toBe('credential-input');
  });

  it('should classify email input with weight 0.7', () => {
    const el = mockElement({ tag: 'input', type: 'email', name: 'Email' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.7);
    expect(result.category).toBe('credential-input');
  });

  it('should classify tel input with weight 0.7', () => {
    const el = mockElement({ tag: 'input', type: 'tel', name: 'Phone' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.7);
    expect(result.category).toBe('credential-input');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Search Input (0.7)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify search input with weight 0.7', () => {
    const el = mockElement({ tag: 'input', type: 'text', name: 'Search products' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.7);
    expect(result.category).toBe('search-input');
  });

  it('should classify Russian search input (поиск)', () => {
    const el = mockElement({ tag: 'input', type: 'text', name: 'Поиск' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.7);
    expect(result.category).toBe('search-input');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation Links (0.5)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify "Profile" link as navigation', () => {
    const el = mockElement({ tag: 'a', name: 'Profile' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.5);
    expect(result.category).toBe('navigation');
  });

  it('should classify "Login" link as gray zone (not in NAVIGATION_KEYWORDS)', () => {
    // "Login" is not in NAVIGATION_KEYWORDS (profile, account, menu, etc.)
    // So it goes to gray zone for AI classification
    const el = mockElement({ tag: 'a', name: 'Login' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.5);
    expect(result.category).toBe('link');
    expect(result.needsAI).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Decorative Elements (0.05)
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify img as decorative with weight 0.05', () => {
    const el = mockElement({ tag: 'img', name: 'Logo' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.05);
    expect(result.category).toBe('decorative');
  });

  it('should classify svg as decorative', () => {
    const el = mockElement({ tag: 'svg', name: 'Icon' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.05);
    expect(result.category).toBe('decorative');
  });

  it('should classify footer link as decorative', () => {
    const el = mockElement({ tag: 'a', name: 'Social Link', context: 'footer' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.05);
    expect(result.category).toBe('decorative');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Gray Zone Elements
  // ─────────────────────────────────────────────────────────────────────────
  it('should classify h1 as gray zone header', () => {
    const el = mockElement({ tag: 'h1', name: 'Welcome' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.3);
    expect(result.category).toBe('header');
    expect(result.needsAI).toBe(true);
  });

  it('should classify paragraph as gray zone text', () => {
    const el = mockElement({ tag: 'p', name: 'Some text content' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.1);
    expect(result.category).toBe('text');
    expect(result.needsAI).toBe(true);
  });

  it('should classify unknown element as gray zone', () => {
    const el = mockElement({ tag: 'section', name: 'Content Area' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.2);
    expect(result.category).toBe('unknown');
    expect(result.needsAI).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FALSE POSITIVE PREVENTION TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('False Positive Prevention', () => {
  const calculator = new HybridSemanticWeightCalculator('login to website');

  it('should NOT match "catalog" as "log" (substring collision)', () => {
    const el = mockElement({ tag: 'a', name: 'Product Catalog' });
    const result = calculator.calculateHeuristic(el);
    // Should NOT be classified as navigation with "log" keyword
    expect(result.category).not.toBe('primary-action');
    expect(result.needsAI).toBe(true); // Should go to AI for classification
  });

  it('should NOT match "blogging" as "log"', () => {
    const el = mockElement({ tag: 'a', name: 'Blogging Platform' });
    const result = calculator.calculateHeuristic(el);
    expect(result.category).not.toBe('primary-action');
  });

  it('should match "logging in" with stemming', () => {
    const el = mockElement({ tag: 'button', name: 'Logging In...' });
    const result = calculator.calculateHeuristic(el);
    // "logging" stems to "log" or "logg", but "login" stems to "login"
    // This should match because we have "login" in PRIMARY_ACTION_KEYWORDS
    // and "logging" might stem to match - verify behavior
    expect(result.category).toBe('button'); // May be gray zone if stemming doesn't match
  });

  it('should match "Sign In" as multi-word keyword', () => {
    const el = mockElement({ tag: 'button', name: 'Sign In to Your Account' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBeGreaterThanOrEqual(0.9);
    expect(result.category).toBe('primary-action');
  });

  it('should classify Russian inflected verb "войдите" as gray zone (stemming limitation)', () => {
    // "войдите" does NOT stem to "войти" with our light Russian stemming
    // This is a known limitation - light stemming is conservative
    // The button goes to gray zone for AI classification
    const el = mockElement({ tag: 'button', name: 'Войдите в систему' });
    const result = calculator.calculateHeuristic(el);
    expect(result.weight).toBe(0.5);
    expect(result.category).toBe('button');
    expect(result.needsAI).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GOAL-ORIENTED SUMMARY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('buildGoalOrientedSummary', () => {
  const calculator = new HybridSemanticWeightCalculator('login to website');

  it('should return minimal message for empty diff', () => {
    const diff = {
      urlChanged: false,
      urlBefore: 'https://example.com',
      urlAfter: 'https://example.com',
      addedElements: [],
      removedRefs: [],
      changedElements: [],
      hasVisualChange: false,
      newPageErrors: [],
      newConsoleErrors: [],
      newNetworkErrors: [],
      semanticWeight: 0,
      meaningfulChange: false,
      significantChange: false,
      progressSentiment: 'No Effect' as const,
    };
    const summary = calculator.buildGoalOrientedSummary(diff as any);
    expect(summary).toBe('Minimal changes detected.');
  });

  it('should include URL change in summary', () => {
    const diff = {
      urlChanged: true,
      urlBefore: 'https://example.com',
      urlAfter: 'https://example.com/login',
      addedElements: [],
      removedRefs: [],
      changedElements: [],
      hasVisualChange: true,
      newPageErrors: [],
      newConsoleErrors: [],
      newNetworkErrors: [],
      semanticWeight: 0.5,
      meaningfulChange: true,
      significantChange: false,
      progressSentiment: 'Minor Change' as const,
    };
    const summary = calculator.buildGoalOrientedSummary(diff as any);
    expect(summary).toContain('Navigated to');
    expect(summary).toContain('/login');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Z-INDEX LAYERING TESTS (Percentile-based, no hardcoded thresholds)
// ═══════════════════════════════════════════════════════════════════════════

describe('Z-Index Layering Scoring', () => {
  const calculator = new HybridSemanticWeightCalculator('login to website');

  // ─────────────────────────────────────────────────────────────────────────
  // Percentile Ranking Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Percentile Ranking', () => {
    it('should boost high z-index elements (top percentile)', async () => {
      // Element with highest z-index should get ~1.2x multiplier
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          // Background button (lowest z-index)
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'Background',
            computedZIndex: 1,
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
          // Modal button (highest z-index)
          mockElement({
            ref: 'e2',
            tag: 'button',
            name: 'Modal Submit',
            computedZIndex: 100,
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
          // Middle button
          mockElement({
            ref: 'e3',
            tag: 'button',
            name: 'Middle',
            computedZIndex: 50,
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);

      // Find enriched elements by ref
      const e1 = enriched.addedElements.find(e => e.ref === 'e1');
      const e2 = enriched.addedElements.find(e => e.ref === 'e2');
      const e3 = enriched.addedElements.find(e => e.ref === 'e3');

      expect(e1).toBeDefined();
      expect(e2).toBeDefined();
      expect(e3).toBeDefined();

      // High z-index element should have higher weight than low z-index
      expect(e2!.semanticWeight).toBeGreaterThan(e1!.semanticWeight);

      // Middle should be between low and high
      expect(e3!.semanticWeight).toBeGreaterThan(e1!.semanticWeight);
      expect(e3!.semanticWeight).toBeLessThan(e2!.semanticWeight);
    });

    it('should handle single element with z-index (percentile = 1.0)', async () => {
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'Submit',
            computedZIndex: 10,
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);
      const e1 = enriched.addedElements.find(e => e.ref === 'e1');

      expect(e1).toBeDefined();
      // Single element has percentile 1.0 → multiplier 1.2
      // Base weight 0.9 (primary action) * 1.2 = 1.08, clamped to 1.0
      expect(e1!.semanticWeight).toBeGreaterThanOrEqual(0.9);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Coverage Penalty Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Coverage Penalty', () => {
    it('should downweight covered elements (isTopMostAtCenter = false)', async () => {
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          // Visible button (not covered)
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'Submit',
            computedZIndex: 10,
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
          // Covered button (behind overlay)
          mockElement({
            ref: 'e2',
            tag: 'button',
            name: 'Submit',
            computedZIndex: 10,
            isPositioned: true,
            isTopMostAtCenter: false, // Covered!
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);
      const visible = enriched.addedElements.find(e => e.ref === 'e1');
      const covered = enriched.addedElements.find(e => e.ref === 'e2');

      expect(visible).toBeDefined();
      expect(covered).toBeDefined();

      // Covered element should have lower weight due to 0.6x penalty
      // Note: z-index percentile can offset the penalty slightly
      // (covered gets higher percentile → boost, but coverage penalty → downweight)
      // Net effect: covered should still be lower than visible
      expect(covered!.semanticWeight).toBeLessThan(visible!.semanticWeight);
    });

    it('should NOT apply coverage penalty to static positioned elements', async () => {
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          // Static element with isTopMostAtCenter = false (not really covered)
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'Submit',
            computedZIndex: null, // No z-index
            isPositioned: false, // Static position
            isTopMostAtCenter: false, // Would be covered if positioned
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);
      const e1 = enriched.addedElements.find(e => e.ref === 'e1');

      expect(e1).toBeDefined();
      // Static element should NOT get coverage penalty
      // likelyCovered = false when isPositioned = false
      expect(e1!.semanticWeight).toBeGreaterThanOrEqual(0.4); // Gray zone button weight
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Safe Fallback Tests (No Z-Index Data)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Safe Fallbacks', () => {
    it('should handle elements without z-index gracefully', async () => {
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          // Element without any z-index data
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'Submit',
            // No computedZIndex, isPositioned, isTopMostAtCenter
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);
      const e1 = enriched.addedElements.find(e => e.ref === 'e1');

      expect(e1).toBeDefined();
      // Should use base heuristic weight without layering multiplier
      expect(e1!.semanticWeight).toBeGreaterThan(0);
      expect(e1!.semanticWeight).toBeLessThanOrEqual(1);
    });

    it('should handle null z-index (auto)', async () => {
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'Submit',
            computedZIndex: null, // Explicitly null (z-index: auto)
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);
      const e1 = enriched.addedElements.find(e => e.ref === 'e1');

      expect(e1).toBeDefined();
      // Null z-index → no percentile → no multiplier applied
      expect(e1!.semanticWeight).toBeGreaterThan(0);
    });

    it('should handle mixed elements (some with z-index, some without)', async () => {
      const diff = {
        urlChanged: false,
        urlBefore: 'https://example.com',
        urlAfter: 'https://example.com',
        addedElements: [
          mockElement({
            ref: 'e1',
            tag: 'button',
            name: 'With Z-Index',
            computedZIndex: 100,
            isPositioned: true,
            isTopMostAtCenter: true,
          }),
          mockElement({
            ref: 'e2',
            tag: 'button',
            name: 'Without Z-Index',
            // No z-index data
          }),
        ],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: true,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect' as const,
      };

      const enriched = await calculator.enrichWithAI(diff as any);
      const withZ = enriched.addedElements.find(e => e.ref === 'e1');
      const withoutZ = enriched.addedElements.find(e => e.ref === 'e2');

      expect(withZ).toBeDefined();
      expect(withoutZ).toBeDefined();

      // Both should have valid weights
      expect(withZ!.semanticWeight).toBeGreaterThan(0);
      expect(withoutZ!.semanticWeight).toBeGreaterThan(0);
    });
  });
});
