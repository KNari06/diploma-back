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

  /** Consecutive "No Effect" iterations before hard early stop.
   *  Prevents the agent from burning iterations when completely stuck. */
  maxConsecutiveNoEffect: 5,

  /** Enable cross-check with iframes */
  enableIframeCrosscheck: true,

  /** Enable cross-check with Shadow DOM */
  enableShadowDOMCrosscheck: true,

  // ═══════════════════════════════════════════════════════════════════════════
  // SHADOW DOM SUPPORT (P1 Feature)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable full Shadow DOM traversal in snapshot collector */
  enableShadowDOMSupport: true,

  /** Maximum recursion depth for nested shadow roots (prevent infinite loops) */
  shadowDOMMaxDepth: 5,

  /** Timeout for shadow DOM traversal (ms) */
  shadowDOMTraversalTimeoutMs: 3000,

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

  // ═══════════════════════════════════════════════════════════════════════════
  // CORE BRAIN MODEL CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════
  /** Model to use for core brain decision making (upgraded from gpt-4o-mini) */
  coreBrainModel: 'gpt-4o' as const,

  /** Maximum tokens for core brain responses */
  coreBrainMaxTokens: 800,

  // ═══════════════════════════════════════════════════════════════════════════
  // NEGATIVE REINFORCEMENT (Action Blacklist)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable negative reinforcement to prevent repeating failed actions */
  enableNegativeReinforcement: true,

  /** Number of failures before an action is blacklisted */
  negativeReinforcementThreshold: 2,

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE DRIFT AUDITOR
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable state drift auditor for confidence scoring, attribution, loop/anomaly detection */
  enableStateDriftAuditor: true,

  // ═══════════════════════════════════════════════════════════════════════════
  // MULTI-AGENT BRAIN (Observer → Strategist → Actor)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable multi-agent brain (Observer → Strategist → Actor → Critic pipeline) */
  enableMultiAgentBrain: true,

  /** Timeout for Observer agent AI call (ms) */
  multiAgentObserverTimeoutMs: 5000,

  /** Timeout for Strategist agent AI call (ms) */
  multiAgentStrategistTimeoutMs: 5000,

  /** Timeout for Actor agent AI call (ms) */
  multiAgentActorTimeoutMs: 3000,

  /** Enable Observer cache for unchanged pages */
  multiAgentObserverCacheEnabled: true,

  // Manus-style Critic Agent
  enableCriticAgent: true,
  multiAgentCriticTimeoutMs: 2000,
  /** Max reasoning history entries for consistency check */
  criticReasoningHistorySize: 10,
  /** Maximum tokens for Critic AI response (must fit override JSON) */
  criticMaxTokens: 350,
  /** Confidence penalty per policy warning (subtracted from AI confidence) */
  criticWarningPenalty: 0.2,
  /** Confidence penalty per reasoning inconsistency */
  criticInconsistencyPenalty: 0.15,
  /** Minimum confidence floor after penalties */
  criticMinConfidence: 0.3,
  /** Max element lines to include in Critic prompt for override accuracy */
  criticElementListMaxLines: 30,

  // ═══════════════════════════════════════════════════════════════════════════
  // COGNITIVE ENHANCEMENTS (Working Memory, Structured Strategy, Adaptive)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable structured working memory across iterations */
  enableWorkingMemory: true,
  /** Enable structured strategy interface (Strategist → Actor without regex) */
  enableStructuredStrategy: true,
  /** Enable adaptive circuit breaker (auto-disable multi-agent on high failure rate) */
  enableCircuitBreaker: true,
  /** Sliding window size for circuit breaker failure rate calculation */
  circuitBreakerWindowSize: 5,
  /** Failure rate threshold to trip circuit breaker (0-1) */
  circuitBreakerFailThreshold: 0.6,
  /** How often (iterations) to retry when circuit breaker is open */
  circuitBreakerRetryInterval: 3,
  /** Skip critic for low-risk deterministic actions (saves ~2s) */
  criticSkipForLowRisk: true,
  /** Enable critic override — apply structured override commands instead of just logging */
  enableCriticOverride: true,
  /** Preserve accumulated context when falling back to monolithic */
  preserveContextOnFallback: true,
  /** Enable pre-validation of alternatives before branching */
  enableValidatedAlternatives: true,
  /** Enable deterministic precondition checks before trying alternative hypotheses */
  enableHypothesisPreconditions: true,
  /** Track critic rejection reasons in working memory for cross-ref pattern avoidance */
  enableCriticRejectionMemory: true,
  /** Maximum number of critic rejections to keep in working memory */
  criticRejectionMemorySize: 5,
  /** Re-run Strategist with critic feedback when all alternatives exhausted (one retry, no loops) */
  enableReStrategizeOnReject: true,
  /** Check vision conflicts (covered/hidden/disabled elements) in Critic Phase 1 (zero AI cost) */
  enableCriticVisualCheck: true,
  /** Maximum elements in formatted snapshot (0 = unlimited). Prevents token explosion on heavy pages */
  snapshotMaxElements: 80,

  // ═══════════════════════════════════════════════════════════════════════════
  // SUPERVISOR LAYER (Manus Tiered Escalation)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable Supervisor layer */
  enableSupervisorLayer: true,
  /** State hash repeats to trigger Tier 1 recovery */
  supervisorStateHashRepeatThreshold: 3,
  /** Wrong-page iterations for hard backtrack */
  supervisorWrongPageThreshold: 2,
  /** Max Tier 1 interventions before escalation to Tier 2 */
  supervisorMaxInterventions: 5,
  /** Recent iterations for forbidden action window */
  supervisorForbiddenActionWindow: 3,
  /** Max element signatures in state hash */
  supervisorStateHashElementCount: 20,
  /** Enable Tier 2 AI diagnosis (gpt-4o-mini) when Tier 1 exhausted */
  enableSupervisorTier2: true,
  /** Timeout for Tier 2 AI call (ms) */
  supervisorTier2TimeoutMs: 3000,

  // ═══════════════════════════════════════════════════════════════════════════
  // PIPELINE V2: COLLABORATIVE AGENT TEAM (Planner → Executor → Reviewer)
  // ═══════════════════════════════════════════════════════════════════════════
  /** Enable Pipeline v2 (replaces multi-agent brain + monolithic fallback) */
  enablePipelineV2: false,
  /** Maximum pipeline rounds (Planner→Executor→Reviewer cycles) */
  pipelineMaxRounds: 10,
  /** Pipeline timeout in ms */
  pipelineTimeoutMs: 5 * 60 * 1000,
  /** Max command-calling rounds per Executor invocation */
  pipelineExecutorMaxRounds: 3,
} as const;

