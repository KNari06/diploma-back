/**
 * ActionPatternDetector
 * Detects problematic patterns in test execution:
 * - Repeated actions (clicking same button multiple times)
 * - Failed action chains (multiple failures in a row)
 * - Stuck patterns (no progress after N actions)
 */

import { logger } from '@/utils/logger';
import { ActionResult, DynamicAction, TestState } from '../types/intelligent-testing.types';

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
