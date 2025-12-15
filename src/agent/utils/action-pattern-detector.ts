/**
 * ActionPatternDetector
 * Detects problematic patterns in test execution:
 * - Repeated actions (clicking same button multiple times)
 * - Failed action chains (multiple failures in a row)
 * - Stuck patterns (no progress after N actions)
 */

import { logger } from '@/utils/logger';
import { ActionResult, TestState } from '../types/intelligent-testing.types';

export interface ActionPattern {
  type: 'repeated_action' | 'failed_chain' | 'stuck' | 'timeout_chain';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggestion: string;
  actions: ActionResult[];
}

export interface PatternDetectionResult {
  hasPattern: boolean;
  patterns: ActionPattern[];
  shouldStop: boolean;
  reason?: string;
}

export class ActionPatternDetector {
  /**
   * Detect problematic action patterns
   */
  static detectPatterns(state: TestState): PatternDetectionResult {
    const patterns: ActionPattern[] = [];

    // 1. Check for repeated identical actions
    const repeatedPattern = this.detectRepeatedActions(state);
    if (repeatedPattern) {
      patterns.push(repeatedPattern);
    }

    // 2. Check for failed action chains
    const failedChainPattern = this.detectFailedChain(state);
    if (failedChainPattern) {
      patterns.push(failedChainPattern);
    }

    // 3. Check for stuck state (no URL changes)
    const stuckPattern = this.detectStuckState(state);
    if (stuckPattern) {
      patterns.push(stuckPattern);
    }

    // 4. Check for timeout chains
    const timeoutPattern = this.detectTimeoutChain(state);
    if (timeoutPattern) {
      patterns.push(timeoutPattern);
    }

    // Decide if we should stop
    const criticalPatterns = patterns.filter(p => p.severity === 'critical');
    const shouldStop = criticalPatterns.length > 0;

    if (patterns.length > 0) {
      logger.warn('[ACTION_PATTERN_DETECTOR] Problematic patterns detected', {
        patternsCount: patterns.length,
        criticalCount: criticalPatterns.length,
        shouldStop,
        types: patterns.map(p => p.type),
      });
    }

    return {
      hasPattern: patterns.length > 0,
      patterns,
      shouldStop,
      reason: shouldStop ? criticalPatterns[0].description : undefined,
    };
  }

  /**
   * Detect if same action is being repeated
   * Example: Click same button 3+ times in a row
   * ✅ IMPROVED: Context-aware - ignores normal patterns (form validation, multi-step forms)
   */
  private static detectRepeatedActions(state: TestState): ActionPattern | null {
    const recentActions = state.completedActions.slice(-5); // Last 5 actions
    if (recentActions.length < 3) {
      return null;
    }

    // Group by selector + action type
    const actionSignatures = recentActions.map(a => ({
      signature: `${a.action.action}::${a.action.selector || 'no-selector'}`,
      result: a,
    }));

    // Count consecutive identical actions
    let maxConsecutive = 1;
    let currentConsecutive = 1;
    let repeatedSignature = '';

    for (let i = 1; i < actionSignatures.length; i++) {
      if (actionSignatures[i].signature === actionSignatures[i - 1].signature) {
        currentConsecutive++;
        if (currentConsecutive > maxConsecutive) {
          maxConsecutive = currentConsecutive;
          repeatedSignature = actionSignatures[i].signature;
        }
      } else {
        currentConsecutive = 1;
      }
    }

    if (maxConsecutive >= 3) {
      const [actionType, selector] = repeatedSignature.split('::');

      // ✅ IMPROVED: Context-aware filtering - ignore normal patterns
      const isNormalPattern = this.isNormalRepeatedPattern(recentActions, actionType, selector);
      if (isNormalPattern) {
        logger.debug('[ACTION_PATTERN_DETECTOR] Ignoring normal repeated pattern', {
          actionType,
          selector,
          reason: isNormalPattern,
        });
        return null; // Not a problem - normal user behavior
      }

      return {
        type: 'repeated_action',
        severity: maxConsecutive >= 4 ? 'critical' : 'high',
        description: `Action "${actionType}" on "${selector}" was repeated ${maxConsecutive} times consecutively`,
        suggestion: `Stop repeating "${actionType}" on "${selector}". Try different action or element.`,
        actions: recentActions.filter(a =>
          `${a.action.action}::${a.action.selector || 'no-selector'}` === repeatedSignature
        ),
      };
    }

    return null;
  }

