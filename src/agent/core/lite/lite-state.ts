/**
 * LiteState
 * Manages iteration history and stuck detection
 * CRITICAL: Prevents infinite loops and token waste
 */

import { logger } from '@/utils/core/logger';
import { StateDiffComputer } from './analysis/state-diff';
import type { ActionOutcome, IterationRecord, StuckCheck } from './lite-types';

export class LiteState {
  private iterations: IterationRecord[] = [];
  private stateHashes: string[] = []; // Track state hashes for stuck detection

  /**
   * Record an iteration
   * Stores full iteration data including decision, result, and state changes
   * Also computes state hash for stuck detection
   *
   * @param record - Iteration record to store
   */
  recordIteration(record: IterationRecord): void {
    this.iterations.push(record);

    // Compute and store state hash for stuck detection
    const elementNames = record.result.stateDiff.addedElements
      .map((el) => el.name)
      .concat(record.result.stateDiff.removedRefs);
    const hash = this.computeStateHash(record.stateAfter.url, elementNames);
    this.stateHashes.push(hash);

    logger.debug('[LITE_STATE] Recorded iteration', {
      iteration: record.iteration,
      action: record.decision.command.action,
      outcome: record.result.outcome,
      urlChanged: record.result.stateDiff.urlChanged,
      stateHash: hash,
    });
  }

  /**
   * Check if agent is stuck
   * Detects patterns that indicate no progress using state hashes
   *
   * @returns Stuck check result with reason and suggestion
   */
  isStuck(): StuckCheck {
    const last3 = this.iterations.slice(-3);

    if (last3.length < 3) {
      return { stuck: false };
    }

    // Check 1: URL unchanged for 3 iterations
    const urlUnchanged = last3.every(
      (i) => i.stateAfter.url === last3[0].stateAfter.url
    );

    // Check 2: Same state hash 3 times (more accurate than action comparison)
    const last3Hashes = this.stateHashes.slice(-3);
    const sameStateHash =
      last3Hashes.length === 3 &&
      last3Hashes[0] === last3Hashes[1] &&
      last3Hashes[1] === last3Hashes[2];

    // Check 3: Same action on same target 3 times
    const sameAction = last3.every(
      (i) =>
        i.decision.command.action === last3[0].decision.command.action &&
        i.decision.command.ref === last3[0].decision.command.ref
    );

    // Check 4: No significant visual changes
    const noMajorChanges = last3.every(
      (i) =>
        !i.result.stateDiff.urlChanged &&
        i.result.stateDiff.addedElements.length < 2 &&
        i.result.stateDiff.removedRefs.length < 2
    );

    // Stuck scenario 1: Same state hash repeated 3 times (highest priority)
    if (urlUnchanged && sameStateHash) {
      logger.warn('[LITE_STATE] Agent stuck: identical state hash 3 times', {
        hash: last3Hashes[0],
        url: last3[0].stateAfter.url,
      });

      return {
        stuck: true,
        reason: 'Page state unchanged for 3 iterations (identical hash)',
        suggestion:
          'YOU ARE IN A DEAD END. Try a COMPLETELY DIFFERENT approach: scroll down, look for alternative buttons, check for hidden modals, or navigate to a different section.',
      };
    }

    // Stuck scenario 2: Same action repeated
    if (urlUnchanged && sameAction) {
      logger.warn('[LITE_STATE] Agent stuck: same action repeated', {
        action: last3[0].decision.command.action,
        ref: last3[0].decision.command.ref,
      });

      return {
        stuck: true,
        reason: `Same action "${last3[0].decision.command.action}" on "${last3[0].decision.command.ref}" 3 times`,
        suggestion:
          'Try different approach: refresh page, go back, or look for hidden modals blocking the screen',
      };
    }

    // Stuck scenario 3: No progress
    if (urlUnchanged && noMajorChanges) {
      logger.warn('[LITE_STATE] Agent stuck: no progress', {
        lastAction: last3[2].decision.command.action,
      });

      return {
        stuck: true,
        reason: 'No significant progress in 3 iterations',
        suggestion:
          'Consider: scrolling to find more elements, closing popups, or trying different navigation path',
      };
    }

    return { stuck: false };
  }

