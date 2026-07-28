/**
 * Diagnostics for the scope guard firing on plainly in-scope requests.
 *
 * Live mobile-editor sessions produced the off-topic refusal in answer to
 * unambiguous test-authoring requests ("Add a step to TC-30 that checks…"),
 * and once it happened every later message in that conversation was refused
 * too. Four hypotheses were filed and none confirmed, because no log line
 * carried the ROUTING facts next to the refusal — which is what tells them
 * apart.
 *
 * It earned its keep on the first real occurrence (JanaPost TC-31, 2026-07-28)
 * by refuting the then-leading theory. The captured line read
 * `intent: mobile_agent · routingSource: force_route · mobileEditorMode: true ·
 * hasMobileSessionId: true`, so the message HAD reached the mobile agent on a
 * live session — it was never a fallthrough to web general chat. The guard was
 * firing inside the mobile agent itself, on a message that opened with a pasted
 * runner error. That is what the prompt amendment in
 * `mobile_agent/prompts.ts` now addresses.
 *
 * Kept because the amendment is a prompt change, not a gate: it makes the
 * refusal much less likely, not impossible, and this is the only signal that
 * would show a regression.
 *
 * This module is DIAGNOSTICS ONLY. It gates a log line and a counter, never
 * control flow — which is why matching on reply text here does not contradict
 * Hard invariant #13 ("a gate refusal is identified by
 * `SkillResult.needsConfirmation`, never by matching the message text"). That
 * invariant governs decisions; this only governs what we write to the log.
 */

import type { Response } from 'express';
import { SCOPE_GUARD_BLOCK } from '@/ai/prompts/intent-and-chat-prompts';
import { incCounter } from '@/utils/core/mobile-chat-metrics';
import { logger } from '@/utils/core/logger';

/**
 * The product-name token the guard's own refusal recipe puts in every refusal,
 * derived from the prompt constant rather than re-typed so the predicate cannot
 * drift when the wording changes. Falls back to the literal if the block is
 * ever restructured past recognition.
 *
 * Deriving it also makes the predicate language-agnostic: the guard tells the
 * model to reply "in the user's language", but the product names survive
 * translation, so a Russian or Kazakh refusal still carries this token where a
 * hand-written ru/kk phrase list would have missed it.
 */
const REFUSAL_TOKEN: string =
  SCOPE_GUARD_BLOCK.match(/only help with ([A-Za-z]+\/[A-Za-z]+)/i)?.[1] ?? 'testing/QAIT';

/** Tolerates spacing around the slash; anchored on nothing else. */
const REFUSAL_RE = new RegExp(
  REFUSAL_TOKEN.split('/')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*/\\s*'),
  'i',
);

/**
 * A genuine refusal is one short sentence plus one follow-up question. A long
 * reply that happens to name the product is an ANSWER mentioning it, not a
 * refusal — bounding the length is what keeps this from flagging every helpful
 * "QAIT can also run these as a regression…" paragraph.
 */
const MAX_REFUSAL_CHARS = 400;

export function looksLikeScopeRefusal(reply: unknown): boolean {
  if (typeof reply !== 'string') return false;
  const text = reply.trim();
  if (!text || text.length > MAX_REFUSAL_CHARS) return false;
  return REFUSAL_RE.test(text);
}

/**
 * Pull the user-visible reply out of a chat response body. Handlers are not
 * uniform about the field name, so try the shapes that actually occur before
 * giving up.
 */
export function extractReplyText(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  for (const key of ['message', 'reply', 'response', 'content']) {
    const v = b[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Routing facts captured at request time — what discriminates the hypotheses. */
export interface ScopeRefusalContext {
  chatSessionId?: string;
  userId?: string;
  testCaseId?: string;
  intent?: string;
  routingSource?: string;
  viaMobileBackstop: boolean;
  storeKind?: string;
  mobileEditorMode: boolean;
  hasMobileSessionId: boolean;
  testCasePlatform?: string | null;
  message: string;
}

/**
 * Wrap `res.json` so a refusal-shaped reply is logged with the routing facts
 * that produced it. Chains onto whatever wrapper is already installed, so it
 * composes with the compound-step capture and the `mobileContextMissing` tag.
 *
 * Lives here rather than inline in the controller: `chat.controller.ts` is
 * already far past the size where a new named concern should be extracted, and
 * this one is self-contained.
 *
 * `getContext` is a thunk because `intent` is only known after the classifier
 * or force-route has run, which is after this is installed.
 */
export function installScopeRefusalTelemetry(
  res: Response,
  getContext: () => ScopeRefusalContext,
): void {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    try {
      const replyText = extractReplyText(body);
      if (looksLikeScopeRefusal(replyText)) {
        const ctx = getContext();
        incCounter('chat.scope_refusal', ctx.intent ?? 'unknown');
        logger.warn('[CHAT] Scope-guard refusal returned to user', {
          ...ctx,
          // Truncated: enough to recognise the request shape (does it open with
          // a pasted error? a prohibition?) without copying a whole message —
          // which may carry values a user typed — into the app log.
          message: undefined,
          messagePreview: ctx.message.slice(0, 200),
          replyPreview: replyText?.slice(0, 200),
        });
      }
    } catch {
      // Diagnostics must never break a reply.
    }
    return originalJson(body);
  };
}
