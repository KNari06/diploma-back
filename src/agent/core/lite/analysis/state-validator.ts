/**
 * StateValidator
 * Validates action outcomes based on state changes
 * Determines if action was successful, had no effect, or encountered errors
 */

import { logger } from '@/utils/core/logger';
import type { ActionOutcome, StateDiff } from '../lite-types';

export class StateValidator {
  /**
   * Validate action outcome based on state diff
   * Uses feedback loop principle: success = state changed
   *
   * @param diff - State diff to validate
   * @param executionError - Optional execution error message
   * @param elementCountBefore - Element count before action (for critical error detection)
   * @param elementCountAfter - Element count after action (for critical error detection)
   * @returns Action outcome classification
   */
  static validate(
    diff: StateDiff,
    executionError?: string,
    elementCountBefore?: number,
    elementCountAfter?: number,
    actionType?: string
  ): ActionOutcome {
    try {
      // 1. Execution error - action failed to execute
      if (executionError) {
        logger.debug('[STATE_VALIDATOR] Execution error detected', {
          error: executionError.slice(0, 100),
        });
        return 'execution_error';
      }

      // 2. Rate limited - HTTP 429 detected (back off and wait)
      const net = diff.newNetworkErrors || [];
      const rateLimited = net.some((e) => {
        const s = (e || '').toLowerCase();
        return s.includes('http 429') || s.includes(' 429') || s.includes('too many requests') || s.includes('rate limit');
      });
      if (rateLimited) {
        logger.warn('[STATE_VALIDATOR] Rate limit detected', {
          networkErrors: net.slice(0, 2),
        });
        return 'rate_limited';
      }

      // 2. CRITICAL ERROR - page crashed/blank (>90% elements disappeared)
      // This indicates a white screen or page crash that needs reload
      if (
        elementCountBefore !== undefined &&
        elementCountAfter !== undefined &&
        elementCountBefore > 10 &&
        elementCountAfter < 3
      ) {
        logger.error('[STATE_VALIDATOR] CRITICAL ERROR: Page appears blank', {
          elementsBefore: elementCountBefore,
          elementsAfter: elementCountAfter,
        });
        return 'critical_error';
      }

      // 3. State changed - action was successful
      // Checked BEFORE validation_error: if DOM changed, the action worked even if
      // the page has background JS errors (unrelated console errors, analytics failures, etc.)
      if (diff.hasVisualChange) {
        if (diff.newPageErrors.length > 0 || diff.newConsoleErrors.length > 0) {
          logger.debug('[STATE_VALIDATOR] State changed WITH errors (errors likely unrelated)', {
            urlChanged: diff.urlChanged,
            addedElements: diff.addedElements.length,
            pageErrors: diff.newPageErrors.length,
            consoleErrors: diff.newConsoleErrors.length,
          });
        } else {
          logger.debug('[STATE_VALIDATOR] State changed - action successful', {
            urlChanged: diff.urlChanged,
            addedElements: diff.addedElements.length,
            removedRefs: diff.removedRefs.length,
            changedElements: diff.changedElements.length,
          });
        }
        return 'state_changed';
      }

      // 3b. Fill/select actions always change state (input value) even when diff doesn't detect it
      // The diff engine tracks DOM structure changes but not input value mutations.
      // If fill/select executed without error, the field was filled — treat as state_changed.
      if ((actionType === 'fill' || actionType === 'select') && !executionError) {
        logger.debug('[STATE_VALIDATOR] Fill/select completed without error — treating as state_changed', {
          actionType,
          hasPageErrors: diff.newPageErrors.length > 0,
        });
        return 'state_changed';
      }

      // 4. Validation error - new errors appeared BUT no state change
      // This means the action didn't work AND errors appeared (form validation failure, etc.)
      if (diff.newPageErrors.length > 0 || diff.newConsoleErrors.length > 0) {
        logger.debug('[STATE_VALIDATOR] Validation errors detected (no state change)', {
          pageErrors: diff.newPageErrors.length,
          consoleErrors: diff.newConsoleErrors.length,
        });
        return 'validation_error';
      }

      // 5. No effect - action executed but no visible state change
      logger.debug('[STATE_VALIDATOR] No state change detected');
      return 'no_effect';
    } catch (error) {
      logger.error('[STATE_VALIDATOR] Failed to validate state', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Default to no_effect on validation error
      return 'no_effect';
    }
  }

  /**
   * Check if outcome represents success
   *
   * @param outcome - Action outcome to check
   * @returns True if action was successful
   */
  static isSuccess(outcome: ActionOutcome): boolean {
    return outcome === 'state_changed';
  }

  /**
   * Check if outcome represents an error
   *
   * @param outcome - Action outcome to check
   * @returns True if there was an error
   */
  static isError(outcome: ActionOutcome): boolean {
    // rate_limited is not an "error" for the agent - it should back off and retry later
    return outcome === 'execution_error' || outcome === 'validation_error' || outcome === 'critical_error';
  }

  /**
   * Check if outcome is a critical error requiring page reload
   *
   * @param outcome - Action outcome to check
   * @returns True if critical error
   */
  static isCritical(outcome: ActionOutcome): boolean {
    return outcome === 'critical_error';
  }

  /**
   * Get human-readable description of outcome
   *
   * @param outcome - Action outcome
   * @param diff - State diff for context
   * @returns Description string
   */
  static describe(outcome: ActionOutcome, diff?: StateDiff): string {
    switch (outcome) {
      case 'state_changed':
        if (diff?.urlChanged) {
          return `Success: Navigated to ${diff.urlAfter}`;
        }
        if (diff?.addedElements && diff.addedElements.length > 0) {
          return `Success: ${diff.addedElements.length} new elements appeared`;
        }
        if (diff?.changedElements && diff.changedElements.length > 0) {
          return `Success: ${diff.changedElements.length} elements changed`;
        }
        return 'Success: Page state changed';

      case 'validation_error':
        if (diff?.newPageErrors && diff.newPageErrors.length > 0) {
          return `Validation error: ${diff.newPageErrors[0].slice(0, 100)}`;
        }
        if (diff?.newConsoleErrors && diff.newConsoleErrors.length > 0) {
          return `Console error: ${diff.newConsoleErrors[0].slice(0, 100)}`;
        }
        return 'Validation error: New errors detected';

      case 'rate_limited':
        if (diff?.newNetworkErrors && diff.newNetworkErrors.length > 0) {
          return `Rate limited: ${diff.newNetworkErrors[0].slice(0, 100)}`;
        }
        return 'Rate limited: HTTP 429 detected - backing off';

      case 'no_effect':
        return 'No effect: Action executed but no state change detected';

      case 'execution_error':
        return 'Execution error: Action failed to execute';

      case 'critical_error':
        return 'CRITICAL ERROR: Page appears blank/crashed - attempting reload';

      default:
        return 'Unknown outcome';
    }
  }

  /**
   * Calculate confidence score for outcome
   * Higher score = more confident about the outcome
   *
   * @param outcome - Action outcome
   * @param diff - State diff
   * @returns Confidence score (0-1)
   */
  static getConfidence(outcome: ActionOutcome, diff: StateDiff): number {
    switch (outcome) {
      case 'state_changed': {
        // High confidence if multiple indicators of change
        let score = 0.5;
        if (diff.urlChanged) score += 0.3;
        if (diff.addedElements.length > 3) score += 0.2;
        if (diff.removedRefs.length > 3) score += 0.1;
        if (diff.changedElements.length > 0) score += 0.1;
        return Math.min(score, 1.0);
      }

      case 'validation_error':
        // High confidence if errors are present
        return diff.newPageErrors.length + diff.newConsoleErrors.length > 0 ? 0.9 : 0.5;

      case 'rate_limited':
        // High confidence if network errors indicate 429
        return (diff.newNetworkErrors || []).length > 0 ? 0.95 : 0.7;

      case 'execution_error':
        // Always high confidence for execution errors
        return 0.95;

      case 'no_effect':
        // Low confidence - might have missed subtle changes
        return 0.6;

      case 'critical_error':
        // Very high confidence - drastic element drop is clear
        return 0.99;

      default:
        return 0.5;
    }
  }
}