  /**
   * Compute state hash from URL and element names
   * Used for accurate stuck detection
   *
   * @param url - Current page URL
   * @param elements - Element names/refs on the page
   * @returns Hash string
   */
  private computeStateHash(url: string, elements: string[]): string {
    const data = url + '|' + elements.sort().join(',');
    // djb2 hash algorithm
    let hash = 5381;
    for (let i = 0; i < data.length; i++) {
      hash = (hash * 33) ^ data.charCodeAt(i);
    }
    return hash.toString(16);
  }

  /**
   * Get formatted history for AI prompt
   * Concise format to fit in token limits
   *
   * @param maxIterations - Maximum number of iterations to include (default: 5)
   * @returns Formatted history string
   */
  getFormattedHistory(maxIterations: number = 5): string {
    if (this.iterations.length === 0) {
      return 'No actions yet';
    }

    // Get recent iterations (last N)
    const recentIterations = this.iterations.slice(-maxIterations);

    const lines: string[] = [];

    recentIterations.forEach((iter) => {
      const outcomeEmoji = this.getOutcomeEmoji(iter.result.outcome);
      const actionStr = `${iter.decision.command.action}${iter.decision.command.ref ? `(${iter.decision.command.ref})` : ''}`;

      let line = `${iter.iteration + 1}. ${outcomeEmoji} ${actionStr}`;

      // Add brief state change info
      if (iter.result.stateDiff.urlChanged) {
        line += ` → ${this.getShortUrl(iter.stateAfter.url)}`;
      } else if (iter.result.stateDiff.addedElements.length > 0) {
        line += ` (+${iter.result.stateDiff.addedElements.length} elements)`;
      } else if (iter.result.outcome === 'no_effect') {
        line += ' (no change)';
      } else if (iter.result.error) {
        line += ` (${iter.result.error.slice(0, 30)})`;
      }

      lines.push(line);
    });

    return lines.join('\n');
  }

  /**
   * Get last action outcome
   * Used to provide feedback to AI about previous action
   *
   * @returns Description of last outcome or undefined
   */
  getLastOutcome(): string | undefined {
    if (this.iterations.length === 0) {
      return undefined;
    }

    const last = this.iterations[this.iterations.length - 1];
    const diff = last.result.stateDiff;

    switch (last.result.outcome) {
      case 'state_changed':
        if (diff.urlChanged) {
          return `✅ Success: Navigated to ${this.getShortUrl(diff.urlAfter)}`;
        }
        return `✅ Success: ${StateDiffComputer.format(diff)}`;

      case 'validation_error':
        if (diff.newPageErrors.length > 0) {
          return `⚠️ Validation error: ${diff.newPageErrors[0].slice(0, 100)}`;
        }
        return `⚠️ Validation error detected`;

      case 'no_effect':
        return `➖ No effect: Action executed but no state change detected`;

      case 'execution_error':
        return `❌ Execution error: ${last.result.error?.slice(0, 100) || 'Unknown error'}`;

      case 'critical_error':
        return `🔴 CRITICAL ERROR: Page crashed/blank - page was reloaded`;

      default:
        return undefined;
    }
  }

  /**
   * Get iteration count
   */
  getIterationCount(): number {
    return this.iterations.length;
  }

  /**
   * Get all iterations
   */
  getAllIterations(): IterationRecord[] {
    return [...this.iterations];
  }

  /**
   * Clear all iterations and state hashes
   */
  clear(): void {
    this.iterations = [];
    this.stateHashes = [];
    logger.debug('[LITE_STATE] Cleared all iterations and hashes');
  }

  /**
   * Get emoji for outcome
   */
  private getOutcomeEmoji(outcome: ActionOutcome): string {
    switch (outcome) {
      case 'state_changed':
        return '✅';
      case 'validation_error':
        return '⚠️';
      case 'no_effect':
        return '➖';
      case 'execution_error':
        return '❌';
      case 'critical_error':
        return '🔴';
      default:
        return '❓';
    }
  }

  /**
   * Get short version of URL
   */
  private getShortUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname + urlObj.search;
      return path.slice(0, 50);
    } catch {
      return url.slice(0, 50);
    }
  }
}
