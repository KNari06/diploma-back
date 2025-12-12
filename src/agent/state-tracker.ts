/**
 * StateTracker
 * Tracks test execution state
 * Detects cycles, loops, and manages page visit history
 */

import { logger } from '@/utils/logger';
import {
  ActionResult,
  CycleDetectionResult,
  PageType,
  PageVisit,
  TestState,
} from './types/intelligent-testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// STATE TRACKER
// ═══════════════════════════════════════════════════════════════════════════

export class StateTracker {
  /**
   * Create initial test state
   * @param goal - Testing goal
   * @param startUrl - Starting URL
   * @param maxPages - Maximum pages to analyze
   * @param maxDuration - Maximum duration in milliseconds
   * @returns Initial state
   */
  static createInitialState(
    goal: string,
    startUrl: string,
    maxPages: number = 10,
    maxDuration: number = 5 * 60 * 1000
  ): TestState {
    return {
      goal,
      startUrl,
      currentUrl: startUrl,
      visitedPages: [],
      completedActions: [],
      errors: [],
      startTime: Date.now(),
      pagesAnalyzed: 0,
      maxPages,
      maxDuration,
      estimatedCost: 0,
    };
  }

  /**
   * Record page visit
   * @param state - Current state
   * @param visit - Page visit data
   * @returns Updated state
   */
  static recordPageVisit(state: TestState, visit: PageVisit): TestState {
    logger.debug('[STATE_TRACKER] Recording page visit', {
      url: visit.url,
      pageType: visit.pageType,
    });

    return {
      ...state,
      visitedPages: [...state.visitedPages, visit],
      pagesAnalyzed: state.pagesAnalyzed + 1,
      currentUrl: visit.url,
    };
  }

  /**
   * Record action result
   * @param state - Current state
   * @param result - Action result
   * @returns Updated state
   */
  static recordActionResult(state: TestState, result: ActionResult): TestState {
    logger.debug('[STATE_TRACKER] Recording action result', {
      action: result.action.description,
      success: result.success,
    });

    const updatedState: TestState = {
      ...state,
      completedActions: [...state.completedActions, result],
      currentUrl: result.urlAfter,
    };

    // Record error if action failed
    if (!result.success && result.error) {
      updatedState.errors = [
        ...state.errors,
        {
          message: result.error,
          timestamp: result.timestamp,
        },
      ];
    }

    return updatedState;
  }

