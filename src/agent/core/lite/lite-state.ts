/**
 * LiteState
 * Manages iteration history and stuck detection
 * CRITICAL: Prevents infinite loops and token waste
 *
 * WORKSTREAM 4: Also manages recovery anchors and attempt counters
 */

import { logger } from '@/utils/core/logger';
import { StateDiffComputer } from './analysis/state-diff';
import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import type {
  ActionOutcome,
  BlacklistedAction,
  FailedActionEntry,
  FunnelPhaseType,
  IterationRecord,
  LiteSnapshot,
  RecoveryPoint,
  StateDiff,
  StuckCheck,
  VisualSignature,
} from './lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// WORKSTREAM 4: Recovery Constants
// ═══════════════════════════════════════════════════════════════════════════
const ANCHOR_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RECOVERY_ATTEMPTS = 2;

export class LiteState {
  private iterations: IterationRecord[] = [];
  private stateHashes: string[] = []; // Track state hashes for stuck detection
  private focusedStateHashes: string[] = []; // PHASE C: Track goal-focused element hashes (semantic delta)
  private focusedHighWeightCounts: number[] = []; // WORKSTREAM C: Track count of high-weight (>=0.8) elements
  private consecutiveStuckCount: number = 0; // Track consecutive stuck iterations for AI fallback trigger
  // Visual Anchors: Store signatures for interacted elements (fallback when ref changes)
  private visualSignatures: Map<string, VisualSignature> = new Map();

