/**
 * Exploration Confirmation Handler
 * Intercepts user responses to exploration confirmation prompts.
 * Uses Redis to store pending exploration state between messages.
 * Uses AI to classify user intent (confirm/decline/other).
 */

import { Request, Response } from 'express';
import { redisConnection, QueueManager } from '@/config/infrastructure/queues';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { DEFAULT_EXPLORATION_BUDGET, generateExplorationId } from '@/agent/core/lite/exploration/types';
import { classifyConfirmation } from './confirmation-classifier';
import { ValidationError } from '@/types';
import { normalizeEntryUrl } from '@/utils/validation/entry-url';
import { preflightEntryUrl } from '@/services/testing/exploration/entry-preflight.service';

export const PENDING_EXPLORATION_PREFIX = 'pending_exploration:';

/**
 * TTL for the pending-exploration confirmation window. Single source so the
 * creator (ai_test handler) and the clarify-re-arm here can't drift.
 */
export const PENDING_EXPLORATION_TTL_SEC = 600; // 10 min

/**
 * Max consecutive "other" (ambiguous) replies before we stop re-asking and let
 * the message flow to normal chat. Without a cap the user could be trapped
 * answering the same yes/no prompt forever (only the 10-min TTL would release
 * it). Mirrors the bounded-retry pattern used across the branch
 * (MAX_PREFLIGHT_REVISES, serverErrorBlockAfter).
 */
export const MAX_EXPLORATION_CLARIFY_REASKS = 2;

interface PendingExplorationData {
  entryUrl: string;
  projectId: string;
  userId: string;
  chatSessionId?: string;
  workspaceId?: string;
  scopeHint?: string;
  credentials?: { email?: string; username?: string; phone?: string; password: string };
  /** Consecutive ambiguous ("other") replies so far — bounds the re-ask loop. */
  otherCount?: number;
}


/**
 * Check if user is responding to a pending exploration confirmation.
 * Returns true if the message was handled (response sent), false otherwise.
 */
