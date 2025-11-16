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
 */
export function shouldRequestContinuation(
  pagesVisited: number,
  executionTimeMs: number,
  currentRun: number
): { shouldPause: boolean; reason?: string } {
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
