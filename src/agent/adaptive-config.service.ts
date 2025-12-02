/**
 * AdaptiveConfigService
 *
 * Adaptive configuration based on context, not hardcoded values
 * Determines thresholds, timeouts, and action requirements dynamically
 */

import { DynamicAction, PageType, TestState } from './types/intelligent-testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// BASE CONFIGURATION (fallback defaults)
// ═══════════════════════════════════════════════════════════════════════════

const BASE_TIMEOUTS = {
  NAVIGATION: 30000,
  SELECTOR_WAIT: 30000,
  ELEMENT_VISIBILITY: 2000,
  GO_BACK: 5000,
  CONDITIONAL_FIELD_WAIT: 500,
  PREREQUISITE_ACTION_DELAY: 300,
  VALIDATION_DELAY: 300,
} as const;

const BASE_THRESHOLDS = {
  MAX_SELECTOR_FAILURES: 3,
  MAX_ERRORS_BEFORE_STOP: 10,
  RECENT_SELECTOR_ERRORS_THRESHOLD: 3,
  RECENT_ERRORS_CHECK_COUNT: 5,
  LOW_SUCCESS_RATE_THRESHOLD: 0.2,
  MIN_ACTIONS_FOR_SUCCESS_RATE: 3,
  CYCLE_DETECTION_THRESHOLD: 3,
  CONSECUTIVE_EMPTY_PAGES_THRESHOLD: 2,
  MAX_VALIDATION_ERRORS_TO_FIX: 3,
  VALIDATION_FIX_CONFIDENCE_THRESHOLD: 0.7,
  EVENT_DEDUPLICATION_WINDOW: 500,
  NOISY_EVENT_EMIT_INTERVAL: 3,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// ACTION TYPE CONSTANTS (DRY - avoid repeating in methods)
// ═══════════════════════════════════════════════════════════════════════════

/** Actions that modify page/form state */
const STATE_MODIFYING_ACTIONS = ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'submit'] as const;

/** Actions that require user interaction with elements */
const INTERACTIVE_ACTIONS = ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'press'] as const;

/** Actions that may trigger conditional/dynamic fields in forms */
const CONDITIONAL_TRIGGER_ACTIONS = ['fill', 'select', 'check', 'uncheck'] as const;