  /**
   * ✅ NEW: Check if repeated action is a normal pattern (not a problem)
   * Examples: Form validation retries, multi-step form navigation, etc.
   */
  private static isNormalRepeatedPattern(
    recentActions: ActionResult[],
    actionType: string,
    selector: string
  ): string | null {
    // Pattern 1: Form validation - filling same field after validation errors is normal
    if (actionType === 'fill' || actionType === 'type') {
      // Check if previous action failed with validation error
      const previousAction = recentActions[recentActions.length - 2];
      if (previousAction && !previousAction.success) {
        const errorMsg = (previousAction.error || '').toLowerCase();
        if (errorMsg.includes('validation') || errorMsg.includes('required') ||
            errorMsg.includes('invalid') || errorMsg.includes('error')) {
          return 'form_validation_retry';
        }
      }
    }

    // Pattern 2: Multi-step form navigation - clicking "Next" multiple times is normal
    if (actionType === 'click') {
      const actionDesc = (recentActions[recentActions.length - 1]?.action.description || '').toLowerCase();
      if (actionDesc.includes('next') || actionDesc.includes('continue') ||
          actionDesc.includes('submit') || actionDesc.includes('proceed')) {
        // Check if we're on a form page (likely multi-step)
        const hasFormContext = recentActions.some(a =>
          a.action.description?.toLowerCase().includes('form') ||
          a.action.description?.toLowerCase().includes('step')
        );
        if (hasFormContext) {
          return 'multi_step_form_navigation';
        }
      }
    }

    // Pattern 3: Retry after temporary failure (network, timeout) - normal
    const lastAction = recentActions[recentActions.length - 1];
    const secondLastAction = recentActions[recentActions.length - 2];
    if (secondLastAction && !secondLastAction.success && lastAction?.success) {
      const errorMsg = (secondLastAction.error || '').toLowerCase();
      if (errorMsg.includes('timeout') || errorMsg.includes('network') ||
          errorMsg.includes('connection') || errorMsg.includes('retry')) {
        return 'retry_after_temporary_failure';
      }
    }

    return null; // Not a normal pattern - might be a problem
  }

  /**
   * Detect chain of failed actions
   * Example: 3+ failed actions in a row
   */
  private static detectFailedChain(state: TestState): ActionPattern | null {
    const recentActions = state.completedActions.slice(-10); // Last 10 actions
    if (recentActions.length < 3) {
      return null;
    }

    // Count consecutive failures
    let consecutiveFailures = 0;
    const failedActions: ActionResult[] = [];

    for (let i = recentActions.length - 1; i >= 0; i--) {
      if (!recentActions[i].success) {
        consecutiveFailures++;
        failedActions.unshift(recentActions[i]);
      } else {
        break; // Stop at first success
      }
    }

    if (consecutiveFailures >= 3) {
      return {
        type: 'failed_chain',
        severity: consecutiveFailures >= 5 ? 'critical' : 'high',
        description: `${consecutiveFailures} consecutive actions failed`,
        suggestion: `Test is failing repeatedly. Consider stopping or changing strategy.`,
        actions: failedActions,
      };
    }

    return null;
  }

  /**
   * Detect stuck state (no URL changes)
   * Example: 5+ actions without URL change
   * ✅ IMPROVED: Context-aware - ignores SPA patterns (modals, tabs, dropdowns)
   */
  private static detectStuckState(state: TestState): ActionPattern | null {
    const recentActions = state.completedActions.slice(-8); // Last 8 actions
    if (recentActions.length < 5) {
      return null;
    }

    // Count actions without URL change
    const noNavigationActions = recentActions.filter(a => !a.urlChanged);
    const stuckCount = noNavigationActions.length;

    // Also check if we're on the same URL for all recent actions
    const urls = recentActions.map(a => a.urlAfter);
    const uniqueUrls = new Set(urls);

    if (stuckCount >= 5 && uniqueUrls.size === 1) {
      // ✅ IMPROVED: Check if this is a normal SPA pattern (not stuck)
      const isSPAPattern = this.isNormalSPAPattern(recentActions);
      if (isSPAPattern) {
        logger.debug('[ACTION_PATTERN_DETECTOR] Ignoring SPA pattern (no URL change)', {
          reason: isSPAPattern,
          stuckCount,
        });
        return null; // Not stuck - normal SPA behavior
      }

      // Check if any actions succeeded
      const hasSuccesses = recentActions.some(a => a.success);

      if (!hasSuccesses) {
        return {
          type: 'stuck',
          severity: 'critical',
          description: `Stuck on same page for ${stuckCount} failed actions`,
          suggestion: `Test is stuck on ${urls[0]}. All actions failing. Stop and investigate.`,
          actions: noNavigationActions,
        };
      }

      return {
        type: 'stuck',
        severity: 'medium',
        description: `No page navigation for ${stuckCount} actions`,
        suggestion: `Consider navigating to different page or changing interaction strategy.`,
        actions: noNavigationActions,
      };
    }

    return null;
  }