  /**
   * Update estimated cost
   * @param state - Current state
   * @param additionalCost - Cost to add
   * @returns Updated state
   */
  static updateCost(state: TestState, additionalCost: number): TestState {
    return {
      ...state,
      estimatedCost: state.estimatedCost + additionalCost,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // URL NORMALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Normalize URL for comparison (remove query params, normalize www, protocol)
   * ✅ FIX: URLs with different query params should be considered the same
   * ///improvement: Added URL normalization to prevent false cycle detection and improve start URL validation
   */
  private static normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Remove query params and hash
      urlObj.search = '';
      urlObj.hash = '';
      // Normalize www (remove www for comparison)
      let hostname = urlObj.hostname;
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      urlObj.hostname = hostname;
      // Normalize protocol (always use https for comparison)
      urlObj.protocol = 'https:';
      return urlObj.toString().replace(/\/$/, ''); // Remove trailing slash
    } catch {
      // If URL parsing fails, just remove query params manually
      return url.split('?')[0].split('#')[0].replace(/\/$/, '');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CYCLE DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect if we're stuck in a cycle
   * @param state - Current state
   * @param currentUrl - Current URL
   * @param maxVisits - Maximum visits to same URL
   * @returns Cycle detection result
   */
  static detectCycle(
    state: TestState,
    currentUrl: string,
    maxVisits: number = 3
  ): CycleDetectionResult {
    // ✅ FIX: Normalize URLs for comparison
    const normalizedCurrent = this.normalizeUrl(currentUrl);

    // Count how many times we've "meaningfully" visited this URL (normalized).
    //
    // We count a visit if:
    // - it has at least one successful action, OR
    // - it's the first time we ever saw this URL (even if actions failed),
    //   to avoid undercounting cycles on pages where we keep failing to act.
    let visitCount = 0;
    const seenUrls = new Set<string>();

    for (const page of state.visitedPages) {
      const normalizedPageUrl = this.normalizeUrl(page.url);
      const isSameUrl = normalizedPageUrl === normalizedCurrent;
      const firstTimeForThisUrl = !seenUrls.has(normalizedPageUrl);

      seenUrls.add(normalizedPageUrl);

      if (!isSameUrl) continue;

      const hasSuccessfulActions = page.actionResults?.some((r) => r.success) || false;
      if (hasSuccessfulActions || firstTimeForThisUrl) {
        visitCount += 1;
      }
    }

    if (visitCount >= maxVisits) {
      logger.warn('[STATE_TRACKER] Cycle detected', {
        url: currentUrl,
        visitCount,
        maxVisits,
      });

      return {
        cycleDetected: true,
        repeatedUrl: currentUrl,
        visitCount,
        suggestion: `Already visited ${currentUrl} ${visitCount} times. Consider moving to a different page or stopping.`,
      };
    }

    // Check for navigation loops (A → B → A → B)
    const recentPages = state.visitedPages.slice(-6); // Last 6 pages
    if (recentPages.length >= 4) {
      const pattern = this.detectNavigationPattern(recentPages);
      if (pattern) {
        logger.warn('[STATE_TRACKER] Navigation loop detected', {
          pattern,
        });

        return {
          cycleDetected: true,
          suggestion: `Detected navigation loop: ${pattern}. Try a different approach.`,
        };
      }
    }

    return {
      cycleDetected: false,
      suggestion: 'No cycles detected, safe to continue',
    };
  }

  /**
   * Detect repeating navigation patterns (A → B → A → B)
   */
  private static detectNavigationPattern(
    recentPages: PageVisit[]
  ): string | null {
    if (recentPages.length < 4) {
      return null;
    }

    // Check for A → B → A → B pattern
    // ✅ FIX: Normalize URLs to avoid false negatives due to query/hash/protocol differences
    const urls = recentPages.map((p) => this.normalizeUrl(p.url));

    for (let i = 0; i < urls.length - 3; i++) {
      if (
        urls[i] === urls[i + 2] &&
        urls[i + 1] === urls[i + 3] &&
        urls[i] !== urls[i + 1]
      ) {
        return `${urls[i]} ↔ ${urls[i + 1]}`;
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get recent page history
   * @param state - Current state
   * @param limit - Number of recent pages
   * @returns Recent page visits
   */
  static getRecentPages(state: TestState, limit: number = 5): PageVisit[] {
    return state.visitedPages.slice(-limit);
  }

  /**
   * Get recent actions
   * @param state - Current state
   * @param limit - Number of recent actions
   * @returns Recent action results
   */
  static getRecentActions(state: TestState, limit: number = 10): ActionResult[] {
    return state.completedActions.slice(-limit);
  }

  /**
   * Get success rate
   * @param state - Current state
   * @returns Success rate (0-1)
   */
  static getSuccessRate(state: TestState): number {
    if (state.completedActions.length === 0) {
      return 1.0;
    }

    const successCount = state.completedActions.filter(a => a.success).length;
    return successCount / state.completedActions.length;
  }

  /**
   * Get elapsed time in milliseconds
   * @param state - Current state
   * @returns Elapsed time
   */
  static getElapsedTime(state: TestState): number {
    return Date.now() - state.startTime;
  }

  /**
   * Check if page type has been visited
   * @param state - Current state
   * @param pageType - Page type to check
   * @returns True if visited
   */
  static hasVisitedPageType(state: TestState, pageType: PageType): boolean {
    return state.visitedPages.some(page => page.pageType === pageType);
  }

  /**
   * Get visited page types
   * @param state - Current state
   * @returns Array of visited page types
   */
  static getVisitedPageTypes(state: TestState): PageType[] {
    const types = new Set(state.visitedPages.map(page => page.pageType));
    return Array.from(types);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATISTICS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get test statistics
   * @param state - Current state
   * @returns Test statistics
   */
  static getStatistics(state: TestState): {
    duration: number;
    pagesVisited: number;
    actionsTaken: number;
    successRate: number;
    errorCount: number;
    estimatedCost: number;
    pageTypes: PageType[];
  } {
    return {
      duration: this.getElapsedTime(state),
      pagesVisited: state.pagesAnalyzed,
      actionsTaken: state.completedActions.length,
      successRate: this.getSuccessRate(state),
      errorCount: state.errors.length,
      estimatedCost: state.estimatedCost,
      pageTypes: this.getVisitedPageTypes(state),
    };
  }

  /**
   * Format statistics for logging
   * @param state - Current state
   * @returns Formatted string
   */
  static formatStatistics(state: TestState): string {
    const stats = this.getStatistics(state);
    const duration = Math.round(stats.duration / 1000);

    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 TEST STATISTICS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Duration: ${duration}s
Pages Visited: ${stats.pagesVisited}
Actions Taken: ${stats.actionsTaken}
Success Rate: ${Math.round(stats.successRate * 100)}%
Errors: ${stats.errorCount}
Cost: $${stats.estimatedCost.toFixed(3)}
Page Types: ${stats.pageTypes.join(', ')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();
  }
}
