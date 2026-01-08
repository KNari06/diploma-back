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
  private consecutiveStuckCount: number = 0; // Track consecutive stuck iterations for AI fallback trigger

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
   * ✅ MY IDEA: Enhanced with URL pattern detection (redirects, same page navigation)
   *
   * @returns Stuck check result with reason and suggestion
   */
  isStuck(): StuckCheck {
    const last3 = this.iterations.slice(-3);

    if (last3.length < 3) {
      // Not enough history to determine stuck state - ensure counter is reset
      this.consecutiveStuckCount = 0;
      return { stuck: false };
    }

    // Check 1: URL unchanged for 3 iterations
    const urlUnchanged = last3.every(
      (i) => i.stateAfter.url === last3[0].stateAfter.url
    );

    // ✅ MY IDEA: Check if URL keeps changing but it's the same pattern (redirect loop)
    const urlsChanged = last3.map((i) => i.stateAfter.url);
    const hasUrlChanges = new Set(urlsChanged).size > 1;
    const allDifferent = new Set(urlsChanged).size === 3;

    // Check for redirect loop (all 3 URLs different but probably redirecting)
    if (hasUrlChanges && allDifferent) {
      const allRedirects = last3.every((i) => i.result.stateDiff.urlChanged);
      if (allRedirects) {
        this.consecutiveStuckCount++;
        logger.warn('[LITE_STATE] Possible redirect loop detected', {
          urls: urlsChanged.map((u) => this.getShortUrl(u)),
          consecutiveStuckCount: this.consecutiveStuckCount,
        });

        return {
          stuck: true,
          reason: 'Possible redirect loop: URL keeps changing but no progress',
          suggestion:
            'You might be in a redirect loop. Try a different navigation path or check for authentication requirements.',
        };
      }
    }

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
      this.consecutiveStuckCount++;
      logger.warn('[LITE_STATE] Agent stuck: identical state hash 3 times', {
        hash: last3Hashes[0],
        url: last3[0].stateAfter.url,
        consecutiveStuckCount: this.consecutiveStuckCount,
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
      this.consecutiveStuckCount++;
      logger.warn('[LITE_STATE] Agent stuck: same action repeated', {
        action: last3[0].decision.command.action,
        ref: last3[0].decision.command.ref,
        consecutiveStuckCount: this.consecutiveStuckCount,
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
      this.consecutiveStuckCount++;
      logger.warn('[LITE_STATE] Agent stuck: no progress', {
        lastAction: last3[2].decision.command.action,
        consecutiveStuckCount: this.consecutiveStuckCount,
      });

      return {
        stuck: true,
        reason: 'No significant progress in 3 iterations',
        suggestion:
          'Consider: scrolling to find more elements, closing popups, or trying different navigation path',
      };
    }

    // Not stuck - reset counter
    this.consecutiveStuckCount = 0;
    return { stuck: false };
  }

  /**
   * Get consecutive stuck count
   * Used by LiteEngine to determine when to trigger AI fallback
   *
   * @returns Number of consecutive stuck iterations
   */
  getConsecutiveStuckCount(): number {
    return this.consecutiveStuckCount;
  }

  /**
   * Reset consecutive stuck count
   * Called when agent makes progress or AI fallback provides guidance
   */
  resetConsecutiveStuckCount(): void {
    this.consecutiveStuckCount = 0;
    logger.debug('[LITE_STATE] Reset consecutive stuck count');
  }

  /**
   * Get the current state hash
   * Used by LiteEngine for audit cooldown bypass detection
   *
   * @returns Current state hash or null if no iterations recorded
   */
  getCurrentStateHash(): string | null {
    if (this.stateHashes.length === 0) {
      return null;
    }
    return this.stateHashes[this.stateHashes.length - 1];
  }

  /**
   * Compute state hash from URL and element names
   * Used for accurate stuck detection
   * ✅ FIX: Filters out dynamic elements (clocks, ads, timers) to prevent false negatives
   *
   * @param url - Current page URL
   * @param elements - Element names/refs on the page
   * @returns Hash string
   */
  private computeStateHash(url: string, elements: string[]): string {
    // ✅ FIX: Filter out dynamic/noisy elements before hashing
    const stableElements = this.filterDynamicElements(elements);

    const data = url + '|' + stableElements.sort().join(',');
    // djb2 hash algorithm
    let hash = 5381;
    for (let i = 0; i < data.length; i++) {
      hash = (hash * 33) ^ data.charCodeAt(i);
    }
    return hash.toString(16);
  }

  /**
   * Filter out dynamic elements that change frequently
   * ✅ FIX: Prevents clocks, ads, timers from breaking stuck detection
   *
   * @param elements - Raw element names/refs
   * @returns Filtered stable elements
   */
  private filterDynamicElements(elements: string[]): string[] {
    const DYNAMIC_PATTERNS = [
      // Time-related
      /time/i,
      /clock/i,
      /timer/i,
      /countdown/i,
      /\d{1,2}:\d{2}(:\d{2})?/, // HH:MM:SS format
      // Ads and dynamic content
      /ad[_-]?banner/i,
      /advertisement/i,
      /sponsored/i,
      /promo/i,
      // Animations and loaders
      /spinner/i,
      /loading/i,
      /skeleton/i,
      /placeholder/i,
      // Counters and stats
      /\d+\s*(views?|likes?|shares?)/i,
      /visitor[_-]?count/i,
      // Live updates
      /live[_-]?update/i,
      /realtime/i,
      /streaming/i,
    ];

    const filtered = elements.filter((el) => {
      const lowerEl = el.toLowerCase();
      // Keep element if it doesn't match any dynamic pattern
      return !DYNAMIC_PATTERNS.some((pattern) => pattern.test(lowerEl));
    });

    // Log if we filtered out elements (for debugging)
    if (filtered.length < elements.length) {
      logger.debug('[LITE_STATE] Filtered dynamic elements from hash', {
        original: elements.length,
        filtered: filtered.length,
        removed: elements.length - filtered.length,
      });
    }

    return filtered;
  }

  /**
   * Get formatted history for AI prompt
   * Concise format to fit in token limits
   * Compresses repeated wait/no_effect actions to reduce token waste
   * ✅ FIX: Dynamic limit based on available token budget (5-10 iterations)
   *
   * @param maxIterations - Maximum number of iterations to include (default: dynamic based on history size)
   * @returns Formatted history string
   */
  getFormattedHistory(maxIterations?: number): string {
    if (this.iterations.length === 0) {
      return 'No actions yet';
    }

    // ✅ FIX: Dynamic limit based on complexity
    // For complex flows (10+ iterations), show more history if tokens allow
    // For simple flows, keep it short
    let limit: number;
    if (maxIterations !== undefined) {
      limit = maxIterations;
    } else {
      // Auto-adjust based on total iteration count
      const totalIterations = this.iterations.length;
      if (totalIterations >= 10) {
        limit = 10; // Long flow - show more context
      } else if (totalIterations >= 7) {
        limit = 7; // Medium flow
      } else {
        limit = 5; // Short flow
      }

      logger.debug('[LITE_STATE] Dynamic history limit', {
        totalIterations,
        limit,
        reason: totalIterations >= 10 ? 'Complex flow' : totalIterations >= 7 ? 'Medium flow' : 'Short flow',
      });
    }

    // Get recent iterations (last N)
    const recentIterations = this.iterations.slice(-limit);

    const lines: string[] = [];
    let lastActionKey: string | null = null;
    let repeatCount = 1;

    recentIterations.forEach((iter, idx) => {
      const outcomeEmoji = this.getOutcomeEmoji(iter.result.outcome);
      const actionStr = `${iter.decision.command.action}${iter.decision.command.ref ? `(${iter.decision.command.ref})` : ''}`;

      // Check if this is a "noisy" action that should be compressed
      const isNoisyAction = iter.decision.command.action === 'wait' || iter.result.outcome === 'no_effect';
      const currentActionKey = `${actionStr}_${iter.result.outcome}`;

      // Compress consecutive noisy actions
      if (idx > 0 && isNoisyAction && currentActionKey === lastActionKey) {
        repeatCount++;
        return; // Skip this iteration, will add count at the end
      }

      // If we had repeated actions, add the count to the last line
      if (repeatCount > 1 && lines.length > 0) {
        lines[lines.length - 1] += ` (×${repeatCount})`;
      }
      repeatCount = 1;
      lastActionKey = isNoisyAction ? currentActionKey : null;

      // Build the line
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

    // Handle trailing repeats
    if (repeatCount > 1 && lines.length > 0) {
      lines[lines.length - 1] += ` (×${repeatCount})`;
    }

    return lines.join('\n');
  }

  /**
   * Get last action outcome
   * Used to provide feedback to AI about previous action
   * ✅ MY IDEA: Enhanced with more context (element count changes, error details)
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
      case 'state_changed': {
        if (diff.urlChanged) {
          return `✅ Success: Navigated to ${this.getShortUrl(diff.urlAfter)}`;
        }
        // ✅ MY IDEA: Add element change context for better AI understanding
        const addedCount = diff.addedElements.length;
        const removedCount = diff.removedRefs.length;
        let changeDesc = StateDiffComputer.format(diff);
        if (addedCount > 0 || removedCount > 0) {
          changeDesc += ` (Added: ${addedCount}, Removed: ${removedCount})`;
        }
        return `✅ Success: ${changeDesc}`;
      }

      case 'validation_error': {
        if (diff.newPageErrors.length > 0) {
          // ✅ MY IDEA: Show multiple errors if available (max 2)
          const errors = diff.newPageErrors.slice(0, 2);
          const errorMsg = errors.join('; ');
          return `⚠️ Validation error: ${errorMsg.slice(0, 150)}${diff.newPageErrors.length > 2 ? ` (+${diff.newPageErrors.length - 2} more)` : ''}`;
        }
        return `⚠️ Validation error detected`;
      }

      case 'no_effect':
        // ✅ MY IDEA: Add hint about what to try next
        return `➖ No effect: Action executed but no state change detected. Try: different element, scroll, or wait.`;

      case 'execution_error': {
        // ✅ MY IDEA: Include action that failed for better context
        const failedAction = last.decision.command.action;
        const failedRef = last.decision.command.ref;
        return `❌ Execution error (${failedAction}${failedRef ? ` on ${failedRef}` : ''}): ${last.result.error?.slice(0, 100) || 'Unknown error'}`;
      }

      case 'critical_error':
        return `🔴 CRITICAL ERROR: Page crashed/blank - page was reloaded. Start fresh.`;

      case 'rate_limited':
        return `⏳ Rate limited (HTTP 429): Backing off and waiting before retrying.`;

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
    this.consecutiveStuckCount = 0;
    logger.debug('[LITE_STATE] Cleared all iterations, hashes, and stuck count');
  }

  /**
   * Get state metrics for monitoring and debugging
   * ✅ MY IDEA: Useful for production monitoring and debugging stuck issues
   *
   * @returns State metrics object
   */
  getMetrics(): {
    totalIterations: number;
    consecutiveStuckCount: number;
    outcomeDistribution: Record<ActionOutcome, number>;
    uniqueUrls: number;
    averageElementChangePerIteration: number;
    lastStateHash: string | undefined;
  } {
    const outcomeDistribution: Record<ActionOutcome, number> = {
      state_changed: 0,
      validation_error: 0,
      no_effect: 0,
      execution_error: 0,
      critical_error: 0,
      rate_limited: 0,
    };

    let totalElementChanges = 0;
    const uniqueUrls = new Set<string>();

    this.iterations.forEach((iter) => {
      outcomeDistribution[iter.result.outcome]++;
      totalElementChanges +=
        iter.result.stateDiff.addedElements.length + iter.result.stateDiff.removedRefs.length;
      uniqueUrls.add(iter.stateAfter.url);
    });

    const avgElementChange =
      this.iterations.length > 0 ? totalElementChanges / this.iterations.length : 0;

    return {
      totalIterations: this.iterations.length,
      consecutiveStuckCount: this.consecutiveStuckCount,
      outcomeDistribution,
      uniqueUrls: uniqueUrls.size,
      averageElementChangePerIteration: Math.round(avgElementChange * 10) / 10,
      lastStateHash: this.stateHashes[this.stateHashes.length - 1],
    };
  }

  /**
   * Get emoji for outcome
   * ✅ IMPORTANT: AI responds very well to emoji (✅/❌)
   * This helps AI instantly understand result "color" without reading text
   * Emojis are parsed faster than text and improve decision quality
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
      case 'rate_limited':
        return '⏳';
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
