/**
 * SmartWaitService
 * Adaptive waiting strategies to prevent flaky tests
 *
 * Key features:
 * - Adaptive wait strategies based on page context
 * - Selector stability scoring (flakiness detection)
 * - Smart retry with exponential backoff
 * - Animation/transition detection
 * - Network idle detection
 */

import { logger } from '@/utils/core/logger';
import { Locator, Page } from 'playwright';
import { getLocator, normalizeSelector } from './selector-utils';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface WaitOptions {
  timeout?: number;
  strategy?: WaitStrategy;
  retries?: number;
  retryDelay?: number;
  stabilityThreshold?: number; // ✅ FIX: Configurable DOM stability threshold (ms)
}

export type WaitStrategy =
  | 'fast'           // Just check visibility (quick, might be flaky)
  | 'stable'         // Wait for element to be stable (recommended)
  | 'network_idle'   // Wait for network + element stable
  | 'full'           // Wait for everything (slowest, most reliable)
  | 'auto';          // Auto-detect best strategy

export interface SelectorStabilityScore {
  score: number;         // 0-100 (100 = most stable)
  isFlaky: boolean;      // true if score < 50
  reasons: string[];     // Why it might be flaky
  recommendation?: string; // Better selector suggestion
  selectorType: SelectorType;
}

export type SelectorType =
  | 'data-testid'    // Best: data-testid="value"
  | 'aria'           // Good: role=, aria-label
  | 'text'           // Good: text="value"
  | 'id'             // Medium: #id (can be dynamic)
  | 'class'          // Risky: .class (can be dynamic)
  | 'css_path'       // Bad: div > div > button
  | 'xpath'          // Bad: //div[3]/button
  | 'nth_child'      // Bad: :nth-child(n)
  | 'unknown';

