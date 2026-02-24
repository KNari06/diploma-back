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
};
