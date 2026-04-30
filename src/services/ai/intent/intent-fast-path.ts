/**
 * Intent fast-path — deterministic classifier for trivial messages.
 *
 * Runs BEFORE the LLM classifier. Catches a narrow whitelist of messages
 * where the intent is 100% unambiguous and an LLM call would just burn
 * tokens + ~800ms of latency:
 *
 *   - Bare greetings / thanks / farewells → `general_chat` (needsTools=false)
 *   - Bare cancel / stop → `general_chat`
 *   - Bare yes/no ONLY when chat history has a pending plan or AI question
 *     (otherwise fall through to the LLM — it needs history context to decide)
 *
 * Safety invariants:
 *   1. Exact match only (after trim + lowercase). No prefix, no substring.
 *      "yes, also test /users" → LLM path (new api_test request).
 *   2. Whitelist covers en + ru common forms. Anything else → LLM path.
 *   3. Confidence is set below 0.9 so downstream code still treats it as
 *      "probable" rather than "certain" — survives the occasional edge case.
 *   4. Disabled entirely when `INTENT_FAST_PATH_DISABLED=true` in env.
 */

import type { IntentResult } from '@/types';
import type { IntentParserContext } from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

// ─────────────────────────────────────────────────────────────────────────
// Whitelists — keep narrow. Adding entries is cheap; widening match logic
// (prefix / contains) is NOT — it's how fast-paths silently break correctness.
// ─────────────────────────────────────────────────────────────────────────

/** Messages that are ALWAYS pure conversation. No data access, no tools. */
const PURE_CHITCHAT = new Set<string>([
  // en
  'hi', 'hello', 'hey', 'yo', 'sup',
  'thanks', 'thank you', 'thx', 'ty',
  'bye', 'goodbye', 'see you', 'cya',
  // ru
  'привет', 'здравствуй', 'здравствуйте', 'хай',
  'спасибо', 'спс', 'благодарю',
  'пока', 'до свидания', 'увидимся',
]);

/** Cancel / stop. Always general_chat (user is controlling the conversation). */
const CANCEL_WORDS = new Set<string>([
  'cancel', 'stop', 'abort', 'nevermind', 'never mind', 'forget it',
  'отмена', 'стоп', 'отменить', 'забей', 'не надо',
]);

/** Approval words — only fast-pathable when history shows a pending plan. */
const APPROVAL_WORDS = new Set<string>([
  'yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'sure', 'go', 'go ahead', 'do it',
  'да', 'ага', 'давай', 'хорошо', 'ок', 'окей', 'поехали', 'запускай',
]);

/** Negation — only fast-pathable when history shows a pending confirmation. */
const REJECTION_WORDS = new Set<string>([
  'no', 'nope', 'nah',
  'нет', 'неа', 'не',
]);

// ─────────────────────────────────────────────────────────────────────────
// Fast-path entry
// ─────────────────────────────────────────────────────────────────────────

export interface FastPathHit {
  result: IntentResult;
  reason: string;
}

export function tryIntentFastPath(
  message: string,
  context?: IntentParserContext,
): FastPathHit | null {
  if (env.INTENT_FAST_PATH_DISABLED === true) return null;

  const normalized = message.trim().toLowerCase();
  if (!normalized || normalized.length > 40) return null; // guard against long msgs

  // 1. Pure chitchat — safest branch. No context needed, no data access.
  if (PURE_CHITCHAT.has(normalized)) {
    return {
      result: {
        intent: 'general_chat',
        intent_confidence: 0.88,
        needsTools: false,
        rawText: message,
      },
      reason: 'chitchat',
    };
  }

  // 2. Cancel/stop — always general_chat. User is steering the conversation.
  if (CANCEL_WORDS.has(normalized)) {
    return {
      result: {
        intent: 'general_chat',
        intent_confidence: 0.85,
        needsTools: false,
        rawText: message,
      },
      reason: 'cancel',
    };
  }

  // 3. yes/no — ONLY safe when there's a pending plan / question in history.
  // Without that context, "yes" is truly ambiguous and the LLM should see the
  // whole conversation to decide. We deliberately DO NOT fast-path plain "yes"
  // to avoid misrouting new requests that happen to start with the word.
  if (APPROVAL_WORDS.has(normalized) || REJECTION_WORDS.has(normalized)) {
    if (!hasPendingConfirmation(context)) return null;
    return {
      result: {
        intent: 'general_chat',
        intent_confidence: 0.80,
        needsTools: true, // the downstream handler may trigger saved-plan actions
        rawText: message,
      },
      reason: APPROVAL_WORDS.has(normalized) ? 'approval' : 'rejection',
    };
  }

  return null;
}

/**
 * Heuristic: does the recent chat history look like it's waiting for a
 * yes/no answer from the user? We look at the last assistant message and
 * check for a question mark or a known "do you want me to..." phrase.
 *
 * Conservative on purpose: a miss = LLM path (correct but slower), a false
 * positive = mis-classify a genuine new request as an approval (wrong and
 * hard to debug). We err toward "miss".
 */
function hasPendingConfirmation(context?: IntentParserContext): boolean {
  const history = context?.chatHistory;
  if (!history || history.length === 0) return false;

  // Find the most recent assistant turn.
  const lastAssistant = [...history].reverse().find(
    (m) => m.role === 'ai' || m.role === 'assistant',
  );
  if (!lastAssistant) return false;

  const content = (lastAssistant.content || '').toLowerCase();
  if (content.length === 0) return false;

  // A direct question.
  if (content.trimEnd().endsWith('?')) return true;

  // Common "shall I run this" phrasings (en + ru).
  const confirmationMarkers = [
    'shall i', 'should i', 'do you want me', 'ready to run', 'run it?',
    'запустить', 'выполнить', 'подтверди', 'продолжить', 'начать',
  ];
  return confirmationMarkers.some((m) => content.includes(m));
}

/**
 * Thin telemetry hook — called when a fast-path hit happens. Kept separate
 * so callers can wire logging without pulling the logger into the pure
 * classifier above.
 */
export function logFastPathHit(hit: FastPathHit, message: string): void {
  logger.info('[INTENT_FAST_PATH] hit', {
    reason: hit.reason,
    intent: hit.result.intent,
    messagePreview: message.slice(0, 60),
  });
}
