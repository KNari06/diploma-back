import type { SubAgentConfig } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-AGENT PIPELINE CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Feature flag: CHAT_SUB_AGENTS_ENABLED=false in .env to disable pipeline
 * and fall back to the monolithic agentic loop.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Parse a numeric env var with a default.
 * Unlike `Number(x) || default`, this correctly handles `0` as a valid value.
 * Returns the default only when the env var is undefined, empty, or not a valid number.
 */
function envNum(envVar: string | undefined, defaultValue: number): number {
  if (envVar === undefined || envVar === '') return defaultValue;
  const parsed = Number(envVar);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

export const SUB_AGENT_CONFIG: SubAgentConfig = {
  /** Enable/disable sub-agent pipeline. Set CHAT_SUB_AGENTS_ENABLED=false to disable. */
  enabled: process.env.CHAT_SUB_AGENTS_ENABLED !== 'false',

  /** Router confidence below this → fallback to monolithic */
  routerConfidenceThreshold: 0.6,

  /** Below this → fallback to monolithic. Between this and routerConfidenceThreshold → ask clarification. */
  routerClarificationThreshold: envNum(process.env.CHAT_ROUTER_CLARIFICATION_THRESHOLD, 0.3),

  /** Maximum tool-calling rounds for executor agent */
  maxToolRounds: 3,

  /** Circuit breaker: sliding window size */
  circuitBreakerWindowSize: 10,

  /** Circuit breaker: failure rate threshold to open (0-1) */
  circuitBreakerFailThreshold: 0.5,

  /** Circuit breaker: try every N-th request when open */
  circuitBreakerRetryInterval: 5,

  /** Timeout for individual agent LLM calls (ms) */
  agentTimeoutMs: 15000,

  // ── Cooperative Multi-Agent Features ──────────────────────────────────

  /** Maximum concurrent sub-executors for parallel plan steps */
  maxSubExecutors: envNum(process.env.CHAT_MAX_SUB_EXECUTORS, 3),

  /** Hard cap on concurrency regardless of maxSubExecutors (safety limit) */
  absoluteMaxConcurrency: envNum(process.env.CHAT_ABSOLUTE_MAX_CONCURRENCY, 5),

  /** Maximum tool rounds per sub-executor (lighter than main executor's maxToolRounds) */
  maxSubExecutorRounds: envNum(process.env.CHAT_MAX_SUB_EXECUTOR_ROUNDS, 2),

  /** Maximum reviewer retry attempts */
  maxReviewRetries: envNum(process.env.CHAT_MAX_REVIEW_RETRIES, 1),

  /** Reviewer agent timeout (ms) */
  reviewerTimeoutMs: envNum(process.env.CHAT_REVIEWER_TIMEOUT_MS, 10000),

  /** Responder agent timeout (ms) — longer than router/reviewer because it generates full-length responses (1500 tokens) */
  responderTimeoutMs: envNum(process.env.CHAT_RESPONDER_TIMEOUT_MS, 25000),

  /** Enable reviewer agent. Set CHAT_REVIEWER_ENABLED=false to disable. */
  enableReviewer: process.env.CHAT_REVIEWER_ENABLED !== 'false',

  /** Enable parallel sub-executor spawning. Opt-in: CHAT_PARALLEL_EXECUTION_ENABLED=true */
  enableParallelExecution: process.env.CHAT_PARALLEL_EXECUTION_ENABLED === 'true',

  /** Minimum plan steps to trigger parallel execution */
  minStepsForParallel: envNum(process.env.CHAT_MIN_STEPS_FOR_PARALLEL, 3),

  /** Maximum insights stored on blackboard (bounded to prevent memory growth) */
  maxBlackboardInsights: envNum(process.env.CHAT_MAX_BLACKBOARD_INSIGHTS, 10),

  /** Max characters for tool result truncation in reviewer summary */
  reviewerResultTruncateChars: envNum(process.env.CHAT_REVIEWER_RESULT_TRUNCATE, 1500),

  /** Max characters for tool result truncation in responder summary */
  responderResultTruncateChars: envNum(process.env.CHAT_RESPONDER_RESULT_TRUNCATE, 2000),

  // ── LLM Parameters (per-agent temperature & max_tokens) ─────────────

  executorTemperature: envNum(process.env.CHAT_EXECUTOR_TEMPERATURE, 0.3),
  executorMaxTokens: envNum(process.env.CHAT_EXECUTOR_MAX_TOKENS, 1500),
  subExecutorTemperature: envNum(process.env.CHAT_SUB_EXECUTOR_TEMPERATURE, 0.3),
  subExecutorMaxTokens: envNum(process.env.CHAT_SUB_EXECUTOR_MAX_TOKENS, 1000),
  reviewerTemperature: envNum(process.env.CHAT_REVIEWER_TEMPERATURE, 0.1),
  reviewerMaxTokens: envNum(process.env.CHAT_REVIEWER_MAX_TOKENS, 400),
  responderTemperature: envNum(process.env.CHAT_RESPONDER_TEMPERATURE, 0.5),
  responderMaxTokens: envNum(process.env.CHAT_RESPONDER_MAX_TOKENS, 1500),
  routerTemperature: envNum(process.env.CHAT_ROUTER_TEMPERATURE, 0.1),
  routerMaxTokens: envNum(process.env.CHAT_ROUTER_MAX_TOKENS, 300),
  plannerTemperature: envNum(process.env.CHAT_PLANNER_TEMPERATURE, 0.2),
  plannerMaxTokens: envNum(process.env.CHAT_PLANNER_MAX_TOKENS, 800),

  // ── Reviewer Thresholds ─────────────────────────────────────────────

  reviewerFastApproveAlignment: envNum(process.env.CHAT_REVIEWER_FAST_APPROVE_ALIGNMENT, 0.9),
  reviewerFullPlanApproveAlignment: envNum(process.env.CHAT_REVIEWER_FULL_PLAN_APPROVE_ALIGNMENT, 0.95),
  reviewerFallbackAlignment: envNum(process.env.CHAT_REVIEWER_FALLBACK_ALIGNMENT, 0.7),

  // ── Context Window Limits ───────────────────────────────────────────

  routerRecentMessagesLimit: envNum(process.env.CHAT_ROUTER_RECENT_MESSAGES_LIMIT, 6),
  responderHistoryLimit: envNum(process.env.CHAT_RESPONDER_HISTORY_LIMIT, 5),
};
