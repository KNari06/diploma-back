/**
 * Intelligent Test Limits Configuration
 *
 * These limits control the behavior of AI-driven intelligent testing
 * to ensure tests complete within reasonable time and cost constraints.
 */

export const INTELLIGENT_TEST_LIMITS = {
  /**
   * Maximum execution time for a single intelligent test run
   * After this time, the test will stop and ask user if they want to continue
   * Default: 5 minutes
   */
  MAX_EXECUTION_TIME_MS: 5 * 60 * 1000, // 5 minutes

  /**
   * Maximum number of pages to test in a single run
   * After reaching this limit, the test will stop and ask user if they want to continue
   * Default: 10 pages
   */
  MAX_PAGES_PER_RUN: 10,

  /**
   * Maximum total pages to test (across all continuation runs)
   * This is a hard limit to prevent infinite exploration
   * Default: 50 pages
   */
  MAX_TOTAL_PAGES: 50,

  /**
   * Maximum number of continuation runs
   * After this many continuations, the test will force stop
   * Default: 5 runs (10 pages each = 50 pages total)
   */
  MAX_CONTINUATION_RUNS: 5,

  /**
   * Timeout for waiting for user response on continuation prompt
   * After this time, the test will be marked as completed (not failed)
   * Default: 30 minutes
   */
  CONTINUATION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
} as const;

/**
 * Lite Engine Feature Flags (Manus L2-L4-L5 Alignment)
 *
 * Controls advanced AI agent behaviors:
 * - L2: Goal structure (expansion, funnel analysis, refinement)
 * - L4: Target audit (ref validation before execution)
 * - L5: Vision escalation (fallback when DOM is weak)
 */
export const LITE_ENGINE_FLAGS = {
  // ═══════════════════════════════════════════════════════════════════════════
  // L2: GOAL STRUCTURE
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable GoalExpander to parse goal into structured keywords */
  enableGoalExpander: true,

  /** Enable FunnelAnalyzer to detect user journey phase */
  enableFunnelAnalyzer: true,

  /** Enable dynamic goal refinement on phase/URL change */
  enableGoalRefinement: true,

  /** Minimum time between goal refinements (ms) */
  goalRefinementCooldownMs: 5000,

  // ═══════════════════════════════════════════════════════════════════════════
  // L4: TARGET AUDIT GUARD
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable L4 target audit for ref validation */
  enableTargetAuditGuard: true,

  /** Timeout for target audit AI call (ms) */
  targetAuditTimeoutMs: 1500,

  /** Number of top candidates to consider for audit */
  topCandidatesCount: 5,

  // ═══════════════════════════════════════════════════════════════════════════
  // L5: VISION ESCALATION
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable vision escalation when DOM is weak */
  enableVisionEscalation: true,

  /** Consecutive "No Effect" count to trigger vision */
  visionEscalationThreshold: 3,

  /** Enable cross-check with iframes */
  enableIframeCrosscheck: true,

  /** Enable cross-check with Shadow DOM */
  enableShadowDOMCrosscheck: true,

  // ═══════════════════════════════════════════════════════════════════════════
  // L6: PAGE CREDENTIALS EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable extraction of demo credentials from page text (e.g., "username is student") */
  enablePageCredentialsExtraction: true,

  /** Enable asking user for credentials when login form detected but no creds available */
  enableCredentialClarification: true,

  /** Timeout for credential clarification request (ms) */
  credentialClarificationTimeoutMs: 60000,

  // ═══════════════════════════════════════════════════════════════════════════
  // L7: ADDITIONAL CLARIFICATION GATES
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable payment/checkout approval gate (ask before proceeding with payment actions) */
  enablePaymentApprovalGate: true,

  /** Timeout for payment approval clarification (ms) */
  paymentApprovalTimeoutMs: 120000, // 2 minutes

  /** Enable file upload clarification gate (stop/skip when file input detected) */
  enableFileUploadGate: true,

  /** Timeout for file upload clarification (ms) */
  fileUploadTimeoutMs: 60000,

  /** Enable external domain navigation approval gate (ask before cross-origin navigation) */
  enableExternalDomainGate: true,

  /** Enable download/export click approval gate (ask before download actions) */
  enableDownloadApprovalGate: true,

  /** Timeout for external/download approval clarification (ms) */
  externalDownloadApprovalTimeoutMs: 60000,
} as const;

/**
 * Get human-readable time from milliseconds
 */
export function formatExecutionTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Check if intelligent test should pause for continuation
 * @param pagesVisited - Number of pages visited in current run
 * @param executionTimeMs - Total execution time in milliseconds
 * @param currentRun - Current run number (1-indexed)
 * @returns Object with shouldPause flag and optional reason
 */
export function shouldRequestContinuation(
  pagesVisited: number,
  executionTimeMs: number,
  currentRun: number
): { shouldPause: boolean; reason?: string } {
  // Validate inputs
  if (pagesVisited < 0) {
    throw new Error('pagesVisited must be non-negative');
  }
  if (executionTimeMs < 0) {
    throw new Error('executionTimeMs must be non-negative');
  }
  if (currentRun < 1) {
    throw new Error('currentRun must be at least 1');
  }

  // Hard limit: Max continuation runs reached
  if (currentRun >= INTELLIGENT_TEST_LIMITS.MAX_CONTINUATION_RUNS) {
    return {
      shouldPause: true,
      reason: `Maximum continuation runs (${INTELLIGENT_TEST_LIMITS.MAX_CONTINUATION_RUNS}) reached`,
    };
  }

  // Limit: Max pages per run
  if (pagesVisited >= INTELLIGENT_TEST_LIMITS.MAX_PAGES_PER_RUN) {
    return {
      shouldPause: true,
      reason: `Page limit (${INTELLIGENT_TEST_LIMITS.MAX_PAGES_PER_RUN} pages) reached`,
    };
  }

  // Limit: Max execution time
  if (executionTimeMs >= INTELLIGENT_TEST_LIMITS.MAX_EXECUTION_TIME_MS) {
    return {
      shouldPause: true,
      reason: `Time limit (${formatExecutionTime(INTELLIGENT_TEST_LIMITS.MAX_EXECUTION_TIME_MS)}) reached`,
    };
  }

  return { shouldPause: false };
}

/**
 * Check if total pages visited exceeds the absolute maximum
 * @param totalPagesVisited - Total pages visited across all runs
 * @returns True if absolute limit is reached
 */
export function hasReachedTotalPageLimit(totalPagesVisited: number): boolean {
  return totalPagesVisited >= INTELLIGENT_TEST_LIMITS.MAX_TOTAL_PAGES;
}

/**
 * Get remaining pages before hitting the limit
 * @param totalPagesVisited - Total pages visited across all runs
 * @returns Number of remaining pages
 */
export function getRemainingPages(totalPagesVisited: number): number {
  return Math.max(0, INTELLIGENT_TEST_LIMITS.MAX_TOTAL_PAGES - totalPagesVisited);
}
