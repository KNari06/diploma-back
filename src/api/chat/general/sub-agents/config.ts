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

export const SUB_AGENT_CONFIG: SubAgentConfig = {
  /** Enable/disable sub-agent pipeline. Set CHAT_SUB_AGENTS_ENABLED=false to disable. */
  enabled: process.env.CHAT_SUB_AGENTS_ENABLED !== 'false',

  /** Router confidence below this → fallback to monolithic */
  routerConfidenceThreshold: 0.6,

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
  maxSubExecutors: Number(process.env.CHAT_MAX_SUB_EXECUTORS) || 3,

  /** Hard cap on concurrency regardless of maxSubExecutors (safety limit) */
  absoluteMaxConcurrency: Number(process.env.CHAT_ABSOLUTE_MAX_CONCURRENCY) || 5,

  /** Maximum tool rounds per sub-executor (lighter than main executor's maxToolRounds) */
  maxSubExecutorRounds: Number(process.env.CHAT_MAX_SUB_EXECUTOR_ROUNDS) || 2,

  /** Maximum reviewer retry attempts */
  maxReviewRetries: Number(process.env.CHAT_MAX_REVIEW_RETRIES) || 1,

  /** Reviewer agent timeout (ms) */
  reviewerTimeoutMs: Number(process.env.CHAT_REVIEWER_TIMEOUT_MS) || 10000,

  /** Enable reviewer agent. Set CHAT_REVIEWER_ENABLED=false to disable. */
  enableReviewer: process.env.CHAT_REVIEWER_ENABLED !== 'false',

  /** Enable parallel sub-executor spawning. Opt-in: CHAT_PARALLEL_EXECUTION_ENABLED=true */
  enableParallelExecution: process.env.CHAT_PARALLEL_EXECUTION_ENABLED === 'true',

  /** Minimum plan steps to trigger parallel execution */
  minStepsForParallel: Number(process.env.CHAT_MIN_STEPS_FOR_PARALLEL) || 3,

  /** Maximum insights stored on blackboard (bounded to prevent memory growth) */
  maxBlackboardInsights: Number(process.env.CHAT_MAX_BLACKBOARD_INSIGHTS) || 10,

  /** Max characters for tool result truncation in reviewer summary */
  reviewerResultTruncateChars: Number(process.env.CHAT_REVIEWER_RESULT_TRUNCATE) || 1500,

  /** Max characters for tool result truncation in responder summary */
  responderResultTruncateChars: Number(process.env.CHAT_RESPONDER_RESULT_TRUNCATE) || 2000,

  // ── LLM Parameters (per-agent temperature & max_tokens) ─────────────

  executorTemperature: Number(process.env.CHAT_EXECUTOR_TEMPERATURE) || 0.3,
  executorMaxTokens: Number(process.env.CHAT_EXECUTOR_MAX_TOKENS) || 1500,
  subExecutorTemperature: Number(process.env.CHAT_SUB_EXECUTOR_TEMPERATURE) || 0.3,
  subExecutorMaxTokens: Number(process.env.CHAT_SUB_EXECUTOR_MAX_TOKENS) || 1000,
  reviewerTemperature: Number(process.env.CHAT_REVIEWER_TEMPERATURE) || 0.1,
  reviewerMaxTokens: Number(process.env.CHAT_REVIEWER_MAX_TOKENS) || 400,
  responderTemperature: Number(process.env.CHAT_RESPONDER_TEMPERATURE) || 0.5,
  responderMaxTokens: Number(process.env.CHAT_RESPONDER_MAX_TOKENS) || 1500,
  routerTemperature: Number(process.env.CHAT_ROUTER_TEMPERATURE) || 0.1,
  routerMaxTokens: Number(process.env.CHAT_ROUTER_MAX_TOKENS) || 300,
  plannerTemperature: Number(process.env.CHAT_PLANNER_TEMPERATURE) || 0.2,
  plannerMaxTokens: Number(process.env.CHAT_PLANNER_MAX_TOKENS) || 800,

  // ── Reviewer Thresholds ─────────────────────────────────────────────

  reviewerFastApproveAlignment: Number(process.env.CHAT_REVIEWER_FAST_APPROVE_ALIGNMENT) || 0.9,
  reviewerFullPlanApproveAlignment: Number(process.env.CHAT_REVIEWER_FULL_PLAN_APPROVE_ALIGNMENT) || 0.95,
  reviewerFallbackAlignment: Number(process.env.CHAT_REVIEWER_FALLBACK_ALIGNMENT) || 0.7,

  // ── Context Window Limits ───────────────────────────────────────────

  routerRecentMessagesLimit: Number(process.env.CHAT_ROUTER_RECENT_MESSAGES_LIMIT) || 6,
  responderHistoryLimit: Number(process.env.CHAT_RESPONDER_HISTORY_LIMIT) || 5,
};
