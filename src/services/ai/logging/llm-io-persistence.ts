/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LLM I/O persistence — full prompt+completion store (ai_call_logs)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Opt-in, OFF by default. Stores REDACTED prompt/completion text per LLM call,
 * correlated to runId, for hallucination debugging. Distinct from recordAILog
 * (in-memory buffer, aggregates) and ai_usage_log (tokens/cost/decisions).
 *
 * Stage 2 (this file): gating helper only — the table + safeguards exist, the
 * write path is wired in stage 3. Keeping the helper now lets callers guard
 * cheaply and keeps the opt-in contract in one place.
 *
 * Invariant: any text reaching the persist path MUST go through
 * `redactForPersist` (utils/security/redact-llm-text) first. The DB column is
 * named *_redacted to make a raw write obvious in review.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { env } from '@/config/environment/env';

/**
 * Global opt-in switch. OFF unless LLM_IO_PERSIST_ENABLED=true. Callers should
 * short-circuit on false BEFORE doing any redaction/serialisation work so the
 * disabled path costs nothing.
 */
export function isLLMIOPersistEnabled(): boolean {
  return env.LLM_IO_PERSIST_ENABLED === true;
}
