/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHARED TOOL CONSTANTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Shared constants used by both the main Executor and Sub-Executors.
 * Eliminates duplication of timeout maps, tool name lists, etc.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Memory tool names that route to executeMemoryTool instead of SkillRegistry. */
export const MEMORY_TOOL_NAMES = ['remember_fact', 'search_memory', 'forget_fact'];

/**
 * Per-tool timeout overrides (ms).
 * Tools not listed here use the default timeout from SUB_AGENT_CONFIG.agentTimeoutMs.
 *
 * Grouped by expected latency:
 * - Fast (≤3s): memory operations, simple lookups
 * - Medium (8-15s): DB aggregate queries, list operations
 * - Slow (25-60s): AI analysis, write operations, test execution
 */
export const TOOL_TIMEOUTS: Record<string, number> = {
  // Fast tools (memory, simple reads)
  remember_fact: 3000,
  search_memory: 3000,
  forget_fact: 3000,
  // Medium tools (DB aggregate queries)
  qa_list_test_cases: 8000,
  qa_get_analytics_summary: 10000,
  qa_get_results_overview: 10000,
  qa_get_full_dashboard: 15000,
  qa_get_heatmap: 10000,
  qa_get_time_series: 10000,
  qa_list_test_executions: 10000,
  // Slow tools (AI analysis, write operations)
  qa_get_coverage_report: 25000,
  qa_analyze_failure: 25000,
  qa_get_recommendations: 25000,
  qa_run_test: 60000,
  qa_create_test_case: 15000,
  qa_screenshot: 10000,
  qa_manage_regression_plan: 10000,
  qa_manage_schedule: 10000,
};

/** Default timeout for tools not in TOOL_TIMEOUTS (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 15000;

/**
 * Get the timeout for a specific tool.
 * Falls back to DEFAULT_TOOL_TIMEOUT_MS if not in the override map.
 */
export function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUTS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;
}

/**
 * Wrap a promise with both a per-tool timeout AND abort signal cancellation.
 *
 * Races the original promise against:
 * 1. A timeout (per-tool or default)
 * 2. An abort signal listener (if provided)
 *
 * Whichever fires first wins — the tool promise continues in background
 * but its result is discarded (JS can't truly cancel a running Promise).
 *
 * @param promise  - The tool execution promise
 * @param toolName - Tool name (for timeout lookup + error messages)
 * @param abortSignal - Optional AbortSignal to race against
 */
export function withToolTimeoutAndAbort<T>(
  promise: Promise<T>,
  toolName: string,
  abortSignal?: AbortSignal,
): Promise<T> {
  const timeoutMs = getToolTimeout(toolName);

  const racers: Promise<T>[] = [
    promise,
    // Timeout racer
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ];

  // Abort racer — only if signal exists and isn't already aborted
  if (abortSignal) {
    if (abortSignal.aborted) {
      return Promise.reject(new Error(`Tool '${toolName}' skipped — request already cancelled`));
    }
    racers.push(
      new Promise<never>((_, reject) =>
        abortSignal.addEventListener(
          'abort',
          () => reject(new Error(`Tool '${toolName}' cancelled — request aborted`)),
          { once: true }
        )
      )
    );
  }

  return Promise.race(racers);
}