/**
 * Adaptive timeout configuration based on site performance profile
 */
export interface AdaptiveTimeoutConfig {
  networkIdleMs: number;
  typingDelayMs: number;
  scrollAmountPx: number;
  actionTimeoutMs: number;
  siteProfile: 'fast' | 'normal' | 'slow';
}

/**
 * Compute adaptive timeouts based on initial page load time
 */
export function computeAdaptiveTimeouts(loadTimeMs: number): AdaptiveTimeoutConfig {
  // Fast sites: < 1000ms load time
  if (loadTimeMs < 1000) {
    return {
      networkIdleMs: 3000,
      typingDelayMs: 50,
      scrollAmountPx: 800,
      actionTimeoutMs: 5000,
      siteProfile: 'fast',
    };
  }

  // Slow sites: >= 3000ms load time
  if (loadTimeMs >= 3000) {
    return {
      networkIdleMs: 8000,
      typingDelayMs: 150,
      scrollAmountPx: 500,
      actionTimeoutMs: 15000,
      siteProfile: 'slow',
    };
  }

  // Normal sites: 1000-3000ms load time
  return {
    networkIdleMs: 5000,
    typingDelayMs: 100,
    scrollAmountPx: 600,
    actionTimeoutMs: 10000,
    siteProfile: 'normal',
  };
}

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
