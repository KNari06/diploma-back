import { ChatService } from '@/services/utils/chat.service';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { Request, Response } from 'express';
import { checkRequestAborted } from '../shared/request-cancellation';
import { emitProcessingStep } from '../shared/utils';
import { executeApiAgentTestFlow } from './agent-execution';
import { isValidLevel } from '@/services/testing/api/agent';

function parseAgentLevelFromText(message: string): 'light' | 'medium' | 'hard' | undefined {
  if (!message || typeof message !== 'string') return undefined;

  const text = message.toLowerCase();
  // Keep parsing conservative: only explicit level keywords.
  const hard = /\b(hard|хард)\b/i.test(text);
  const medium = /\b(medium|медиум)\b/i.test(text);
  const light = /\b(light|лайт)\b/i.test(text);

  if (hard) return 'hard';
  if (medium) return 'medium';
  if (light) return 'light';
  return undefined;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: API TEST
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function handleApiTest(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    abortSignal?: AbortSignal;
    logger?: FunctionLogger;
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, answers, abortSignal, logger: functionLogger } = params;

  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  try {
    // FIX #8: Validate and merge answers into parsedIntent if provided
    if (answers) {
      // Validate answers structure
      if (typeof answers !== 'object' || Array.isArray(answers)) {
        logger.error('[API_TEST] Invalid answers structure', { answers: typeof answers });
        throw new Error('Invalid answers format - expected object');
      }

      // Safely merge answers with validation
      const validatedAnswers: Record<string, any> = {};

      if (answers.apiMethod && typeof answers.apiMethod === 'string') {
        parsedIntent.apiMethod = answers.apiMethod.toUpperCase();
        validatedAnswers.apiMethod = answers.apiMethod;
      }

      if (answers.apiUrl && typeof answers.apiUrl === 'string') {
        // Accept both absolute URLs and relative paths (no strict URL format validation)
        const trimmed = answers.apiUrl.trim();
        if (trimmed.length > 0) {
          parsedIntent.apiUrl = trimmed;
          parsedIntent.isRelativePath = !trimmed.startsWith('http://') && !trimmed.startsWith('https://');
          validatedAnswers.apiUrl = trimmed;
        }
      }

      if (answers.apiBody) {
        parsedIntent.apiBody = answers.apiBody;
        validatedAnswers.apiBody = typeof answers.apiBody === 'string' ? 'provided' : 'object';
      }

      if (answers.apiHeaders && typeof answers.apiHeaders === 'object') {
        parsedIntent.apiHeaders = answers.apiHeaders;
        validatedAnswers.apiHeaders = Object.keys(answers.apiHeaders).length;
      }

      logger.info('[API_TEST] Merged validated answers into parsedIntent', {
        answersProvided: Object.keys(validatedAnswers),
        method: parsedIntent.apiMethod,
        url: parsedIntent.apiUrl,
      });
    }

    logger.info('[API_TEST] Starting API test flow', {
      method: parsedIntent?.apiMethod,
      url: parsedIntent?.apiUrl,
      hasParsedIntent: !!parsedIntent,
      hasAnswers: !!answers,
      agentLevel: parsedIntent?.agentLevel || parsedIntent?.metadata?.agentLevel,
    });

    const emitProcessingStepWithLogging = functionLogger
      ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
      : emitProcessingStep;
    emitProcessingStepWithLogging(chatSessionId, 'checking_autonomous', '🔍 Analyzing API request...', 30);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: VALIDATE API INFO - ASK FOR MISSING DETAILS
    // ═══════════════════════════════════════════════════════════════════════

    if (parsedIntent?.apiMethod && typeof parsedIntent.apiMethod === 'string') {
      parsedIntent.apiMethod = parsedIntent.apiMethod.toUpperCase();
    }

    const hasMethod = !!parsedIntent?.apiMethod;
    const hasUrl = !!parsedIntent?.apiUrl;

    // If missing method OR URL, ask clarifying questions
    if (!hasMethod || !hasUrl) {
      logger.info('[API_TEST] Missing API details, asking for clarification', {
        hasMethod,
        hasUrl,
        message: message.substring(0, 50),
      });

      const questions = [];

      if (!hasUrl) {
        questions.push({
          id: 'apiUrl',
          question: '🌐 What is the API endpoint URL?',
          type: 'text',
          required: true,
          placeholder: 'https://api.example.com/v1/users',
        });
      }

      if (!hasMethod) {
        questions.push({
          id: 'apiMethod',
          question: '📡 Which HTTP method should I use?',
          type: 'select',
          required: true,
          options: [
            { value: 'GET', label: 'GET - Retrieve data' },
            { value: 'POST', label: 'POST - Create/Submit data' },
            { value: 'PUT', label: 'PUT - Update/Replace data' },
            { value: 'PATCH', label: 'PATCH - Partial update' },
            { value: 'DELETE', label: 'DELETE - Remove data' },
          ],
        });
      }

      const clarificationMessage = `📋 I need a few more details to set up the API test:\n${questions.map(q => `• ${q.question}`).join('\n')}`;

      // Save to history
      if (chatSessionId) {
        const saveChatMessagesWithLogging = functionLogger
          ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
          : ChatService.saveChatMessages.bind(ChatService);
        await saveChatMessagesWithLogging(chatSessionId, [
          { role: 'user', content: message },
          { role: 'ai', content: clarificationMessage },
        ]);
      }

      // Note: This conversationId is just for tracking clarification, not a test plan ID
      // So it can use timestamp, but for consistency we could use UUID too
      res.json({
        reply: clarificationMessage,
        questions,
        conversationId: `api_clarify_${Date.now()}`, // Clarification tracking ID (not a test plan)
        needsMoreInfo: true,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // NEW: ALWAYS RUN API-AGENT FOR CHAT-BASED API TESTING
    // ═══════════════════════════════════════════════════════════════════════

    const candidateLevel =
      (parsedIntent?.agentLevel || parsedIntent?.metadata?.agentLevel) ??
      parseAgentLevelFromText(message) ??
      'light';
    const agentLevel = isValidLevel(candidateLevel) ? candidateLevel : 'light';

    logger.info('[API_TEST] Routing to API agent flow', {
      level: agentLevel,
      url: parsedIntent.apiUrl,
      method: parsedIntent.apiMethod,
      hasExplicitLevel: !!(parsedIntent?.agentLevel || parsedIntent?.metadata?.agentLevel),
    });

    // Resolve actual project_id from chat_session (workspace_id !== projectId)
    let resolvedProjectId: string | undefined;
    if (chatSessionId) {
      try {
        const { data: session } = await supabaseAdmin
          .from('chat_sessions')
          .select('project_id')
          .eq('id', chatSessionId)
          .single();
        if (session?.project_id) {
          resolvedProjectId = session.project_id;
        }
      } catch (err) {
        logger.warn('[API_TEST] Failed to resolve project_id from chat session', {
          error: err instanceof Error ? err.message : String(err),
          chatSessionId,
        });
      }
    }

    await executeApiAgentTestFlow(res, {
      level: agentLevel,
      url: parsedIntent.apiUrl,
      method: parsedIntent.apiMethod || 'GET',
      headers: parsedIntent.apiHeaders,
      body: parsedIntent.apiBody,
      expectedStatus: parsedIntent.expectedStatus,
      expectedBehavior: parsedIntent.expectedBehavior || parsedIntent?.metadata?.expectedBehavior,
      userId,
      chatSessionId,
      projectId: resolvedProjectId,
      workspaceId: workspace_id,
      userMessage: message,
    });
  } catch (error) {
    logger.error('[API_TEST] Error in API test flow', {
      error,
      errorType: error?.constructor?.name,
      errorMessage: error instanceof Error ? error.message : String(error),
      parsedIntent,
    });

    const errorMessage = error instanceof Error && error.message
      ? error.message
      : (error ? String(error) : 'Failed to process API test request');

    // Save error to history
    if (chatSessionId) {
      const saveChatMessagesWithLogging = functionLogger
        ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
        : ChatService.saveChatMessages.bind(ChatService);
      await saveChatMessagesWithLogging(chatSessionId, [
        { role: 'user', content: params.message },
        { role: 'ai', content: `❌ Error: ${errorMessage}` },
      ]);
    }

    res.status(500).json({
      success: false,
      error: 'Failed to process API test',
      message: errorMessage,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}
