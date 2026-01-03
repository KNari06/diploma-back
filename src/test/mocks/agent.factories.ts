/**
 * Factory helpers for agent/intelligent testing types
 * Creates valid test fixtures with sensible defaults
 */

import {
  ActionResult,
  DynamicAction,
  IntelligentTestConfig,
  PageContext,
  PageType,
  PageVisit,
  TestState,
  SafetyConfig,
  NextStepDecision,
} from '@/agent/types/intelligent-testing.types';

/**
 * Create a test DynamicAction with defaults
 */
export function createDynamicAction(overrides: Partial<DynamicAction> = {}): DynamicAction {
  return {
    action: 'click',
    selector: 'button#submit',
    description: 'Click submit button',
    expectedResult: 'Form submitted',
    ...overrides,
  };
}

/**
 * Create a test ActionResult with defaults
 */
export function createActionResult(overrides: Partial<ActionResult> = {}): ActionResult {
  const action = overrides.action || createDynamicAction();
  return {
    action,
    success: true,
    urlChanged: false,
    urlBefore: 'https://example.com/page1',
    urlAfter: 'https://example.com/page1',
    timestamp: Date.now(),
    durationMs: 150,
    ...overrides,
  };
}

/**
 * Create a test PageVisit with defaults
 */
export function createPageVisit(overrides: Partial<PageVisit> = {}): PageVisit {
  return {
    url: 'https://example.com/page1',
    pageType: 'home' as PageType,
    timestamp: Date.now(),
    actions: [createDynamicAction()],
    actionResults: [createActionResult()],
    success: true,
    ...overrides,
  };
}

/**
 * Create a test PageContext with defaults
 */
export function createPageContext(overrides: Partial<PageContext> = {}): PageContext {
  return {
    url: 'https://example.com',
    pageType: 'home' as PageType,
    timestamp: Date.now(),
    vision: {
      pageType: 'home' as PageType,
      description: 'Homepage with navigation',
      elements: [],
      suggestions: ['Click on login'],
    },
    dom: {
      forms: [],
      buttons: [{ text: 'Login', selector: 'button#login' }],
      links: [],
      inputs: [],
    },
    requiredActions: [],
    possibleActions: ['click login', 'navigate to products'],
    criticalElements: [],
    warnings: [],
    ...overrides,
  };
}

/**
 * Create a test SafetyConfig with defaults
 */
export function createSafetyConfig(overrides: Partial<SafetyConfig> = {}): SafetyConfig {
  return {
    level: 'normal',
    maxPages: 10,
    maxDuration: 60000,
    maxCost: 1.0,
    allowedDomains: ['example.com'],
    forbiddenActions: ['delete', 'remove'],
    forbiddenUrls: ['/admin', '/delete'],
    ...overrides,
  };
}

/**
 * Create a test IntelligentTestConfig with defaults
 */
export function createIntelligentTestConfig(
  overrides: Partial<IntelligentTestConfig> = {}
): IntelligentTestConfig {
  return {
    mode: 'balanced',
    safety: createSafetyConfig(),
    goal: 'Test login flow',
    startUrl: 'https://example.com',
    browser: 'chromium',
    ...overrides,
  };
}

/**
 * Create a test TestState with defaults
 */
export function createTestState(overrides: Partial<TestState> = {}): TestState {
  return {
    goal: 'Test login flow',
    startUrl: 'https://example.com',
    currentUrl: 'https://example.com',
    visitedPages: [],
    completedActions: [],
    errors: [],
    startTime: Date.now(),
    pagesAnalyzed: 0,
    maxPages: 10,
    maxDuration: 60000,
    estimatedCost: 0,
    ...overrides,
  };
}

/**
 * Create a test NextStepDecision with defaults
 */
export function createNextStepDecision(overrides: Partial<NextStepDecision> = {}): NextStepDecision {
  return {
    action: 'continue',
    reason: 'More pages to explore',
    confidence: 0.85,
    ...overrides,
  };
}

/**
 * Create a large TestState that would trigger compression
 * Useful for testing context-compressor
 */
export function createLargeTestState(pagesCount: number = 20, actionsCount: number = 50): TestState {
  const pages: PageVisit[] = [];
  const actions: ActionResult[] = [];

  for (let i = 0; i < pagesCount; i++) {
    pages.push(
      createPageVisit({
        url: `https://example.com/page${i}`,
        pageType: (i % 2 === 0 ? 'product' : 'category') as PageType,
      })
    );
  }

  for (let i = 0; i < actionsCount; i++) {
    actions.push(
      createActionResult({
        action: createDynamicAction({
          action: i % 3 === 0 ? 'click' : i % 3 === 1 ? 'fill' : 'scroll',
          description: `Action ${i}`,
        }),
        success: i % 5 !== 0, // 80% success rate
      })
    );
  }

  return createTestState({
    visitedPages: pages,
    completedActions: actions,
    pagesAnalyzed: pagesCount,
    errors: [
      { message: 'Element not found', timestamp: Date.now() - 5000 },
      { message: 'Timeout waiting for selector', timestamp: Date.now() - 3000 },
    ],
  });
}