  // P1: Cached regex patterns for performance (avoid recompiling in filterDynamicElements)
  private static readonly DYNAMIC_PATTERNS = [
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

  // ═══════════════════════════════════════════════════════════════════════════
  // NEGATIVE REINFORCEMENT: Failed Action Tracking
  // ═══════════════════════════════════════════════════════════════════════════
  /** Failed actions map: key = "{action}:{ref}", value = FailedActionEntry */
  private failedActions: Map<string, FailedActionEntry> = new Map();
  /** Maximum number of failed action entries (LRU eviction) */
  private readonly MAX_FAILED_ACTIONS = 50;

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE DRIFT AUDITOR: Tracking State
  // ═══════════════════════════════════════════════════════════════════════════
  /** URL path → visit count (for loop detection) */
  private urlVisitCounts: Map<string, number> = new Map();
  /** Normalized error message → occurrence count */
  private errorOccurrenceCounts: Map<string, number> = new Map();
  /** Ring buffer of recent element ref sets for flicker detection (last 5 iterations) */
  private recentElementRefSets: Array<Set<string>> = [];
  /** Error count per iteration for trend detection (last 5) */
  private errorCountHistory: number[] = [];
  /** Ring buffer max size */
  private readonly RING_BUFFER_SIZE = 5;

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSTREAM 4: Recovery State
  // ═══════════════════════════════════════════════════════════════════════════
  /** Recovery points by funnel phase (one per phase) */
  private recoveryPointByPhase: Map<FunnelPhaseType, RecoveryPoint> = new Map();
  /** Recovery attempts by key (goal + normalizedUrl) - loop-proof */
  private recoveryAttemptsByKey: Map<string, number> = new Map();
  /** Last recovery attempt key - for zombie detection */
  private lastRecoveryAttemptKey: string | null = null;
  /** Iteration when last recovery attempt happened */
  private lastRecoveryAttemptIteration: number | null = null;

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
   * WORKSTREAM C: Record focused semantic metrics
   * Combines hash (for "false progress" detection) with high-weight count (for "no growth" detection)
   *
   * @param url - Current page URL
   * @param goalRelevantElements - Array of element names with weight >= 0.5
   * @param highWeightCount - Count of elements with weight >= 0.8 (top targets)
   */
  recordFocusedMetrics(url: string, goalRelevantElements: string[], highWeightCount: number): void {
    const focusedHash = this.computeStateHash(url, goalRelevantElements);
    this.focusedStateHashes.push(focusedHash);
    this.focusedHighWeightCounts.push(highWeightCount);

    logger.debug('[LITE_STATE] Recorded focused metrics', {
      focusedHash,
      elementCount: goalRelevantElements.length,
      highWeightCount,
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

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE C: Focused Semantic Hash Check (Semantic Delta)
    // Detects "false progress" - ads/timers changing but goal zone is static
    // ═══════════════════════════════════════════════════════════════════════════
    const last3FocusedHashes = this.focusedStateHashes.slice(-3);
    const sameFocusedHash =
      last3FocusedHashes.length === 3 &&
      last3FocusedHashes[0] === last3FocusedHashes[1] &&
      last3FocusedHashes[1] === last3FocusedHashes[2];

    // False progress: regular hash changes but focused hash stays the same
    // This means ads/banners are changing but goal-relevant elements are static
    if (!sameStateHash && sameFocusedHash && urlUnchanged) {
      this.consecutiveStuckCount++;
      logger.warn('[LITE_STATE] False progress detected via focused hash', {
        regularHashChanges: true,
        focusedHashStatic: true,
        focusedHash: last3FocusedHashes[0],
        consecutiveStuckCount: this.consecutiveStuckCount,
      });

      return {
        stuck: true,
        reason: 'False progress: dynamic content changing but goal zone is static',
        suggestion:
          'Ads, timers, or banners may be changing but no progress toward goal. Try interacting with elements in the goal-relevant area.',
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // WORKSTREAM C: High-weight count growth check (for dynamic/lazy-load pages)
    // Detects "dynamic churn" - focused hash changes but no NEW high-importance targets
    // ═══════════════════════════════════════════════════════════════════════════
    const last3HighCounts = this.focusedHighWeightCounts.slice(-3);
    if (last3HighCounts.length === 3 && urlUnchanged && !sameFocusedHash) {
      // Focused hash is changing (dynamic content) but we need to check if
      // high-weight targets are actually growing
      const maxPrevious = Math.max(last3HighCounts[0], last3HighCounts[1]);
      const current = last3HighCounts[2];
      const noGrowth = current <= maxPrevious;

      // Additional gate: ensure we're actually seeing no progress (no major changes)
      const noMajorChangesLocal = last3.every(
        (i) =>
          !i.result.stateDiff.urlChanged &&
          i.result.stateDiff.addedElements.length < 3
      );

      if (noGrowth && noMajorChangesLocal) {
        this.consecutiveStuckCount++;
        logger.warn('[LITE_STATE] Dynamic churn without new targets detected', {
          last3HighCounts,
          focusedHashChanging: true,
          noGrowth: true,
          consecutiveStuckCount: this.consecutiveStuckCount,
        });

        return {
          stuck: true,
          reason: 'Dynamic content changing but no new high-importance targets (>=0.8) in 3 iterations',
          suggestion:
            'Page is loading new content but not surfacing relevant targets. Try scrolling, waiting, or looking for alternative navigation.',
        };
      }
    }

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

    // ✅ FIX P2: Not stuck - but only reset counter on SIGNIFICANT progress
    // This prevents false resets when minor changes occur (ads, timers, etc.)
    const lastIteration = this.iterations[this.iterations.length - 1];
    if (lastIteration) {
      const lastDiff = lastIteration.result.stateDiff;
      // Reset only on real progress (URL change or significant DOM change)
      if (lastDiff.urlChanged || lastDiff.significantChange) {
        this.consecutiveStuckCount = 0;
        logger.debug('[LITE_STATE] Reset stuck count - significant progress detected', {
          urlChanged: lastDiff.urlChanged,
          significantChange: lastDiff.significantChange,
        });
      } else if (this.consecutiveStuckCount > 0) {
        // Full reset on minor progress (fix for non-consecutive accumulation bug)
        this.consecutiveStuckCount = 0;
        logger.debug('[LITE_STATE] Reset stuck count - minor progress detected', {
          newCount: this.consecutiveStuckCount,
        });
      }
    } else {
      // No iterations yet - reset
      this.consecutiveStuckCount = 0;
    }
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
    const filtered = elements.filter((el) => {
      const lowerEl = el.toLowerCase();
      // Keep element if it doesn't match any dynamic pattern
      // P1: Use cached static patterns for performance
      return !LiteState.DYNAMIC_PATTERNS.some((pattern) => pattern.test(lowerEl));
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
   * Get last state diff for AI analysis
   * Returns the state diff from the previous iteration to help AI understand what changed
   *
   * @returns Last state diff and action or undefined if no iterations yet
   */
  getLastStateDiff(): { diff: StateDiff; action: string } | undefined {
    if (this.iterations.length === 0) {
      return undefined;
    }

    const last = this.iterations[this.iterations.length - 1];
    return {
      diff: last.result.stateDiff,
      action: last.decision.command.action,
    };
  }

  /**
   * Get all iterations
   */
  getAllIterations(): IterationRecord[] {
    return [...this.iterations];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VISUAL ANCHORS: Signature Storage
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Save visual signature for an element after successful interaction.
   * Used as fallback when ref-based lookup fails on dynamic sites.
   *
   * @param ref Element ref that was interacted with
   * @param signature Visual signature (spatial fingerprint)
   */
  saveSignature(ref: string, signature: VisualSignature): void {
    this.visualSignatures.set(ref, signature);
    logger.debug('[LITE_STATE] Saved visual signature', {
      ref,
      tag: signature.tag,
      anchorCount: signature.anchors.length,
      ownText: signature.ownText.slice(0, 30),
    });
  }

  /**
   * Get visual signature for an element.
   * Used when ref-based lookup fails and we need to find element by spatial position.
   *
   * @param ref Element ref to look up
   * @returns Visual signature if exists, undefined otherwise
   */
  getSignature(ref: string): VisualSignature | undefined {
    return this.visualSignatures.get(ref);
  }

  /**
   * Check if we have a signature for an element
   *
   * @param ref Element ref to check
   * @returns True if signature exists
   */
  hasSignature(ref: string): boolean {
    return this.visualSignatures.has(ref);
  }

  /**
   * Get total number of stored signatures
   */
  getSignatureCount(): number {
    return this.visualSignatures.size;
  }

  /**
   * Clear all visual signatures (used for hard reload recovery)
   */
  clearVisualSignatures(): void {
    this.visualSignatures.clear();
    logger.debug('[LITE_STATE] Cleared visual signatures');
  }

  /**
   * Clear all iterations and state hashes
   */
  clear(): void {
    this.iterations = [];
    this.stateHashes = [];
    this.focusedStateHashes = []; // PHASE C: Clear focused hashes too
    this.focusedHighWeightCounts = []; // WORKSTREAM C: Clear high-weight counts
    this.consecutiveStuckCount = 0;
    this.visualSignatures.clear();
    // Negative reinforcement: Clear failed actions
    this.failedActions.clear();
    // State drift auditor: Clear tracking
    this.urlVisitCounts.clear();
    this.errorOccurrenceCounts.clear();
    this.recentElementRefSets = [];
    this.errorCountHistory = [];
    // WORKSTREAM 4: Clear recovery state
    this.recoveryPointByPhase.clear();
    this.recoveryAttemptsByKey.clear();
    this.lastRecoveryAttemptKey = null;
    this.lastRecoveryAttemptIteration = null;
    logger.debug('[LITE_STATE] Cleared all iterations, hashes, signatures, recovery state, and stuck count');
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

  // ═══════════════════════════════════════════════════════════════════════════
  // NEGATIVE REINFORCEMENT: Failed Action Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a failed action attempt
   * Increments failure count for the action+ref combination
   */
  recordFailedAction(
    action: string,
    ref: string,
    elementName: string,
    outcome: ActionOutcome,
    iteration: number,
    error?: string,
  ): void {
    const key = `${action}:${ref}`;
    const existing = this.failedActions.get(key);

    if (existing) {
      existing.failureCount++;
      existing.lastOutcome = outcome;
      existing.lastError = error;
      existing.lastFailureIteration = iteration;
    } else {
      // LRU eviction if at capacity
      if (this.failedActions.size >= this.MAX_FAILED_ACTIONS) {
        // Remove oldest entry by firstFailureIteration
        let oldestKey: string | null = null;
        let oldestIteration = Infinity;
        for (const [k, v] of this.failedActions) {
          if (v.firstFailureIteration < oldestIteration) {
            oldestIteration = v.firstFailureIteration;
            oldestKey = k;
          }
        }
        if (oldestKey) {
          this.failedActions.delete(oldestKey);
        }
      }

      this.failedActions.set(key, {
        action,
        ref,
        elementName,
        failureCount: 1,
        lastOutcome: outcome,
        lastError: error,
        firstFailureIteration: iteration,
        lastFailureIteration: iteration,
      });
    }

    logger.debug('[LITE_STATE] Recorded failed action', {
      key,
      failureCount: this.failedActions.get(key)?.failureCount,
      outcome,
    });
  }

  /**
   * Remove a failed action entry (action succeeded)
   */
  removeFailedAction(action: string, ref: string): void {
    const key = `${action}:${ref}`;
    if (this.failedActions.delete(key)) {
      logger.debug('[LITE_STATE] Removed failed action (succeeded)', { key });
    }
  }

  /**
   * Clear all failed actions (e.g., URL changed = new page)
   */
  clearFailedActions(): void {
    if (this.failedActions.size > 0) {
      logger.debug('[LITE_STATE] Cleared failed actions (URL changed)', {
        count: this.failedActions.size,
      });
      this.failedActions.clear();
    }
  }

  /**
   * Get blacklisted actions (failed >= threshold)
   * Returns max 5 entries sorted by failure count descending
   */
  getBlacklistedActions(): BlacklistedAction[] {
    const threshold = LITE_ENGINE_FLAGS.negativeReinforcementThreshold;
    const blacklisted: BlacklistedAction[] = [];

    for (const [key, entry] of this.failedActions) {
      if (entry.failureCount >= threshold) {
        blacklisted.push({
          key,
          action: entry.action,
          ref: entry.ref,
          elementName: entry.elementName,
          failureCount: entry.failureCount,
          lastOutcome: entry.lastOutcome,
          lastError: entry.lastError,
        });
      }
    }

    // Sort by failure count descending, limit to 5
    return blacklisted
      .sort((a, b) => b.failureCount - a.failureCount)
      .slice(0, 5);
  }

  /**
   * Check if an action is blacklisted
   */
  isActionBlacklisted(action: string, ref: string): boolean {
    const key = `${action}:${ref}`;
    const entry = this.failedActions.get(key);
    if (!entry) return false;
    return entry.failureCount >= LITE_ENGINE_FLAGS.negativeReinforcementThreshold;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE DRIFT AUDITOR: Tracking Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a URL visit for loop detection
   * Uses URL path only (ignoring query params)
   */
  recordUrlVisit(url: string): void {
    try {
      const path = new URL(url).pathname;
      const count = (this.urlVisitCounts.get(path) || 0) + 1;
      this.urlVisitCounts.set(path, count);
    } catch {
      // Invalid URL, ignore
    }
  }

  /**
   * Get URL visit counts (for auditor)
   */
  getUrlVisitCounts(): Map<string, number> {
    return this.urlVisitCounts;
  }

  /**
   * Record error occurrences for repetition detection
   */
  recordErrors(errors: string[]): void {
    for (const err of errors) {
      const normalized = err.toLowerCase().trim().slice(0, 100);
      if (normalized.length === 0) continue;
      const count = (this.errorOccurrenceCounts.get(normalized) || 0) + 1;
      this.errorOccurrenceCounts.set(normalized, count);
    }
  }

  /**
   * Get error occurrence counts (for auditor)
   */
  getErrorOccurrenceCounts(): Map<string, number> {
    return this.errorOccurrenceCounts;
  }

  /**
   * Record element ref set for flicker detection (ring buffer of 5)
   */
  recordElementRefSet(refs: Set<string>): void {
    this.recentElementRefSets.push(refs);
    if (this.recentElementRefSets.length > this.RING_BUFFER_SIZE) {
      this.recentElementRefSets.shift();
    }
  }

  /**
   * Get recent element ref sets (for flicker detection)
   */
  getRecentElementRefSets(): Array<Set<string>> {
    return this.recentElementRefSets;
  }

  /**
   * Record error count for trend detection
   */
  recordErrorCount(count: number): void {
    this.errorCountHistory.push(count);
    if (this.errorCountHistory.length > this.RING_BUFFER_SIZE) {
      this.errorCountHistory.shift();
    }
  }

  /**
   * Get error count history (for trend detection)
   */
  getErrorCountHistory(): number[] {
    return this.errorCountHistory;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSTREAM 4: Recovery Point Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a recovery key from goal and URL
   * Used for loop-proof attempt counting
   */
  /**
   * Compute content hash for SPA-aware recovery (TASK 8)
   * Creates a fingerprint of interactive elements to detect SPA changes
   */
  computeContentHash(snapshot: LiteSnapshot): string {
    // Collect interactive elements (buttons, links, inputs)
    const interactiveElements = snapshot.elements
      .filter(el => ['button', 'a', 'input', 'select', 'textarea'].includes(el.tag))
      .map(el => {
        const tag = el.tag;
        const name = (el.name || '').slice(0, 30);
        const type = el.type || '';
        return `${tag}:${name}:${type}`;
      })
      .sort(); // Sort for consistency

    // Simple DJB2 hash
    let hash = 5381;
    const combined = interactiveElements.join('|');
    for (let i = 0; i < combined.length; i++) {
      hash = ((hash << 5) + hash) + combined.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36); // Base-36 for shorter string
  }

  buildRecoveryKey(goal: string, url: string, contentHash?: string): string {
    try {
      const urlObj = new URL(url);
      const normalizedUrl = urlObj.origin + urlObj.pathname + urlObj.hash; // Ignore query, include hash
      const normalizedGoal = goal.toLowerCase().trim().slice(0, 100);
      const hashPart = contentHash ? `|${contentHash}` : '';
      return `${normalizedGoal}|${normalizedUrl}${hashPart}`;
    } catch {
      const hashPart = contentHash ? `|${contentHash}` : '';
      return `${goal.slice(0, 100)}|${url.slice(0, 100)}${hashPart}`;
    }
  }

  /**
   * Set a recovery point for a funnel phase
   * Only one point per phase (overwrite with fresher)
   */
  setRecoveryPoint(point: RecoveryPoint): void {
    this.recoveryPointByPhase.set(point.funnelPhase, point);
    logger.debug('[LITE_STATE] Set recovery point', {
      phase: point.funnelPhase,
      url: this.getShortUrl(point.url),
      iteration: point.iteration,
    });
  }

  /**
   * Get a recovery point for a funnel phase
   * Returns null if no point, stale (TTL), or invalidated (zombie)
   */
  getRecoveryPoint(phase: FunnelPhaseType): RecoveryPoint | null {
    const point = this.recoveryPointByPhase.get(phase);
    if (!point) return null;

    // Check TTL
    if (Date.now() - point.timestamp > ANCHOR_TTL_MS) {
      logger.warn('[LITE_STATE] Recovery point stale (TTL exceeded)', {
        phase,
        age: Math.round((Date.now() - point.timestamp) / 1000) + 's',
      });
      return null;
    }

    // Check if invalidated (zombie)
    if (point.invalidated) {
      logger.warn('[LITE_STATE] Recovery point invalidated (zombie)', { phase });
      return null;
    }

    return point;
  }

  /**
   * Invalidate a recovery point (zombie detection)
   * Called when recovery leads back to stuck
   */
  invalidateRecoveryPoint(phase: FunnelPhaseType): void {
    const point = this.recoveryPointByPhase.get(phase);
    if (point) {
      point.invalidated = true;
      logger.warn('[LITE_STATE] Invalidated recovery point (zombie)', { phase });
    }
    // Reset last recovery attempt tracking to avoid repeated invalidations
    this.lastRecoveryAttemptKey = null;
    this.lastRecoveryAttemptIteration = null;
  }

  /**
   * Get current recovery attempts for a key
   */
  getRecoveryAttempts(goal: string, url: string): number {
    const key = this.buildRecoveryKey(goal, url);
    return this.recoveryAttemptsByKey.get(key) || 0;
  }

  /**
   * Increment recovery attempts for a key
   * Returns new count
   */
  incRecoveryAttempt(goal: string, url: string): number {
    const key = this.buildRecoveryKey(goal, url);
    const current = this.recoveryAttemptsByKey.get(key) || 0;
    const newCount = current + 1;
    this.recoveryAttemptsByKey.set(key, newCount);

    logger.debug('[LITE_STATE] Incremented recovery attempt', {
      key: key.slice(0, 50),
      count: newCount,
      max: MAX_RECOVERY_ATTEMPTS,
    });

    return newCount;
  }

  /**
   * Check if recovery attempts are exhausted for a key
   */
  isRecoveryExhausted(goal: string, url: string): boolean {
    return this.getRecoveryAttempts(goal, url) >= MAX_RECOVERY_ATTEMPTS;
  }

  /**
   * Reset recovery attempts for a key
   * Called on phase change or meaningful URL change
   */
  resetRecoveryAttempts(goal: string, url: string): void {
    const key = this.buildRecoveryKey(goal, url);
    if (this.recoveryAttemptsByKey.has(key)) {
      this.recoveryAttemptsByKey.delete(key);
      logger.debug('[LITE_STATE] Reset recovery attempts', { key: key.slice(0, 50) });
    }
  }

  /**
   * Reset all recovery attempts
   * Called on FunnelPhase change (SPA-safe)
   */
  resetAllRecoveryAttempts(): void {
    if (this.recoveryAttemptsByKey.size > 0) {
      this.recoveryAttemptsByKey.clear();
      logger.debug('[LITE_STATE] Reset all recovery attempts (phase change)');
    }
  }

  /**
   * Record recovery attempt info for zombie detection
   *
   * @param key Recovery key (goal + normalized URL)
   * @param iteration Current iteration number
   */
  recordRecoveryAttempt(key: string, iteration: number): void {
    this.lastRecoveryAttemptKey = key;
    this.lastRecoveryAttemptIteration = iteration;
    logger.debug('[LITE_STATE] Recorded recovery attempt', {
      key: key.slice(0, 50),
      iteration,
    });
  }

  /**
   * Check if we should invalidate the current phase's recovery point
   * Returns true if we are stuck again within a short window for the same key
   *
   * @param key Recovery key for current attempt
   * @param iteration Current iteration
   */
  shouldInvalidateRecoveryPoint(key: string, iteration: number): boolean {
    if (!this.lastRecoveryAttemptKey || this.lastRecoveryAttemptIteration === null) {
      return false;
    }

    const sameKey = this.lastRecoveryAttemptKey === key;
    const withinWindow = iteration - this.lastRecoveryAttemptIteration <= 2;
    return sameKey && withinWindow;
  }

  /**
   * Clear recovery state
   */
  clearRecoveryState(): void {
    this.recoveryPointByPhase.clear();
    this.recoveryAttemptsByKey.clear();
    this.lastRecoveryAttemptKey = null;
    this.lastRecoveryAttemptIteration = null;
    logger.debug('[LITE_STATE] Cleared recovery state');
  }
}