export async function handlePendingExplorationConfirmation(
  req: Request,
  res: Response,
  message: string,
  chatSessionId: string,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const pendingKey = `${PENDING_EXPLORATION_PREFIX}${chatSessionId || userId}`;

  let pendingRaw: string | null;
  try {
    pendingRaw = await redisConnection.get(pendingKey);
  } catch {
    return false;
  }

  if (!pendingRaw) return false;

  const intent = await classifyConfirmation(message, 'start an exploration (automated site testing)');

  // User confirmed → start exploration
  if (intent === 'confirm') {
    await redisConnection.del(pendingKey);

    let pending: PendingExplorationData;
    try {
      pending = JSON.parse(pendingRaw);
    } catch {
      return false;
    }

    // Defense in depth: the producer now stores an already-validated URL, but a
    // pending payload written before this change (TTL is PENDING_EXPLORATION_TTL_SEC)
    // can still carry a raw one, and Redis is a mutable store. Re-validate rather
    // than trust the blob — this is the last gate before a paid job is enqueued.
    let safeEntryUrl = '';
    let rejection: string | null = null;
    try {
      safeEntryUrl = normalizeEntryUrl(pending.entryUrl);
    } catch (err) {
      const reason = err instanceof ValidationError ? err.message : 'a valid http(s) url is required';
      rejection = `I can't explore **${pending.entryUrl}** — ${reason}`;
      logger.warn('[EXPLORATION_CONFIRM] Rejected — invalid entry URL', {
        url: pending.entryUrl,
        reason,
      });
    }

    // Re-probe, don't reuse the ask-time verdict: the pending payload lives for
    // PENDING_EXPLORATION_TTL_SEC, so a site that was reachable when we asked can
    // be down by the time the user confirms — and this is the last gate before a
    // paid job is enqueued.
    if (!rejection) {
      const preflight = await preflightEntryUrl(safeEntryUrl);
      if (!preflight.ok) {
        rejection = `I couldn't start exploring **${safeEntryUrl}** — ${preflight.message}`;
        logger.info('[EXPLORATION_CONFIRM] Rejected by entry preflight', {
          url: safeEntryUrl,
          verdict: preflight.verdict,
        });
      }
    }

    if (rejection) {
      const errorReply = rejection;
      if (chatSessionId) {
        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: errorReply },
        ]).catch(() => {});
      }
      res.json({
        success: false,
        reply: errorReply,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return true;
    }

    const explorationId = generateExplorationId(userId);

    logger.info('[EXPLORATION_CONFIRM] User confirmed exploration', {
      explorationId,
      url: safeEntryUrl,
      userId,
    });

    try {
      await QueueManager.addExplorationJob({
        explorationId,
        entryUrl: safeEntryUrl,
        projectId: pending.projectId,
        userId: pending.userId,
        chatSessionId: pending.chatSessionId,
        workspaceId: pending.workspaceId,
        scopeHint: pending.scopeHint,
        credentials: pending.credentials,
        maxConcurrency: 5,
      });

      const budgetMinutes = Math.round((DEFAULT_EXPLORATION_BUDGET.totalTimeoutMs) / 60000);
      const replyMessage = `Exploration started for **${safeEntryUrl}**.\n\n⏱ Budget: up to **${budgetMinutes} minutes** and **${DEFAULT_EXPLORATION_BUDGET.maxFlows} test flows**. I'll notify you when test cases are discovered.`;

      if (chatSessionId) {
        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
            content: replyMessage,
            metadata: { explorationId, mode: 'exploration', url: safeEntryUrl },
          },
        ]).catch(() => {});
      }

      res.json({
        success: true,
        reply: replyMessage,
        mode: 'exploration',
        explorationId,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return true;
    } catch (error) {
      logger.error('[EXPLORATION_CONFIRM] Failed to queue exploration', {
        error: error instanceof Error ? error.message : String(error),
      });

      const errorReply = 'Failed to start exploration. Please try again.';
      if (chatSessionId) {
        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: errorReply },
        ]).catch(() => {});
      }

      res.json({
        success: false,
        reply: errorReply,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return true;
    }
  }

  // User declined → clear pending and acknowledge
  if (intent === 'decline') {
    await redisConnection.del(pendingKey);

    logger.info('[EXPLORATION_CONFIRM] User declined exploration', { userId });

    const replyMessage = 'Exploration cancelled. How can I help you instead?';
    if (chatSessionId) {
      ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        { role: 'ai', content: replyMessage },
      ]).catch(() => {});
    }

    res.json({
      success: true,
      reply: replyMessage,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
    return true;
  }

  // intent === 'other' → genuinely ambiguous. Do NOT silently drop the pending
  // state (that re-triggered the same confirmation prompt and looked like a
  // loop). Instead KEEP the pending and ASK the user to clarify yes/no — the
  // next reply re-enters this handler with the pending still set. We refresh
  // the key's TTL so the clarify window doesn't expire mid-conversation.
  let pending: PendingExplorationData;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    // Corrupt pending → drop it and fall through to normal chat.
    await redisConnection.del(pendingKey);
    return false;
  }

  // Bound the clarify loop: after MAX_EXPLORATION_CLARIFY_REASKS ambiguous
  // replies, the user clearly isn't answering yes/no (they're asking something
  // else). Drop the pending and let the message flow to normal chat instead of
  // trapping them on the same prompt until the TTL expires.
  const otherCount = (pending.otherCount ?? 0) + 1;
  if (otherCount > MAX_EXPLORATION_CLARIFY_REASKS) {
    await redisConnection.del(pendingKey);
    return false;
  }

  // Re-arm the pending state (preserve it + bump the counter + refresh TTL) so
  // the clarification reply is still treated as a confirmation answer.
  try {
    await redisConnection.set(
      pendingKey,
      JSON.stringify({ ...pending, otherCount }),
      'EX',
      PENDING_EXPLORATION_TTL_SEC,
    );
  } catch {
    // If Redis write fails, fall through rather than trap the user.
    return false;
  }

  const replyMessage =
    `Just to confirm — should I start the autonomous exploration of **${pending.entryUrl}**?`;
  if (chatSessionId) {
    ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: replyMessage },
    ]).catch(() => {});
  }
  res.json({
    success: true,
    reply: replyMessage,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
  return true;
}
