import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { ChatPersistence } from '@/services/utils/chat-persistence';
import { GLOBAL_STORE, type ChatStore } from '@/services/utils/chat-store';
import { checkRequestAborted } from './request-cancellation';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatMessagePayload } from '@/websocket/types/types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: CLARIFICATION REQUEST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When AI is uncertain about user's intent (confidence < 0.7),
 * ask user for clarification instead of guessing
 */
export async function handleClarificationRequest(
  req: Request,
  res: Response,
  params: {
    parsedIntent: any;
    userId: string;
    chatSessionId?: string;
    abortSignal?: AbortSignal;
    mode?: 'lite' | 'pro' | 'editor';
    /**
     * Persistence backend. needs_clarification IS allowed in test-case
     * scope (intent-parsing.ts whitelists it), so this handler MUST
     * route saves through ChatPersistence — direct ChatService writes
     * would crash on FK violation when chatSessionId belongs to
     * test_case_chat_sessions instead of chat_sessions.
     */
    chatStore?: ChatStore;
    /** Test-case scope marker (UUID). Used for WS dual-emit. */
    testCaseId?: string;
  }
): Promise<void> {
  const { parsedIntent, userId, chatSessionId, abortSignal, mode, testCaseId } = params;
  const store: ChatStore = params.chatStore ?? GLOBAL_STORE;

  if (abortSignal) checkRequestAborted(abortSignal);

  logger.info('[CLARIFICATION] Requesting clarification from user', {
    confidence: parsedIntent.confidence,
    possibleIntents: parsedIntent.possibleIntents,
    reason: parsedIntent.clarificationReason,
  });

  // Build clarification message
  const clarificationMessage = buildClarificationMessage(parsedIntent);

  // Save messages to chat history (with metadata for detection)
  const aiMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  if (chatSessionId) {
    // Through ChatPersistence so test-case sessions land in
    // test_case_chat_messages (FK constraint would otherwise reject
    // the row entirely — chatSessionId here would be a UUID from
    // test_case_chat_sessions, not chat_sessions).
    await ChatPersistence.saveMessages(store, chatSessionId, [
      { role: 'user', content: parsedIntent.rawText || 'No message', metadata: { mode: mode || 'lite' } },
      {
        role: 'ai',
        content: clarificationMessage,
        metadata: {
          mode: mode || 'lite',
          requiresAnswers: true, // Key flag for intent parser detection
          needsMoreInfo: true,
          clarificationReason: parsedIntent.clarificationReason,
          possibleIntents: parsedIntent.possibleIntents,
        },
      },
    ]);
  }

  if (abortSignal) checkRequestAborted(abortSignal);

  // Send clarification question to user via HTTP
  res.json({
    response: clarificationMessage,
    intent: 'needs_clarification',
    confidence: parsedIntent.confidence,
    possibleIntents: parsedIntent.possibleIntents,
    metadata: {
      clarificationReason: parsedIntent.clarificationReason,
      originalIntent: parsedIntent.metadata?.originalIntent,
    },
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });

  // Send clarification message via WebSocket so frontend can update UI immediately
  if (chatSessionId && aiMessageId) {
    try {
      const chatMessagePayload: ChatMessagePayload = {
        sessionId: chatSessionId,
        messageId: aiMessageId,
        role: 'assistant',
        content: clarificationMessage,
        timestamp: new Date().toISOString(),
      };
      // Dual-emit: also reaches `chat:tc:<testCaseId>` room when in
      // test-case scope, so the frontend (which subscribed before the
      // session was created) sees the clarification question.
      webSocketService.emitChatMessage(chatSessionId, chatMessagePayload, testCaseId);
      logger.debug('[CLARIFICATION] Sent clarification message via WebSocket', {
        chatSessionId,
        messageId: aiMessageId,
      });
    } catch (error) {
      // Don't fail the request if WebSocket fails - HTTP response already sent
      logger.warn('[CLARIFICATION] Failed to send clarification via WebSocket (non-critical)', {
        chatSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('[CLARIFICATION] Sent clarification request to user', {
    chatSessionId,
    userId,
  });
}

/**
 * Build user-friendly clarification message
 * Uses GPT-generated clarificationQuestion (no hardcoded suggestions)
 */
export function buildClarificationMessage(parsedIntent: any): string {
  // GPT should generate complete clarificationQuestion with suggestions
  // If GPT didn't provide it, use fallback
  const question = parsedIntent.clarificationQuestion ||
    "I'm not entirely sure what you'd like me to do. Could you provide more details?";

  // Just return GPT's question - it should already include suggestions
  // No need to add hardcoded suggestions here
  return question.trim();
}