export interface SmartWaitResult {
  success: boolean;
  locator?: Locator;
  waitTime: number;
  strategy: WaitStrategy;
  retryCount: number;
  stabilityScore?: SelectorStabilityScore;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Patterns that indicate dynamic/unstable selectors
const FLAKY_PATTERNS = {
  dynamicId: /^#[a-z]+-[a-f0-9]{6,}$/i,           // #btn-abc123
  generatedClass: /\.[a-z]{2,4}-[a-f0-9]{5,}/i,   // .css-1a2b3c
  deepNesting: /(?:>.*){4,}/,                      // div > div > div > div > button
  nthChild: /:nth-child\(\d+\)/i,                  // :nth-child(3)
  nthOfType: /:nth-of-type\(\d+\)/i,               // :nth-of-type(2)
  indexBased: /\[\d+\]/,                           // [3] (XPath index)
  hashId: /#[a-f0-9]{8,}/i,                        // #a1b2c3d4e5f6
  randomSuffix: /__[a-z0-9]+$/i,                   // __abc123
};

// Patterns that indicate stable selectors
const STABLE_PATTERNS = {
  dataTestId: /\[data-testid=/i,                   // [data-testid="..."]
  dataTest: /\[data-test=/i,                       // [data-test="..."]
  dataCy: /\[data-cy=/i,                           // [data-cy="..."]
  ariaLabel: /\[aria-label=/i,                     // [aria-label="..."]
  role: /^role=/i,                                 // role=button
  text: /^text=/i,                                 // text="..."
  label: /^label=/i,                               // label="..."
  placeholder: /\[placeholder=/i,                  // [placeholder="..."]
  name: /\[name=/i,                                // [name="..."]
  type: /\[type=/i,                                // [type="submit"]
};

// ═══════════════════════════════════════════════════════════════════════════
// SMART WAIT SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class SmartWaitService {
  /**
   * Wait for element with smart strategy
   * Auto-detects best wait strategy based on selector and page context
   */
  static async waitForElement(
    page: Page,
    selector: string,
    options: WaitOptions = {}
  ): Promise<SmartWaitResult> {
    const startTime = Date.now();
    const {
      timeout = 10000,
      strategy = 'auto',
      retries = 3,
      retryDelay = 500,
    } = options;

    // Analyze selector stability
    const stabilityScore = this.analyzeSelectorStability(selector);

    // Determine best strategy
    const effectiveStrategy = strategy === 'auto'
      ? this.determineStrategy(stabilityScore, page)
      : strategy;

    logger.debug('[SMART_WAIT] Starting wait', {
      selector: selector.substring(0, 50),
      strategy: effectiveStrategy,
      stabilityScore: stabilityScore.score,
      isFlaky: stabilityScore.isFlaky,
    });

    // Normalize selector
    const normalizedSelector = normalizeSelector(selector);
    let lastError: string | undefined;
    let retryCount = 0;

    // Retry loop with exponential backoff
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // ✅ FIX: Wrap getLocator in try-catch for better error handling
        let locator: Locator;
        try {
          locator = getLocator(page, normalizedSelector).first();
        } catch (locatorError) {
          const errorMsg = locatorError instanceof Error ? locatorError.message : String(locatorError);
          logger.debug('[SMART_WAIT] Invalid selector format', {
            selector: selector.substring(0, 50),
            normalizedSelector: normalizedSelector.substring(0, 50),
            error: errorMsg,
          });
          lastError = `Invalid selector: ${errorMsg}`;
          continue; // Skip to next retry
        }

        // Apply wait strategy
        const waitResult = await this.applyWaitStrategy(
          page,
          locator,
          effectiveStrategy,
          timeout,
          stabilityScore
        );

        if (waitResult.success) {
          const waitTime = Date.now() - startTime;

          logger.debug('[SMART_WAIT] Element ready', {
            selector: selector.substring(0, 50),
            waitTime,
            attempts: attempt + 1,
            strategy: effectiveStrategy,
          });

          return {
            success: true,
            locator,
            waitTime,
            strategy: effectiveStrategy,
            retryCount: attempt,
            stabilityScore,
          };
        }

        lastError = waitResult.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      // Retry with exponential backoff
      if (attempt < retries) {
        retryCount = attempt + 1;
        const delay = retryDelay * Math.pow(1.5, attempt);

        logger.debug('[SMART_WAIT] Retrying', {
          attempt: attempt + 1,
          maxRetries: retries,
          delay,
          lastError,
        });

        await page.waitForTimeout(delay);
      }
    }

    // All retries exhausted
    const waitTime = Date.now() - startTime;

    logger.warn('[SMART_WAIT] Element not ready after retries', {
      selector: selector.substring(0, 50),
      waitTime,
      retries,
      lastError,
      stabilityScore: stabilityScore.score,
    });

    return {
      success: false,
      waitTime,
      strategy: effectiveStrategy,
      retryCount,
      stabilityScore,
      error: lastError || 'Element not ready',
    };
  }

  /**
   * Apply specific wait strategy
   */
  private static async applyWaitStrategy(
    page: Page,
    locator: Locator,
    strategy: WaitStrategy,
    timeout: number,
    stabilityScore: SelectorStabilityScore
  ): Promise<{ success: boolean; error?: string }> {
    const strategyTimeout = this.adjustTimeoutForStrategy(timeout, strategy, stabilityScore);

    try {
      switch (strategy) {
        case 'fast':
          // Just check if visible
          await locator.waitFor({ state: 'visible', timeout: strategyTimeout });
          return { success: true };

        case 'stable':
          // Wait for visible + stable (no size/position changes)
          await locator.waitFor({ state: 'visible', timeout: strategyTimeout });
          await this.waitForElementStable(page, locator, strategyTimeout / 2);
          return { success: true };

        case 'network_idle':
          // Wait for network idle first, then element
          await this.waitForNetworkIdle(page, Math.min(strategyTimeout / 2, 5000));
          await locator.waitFor({ state: 'visible', timeout: strategyTimeout / 2 });
          await this.waitForElementStable(page, locator, 1000);
          return { success: true };

        case 'full':
          // Full stability: network + DOM + animations + element
          await this.waitForNetworkIdle(page, Math.min(strategyTimeout / 3, 5000));
          await this.waitForDOMStable(page, 1000);
          await this.waitForAnimationsComplete(page, 1000);
          await locator.waitFor({ state: 'visible', timeout: strategyTimeout / 3 });
          await this.waitForElementStable(page, locator, 1000);
          return { success: true };

        default:
          await locator.waitFor({ state: 'visible', timeout: strategyTimeout });
          return { success: true };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Adjust timeout based on strategy and selector stability
   */
  private static adjustTimeoutForStrategy(
    baseTimeout: number,
    strategy: WaitStrategy,
    stabilityScore: SelectorStabilityScore
  ): number {
    // Increase timeout for flaky selectors
    const flakyMultiplier = stabilityScore.isFlaky ? 1.5 : 1;

    // Increase timeout for more thorough strategies
    const strategyMultiplier = {
      fast: 0.5,
      stable: 1,
      network_idle: 1.5,
      full: 2,
      auto: 1,
    }[strategy];

    return Math.round(baseTimeout * flakyMultiplier * strategyMultiplier);
  }

  /**
   * Determine best wait strategy based on context
   */
  private static determineStrategy(
    stabilityScore: SelectorStabilityScore,
    page: Page
  ): WaitStrategy {
    void page; // Strategy is currently based on stability score only

    // Flaky selectors need more robust waiting
    if (stabilityScore.isFlaky) {
      return 'stable';
    }

    // Very stable selectors can use fast strategy
    if (stabilityScore.score >= 90) {
      return 'fast';
    }

    // Default to stable for medium stability
    return 'stable';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELECTOR STABILITY ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Analyze selector stability and return score
   * Higher score = more stable/reliable
   */
  static analyzeSelectorStability(selector: string): SelectorStabilityScore {
    const reasons: string[] = [];
    let score = 70; // Base score

    // Detect selector type
    const selectorType = this.detectSelectorType(selector);

    // Score based on selector type
    switch (selectorType) {
      case 'data-testid':
        score = 95;
        break;
      case 'aria':
        score = 90;
        break;
      case 'text':
        score = 85;
        break;
      case 'id':
        score = 75; // IDs can be dynamic
        break;
      case 'class':
        score = 60;
        break;
      case 'css_path':
        score = 40;
        reasons.push('CSS path selectors are fragile to DOM changes');
        break;
      case 'xpath':
        score = 35;
        reasons.push('XPath selectors are fragile to DOM changes');
        break;
      case 'nth_child':
        score = 30;
        reasons.push('Index-based selectors are very fragile');
        break;
    }

    // Check for flaky patterns (reduce score)
    for (const [pattern, regex] of Object.entries(FLAKY_PATTERNS)) {
      if (regex.test(selector)) {
        score -= 15;
        reasons.push(`Contains flaky pattern: ${pattern}`);
      }
    }

    // ✅ FIX: Check for stable patterns with capped bonus
    // Cap at +20 total to prevent over-scoring when multiple patterns match
    let stableBonus = 0;
    for (const [, regex] of Object.entries(STABLE_PATTERNS)) {
      if (regex.test(selector)) {
        stableBonus += 10;
      }
    }
    score += Math.min(stableBonus, 20); // Cap bonus at +20

    // Clamp score to 0-100
    score = Math.max(0, Math.min(100, score));

    // Generate recommendation for flaky selectors
    let recommendation: string | undefined;
    if (score < 50) {
      recommendation = this.generateSelectorRecommendation(selector, selectorType);
    }

    return {
      score,
      isFlaky: score < 50,
      reasons,
      recommendation,
      selectorType,
    };
  }

  /**
   * Detect the type of selector
   * ✅ FIX: Normalize selector first for consistent detection
   */
  private static detectSelectorType(selector: string): SelectorType {
    // Normalize to handle text="..." / Text="..." variations
    const normalized = normalizeSelector(selector);
    const s = normalized.toLowerCase();

    // Check data-testid patterns (highest priority)
    if (/\[data-testid=/.test(s) || /\[data-test=/.test(s) || /\[data-cy=/.test(s)) {
      return 'data-testid';
    }

    // Check ARIA/role patterns
    if (/^role=/.test(s) || /\[aria-/.test(s) || /\[role=/.test(s)) {
      return 'aria';
    }

    // Check text/label patterns
    if (/^text=/.test(s) || /^label=/.test(s)) {
      return 'text';
    }

    // ✅ FIX: XPath detection - simplified pattern
    // Matches: //div, xpath=//div (no need for complex patterns)
    if (/^\/\//.test(normalized) || /^xpath=/.test(s)) {
      return 'xpath';
    }

    // Check ID selectors (but not dynamic IDs)
    if (/^#[a-z]/i.test(normalized) && !FLAKY_PATTERNS.dynamicId.test(normalized)) {
      return 'id';
    }

    // Check class selectors
    if (/^\.[a-z]/i.test(normalized)) {
      return 'class';
    }

    // Check nth-child/nth-of-type patterns
    if (/:nth-child|:nth-of-type/.test(s)) {
      return 'nth_child';
    }

    // Check CSS path (has > combinator)
    if (/>/.test(normalized)) {
      return 'css_path';
    }

    return 'unknown';
  }

  /**
   * Generate recommendation for better selector
   */
  private static generateSelectorRecommendation(
    selector: string,
    currentType: SelectorType
  ): string {
    switch (currentType) {
      case 'xpath':
        return 'Consider using data-testid, aria-label, or role-based selectors instead of XPath';
      case 'css_path':
        return 'Consider adding data-testid attribute to target element';
      case 'nth_child':
        return 'Consider using unique attributes (data-testid, aria-label) instead of index-based selectors';
      case 'class':
        if (FLAKY_PATTERNS.generatedClass.test(selector)) {
          return 'This looks like a generated CSS class. Add data-testid for stability';
        }
        return 'Consider using data-testid or aria-label for more stable selection';
      case 'id':
        if (FLAKY_PATTERNS.dynamicId.test(selector)) {
          return 'This looks like a dynamic ID. Consider using data-testid instead';
        }
        break;
    }
    return 'Consider using data-testid, role, or aria-label selectors for better stability';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WAIT HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wait for element to be stable (no size/position changes)
   */
  private static async waitForElementStable(
    page: Page,
    locator: Locator,
    timeout: number
  ): Promise<void> {
    const startTime = Date.now();
    let lastBox: { x: number; y: number; width: number; height: number } | null = null;
    let stableCount = 0;
    const requiredStableChecks = 3;

    while (Date.now() - startTime < timeout) {
      try {
        const currentBox = await locator.boundingBox();

        if (!currentBox) {
          stableCount = 0;
          await page.waitForTimeout(50);
          continue;
        }

        if (lastBox &&
            currentBox.x === lastBox.x &&
            currentBox.y === lastBox.y &&
            currentBox.width === lastBox.width &&
            currentBox.height === lastBox.height) {
          stableCount++;
          if (stableCount >= requiredStableChecks) {
            return; // Element is stable
          }
        } else {
          stableCount = 0;
        }

        lastBox = currentBox;
        await page.waitForTimeout(50);
      } catch {
        stableCount = 0;
        await page.waitForTimeout(50);
      }
    }
  }

  /**
   * Wait for network to be idle
   * ✅ FIX: Added fallback with request tracking for SPA/long-polling
   */
  private static async waitForNetworkIdle(page: Page, timeout: number): Promise<void> {
    const startTime = Date.now();

    try {
      // Try Playwright's built-in networkidle first
      await page.waitForLoadState('networkidle', { timeout: timeout / 2 });
      return;
    } catch (error) {
      // Fallback: track in-flight requests manually
      logger.debug('[SMART_WAIT] networkidle timeout, using request tracking fallback', {
        elapsed: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'timeout',
      });
    }

    // ✅ Fallback: Manual request tracking
    // Better for SPA/long-polling scenarios
    const remainingTimeout = timeout - (Date.now() - startTime);
    if (remainingTimeout <= 0) return;

    let inFlightRequests = 0;
    let lastRequestTime = Date.now();
    const idleThreshold = 500; // Consider idle if no requests for 500ms

    const onRequest = () => {
      inFlightRequests++;
      lastRequestTime = Date.now();
    };

    const onRequestDone = () => {
      inFlightRequests = Math.max(0, inFlightRequests - 1);
      if (inFlightRequests === 0) {
        lastRequestTime = Date.now();
      }
    };

    page.on('request', onRequest);
    page.on('requestfinished', onRequestDone);
    page.on('requestfailed', onRequestDone);

    try {
      const checkIdle = (): Promise<void> => {
        return new Promise((resolve) => {
          const check = () => {
            const elapsed = Date.now() - startTime;
            const timeSinceLastRequest = Date.now() - lastRequestTime;

            // Idle: no in-flight requests and idle threshold passed
            if (inFlightRequests === 0 && timeSinceLastRequest >= idleThreshold) {
              resolve();
              return;
            }

            // Timeout
            if (elapsed >= timeout) {
              logger.debug('[SMART_WAIT] Request tracking timeout', {
                inFlightRequests,
                timeSinceLastRequest,
              });
              resolve();
              return;
            }

            setTimeout(check, 100);
          };
          check();
        });
      };

      await checkIdle();
    } finally {
      // Cleanup listeners
      page.off('request', onRequest);
      page.off('requestfinished', onRequestDone);
      page.off('requestfailed', onRequestDone);
    }
  }

  /**
   * Wait for DOM to be stable (no mutations)
   * ✅ FIX: Check document.body existence, configurable stabilityThreshold
   */
  private static async waitForDOMStable(
    page: Page,
    timeout: number,
    stabilityThreshold: number = 200 // ✅ FIX: Made configurable
  ): Promise<void> {
    try {
      await page.evaluate(({ timeout, stabilityThreshold }: { timeout: number; stabilityThreshold: number }) => {
        return new Promise<void>((resolve) => {
          // ✅ FIX: Check if document.body exists (browser context)
          // @ts-expect-error - document exists in browser context
          if (!document.body) {
            resolve();
            return;
          }

          let lastMutationTime = Date.now();
          const startTime = Date.now();

          // @ts-expect-error - MutationObserver exists in browser context
          const observer = new MutationObserver(() => {
            lastMutationTime = Date.now();
          });

          // @ts-expect-error - document exists in browser context
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
          });

          const checkStable = () => {
            const elapsed = Date.now() - startTime;
            const timeSinceLastMutation = Date.now() - lastMutationTime;

            // Stable: no mutations for stabilityThreshold ms
            if (timeSinceLastMutation >= stabilityThreshold) {
              observer.disconnect();
              resolve();
              return;
            }

            // Timeout
            if (elapsed >= timeout) {
              observer.disconnect();
              resolve();
              return;
            }

            setTimeout(checkStable, 50);
          };

          // Start checking after short delay
          setTimeout(checkStable, 100);
        });
      }, { timeout, stabilityThreshold });
    } catch (error) {
      // DOM stability check failed, log and continue
      logger.debug('[SMART_WAIT] DOM stability check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Wait for CSS animations to complete
   */
  private static async waitForAnimationsComplete(page: Page, timeout: number): Promise<void> {
    try {
      await page.evaluate((timeout: number) => {
        return new Promise<void>((resolve) => {
          const startTime = Date.now();

          const checkAnimations = () => {
            // @ts-expect-error - browser context
            const animations = document.getAnimations();
            const runningAnimations = animations.filter(
              (anim: any) => anim.playState === 'running'
            );

            if (runningAnimations.length === 0 || Date.now() - startTime > timeout) {
              resolve();
            } else {
              setTimeout(checkAnimations, 50);
            }
          };

          checkAnimations();
        });
      }, timeout);
    } catch {
      // Animation check failed, continue anyway
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART RETRY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute action with smart retry and wait strategies
   */
  static async executeWithSmartRetry<T>(
    action: () => Promise<T>,
    options: {
      retries?: number;
      retryDelay?: number;
      shouldRetry?: (error: Error) => boolean;
      onRetry?: (attempt: number, error: Error) => void;
    } = {}
  ): Promise<{ success: boolean; result?: T; error?: string; attempts: number }> {
    const {
      retries = 3,
      retryDelay = 500,
      shouldRetry = () => true,
      onRetry,
    } = options;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await action();
        return { success: true, result, attempts: attempt + 1 };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < retries && shouldRetry(lastError)) {
          onRetry?.(attempt + 1, lastError);

          // Exponential backoff
          const delay = retryDelay * Math.pow(1.5, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Action failed after retries',
      attempts: retries + 1,
    };
  }
}