  /**
   * ✅ NEW: Check if actions without URL change are normal SPA patterns
   * Examples: Opening modals, switching tabs, interacting with dropdowns
   */
  private static isNormalSPAPattern(recentActions: ActionResult[]): string | null {
    // Pattern 1: Modal interactions - opening/closing modals doesn't change URL
    const hasModalActions = recentActions.some(a => {
      const desc = (a.action.description || '').toLowerCase();
      return desc.includes('modal') || desc.includes('dialog') || desc.includes('popup') ||
             desc.includes('close') || desc.includes('dismiss');
    });
    if (hasModalActions) {
      return 'modal_interactions';
    }

    // Pattern 2: Tab/accordion interactions - switching tabs doesn't change URL
    const hasTabActions = recentActions.some(a => {
      const desc = (a.action.description || '').toLowerCase();
      return desc.includes('tab') || desc.includes('accordion') || desc.includes('panel') ||
             desc.includes('switch') || desc.includes('toggle');
    });
    if (hasTabActions) {
      return 'tab_accordion_interactions';
    }

    // Pattern 3: Dropdown/select interactions - opening dropdowns doesn't change URL
    const hasDropdownActions = recentActions.some(a => {
      const desc = (a.action.description || '').toLowerCase();
      return (desc.includes('dropdown') || desc.includes('select') || desc.includes('menu')) &&
             a.action.action === 'click'; // Clicking dropdowns, not selecting options
    });
    if (hasDropdownActions) {
      return 'dropdown_interactions';
    }

    // Pattern 4: Form interactions on same page - filling forms doesn't change URL until submit
    const hasFormFills = recentActions.filter(a =>
      a.action.action === 'fill' || a.action.action === 'type'
    ).length;
    const hasFormSubmit = recentActions.some(a => {
      const desc = (a.action.description || '').toLowerCase();
      return desc.includes('submit') && a.action.action === 'click';
    });
    if (hasFormFills >= 2 && !hasFormSubmit) {
      return 'form_filling_in_progress';
    }

    // Pattern 5: Successful actions with different selectors - user is exploring page
    const successfulActions = recentActions.filter(a => a.success);
    if (successfulActions.length >= 3) {
      const uniqueSelectors = new Set(successfulActions.map(a => a.action.selector).filter(Boolean));
      if (uniqueSelectors.size >= 3) {
        return 'exploring_page_elements';
      }
    }

    return null; // Not a normal SPA pattern - might be stuck
  }

  /**
   * Detect chain of timeout errors
   * Example: 2+ timeouts in a row
   */
  private static detectTimeoutChain(state: TestState): ActionPattern | null {
    const recentActions = state.completedActions.slice(-5); // Last 5 actions
    if (recentActions.length < 2) {
      return null;
    }

    // Count consecutive timeouts
    let consecutiveTimeouts = 0;
    const timeoutActions: ActionResult[] = [];

    for (let i = recentActions.length - 1; i >= 0; i--) {
      const action = recentActions[i];
      if (!action.success && action.error?.toLowerCase().includes('timeout')) {
        consecutiveTimeouts++;
        timeoutActions.unshift(action);
      } else {
        break;
      }
    }

    if (consecutiveTimeouts >= 2) {
      return {
        type: 'timeout_chain',
        severity: consecutiveTimeouts >= 3 ? 'critical' : 'high',
        description: `${consecutiveTimeouts} consecutive timeout errors`,
        suggestion: `Page is too slow or elements are not loading. Consider increasing timeout or stopping.`,
        actions: timeoutActions,
      };
    }

    return null;
  }

  /**
   * Check if we should stop based on patterns
   */
  static shouldStopTest(state: TestState): { shouldStop: boolean; reason?: string } {
    const detection = this.detectPatterns(state);

    if (detection.shouldStop) {
      return {
        shouldStop: true,
        reason: detection.reason || 'Critical pattern detected',
      };
    }

    return { shouldStop: false };
  }

  /**
   * Get recommendations based on patterns
   */
  static getRecommendations(state: TestState): string[] {
    const detection = this.detectPatterns(state);
    return detection.patterns.map(p => p.suggestion);
  }
}
