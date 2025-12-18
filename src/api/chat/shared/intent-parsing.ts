import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import { parseUserIntent } from '@/services/ai/intentParser.service';
import { ChatService } from '@/services/utils/chat.service';
import { convertRoleForOpenAI } from '@/utils/helpers/chat-helpers';
import { IntentResult } from '@/types';
import { CONSTANTS, FAST_PATH_COMMANDS, PROGRESS } from './constants';
import { emitProcessingStep } from './utils';
import { checkRequestAborted } from './request-cancellation';

/**
 * Get chat history for intent parsing (extracted helper)
 */
export async function getChatHistoryForIntent(
  chatSessionId: string | undefined,
  userId?: string // SECURITY: Optional userId for verification
): Promise<Array<{ role: string; content: string }>> {
  if (!chatSessionId) {
    return [];
  }

  try {
    const recentMessages = await ChatService.getRecentMessages(
      chatSessionId,
      userId, // SECURITY: Pass userId for verification
      CONSTANTS.RECENT_MESSAGES_LIMIT
    );
    // Convert 'ai' role to 'assistant' for OpenAI compatibility
    // ✅ FIX: Include test results from metadata so AI can see them in intent parsing
    const chatHistory = recentMessages.map(msg => {
      let content = msg.content;

      // ✅ FIX: If message has test results in metadata, append them to content
      if (msg.metadata?.testResult) {
        const testResult = msg.metadata.testResult;
        const testId = msg.metadata.testId;
        const testType = msg.metadata.testType || 'unknown';

        // Format test results for AI context (shorter for intent parsing)
        let testResultsText = '\n[TEST RESULTS: ';
        testResultsText += `ID: ${testId}, Type: ${testType}`;
        if (testResult.status) testResultsText += `, Status: ${testResult.status}`;
        if (testResult.statusCode) testResultsText += `, HTTP: ${testResult.statusCode}`;
        if (testResult.responseTime !== undefined) testResultsText += `, Time: ${testResult.responseTime}ms`;
        if (testResult.url) testResultsText += `, URL: ${testResult.url}`;
        testResultsText += ']';

        content += testResultsText;
      }

      return {
        role: convertRoleForOpenAI(msg.role),
        content,
      };
    });

    logger.debug('[CHAT] Retrieved chat history for intent parsing', {
      historyLength: chatHistory.length,
    });

    return chatHistory;
  } catch (error) {
    logger.warn('[CHAT] Failed to get chat history, continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * STEP 4: PARSE INTENT (Only if not responding to test plan) (FIX #5)
 */
export async function parseIntent(
  message: string,
  context: any,
  chatSessionId: string | undefined,
  userId: string,
  workspace_id: string,
  checkRequestTimeout: () => void,
  abortSignal?: AbortSignal
): Promise<any> {
  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: PARSE INTENT (Only if not responding to test plan) (FIX #5)
  // ═══════════════════════════════════════════════════════════════════════

  // ✅ FIX: Validate input parameters
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    logger.error('[CHAT] Invalid message in parseIntent', { message: typeof message, userId });
    throw new Error('Message is required and must be non-empty');
  }

  if (!userId || typeof userId !== 'string') {
    logger.error('[CHAT] Invalid userId in parseIntent', { userId: typeof userId });
    throw new Error('UserId is required');
  }

  if (!workspace_id || typeof workspace_id !== 'string') {
    logger.error('[CHAT] Invalid workspace_id in parseIntent', { workspace_id: typeof workspace_id });
    throw new Error('Workspace_id is required');
  }

  // ✅ FIX: Validate UUID format for workspace_id
  if (!isValidUUID(workspace_id)) {
    logger.error('[CHAT] Invalid workspace_id UUID format', { workspace_id });
    throw new Error('Invalid workspace_id UUID format');
  }

  // ✅ FIX: Check message length (prevent very long messages)
  const MAX_MESSAGE_LENGTH = 10000;
  let validMessage = message.trim();
  if (validMessage.length > MAX_MESSAGE_LENGTH) {
    logger.warn('[CHAT] Message too long, truncating', {
      originalLength: validMessage.length,
      maxLength: MAX_MESSAGE_LENGTH,
    });
    validMessage = validMessage.substring(0, MAX_MESSAGE_LENGTH);
  }

  emitProcessingStep(chatSessionId, 'parsing_intent', '🧠 Understanding what you need...', PROGRESS.INTENT_PARSING);

  // Check if request was cancelled
  if (abortSignal) {
    checkRequestAborted(abortSignal);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FAST PATH: Check for explicit API test keywords from frontend
  // This bypasses AI intent parsing when frontend explicitly specifies action
  // ═══════════════════════════════════════════════════════════════════════
  let parsedIntent: any;

  // ✅ FIX: Improved type guard for context object (exclude arrays)
  const contextObj =
    typeof context === 'object' &&
    context !== null &&
    !Array.isArray(context)
      ? context
      : null;

  const isExplicitApiTest =
    validMessage.startsWith(FAST_PATH_COMMANDS.API_TEST_PREFIX) ||
    contextObj?.action === FAST_PATH_COMMANDS.ACTIONS.RUN_API_TEST;

  if (isExplicitApiTest) {
    logger.info('[CHAT] Fast path: Explicit API test request detected', {
      hasKeyword: validMessage.startsWith(FAST_PATH_COMMANDS.API_TEST_PREFIX),
      hasContextAction: contextObj?.action === FAST_PATH_COMMANDS.ACTIONS.RUN_API_TEST,
      hasApiTestData: !!contextObj?.apiTest,
    });

    // Extract API test data from context if provided
    const apiTestData = contextObj?.apiTest;

    // ✅ FIX: Validate and sanitize apiTestData
    let validApiMethod = 'GET';
    let validApiUrl: string | undefined;
    let validApiBody: any;
    let validApiHeaders: Record<string, string> | undefined;
    let validAssertions: any;

    if (apiTestData) {
      // ✅ FIX: Validate HTTP method
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
      if (apiTestData.method) {
        const methodUpper = String(apiTestData.method).toUpperCase();
        validApiMethod = validMethods.includes(methodUpper) ? methodUpper : 'GET';
      }

      // ✅ FIX: Validate URL
      if (apiTestData.url) {
        if (typeof apiTestData.url === 'string' && apiTestData.url.trim().length > 0) {
          validApiUrl = apiTestData.url.trim();
        } else {
          logger.warn('[CHAT] Invalid apiUrl type or empty', { url: apiTestData.url });
        }
      }

      // ✅ FIX: Validate body (must be object or null)
      if (apiTestData.body !== undefined) {
        if (apiTestData.body === null || typeof apiTestData.body === 'object') {
          validApiBody = apiTestData.body;
        } else {
          logger.warn('[CHAT] Invalid apiBody type', { body: typeof apiTestData.body });
        }
      }

      // ✅ FIX: Validate headers (must be object)
      if (apiTestData.headers) {
        if (typeof apiTestData.headers === 'object' && !Array.isArray(apiTestData.headers)) {
          validApiHeaders = apiTestData.headers;
        } else {
          logger.warn('[CHAT] Invalid apiHeaders type', { headers: typeof apiTestData.headers });
        }
      }

      // ✅ FIX: Validate assertions
      if (apiTestData.assertions !== undefined) {
        validAssertions = apiTestData.assertions;
      }
    }

    // ✅ FIX: Check if required fields are present
    if (!validApiUrl) {
      logger.warn('[CHAT] Fast path API test missing URL, falling back to AI parsing', {
        hasMethod: !!apiTestData?.method,
        hasBody: !!apiTestData?.body,
      });
      // Fallback to normal path - continue below
    } else {
      parsedIntent = {
        intent: 'api_test',
        confidence: 100,
        apiMethod: validApiMethod,
        apiUrl: validApiUrl,
        apiBody: validApiBody,
        apiHeaders: validApiHeaders,
        assertions: validAssertions,
        metadata: {
          source: 'explicit_keyword',
          parsedAt: new Date().toISOString(),
        },
      };
    }
  }

  // Normal path: Use AI to parse intent (if fast path didn't set parsedIntent)
  if (!parsedIntent) {
    // Check if request was cancelled
    if (abortSignal) {
      checkRequestAborted(abortSignal);
    }

    // Normal path: Use AI to parse intent
    // Get chat history for context
    const chatHistory = await getChatHistoryForIntent(chatSessionId, userId); // SECURITY: Pass userId for verification

    // Check if request was cancelled after async operation
    if (abortSignal) {
      checkRequestAborted(abortSignal);
    }

    // ✅ FIX: Log if chat history is empty
    if (chatHistory.length === 0) {
      logger.debug('[CHAT] No chat history available for intent parsing', {
        chatSessionId: chatSessionId || 'none',
      });
    }

    checkRequestTimeout();

    // Parse intent with error handling (FIX #5)
    try {
      parsedIntent = await parseUserIntent(
        validMessage,
        { chatHistory },
        workspace_id
      );

      // Check if request was cancelled after AI call
      if (abortSignal) {
        checkRequestAborted(abortSignal);
      }

      // ✅ FIX: Check if parseUserIntent returned null (doesn't throw error)
      if (!parsedIntent) {
        logger.warn('[CHAT] parseUserIntent returned null, using fallback', {
          userId,
          messageLength: validMessage.length,
        });
        parsedIntent = { intent: 'general_chat', confidence: 0 };
      }

      // ✅ FIX: Validate intent value
      const validIntents = ['api_test', 'platform_test', 'general_chat', 'needs_clarification'];
      if (parsedIntent.intent && !validIntents.includes(parsedIntent.intent)) {
        logger.warn('[CHAT] Invalid intent from parseUserIntent', {
          intent: parsedIntent.intent,
          userId,
        });
        parsedIntent.intent = 'general_chat'; // Fallback to safe default
      }
    } catch (intentError) {
      logger.error('[CHAT] parseUserIntent failed', {
        error: intentError instanceof Error ? intentError.message : String(intentError),
        userId,
        messageLength: validMessage.length,
      });
      // Fallback to general_chat if intent parsing fails
      parsedIntent = { intent: 'general_chat', confidence: 0 };
    }
  }

  // Emit detailed intent information
  const intentMessage = buildIntentMessage(parsedIntent);
  emitProcessingStep(chatSessionId, 'parsing_intent', intentMessage, PROGRESS.INTENT_PARSED);

  const intent = parsedIntent?.intent || 'general_chat';

  logger.info('[CHAT] Intent parsed', {
    intent,
    scope: parsedIntent?.scope,
    confidence: parsedIntent?.confidence,
    usedRAG: parsedIntent?.metadata?.usedRAG,
  });

  checkRequestTimeout();

  return parsedIntent;
}

/**
 * Build user-friendly intent message for WebSocket
 */
export function buildIntentMessage(parsedIntent: IntentResult | null | undefined): string {
  if (!parsedIntent) {
    return '🤔 Understanding your request...';
  }

  const { intent, scope, target, page, apiMethod, apiUrl, urgency, clarificationQuestion } = parsedIntent;

  switch (intent) {
    case 'api_test':
      if (apiUrl && apiMethod) {
        const urgencyEmoji = urgency === 'high' ? '⚡ ' : '';
        return `${urgencyEmoji}🔍 Got it! Testing ${apiMethod} ${apiUrl}`;
      } else if (apiUrl) {
        return `🔍 Got it! Testing API endpoint ${apiUrl}`;
      } else {
        return '🔍 Got it! You want to test an API endpoint';
      }

    case 'platform_test':
      if (page && scope && target) {
        const urgencyEmoji = urgency === 'high' ? '⚡ ' : '';
        return `${urgencyEmoji}🌐 Got it! Testing ${target} on ${page}`;
      } else if (page && scope) {
        return `🌐 Got it! Testing ${scope} on ${page}`;
      } else if (scope && target) {
        return `🌐 Got it! Testing ${target} (${scope})`;
      } else if (page) {
        return `🌐 Got it! Testing website ${page}`;
      } else {
        return '🌐 Got it! You want to test a website';
      }

    case 'needs_clarification':
      // Use GPT-generated clarification question if available, otherwise fallback
      if (clarificationQuestion && clarificationQuestion.trim().length > 0) {
        return `❓ ${clarificationQuestion.trim()}`;
      }
      return '❓ I need a bit more information to help you better';

    case 'general_chat':
      return '💬 Got it! Let me help you with that';

    default:
      return '✅ Intent understood!';
  }
}
