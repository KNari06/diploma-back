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

export const PENDING_EXPLORATION_PREFIX = 'pending_exploration:';

/**
 * TTL for the pending-exploration confirmation window. Single source so the
 * creator (ai_test handler) and the clarify-re-arm here can't drift.
 */
export const PENDING_EXPLORATION_TTL_SEC = 600; // 10 min

interface PendingExplorationData {
  entryUrl: string;
  projectId: string;
  userId: string;
  chatSessionId?: string;
  workspaceId?: string;
  scopeHint?: string;
  credentials?: { email?: string; username?: string; phone?: string; password: string };
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

    const explorationId = generateExplorationId(userId);

    logger.info('[EXPLORATION_CONFIRM] User confirmed exploration', {
      explorationId,
      url: pending.entryUrl,
      userId,
    });

    try {
      await QueueManager.addExplorationJob({
        explorationId,
        entryUrl: pending.entryUrl,
        projectId: pending.projectId,
        userId: pending.userId,
        chatSessionId: pending.chatSessionId,
        workspaceId: pending.workspaceId,
        scopeHint: pending.scopeHint,
        credentials: pending.credentials,
        maxConcurrency: 5,
      });

      const budgetMinutes = Math.round((DEFAULT_EXPLORATION_BUDGET.totalTimeoutMs) / 60000);
      const replyMessage = `Exploration started for **${pending.entryUrl}**.\n\n⏱ Budget: up to **${budgetMinutes} minutes** and **${DEFAULT_EXPLORATION_BUDGET.maxFlows} test flows**. I'll notify you when test cases are discovered.`;

      if (chatSessionId) {
        ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
            content: replyMessage,
            metadata: { explorationId, mode: 'exploration', url: pending.entryUrl },
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

  // Re-arm the pending state (preserve it + refresh TTL) so the clarification
  // reply is still treated as a confirmation answer.
  try {
    await redisConnection.set(pendingKey, pendingRaw, 'EX', PENDING_EXPLORATION_TTL_SEC);
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
