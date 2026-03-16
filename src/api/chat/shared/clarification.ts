import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { ChatService } from '@/services/utils/chat.service';
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
  }
): Promise<void> {
  const { parsedIntent, userId, chatSessionId, abortSignal, mode } = params;

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
    await ChatService.saveChatMessages(chatSessionId, [
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
      webSocketService.emitChatMessage(chatSessionId, chatMessagePayload);
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
