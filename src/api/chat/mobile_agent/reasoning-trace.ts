/**
 * Reasoning trace — sanitised, truncated text the LLM produces via the
 * `think_aloud` tool. Two consumers:
 *   1. WebSocket (live UI) — needs short, immediate, partial text.
 *   2. chat_messages.metadata (history) — keeps a bounded log of the turn's
 *      reasoning chain so the user can revisit "why did the agent do X?".
 *
 * Storage shape lives here so the blackboard, pipeline, and persistence
 * layer agree on field names without circular imports.
 *
 * Caps (chosen empirically; revisit when telemetry tells us otherwise):
 *   WS_PREVIEW_CHARS    — 300, fits one chat-indicator row.
 *   TRACE_PER_ENTRY     — 1000, bounded JSONB row growth.
 *   TRACE_MAX_ENTRIES   — 30, matches MAX_TOOL_ROUNDS in pipeline.
 *
 * Sanitisation strategy:
 *   The LLM's "thoughts" can echo whatever appears in user messages, which
 *   often includes credentials ("user said password=qwerty..."). We mask
 *   credential-shaped substrings BEFORE either emit or persist. Patterns
 *   are deliberately the same family used for step-value sanitisation
 *   (mobile-step-sanitizer.ts) so behaviour is consistent.
 */

import { env } from '@/config/environment/env';
import { redactCredentials } from '@/utils/security/redact-credentials';

export const WS_PREVIEW_CHARS = 300;
export const TRACE_PER_ENTRY = 1000;
export const TRACE_MAX_ENTRIES = 30;

export interface ReasoningEntry {
  /** Round number this thought belongs to (1-based). */
  round: number;
  /** Sanitised, truncated thought text. */
  text: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * Patterns that mask credential-like *assignments* in free-form prose.
 *
 * History: an earlier version of this regex matched the keyword followed
 * by any non-whitespace 3-80 char token, which produced massive false
 * positives — "password into the field" became "password [REDACTED] the
 * field" because "into" is a 4-char non-whitespace token. We now require:
 *
 *   1. An explicit assignment separator (`=`, `:`, or `is`) between the
 *      keyword and the redacted value. Free-form English ("the password
 *      remains hidden") never carries an `=`/`:`/` is `, so prose is left
 *      alone.
 *   2. The captured value must look like a credential — at least one
 *      digit OR special character, OR a continuous letter/digit token of
 *      ≥6 chars (typical password length). Pure short English words
 *      ("are", "the") are skipped.
 *
 * Patterns:
 *   - `password=qwerty123`     → masked
 *   - `password: 'abc-def!'`   → masked
 *   - `password is qwerty123`  → masked
 *   - `password into the field` → NOT masked (no separator)
 *   - `OTP code from SMS`      → NOT masked (no separator)
 *
 * We err symmetric: a missed credential in persisted reasoning is a
 * compliance issue; a wrongly masked phrase is just noise. The previous
 * regex was too aggressive on noise; this one prefers under-masking when
 * the syntactic signal is missing.
 *
 * Intentionally NOT shared with mobile-step-sanitizer.ts — that one
 * masks a typed `value` field, this one scans free-form prose.
 */
/**
 * Mask credential-like assignments in free-form reasoning text. Returns
 * the sanitised string; leaves non-matching prose untouched.
 *
 * The credential-pattern catalogue now lives in the shared
 * `redact-credentials` util so the AI-action logger and any other free-text
 * sink mask identically. This wrapper keeps the mobile call sites stable and
 * preserves the empty-string-on-nullish contract they rely on.
 */
export function sanitizeReasoning(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return redactCredentials(input);
}

/**
 * Safe-truncate that respects UTF-16 code units (emoji / combining chars).
 * Trims trailing whitespace from the truncation point so the visible
 * preview doesn't end mid-word with stray punctuation.
 */
export function safeTruncate(input: string, max: number): string {
  if (!input) return '';
  if (input.length <= max) return input;
  // Walk back from `max` to a clean break (whitespace) within the last
  // 30 chars — keeps the preview readable. Falls back to a hard cut if
  // no whitespace is found.
  const hardCut = input.slice(0, max);
  const lastSpace = hardCut.lastIndexOf(' ');
  const cut = lastSpace > max - 30 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${cut.replace(/\s+$/, '')}…`;
}

/**
 * Persistence kill-switch. Production deployments concerned about JSONB
 * bloat or extra storage cost can disable trace persistence entirely.
 * Live WS streaming is unaffected — only the metadata write skips.
 */
export function isReasoningPersistEnabled(): boolean {
  return env.MOBILE_AGENT_PERSIST_REASONING !== false;
}
