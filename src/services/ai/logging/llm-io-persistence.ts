/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LLM I/O persistence — full prompt+completion store (ai_call_logs)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Opt-in, OFF by default. Stores REDACTED prompt/completion text per LLM call,
 * correlated to runId, for hallucination debugging. Distinct from recordAILog
 * (in-memory buffer, aggregates) and ai_usage_log (tokens/cost/decisions).
 *
 * Invariant: any text reaching the persist path MUST go through
 * `redactForPersist` (utils/security/redact-llm-text) first. The DB column is
 * named *_redacted to make a raw write obvious in review. This module is the
 * ONLY writer — funnels call persistLLMCall and never touch the table directly.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { redactForPersist } from '@/utils/security/redact-llm-text';
import { getAIContext } from '../tracking/ai-context';

/** Cap per text column so one giant prompt can't bloat a row (post-redaction). */
const MAX_PERSIST_CHARS = 20_000;

/**
 * Global opt-in switch. OFF unless LLM_IO_PERSIST_ENABLED=true. Callers should
 * short-circuit on false BEFORE doing any redaction/serialisation work so the
 * disabled path costs nothing.
 */
export function isLLMIOPersistEnabled(): boolean {
  return env.LLM_IO_PERSIST_ENABLED === true;
}

export interface PersistLLMCallInput {
  provider: 'openai' | 'gemini';
  model: string;
  status: 'succeeded' | 'failed';
  /** Raw prompt — serialised + redacted here. Pass messages OR a plain string. */
  prompt: string | ChatCompletionMessageParam[] | undefined;
  /** Raw completion text. Redacted here. */
  completion?: string;
  errorMessage?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}

/**
 * Flatten a messages array into a single readable string for storage.
 *
 * Vision parts are replaced by a placeholder instead of being serialised. A
 * multimodal message carries its images as `image_url` data URLs — the
 * Regression Doctor inlines up to two screenshots at ~4 MB of base64 each — and
 * stringifying those only to `clamp()` them away afterwards would run
 * `JSON.stringify` and every redaction regex across ~8 MB per call, per
 * finding. The bytes are also worthless in a text store: nobody reads base64
 * out of a log column.
 */
function serializePart(part: unknown): string {
  if (typeof part === 'string') return part;
  const type = (part as { type?: string } | null)?.type;
  if (type === 'text') return String((part as { text?: unknown }).text ?? '');
  if (type === 'image_url') return '[image]';
  return type ? `[${type}]` : '';
}

function serializePrompt(prompt: PersistLLMCallInput['prompt']): string {
  if (!prompt) return '';
  if (typeof prompt === 'string') return prompt;
  try {
    return prompt
      .map((m) => {
        const role = (m as { role?: string }).role ?? 'unknown';
        const content = (m as { content?: unknown }).content;
        if (typeof content === 'string') return `[${role}] ${content}`;
        if (Array.isArray(content)) {
          return `[${role}] ${content.map(serializePart).filter(Boolean).join(' ')}`;
        }
        return `[${role}] ${JSON.stringify(content ?? '')}`;
      })
      .join('\n');
  } catch {
    return '[unserialisable prompt]';
  }
}

function clamp(s: string): string {
  return s.length > MAX_PERSIST_CHARS ? s.slice(0, MAX_PERSIST_CHARS) + '…[truncated]' : s;
}

/**
 * Persist one LLM call's redacted prompt+completion to ai_call_logs.
 *
 * - No-op unless the opt-in flag is on AND there's a tracking context with a
 *   workspaceId (attribution is required by the table + RLS).
 * - Both texts go through redactForPersist (secrets/PII/URL tokens) then clamp.
 * - Fire-and-forget, never throws: observability must not break the AI path.
 */
export function persistLLMCall(input: PersistLLMCallInput): void {
  if (!isLLMIOPersistEnabled()) return;

  const ctx = getAIContext();
  // Attribution is mandatory (RLS keys on workspace_id). No context → skip
  // rather than write an unattributable, unreadable row.
  if (!ctx?.workspaceId) return;

  // Build + redact OUTSIDE the async insert so a serialisation error can't
  // leave a half-built promise dangling.
  let row: Record<string, unknown>;
  try {
    row = {
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId ?? null,
      run_id: ctx.runId ?? null,
      test_id: ctx.testId ?? null,
      provider: input.provider,
      model: input.model,
      status: input.status,
      operation_type: ctx.operationType ?? null,
      call_index: typeof ctx.logIteration === 'number' ? ctx.logIteration : null,
      prompt_redacted: clamp(redactForPersist(serializePrompt(input.prompt))),
      completion_redacted: input.completion
        ? clamp(redactForPersist(input.completion))
        : null,
      error_message: input.errorMessage ?? null,
      tokens_in: input.tokensIn ?? null,
      tokens_out: input.tokensOut ?? null,
      duration_ms: input.durationMs ?? null,
    };
  } catch (err) {
    logger.warn('[LLM_IO_PERSIST] Failed to build row (skipped)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Fire-and-forget. Swallow errors — never block or fail the caller. Both the
  // resolved `{ error }` shape AND a rejected promise (client throws) are
  // handled so there's no unhandled rejection.
  try {
    void Promise.resolve(supabaseAdmin.from('ai_call_logs').insert(row))
      .then((res: { error?: { message?: string } | null } | undefined) => {
        if (res?.error) {
          logger.warn('[LLM_IO_PERSIST] Insert failed', { error: res.error.message });
        }
      })
      .catch((err: unknown) => {
        logger.warn('[LLM_IO_PERSIST] Insert threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  } catch (err) {
    logger.warn('[LLM_IO_PERSIST] Insert dispatch threw', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
