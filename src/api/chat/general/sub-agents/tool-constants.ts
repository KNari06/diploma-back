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

// Note: MEMORY_TOOL_NAMES removed — memory tools now registered as MemorySkill in SkillRegistry

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
 * Race a promise against a timeout, returning null on timeout.
 * Used by agent LLM calls (router, reviewer, planner, responder) where timeout = graceful fallback.
 *
 * Unlike withToolTimeoutAndAbort (which rejects), this resolves to null — callers use existing
 * fallback paths for timeout scenarios.
 *
 * IMPORTANT: Cleans up the timer on completion AND swallows errors from the losing promise
 * to prevent dangling timers and unhandled promise rejections.
 *
 * @param promise  - The LLM call promise
 * @param timeoutMs - Timeout in milliseconds
 * @returns The promise result, or null if timeout fired first
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<null>((resolve) => {
    timerId = setTimeout(() => resolve(null), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
    // Swallow errors from the losing promise (LLM call that completes after timeout)
    // Without this, a late network error becomes an unhandled rejection.
    promise.catch(() => {});
  });
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
 * IMPORTANT: Cleans up timers and listeners after the race settles to prevent
 * memory leaks under high concurrency (parallel sub-executors × tool rounds).
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

  // Track cleanup handles
  let timerId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;

  const racers: Promise<T>[] = [
    promise,
    // Timeout racer (with clearable timer)
    new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ];

  // Abort racer — only if signal exists and isn't already aborted
  if (abortSignal) {
    if (abortSignal.aborted) {
      return Promise.reject(new Error(`Tool '${toolName}' skipped — request already cancelled`));
    }
    racers.push(
      new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error(`Tool '${toolName}' cancelled — request aborted`));
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      })
    );
  }

  // Race and clean up regardless of outcome
  return Promise.race(racers).finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  });
}