/** WebSocket events that fire frequently and can be deduplicated */
const BASE_NOISY_EVENTS = ['action_executing', 'action_completed', 'action_failed'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTIVE CONFIGURATION SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class AdaptiveConfigService {
  /**
   * Determine if action requires pre-action analysis
   * Based on action type and context, not hardcoded list
   */
  static requiresPreActionAnalysis(action: DynamicAction, context?: {
    pageType?: PageType;
    hasForm?: boolean;
    isSlowPage?: boolean;
  }): boolean {
    // All interactive actions with selectors need pre-analysis
    if (!action.selector) {
      return false;
    }

    // Actions that modify state always need analysis
    if ((STATE_MODIFYING_ACTIONS as readonly string[]).includes(action.action)) {
      return true;
    }

    // For slow pages, even hover might need analysis
    if (context?.isSlowPage && action.action === 'hover') {
      return true;
    }

    // Form pages require analysis for all form-related actions
    if (context?.hasForm && (STATE_MODIFYING_ACTIONS as readonly string[]).includes(action.action)) {
      return true;
    }

    return false;
  }

  /**
   * Determine if action requires selector validation
   * Based on action type and risk level
   */
  static requiresSelectorValidation(action: DynamicAction, context?: {
    pageType?: PageType;
    selectorReliability?: 'high' | 'medium' | 'low';
  }): boolean {
    if (!action.selector) {
      return false;
    }

    // All interactive actions need validation
    if ((INTERACTIVE_ACTIONS as readonly string[]).includes(action.action)) {
      return true;
    }

    // Low reliability selectors always need validation
    if (context?.selectorReliability === 'low') {
      return true;
    }

    return false;
  }

  /**
   * Determine if action triggers conditional fields
   * Based on action type and form context
   */
  static triggersConditionalFields(action: DynamicAction, context?: {
    pageType?: PageType;
    hasForm?: boolean;
    formType?: 'registration' | 'checkout' | 'contact' | 'settings' | 'unknown';
  }): boolean {
    if (!context?.hasForm) {
      return false;
    }

    // Form-related actions that commonly trigger conditional fields
    if ((CONDITIONAL_TRIGGER_ACTIONS as readonly string[]).includes(action.action)) {
      return true;
    }

    // Checkout forms often have conditional fields
    if (context.formType === 'checkout' && action.action === 'select') {
      return true;
    }

    return false;
  }

  /**
   * Determine if action requires post-action analysis
   * Based on action type and expected outcomes
   */
  static requiresPostActionAnalysis(action: DynamicAction, context?: {
    pageType?: PageType;
    hasForm?: boolean;
    isSubmitAction?: boolean;
  }): boolean {
    // All state-modifying actions need post-analysis
    if ((STATE_MODIFYING_ACTIONS as readonly string[]).includes(action.action)) {
      return true;
    }

    // Form submissions always need post-analysis
    if (context?.isSubmitAction || context?.hasForm) {
      return true;
    }

    return false;
  }

  /**
   * Get adaptive timeout based on context
   */
  static getTimeout(
    type: keyof typeof BASE_TIMEOUTS,
    context?: {
      pageType?: PageType;
      isSlowPage?: boolean;
      networkSpeed?: 'fast' | 'medium' | 'slow';
      hasHeavyJS?: boolean;
      previousTimeouts?: Map<string, number>; // selector -> actual timeout used
    }
  ): number {
    let baseTimeout: number = BASE_TIMEOUTS[type] as number;

    // Adjust based on page type
    if (context?.pageType) {
      const pageTypeMultipliers: Record<PageType, number> = {
        checkout: 1.5, // Payment pages are slower
        payment: 1.5,
        dashboard: 1.3, // Dashboards load data
        product: 1.2, // Product pages have images
        search_results: 1.2,
        home: 1.0,
        login: 1.0,
        register: 1.0,
        cart: 1.0,
        category: 1.0,
        profile: 1.0,
        settings: 1.0,
        error: 1.0,
        unknown: 1.0,
      };

      baseTimeout = Math.round(baseTimeout * (pageTypeMultipliers[context.pageType] || 1.0));
    }

    // Adjust based on network speed
    if (context?.networkSpeed) {
      const networkMultipliers = {
        slow: 2.0,
        medium: 1.5,
        fast: 1.0,
      };
      baseTimeout = Math.round(baseTimeout * networkMultipliers[context.networkSpeed]);
    }

    // Adjust based on heavy JS
    if (context?.hasHeavyJS) {
      baseTimeout = Math.round(baseTimeout * 1.5);
    }

    // Adjust based on previous timeouts (adaptive learning)
    if (context?.previousTimeouts && context.previousTimeouts.size > 0) {
      const avgTimeout = Array.from(context.previousTimeouts.values()).reduce((a, b) => a + b, 0) /
                        context.previousTimeouts.size;
      // Use 1.2x of average if it's higher than base
      if (avgTimeout > baseTimeout) {
        baseTimeout = Math.round(avgTimeout * 1.2);
      }
    }

    // Slow pages get extra time
    if (context?.isSlowPage) {
      baseTimeout = Math.round(baseTimeout * 1.5);
    }

    return baseTimeout;
  }

  /**
   * Get adaptive threshold based on context
   */
  static getThreshold(
    type: keyof typeof BASE_THRESHOLDS,
    context?: {
      testGoal?: string;
      testMode?: 'full' | 'fast' | 'balanced';
      errorRate?: number; // 0.0 - 1.0
      isComplexPage?: boolean;
      hasManySelectors?: boolean;
    }
  ): number {
    let baseThreshold: number = BASE_THRESHOLDS[type] as number;

    // Adjust based on test mode
    if (context?.testMode) {
      const modeMultipliers = {
        fast: 0.7, // More aggressive stopping in fast mode
        balanced: 1.0,
        full: 1.5, // More patient in full mode
      };
      baseThreshold = Math.round(baseThreshold * modeMultipliers[context.testMode]);
    }

    // Adjust based on error rate (if many errors, be more strict)
    if (context?.errorRate !== undefined) {
      if (context.errorRate > 0.5) {
        // High error rate - be more strict
        baseThreshold = Math.round(baseThreshold * 0.7);
      } else if (context.errorRate < 0.1) {
        // Low error rate - can be more patient
        baseThreshold = Math.round(baseThreshold * 1.3);
      }
    }

    // Complex pages need more patience
    if (context?.isComplexPage) {
      baseThreshold = Math.round(baseThreshold * 1.3);
    }

    // Many selectors = more failures expected
    if (context?.hasManySelectors && type === 'MAX_SELECTOR_FAILURES') {
      baseThreshold = Math.round(baseThreshold * 1.5);
    }

    return baseThreshold;
  }

  /**
   * Determine if action is noisy event (for WebSocket deduplication)
   */
  static isNoisyEvent(event: string, context?: {
    actionType?: string;
    isCritical?: boolean;
  }): boolean {
    if ((BASE_NOISY_EVENTS as readonly string[]).includes(event)) {
      // Critical actions are never noisy
      if (context?.isCritical) {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Get adaptive HTTP status ranges
   */
  static getHttpStatusRange(type: 'redirect' | 'error' | 'success'): { start: number; end: number } {
    switch (type) {
      case 'redirect':
        return { start: 300, end: 400 };
      case 'error':
        return { start: 400, end: 600 };
      case 'success':
        return { start: 200, end: 300 };
      default:
        return { start: 0, end: 1000 };
    }
  }

  /**
   * Analyze page context for adaptive configuration
   */
  static analyzePageContext(state: TestState, pageType?: PageType): {
    isSlowPage: boolean;
    hasHeavyJS: boolean;
    networkSpeed: 'fast' | 'medium' | 'slow';
    errorRate: number;
    isComplexPage: boolean;
    hasManySelectors: boolean;
  } {
    // Calculate error rate
    const totalActions = state.completedActions.length;
    const failedActions = state.completedActions.filter(a => !a.success).length;
    const errorRate = totalActions > 0 ? failedActions / totalActions : 0;

    // Detect slow page (based on timestamps if available)
    const isSlowPage = state.completedActions.length > 2
      ? (state.completedActions[state.completedActions.length - 1].timestamp -
         state.completedActions[0].timestamp) / state.completedActions.length > 2000
      : false;

    // Detect heavy JS (based on page type and errors)
    const hasHeavyJS = pageType === 'dashboard' || pageType === 'product' || errorRate > 0.3;

    // Estimate network speed (based on navigation frequency)
    const navigationActions = state.completedActions.filter(a => a.urlChanged);
    let networkSpeed: 'fast' | 'medium' | 'slow' = 'medium';
    if (navigationActions.length > 0) {
      // Estimate based on time between navigations
      const timeBetweenNavs = navigationActions.length > 1
        ? (navigationActions[navigationActions.length - 1].timestamp -
           navigationActions[0].timestamp) / (navigationActions.length - 1)
        : 0;
      if (timeBetweenNavs < 2000) {
        networkSpeed = 'fast';
      } else if (timeBetweenNavs > 5000) {
        networkSpeed = 'slow';
      }
    }

    // Detect complex page (based on page type and visited pages count)
    const isComplexPage = pageType === 'checkout' ||
                         pageType === 'dashboard' ||
                         state.visitedPages.length > 5; // Many pages = complex flow

    // Detect many selectors (based on actions count - more actions = more selectors)
    const hasManySelectors = state.completedActions.length > 20;

    return {
      isSlowPage,
      hasHeavyJS,
      networkSpeed,
      errorRate,
      isComplexPage,
      hasManySelectors,
    };
  }
}
