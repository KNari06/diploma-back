/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION AGENT LLM TUNING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source of truth for the generation params (model / temperature /
 * max_tokens / timeout) of each cognitive exploration agent. Previously these
 * were copy-pasted inline in cartographer.ts / scout.ts / sentinel.ts /
 * strategist.ts, so tuning one agent meant editing it in two places and the
 * four agents drifted apart silently.
 *
 * Model selection still flows from the central AI_MODELS aliases — this map
 * only owns the per-agent decoding knobs, which AI_MODELS intentionally does
 * not cover.
 */

import { AI_MODELS } from '@/config/ai/ai-models.config';

export interface AgentLlmTuning {
  model: string;
  temperature: number;
  maxTokens: number;
  /** Hard wall-clock cap on the agent's AI call (ms). */
  timeoutMs: number;
}

export const EXPLORATION_AGENT_LLM = {
  /** Cartographer — per-page classification + entry-point discovery (vision). */
  cartographer: {
    model: AI_MODELS.vision,
    temperature: 0.1,
    maxTokens: 4000,
    timeoutMs: 25_000,
  },
  /** Strategist — full-state planning over all entry points + insights. */
  strategist: {
    model: AI_MODELS.smart,
    temperature: 0.2,
    maxTokens: 3500,
    timeoutMs: 45_000,
  },
  /** Scout — post-flow branch discovery (fast/cheap). */
  scout: {
    model: AI_MODELS.fast,
    temperature: 0.1,
    maxTokens: 1500,
    timeoutMs: 20_000,
  },
  /** Sentinel — coverage evaluation + gap analysis. */
  sentinel: {
    model: AI_MODELS.smart,
    temperature: 0.1,
    maxTokens: 1500,
    timeoutMs: 20_000,
  },
  /**
   * Product Analyst (Phase 0) — one reasoning pass over the collected evidence to
   * produce the ProductBrief every other agent then reads.
   *
   * Highest maxTokens of any exploration agent: the brief has ~20 fields, several
   * of them arrays, and each carries `source`/`confidence`/`basis`. Truncating the
   * JSON mid-object costs the WHOLE brief (the parser degrades to all-unknown), so
   * paying for headroom is cheaper than a retry. Temperature 0 because this is
   * extraction from evidence, not ideation — a creative answer here is a
   * hallucinated product.
   */
  productAnalyst: {
    model: AI_MODELS.smart,
    temperature: 0,
    maxTokens: 6000,
    timeoutMs: 45_000,
  },
} as const satisfies Record<string, AgentLlmTuning>;
