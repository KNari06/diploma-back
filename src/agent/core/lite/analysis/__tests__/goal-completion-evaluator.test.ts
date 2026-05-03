/**
 * Comprehensive tests for AI-based GoalCompletionEvaluator.
 * Covers: AI prompt construction, heuristic hints, error/timeout handling,
 * edge cases (empty snapshots, quiet success, intermediate auth pages, cancellation).
 */

import type { LiteElement, LiteSnapshot, StateDiff, GoalCompletionResult } from '../../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// MOCKS
// ═══════════════════════════════════════════════════════════════════════════

let mockAskJsonResult: unknown = null;
let mockAskJsonShouldThrow: Error | null = null;
let lastAskJsonPrompt: string = '';
let lastAskJsonOptions: Record<string, unknown> = {};

jest.mock('../../prompt/lite-prompt-builder', () => ({
  LitePromptBuilder: {
    askJson: jest.fn(async (prompt: string, options: Record<string, unknown>) => {
      lastAskJsonPrompt = prompt;
      lastAskJsonOptions = options;
      if (mockAskJsonShouldThrow) throw mockAskJsonShouldThrow;
      return mockAskJsonResult;
    }),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import { GoalCompletionEvaluator } from '../goal-completion-evaluator';

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

function makeElement(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e1',
    role: 'textbox',
    name: '',
    tag: 'input',
    visible: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<LiteSnapshot> = {}): LiteSnapshot {
  return {
    url: 'https://example.com',
    title: 'Example',
    elements: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeDiff(overrides: Partial<StateDiff> = {}): StateDiff {
  return {
    urlChanged: false,
    urlBefore: 'https://example.com',
    urlAfter: 'https://example.com',
    addedElements: [],
    removedRefs: [],
    changedElements: [],
    hasVisualChange: false,
    newPageErrors: [],
    newConsoleErrors: [],
    semanticWeight: 0,
    meaningfulChange: false,
    significantChange: false,
    progressSentiment: 'No Effect',
    ...overrides,
  };
}

// Login page → dashboard transition fixtures
function makeAuthLoginSnapshot(): LiteSnapshot {
  return makeSnapshot({
    url: 'https://juz40-edu.kz/login',
    title: 'Авторизация',
    elements: [
      makeElement({ ref: 'e1', tag: 'input', type: 'text', name: 'email', placeholder: 'Email', visible: true }),
      makeElement({ ref: 'e2', tag: 'input', type: 'password', name: 'password', placeholder: 'Пароль', visible: true }),
      makeElement({ ref: 'e3', tag: 'button', name: 'Войти', visible: true }),
    ],
  });
}

function makeAuthDashboardSnapshot(): LiteSnapshot {
  return makeSnapshot({
    url: 'https://juz40-edu.kz/admin/empty-page',
    title: 'Панель управления',
    elements: [
      makeElement({ ref: 'e10', tag: 'a', name: 'Выйти', visible: true }),
      makeElement({ ref: 'e11', tag: 'div', name: 'Добро пожаловать, Admin', visible: true }),
      makeElement({ ref: 'e12', tag: 'nav', name: 'Главное меню', visible: true }),
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('GoalCompletionEvaluator', () => {
  let evaluator: GoalCompletionEvaluator;

  beforeEach(() => {
    evaluator = new GoalCompletionEvaluator('test-123');
    mockAskJsonResult = null;
    mockAskJsonShouldThrow = null;
    lastAskJsonPrompt = '';
    lastAskJsonOptions = {};
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. BASIC AI CALL — Verify askJson is called with correct params
  // ─────────────────────────────────────────────────────────────────────
  describe('AI call setup', () => {
    it('should use the configured fast model with low temperature', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Not done' };

      await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login to the site'
      );

      // Read from config rather than hardcoding a model name — the
      // fast model gets bumped (gpt-4o-mini → gpt-5.4-mini → ...)
      // without notice and we don't want this test to be the canary
      // for OpenAI version updates. Asserts the evaluator wires the
      // right CONFIG slot, which is the actual contract.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AI_TASK_MODELS } = require('@/config/ai/ai-models.config');
      expect(lastAskJsonOptions.model).toBe(AI_TASK_MODELS.goalDetection);
      expect(lastAskJsonOptions.temperature).toBe(0.05);
      // 400 since we added STATE CHANGES + NOTATION HINTS + ELEMENT
      // FIELD CHANGES blocks for Radix/shadcn data-state visibility.
      expect(lastAskJsonOptions.maxTokens).toBe(400);
      expect(lastAskJsonOptions.timeoutMs).toBe(8000);
    });

    it('should include GOAL in the prompt', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Not done' };

      await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Authorize using admin@test.com'
      );

      expect(lastAskJsonPrompt).toContain('GOAL: Authorize using admin@test.com');
    });

    it('should include BEFORE and AFTER URLs in the prompt', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Not done' };

      const before = makeSnapshot({ url: 'https://site.com/login' });
      const after = makeSnapshot({ url: 'https://site.com/dashboard' });

      await evaluator.evaluate(before, after, makeDiff({ urlChanged: true }), 'Login');

      expect(lastAskJsonPrompt).toContain('https://site.com/login');
      expect(lastAskJsonPrompt).toContain('https://site.com/dashboard');
    });

    it('should include state change info in the prompt', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.2, reason: 'Form still there' };

      const diff = makeDiff({
        urlChanged: true,
        addedElements: [makeElement({ ref: 'new1' }), makeElement({ ref: 'new2' })],
        removedRefs: ['old1'],
      });

      await evaluator.evaluate(makeSnapshot(), makeSnapshot(), diff, 'Login');

      expect(lastAskJsonPrompt).toContain('URL changed: yes');
      expect(lastAskJsonPrompt).toContain('Elements added: 2');
      expect(lastAskJsonPrompt).toContain('Elements removed: 1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. REALISTIC SCENARIO: Login → Dashboard (juz40-edu.kz case)
  // ─────────────────────────────────────────────────────────────────────
  describe('Login success scenario (juz40-edu.kz)', () => {
    it('should return isDone=true when AI confirms login success', async () => {
      mockAskJsonResult = {
        isDone: true,
        confidence: 0.95,
        reason: 'Landed on admin panel, login form disappeared, logout visible',
      };

      const before = makeAuthLoginSnapshot();
      const after = makeAuthDashboardSnapshot();
      const diff = makeDiff({
        urlChanged: true,
        urlBefore: before.url,
        urlAfter: after.url,
        removedRefs: ['e1', 'e2', 'e3'],
        addedElements: after.elements,
        hasVisualChange: true,
      });

      const result = await evaluator.evaluate(before, after, diff, 'Авторизоваться на сайте https://juz40-edu.kz');

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(result.transitionSummary).toContain('juz40-edu.kz/login');
      expect(result.transitionSummary).toContain('juz40-edu.kz/admin/empty-page');
    });

    it('should include heuristic hints about auth form disappearance', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.9, reason: 'Done' };

      const before = makeAuthLoginSnapshot();
      const after = makeAuthDashboardSnapshot();
      const diff = makeDiff({ urlChanged: true });

      await evaluator.evaluate(before, after, diff, 'Login to juz40-edu.kz');

      expect(lastAskJsonPrompt).toContain('DETECTED SIGNALS');
      expect(lastAskJsonPrompt).toContain('Left auth page');
      expect(lastAskJsonPrompt).toContain('Login/register form disappeared');
      expect(lastAskJsonPrompt).toContain('Authenticated UI appeared');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. "QUIET" SUCCESS — URL same, DOM barely changes
  // ─────────────────────────────────────────────────────────────────────
  describe('Quiet success (same URL, minimal DOM change)', () => {
    it('should still query AI even without strong heuristic signals', async () => {
      mockAskJsonResult = {
        isDone: true,
        confidence: 0.75,
        reason: 'Welcome text appeared, no login form visible',
      };

      const before = makeSnapshot({
        url: 'https://quiet-site.com/app',
        title: 'App',
        elements: [
          makeElement({ ref: 'e1', tag: 'input', type: 'text', name: 'username', visible: true }),
          makeElement({ ref: 'e2', tag: 'input', type: 'password', name: 'pass', visible: true }),
        ],
      });
      const after = makeSnapshot({
        url: 'https://quiet-site.com/app',
        title: 'App',
        elements: [
          makeElement({ ref: 'e5', tag: 'span', name: 'Welcome, User!', visible: true }),
        ],
      });
      const diff = makeDiff({ urlChanged: false, hasVisualChange: true });

      const result = await evaluator.evaluate(before, after, diff, 'Login to quiet-site.com');

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBe(0.75);
    });

    it('should report no strong signals in transition summary when URL unchanged', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.3, reason: 'Unclear' };

      const snapshot = makeSnapshot({ url: 'https://x.com/app', title: 'App' });
      const diff = makeDiff({ urlChanged: false });

      const result = await evaluator.evaluate(snapshot, snapshot, diff, 'Do something');

      expect(result.transitionSummary).toContain('URL unchanged');
      expect(result.transitionSummary).toContain('Title unchanged');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. INTERMEDIATE AUTH PAGES (2FA, verify, reset)
  // ─────────────────────────────────────────────────────────────────────
  describe('Intermediate auth pages', () => {
    it('should include 2FA warning hint when landing on verification page', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.2, reason: '2FA page, not final' };

      const before = makeAuthLoginSnapshot();
      const after = makeSnapshot({
        url: 'https://site.com/verify-code',
        title: 'Enter verification code',
        elements: [
          makeElement({ ref: 'e1', tag: 'input', type: 'text', name: 'code', placeholder: 'Enter OTP', visible: true }),
        ],
      });
      const diff = makeDiff({ urlChanged: true });

      await evaluator.evaluate(before, after, diff, 'Sign in to site.com');

      expect(lastAskJsonPrompt).toContain('intermediate auth page');
      expect(lastAskJsonPrompt).toContain('NOT done');
    });

    it('should include warning for forgot password page', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Reset page' };

      const after = makeSnapshot({ url: 'https://site.com/forgot-password', title: 'Reset' });
      const diff = makeDiff({ urlChanged: true });

      await evaluator.evaluate(makeAuthLoginSnapshot(), after, diff, 'Login');

      expect(lastAskJsonPrompt).toContain('intermediate auth page');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. ERROR DETECTION
  // ─────────────────────────────────────────────────────────────────────
  describe('Error detection', () => {
    it('should detect error indicators on the page', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Login error visible' };

      const after = makeSnapshot({
        url: 'https://site.com/login',
        title: 'Login',
        elements: [
          makeElement({ ref: 'e1', tag: 'div', name: 'Ошибка: неверный пароль', visible: true }),
          makeElement({ ref: 'e2', tag: 'input', type: 'password', visible: true }),
          makeElement({ ref: 'e3', tag: 'input', type: 'text', name: 'email', visible: true }),
        ],
      });
      const diff = makeDiff({ urlChanged: false });

      await evaluator.evaluate(makeAuthLoginSnapshot(), after, diff, 'Войти на сайт');

      expect(lastAskJsonPrompt).toContain('Error indicators detected');
    });

    it('should detect English error messages', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.05, reason: 'Error state' };

      const after = makeSnapshot({
        url: 'https://site.com/login',
        title: 'Login failed',
        elements: [
          makeElement({ ref: 'e1', tag: 'span', name: 'invalid credentials', visible: true }),
        ],
      });

      await evaluator.evaluate(makeSnapshot(), after, makeDiff(), 'Login');

      expect(lastAskJsonPrompt).toContain('Error indicators detected');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. NON-AUTH GOALS (checkout, search)
  // ─────────────────────────────────────────────────────────────────────
  describe('Non-auth goals', () => {
    it('should work for checkout goal without auth-specific hints', async () => {
      mockAskJsonResult = {
        isDone: true,
        confidence: 0.92,
        reason: 'Order confirmation page with thank you message',
      };

      const before = makeSnapshot({ url: 'https://shop.com/checkout', title: 'Checkout' });
      const after = makeSnapshot({
        url: 'https://shop.com/order/confirmed',
        title: 'Order Confirmed',
        elements: [makeElement({ ref: 'e1', tag: 'h1', name: 'Thank you for your order!', visible: true })],
      });
      const diff = makeDiff({ urlChanged: true });

      const result = await evaluator.evaluate(before, after, diff, 'Complete checkout and pay for order');

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      // Should NOT have auth-specific hints
      expect(lastAskJsonPrompt).not.toContain('auth page');
      expect(lastAskJsonPrompt).not.toContain('Login/register form disappeared');
    });

    it('should work for search goal', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.88, reason: 'Search results are displayed' };

      const before = makeSnapshot({ url: 'https://google.com', title: 'Google' });
      const after = makeSnapshot({
        url: 'https://google.com/search?q=test',
        title: 'test - Google Search',
        elements: [makeElement({ ref: 'e1', tag: 'div', name: 'About 10 results', visible: true })],
      });

      const result = await evaluator.evaluate(before, after, makeDiff({ urlChanged: true }), 'Search for test');

      expect(result.isDone).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. AI TIMEOUT / FAILURE
  // ─────────────────────────────────────────────────────────────────────
  describe('AI timeout and failure', () => {
    it('should return isDone=false when AI returns null (timeout)', async () => {
      mockAskJsonResult = null;

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toContain('timed out');
      expect(result.transitionSummary).toBeTruthy();
    });

    it('should return isDone=false on non-cancellation error', async () => {
      mockAskJsonShouldThrow = new Error('OpenAI API rate limit exceeded');

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe('Evaluation error');
    });

    it('should re-throw cancellation errors', async () => {
      mockAskJsonShouldThrow = new Error('Test cancelled');

      await expect(
        evaluator.evaluate(makeSnapshot(), makeSnapshot(), makeDiff(), 'Login')
      ).rejects.toThrow('cancelled');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. AI RESPONSE EDGE CASES
  // ─────────────────────────────────────────────────────────────────────
  describe('AI response edge cases', () => {
    it('should handle missing isDone field (default to false)', async () => {
      mockAskJsonResult = { confidence: 0.8, reason: 'Looks done' };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(false);
    });

    it('should handle missing confidence field (default to 0)', async () => {
      mockAskJsonResult = { isDone: true, reason: 'Done' };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBe(0);
    });

    it('should clamp confidence to [0, 1] range', async () => {
      mockAskJsonResult = { isDone: true, confidence: 1.5, reason: 'Very done' };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.confidence).toBe(1);
    });

    it('should clamp negative confidence to 0', async () => {
      mockAskJsonResult = { isDone: false, confidence: -0.3, reason: 'Error' };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.confidence).toBe(0);
    });

    it('should handle missing reason field', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.7 };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.reason).toBe('No reason provided');
    });

    it('should handle empty object response', async () => {
      mockAskJsonResult = {};

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.reason).toBe('No reason provided');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. HEURISTIC HINTS — Detailed signal coverage
  // ─────────────────────────────────────────────────────────────────────
  describe('Heuristic hints correctness', () => {
    it('should detect URL transition hint', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.3, reason: 'Not done' };

      const diff = makeDiff({ urlChanged: true });

      await evaluator.evaluate(
        makeSnapshot({ url: 'https://a.com/page1' }),
        makeSnapshot({ url: 'https://a.com/page2' }),
        diff,
        'Do something'
      );

      expect(lastAskJsonPrompt).toContain('URL transitioned');
    });

    it('should detect title change hint', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.3, reason: 'No' };

      await evaluator.evaluate(
        makeSnapshot({ title: 'Old Title' }),
        makeSnapshot({ title: 'New Title' }),
        makeDiff(),
        'Navigate somewhere'
      );

      expect(lastAskJsonPrompt).toContain('Page title changed');
      expect(lastAskJsonPrompt).toContain('"Old Title"');
      expect(lastAskJsonPrompt).toContain('"New Title"');
    });

    it('should detect success keywords appearance', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.8, reason: 'Dashboard appeared' };

      const before = makeSnapshot({ elements: [] });
      const after = makeSnapshot({
        elements: [makeElement({ ref: 'e1', name: 'Welcome to dashboard', visible: true })],
      });

      await evaluator.evaluate(before, after, makeDiff(), 'Login');

      expect(lastAskJsonPrompt).toContain('Success keywords appeared');
    });

    it('should NOT produce auth hints for non-auth goals', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      const before = makeSnapshot({
        url: 'https://shop.com/login',
        elements: [
          makeElement({ ref: 'e1', tag: 'input', type: 'text', name: 'email', visible: true }),
          makeElement({ ref: 'e2', tag: 'input', type: 'password', visible: true }),
        ],
      });
      const after = makeSnapshot({ url: 'https://shop.com/products' });

      await evaluator.evaluate(before, after, makeDiff({ urlChanged: true }), 'Buy a product');

      expect(lastAskJsonPrompt).not.toContain('Left auth page');
      expect(lastAskJsonPrompt).not.toContain('Login/register form disappeared');
    });

    it('should generate no DETECTED SIGNALS section when no hints match', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Nothing changed' };

      const snapshot = makeSnapshot({
        url: 'https://x.com/page',
        title: 'Page',
        elements: [makeElement({ ref: 'e1', tag: 'div', name: 'content', visible: true })],
      });

      await evaluator.evaluate(snapshot, snapshot, makeDiff(), 'Buy a product');

      expect(lastAskJsonPrompt).not.toContain('DETECTED SIGNALS');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. SNAPSHOT SUMMARY
  // ─────────────────────────────────────────────────────────────────────
  describe('Snapshot summary for prompt', () => {
    it('should include visible element tags and names in prompt', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      const snapshot = makeSnapshot({
        elements: [
          makeElement({ ref: 'e1', tag: 'button', name: 'Submit Order', visible: true }),
          makeElement({ ref: 'e2', tag: 'input', type: 'text', placeholder: 'Search...', visible: true }),
          makeElement({ ref: 'e3', tag: 'a', name: 'Home', visible: false }),
        ],
      });

      await evaluator.evaluate(snapshot, snapshot, makeDiff(), 'Test');

      expect(lastAskJsonPrompt).toContain('button: Submit Order');
      expect(lastAskJsonPrompt).toContain('input[text]: Search...');
      // Hidden element should be excluded
      expect(lastAskJsonPrompt).not.toContain('Home');
    });

    it('should handle snapshot with no visible elements', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0, reason: 'Empty page' };

      const snapshot = makeSnapshot({ elements: [] });

      await evaluator.evaluate(snapshot, snapshot, makeDiff(), 'Test');

      expect(lastAskJsonPrompt).toContain('(no visible elements)');
    });

    it('should limit elements to maxElements (20)', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      const elements: LiteElement[] = [];
      for (let i = 0; i < 50; i++) {
        elements.push(makeElement({
          ref: `e${i}`,
          tag: 'div',
          name: `Element ${i}`,
          visible: true,
        }));
      }
      const snapshot = makeSnapshot({ elements });

      await evaluator.evaluate(snapshot, snapshot, makeDiff(), 'Test');

      // Should NOT contain elements beyond index 19
      expect(lastAskJsonPrompt).toContain('Element 0');
      expect(lastAskJsonPrompt).toContain('Element 19');
      expect(lastAskJsonPrompt).not.toContain('Element 20');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. TRANSITION SUMMARY
  // ─────────────────────────────────────────────────────────────────────
  describe('Transition summary format', () => {
    it('should format URL change in transition summary', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.3, reason: 'Not done' };

      const result = await evaluator.evaluate(
        makeSnapshot({ url: 'https://site.com/login' }),
        makeSnapshot({ url: 'https://site.com/dashboard' }),
        makeDiff({ urlChanged: true }),
        'Login'
      );

      expect(result.transitionSummary).toContain('URL: https://site.com/login -> https://site.com/dashboard');
    });

    it('should format URL unchanged in transition summary', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      const result = await evaluator.evaluate(
        makeSnapshot({ url: 'https://site.com/app' }),
        makeSnapshot({ url: 'https://site.com/app' }),
        makeDiff({ urlChanged: false }),
        'Do something'
      );

      expect(result.transitionSummary).toContain('URL unchanged: https://site.com/app');
    });

    it('should include title change in transition summary', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.2, reason: 'Maybe' };

      const result = await evaluator.evaluate(
        makeSnapshot({ title: 'Login' }),
        makeSnapshot({ title: 'Dashboard' }),
        makeDiff(),
        'Login'
      );

      expect(result.transitionSummary).toContain('Title: "Login" -> "Dashboard"');
    });

    it('should always return a valid transitionSummary even on AI failure', async () => {
      mockAskJsonResult = null;

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(typeof result.transitionSummary).toBe('string');
      expect(result.transitionSummary.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. CONSTRUCTOR — testId handling
  // ─────────────────────────────────────────────────────────────────────
  describe('Constructor', () => {
    it('should use "unknown" when no testId provided', async () => {
      const noIdEvaluator = new GoalCompletionEvaluator();
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      const result = await noIdEvaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      // Should not crash; result should be valid
      expect(result.isDone).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 13. RUSSIAN LANGUAGE GOALS
  // ─────────────────────────────────────────────────────────────────────
  describe('Russian language support', () => {
    it('should detect auth intent in Russian (войти)', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.9, reason: 'Auth succeeded' };

      const before = makeAuthLoginSnapshot();
      const after = makeAuthDashboardSnapshot();

      await evaluator.evaluate(before, after, makeDiff({ urlChanged: true }), 'Войти на сайт juz40-edu.kz');

      expect(lastAskJsonPrompt).toContain('Left auth page');
      expect(lastAskJsonPrompt).toContain('Authenticated UI appeared');
    });

    it('should detect auth intent in Russian (авторизация)', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.3, reason: 'Still on page' };

      await evaluator.evaluate(
        makeAuthLoginSnapshot(), makeAuthLoginSnapshot(), makeDiff(), 'Авторизация на сайте'
      );

      // Auth is detected, but no url change / form disappearance → no auth-specific hints
      expect(lastAskJsonPrompt).not.toContain('Left auth page');
    });

    it('should detect Russian error messages', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'Error detected' };

      const after = makeSnapshot({
        elements: [makeElement({ ref: 'e1', name: 'Ошибка авторизации', visible: true })],
      });

      await evaluator.evaluate(makeSnapshot(), after, makeDiff(), 'Войти');

      expect(lastAskJsonPrompt).toContain('Error indicators detected');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 14. CONFIDENCE THRESHOLD INTEGRATION (engine uses >= 0.6)
  // ─────────────────────────────────────────────────────────────────────
  describe('Confidence threshold edge cases', () => {
    it('should faithfully pass through confidence=0.59 (below engine threshold)', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.59, reason: 'Marginally done' };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBe(0.59);
      // Engine would NOT stop here (0.59 < 0.6), but evaluator returns honest result
    });

    it('should pass through exactly 0.6 confidence', async () => {
      mockAskJsonResult = { isDone: true, confidence: 0.6, reason: 'Just enough' };

      const result = await evaluator.evaluate(
        makeSnapshot(), makeSnapshot(), makeDiff(), 'Login'
      );

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBe(0.6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 15. PROMPT RULES VERIFICATION
  // ─────────────────────────────────────────────────────────────────────
  describe('Prompt rules', () => {
    it('should contain strict rules for the AI', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      await evaluator.evaluate(makeSnapshot(), makeSnapshot(), makeDiff(), 'Login');

      expect(lastAskJsonPrompt).toContain('isDone=true ONLY if goal is FULLY achieved');
      expect(lastAskJsonPrompt).toContain('intermediate');
      expect(lastAskJsonPrompt).toContain('Be STRICT');
    });

    it('should request JSON response format', async () => {
      mockAskJsonResult = { isDone: false, confidence: 0.1, reason: 'No' };

      await evaluator.evaluate(makeSnapshot(), makeSnapshot(), makeDiff(), 'Login');

      expect(lastAskJsonPrompt).toContain('Respond JSON');
      expect(lastAskJsonPrompt).toContain('"isDone"');
      expect(lastAskJsonPrompt).toContain('"confidence"');
      expect(lastAskJsonPrompt).toContain('"reason"');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // 16. REGRESSION: Same URL + Same title + DOM change (original bug)
  // ─────────────────────────────────────────────────────────────────────
  describe('Regression: Same URL after credential fill', () => {
    it('should still evaluate when URL and title unchanged but elements differ', async () => {
      mockAskJsonResult = {
        isDone: true,
        confidence: 0.85,
        reason: 'Login form replaced with user dashboard content',
      };

      const before = makeSnapshot({
        url: 'https://spa-site.com/',
        title: 'App',
        elements: [
          makeElement({ ref: 'e1', tag: 'input', type: 'text', name: 'email', visible: true }),
          makeElement({ ref: 'e2', tag: 'input', type: 'password', visible: true }),
          makeElement({ ref: 'e3', tag: 'button', name: 'Sign In', visible: true }),
        ],
      });
      const after = makeSnapshot({
        url: 'https://spa-site.com/',
        title: 'App',
        elements: [
          makeElement({ ref: 'e10', tag: 'nav', name: 'Dashboard', visible: true }),
          makeElement({ ref: 'e11', tag: 'button', name: 'Logout', visible: true }),
        ],
      });
      const diff = makeDiff({
        urlChanged: false,
        hasVisualChange: true,
        addedElements: after.elements,
        removedRefs: ['e1', 'e2', 'e3'],
      });

      const result = await evaluator.evaluate(before, after, diff, 'Sign in to spa-site.com');

      expect(result.isDone).toBe(true);
      expect(result.confidence).toBe(0.85);
      // Heuristic hints should detect form disappearance + authenticated UI
      expect(lastAskJsonPrompt).toContain('Login/register form disappeared');
      expect(lastAskJsonPrompt).toContain('Authenticated UI appeared');
    });
  });
});
