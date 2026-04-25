import { supabaseAdmin } from '@/db/supabase';
import { parseUserIntent } from '@/services/ai/intent/intent-parser.service';
import { ChatService } from '@/services/utils/chat.service';
import { IntentResult } from '@/types';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { convertRoleForOpenAI } from '@/utils/helpers/chat-helpers';
import { isValidUUID } from '@/utils/validation/validation';
import { CONSTANTS, FAST_PATH_COMMANDS, PROGRESS } from './constants';
import { getAvailableIntents, hasHandler } from './handler-registry';
import { buildRegressionContext } from './regression-context';
import { checkRequestAborted } from './request-cancellation';
import { emitProcessingStep } from './utils';

/**
 * Get chat history for intent parsing (extracted helper)
 */
export async function getChatHistoryForIntent(
  chatSessionId: string | undefined,
  userId?: string, // SECURITY: Optional userId for verification
  functionLogger?: FunctionLogger,
  mode?: 'lite' | 'pro' | 'editor'
): Promise<Array<{ role: string; content: string }>> {
  if (!chatSessionId) {
    return [];
  }

  try {
    // We want the model to reason over a small, stable context window.
    // In editor mode, use a smaller window (2 messages = 1 exchange) to reduce noise
    // from non-editor conversations. Editor actions ("click X", "type Y") rarely need
    // more context. In normal mode, use 4 messages (2 exchanges) for multi-turn continuity.
    const CONTEXT_WINDOW_MESSAGES = mode === 'editor' ? 2 : 4;
    const getRecentMessagesWithLogging = functionLogger
      ? withFunctionLogging(ChatService.getRecentMessages.bind(ChatService), 'ChatService.getRecentMessages', functionLogger)
      : ChatService.getRecentMessages.bind(ChatService);
    const recentMessages = await getRecentMessagesWithLogging(
      chatSessionId,
      userId, // SECURITY: Pass userId for verification
      Math.max(CONSTANTS.RECENT_MESSAGES_LIMIT, CONTEXT_WINDOW_MESSAGES)
    );
    // Convert 'ai' role to 'assistant' for OpenAI compatibility
    // ✅ FIX: Include test results from metadata so AI can see them in intent parsing
    const fullChatHistory = recentMessages.map(msg => {
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
      historyLength: fullChatHistory.length,
    });

    // Only keep the last N messages (chronological order is guaranteed by ChatService.getRecentMessages)
    const windowedHistory = fullChatHistory.slice(-CONTEXT_WINDOW_MESSAGES);
    logger.debug('[CHAT] Using chat history window for intent parsing', {
      windowSize: CONTEXT_WINDOW_MESSAGES,
      used: windowedHistory.length,
    });

    return windowedHistory;
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
  abortSignal?: AbortSignal,
  functionLogger?: FunctionLogger,
  mode?: 'lite' | 'pro' | 'editor'
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

  const emitProcessingStepWithLogging = functionLogger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
    : emitProcessingStep;
  emitProcessingStepWithLogging(chatSessionId, 'parsing_intent', 'Understanding what you need...', PROGRESS.INTENT_PARSING);

  // Check if request was cancelled
  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FAST PATH: Check for explicit API test keywords from frontend
  // This bypasses AI intent parsing when frontend explicitly specifies action
  // ═══════════════════════════════════════════════════════════════════════
  let parsedIntent: any;

  const extractAgentLevelFromText = (text: string): 'light' | 'medium' | 'hard' | undefined => {
    if (!text) return undefined;
    const lower = text.toLowerCase();

    // 1) Direct explicit keywords (most reliable)
    if (/\b(hard|хард|хардкор|сложн(?:ый|ая|ое)?|тяжел(?:ый|ая|ое)?)\b/i.test(lower)) return 'hard';
    if (/\b(medium|медиум|средн(?:ий|яя|ее)?)\b/i.test(lower)) return 'medium';
    if (/\b(light|лайт|лёгк(?:ий|ая|ое)?|легк(?:ий|ая|ое)?)\b/i.test(lower)) return 'light';

    // 2) Combined forms: "hard mode", "lightmode", "medium-level", etc.
    const combined = lower.match(/\b(light|medium|hard)(?:\s*|[-_])?(mode|level)\b/i);
    if (combined?.[1]) {
      const base = combined[1].toLowerCase();
      if (base === 'hard') return 'hard';
      if (base === 'medium') return 'medium';
      if (base === 'light') return 'light';
    }

    // 3) Numeric levels: "level 1/2/3", "lvl2", "L1/L2/L3"
    const lvl = lower.match(/\b(level|lvl)\s*([123])\b/i) || lower.match(/\b(l[123])\b/i);
    if (lvl) {
      const digit = (lvl[2] || lvl[1]?.slice(1)) as '1' | '2' | '3' | undefined;
      if (digit === '1') return 'light';
      if (digit === '2') return 'medium';
      if (digit === '3') return 'hard';
    }

    // 4) Contextual synonyms (only when user explicitly talks about mode/level/difficulty)
    const hasLevelContext = /\b(mode|level|difficulty)\b/i.test(lower);
    if (hasLevelContext) {
      if (/\b(advanced|pro|strict|deep)\b/i.test(lower)) return 'hard';
      if (/\b(standard|normal)\b/i.test(lower)) return 'medium';
      if (/\b(easy|simple)\b/i.test(lower)) return 'light';
    }

    return undefined;
  };

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
    let validAgentLevel: 'light' | 'medium' | 'hard' | undefined;

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

      // ✅ NEW: Validate agent level (light/medium/hard) from UI
      if (apiTestData.level) {
        const levelLower = String(apiTestData.level).toLowerCase();
        if (levelLower === 'light' || levelLower === 'medium' || levelLower === 'hard') {
          validAgentLevel = levelLower;
        } else {
          logger.warn('[CHAT] Invalid agent level', { level: apiTestData.level });
        }
      }
    }

    // If UI didn't pass explicit level, try to infer from message text (fallback).
    if (!validAgentLevel) {
      validAgentLevel = extractAgentLevelFromText(validMessage);
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
        // Confidence is expected to be 0..1 across the codebase
        intent_confidence: 1,
        confidence: 1,
        rawText: validMessage,
        apiMethod: validApiMethod,
        apiUrl: validApiUrl,
        apiBody: validApiBody,
        apiHeaders: validApiHeaders,
        // ✅ NEW: Agent level from UI (light/medium/hard)
        agentLevel: validAgentLevel,
        // Keep assertions in metadata (IntentResult does not define this field)
        metadata: {
          source: 'explicit_keyword',
          parsedAt: new Date().toISOString(),
          assertions: validAssertions,
          agentLevel: validAgentLevel,
        },
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FAST PATH: Swagger/OpenAPI URL detection → api_flow_test
  // Skip AI when the message obviously contains a spec URL
  // ═══════════════════════════════════════════════════════════════════════
  if (!parsedIntent) {
    const SWAGGER_URL_PATTERN = /https?:\/\/[^\s]+\/(swagger|openapi|api-docs)[^\s]*/i;
    const SPEC_FILE_URL = /https?:\/\/[^\s]+\.(json|yaml|yml)(\?[^\s]*)?/i;
    const msgLower = validMessage.toLowerCase();

    const hasSwaggerUrl = SWAGGER_URL_PATTERN.test(validMessage);
    const hasSpecFileUrl = SPEC_FILE_URL.test(validMessage) &&
      (msgLower.includes('swagger') || msgLower.includes('openapi') || msgLower.includes('spec') || msgLower.includes('api') || msgLower.includes('flow'));
    const hasCurlBlock = msgLower.includes('curl ') && msgLower.includes('http');

    if (hasSwaggerUrl || hasSpecFileUrl || hasCurlBlock) {
      logger.info('[CHAT] Fast path: Swagger/OpenAPI spec URL detected', {
        hasSwaggerUrl,
        hasSpecFileUrl,
        hasCurlBlock,
      });
      parsedIntent = {
        intent: 'api_flow_test',
        intent_confidence: 0.95,
        confidence: 0.95,
        rawText: validMessage,
        metadata: {
          source: 'fast_path_swagger_url',
          parsedAt: new Date().toISOString(),
        },
      };
    }
  }

  // Normal path: Use AI to parse intent (if fast path didn't set parsedIntent)
  if (!parsedIntent) {
    // Check if request was cancelled
    if (abortSignal) {
      const checkRequestAbortedWithLogging = functionLogger
        ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
        : checkRequestAborted;
      checkRequestAbortedWithLogging(abortSignal);
    }

    // Normal path: Use AI to parse intent
    // Get chat history for context
    const getChatHistoryForIntentWithLogging = functionLogger
      ? withFunctionLogging(getChatHistoryForIntent, 'getChatHistoryForIntent', functionLogger)
      : getChatHistoryForIntent;
    const chatHistory = await getChatHistoryForIntentWithLogging(chatSessionId, userId, functionLogger, mode); // SECURITY: Pass userId for verification

    // Check if request was cancelled after async operation
    if (abortSignal) {
      const checkRequestAbortedWithLogging = functionLogger
        ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
        : checkRequestAborted;
      checkRequestAbortedWithLogging(abortSignal);
    }

    // ✅ FIX: Log if chat history is empty
    if (chatHistory.length === 0) {
      logger.debug('[CHAT] No chat history available for intent parsing', {
        chatSessionId: chatSessionId || 'none',
      });
    }

    checkRequestTimeout();

    // Get project_id from chat session if available
    let projectId: string | undefined;
    if (chatSessionId) {
      try {
        const { data: session } = await supabaseAdmin
          .from('chat_sessions')
          .select('project_id')
          .eq('id', chatSessionId)
          .maybeSingle();
        projectId = session?.project_id || undefined;
      } catch (error) {
        logger.warn('[INTENT_PARSING] Failed to get project_id from session', { error, chatSessionId });
      }
    }

    // Build regression context (last test ID, saved cases count, etc.)
    const regressionContext = await buildRegressionContext({
      chatSessionId,
      userId,
      projectId,
    });

    // Get available intents from handler registry
    const availableIntents = getAvailableIntents();

    // Parse intent with error handling (FIX #5)
    try {
      const parseUserIntentWithLogging = functionLogger
        ? withFunctionLogging(parseUserIntent, 'parseUserIntent', functionLogger)
        : parseUserIntent;
      parsedIntent = await parseUserIntentWithLogging(
        validMessage,
        {
          chatHistory,
          ...regressionContext,
          mode,
          previewSessionId: contextObj?.previewSessionId,
          mobileSessionId: contextObj?.mobileSessionId,
        },
        projectId ?? workspace_id, // Use project_id from session if available, fallback to workspace_id
        availableIntents // Pass dynamic intent list
      );

      // Check if request was cancelled after AI call
      if (abortSignal) {
        const checkRequestAbortedWithLogging = functionLogger
          ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
          : checkRequestAborted;
        checkRequestAbortedWithLogging(abortSignal);
      }

      // ✅ FIX: Check if parseUserIntent returned null (doesn't throw error)
      if (!parsedIntent) {
        logger.warn('[CHAT] parseUserIntent returned null, using fallback', {
          userId,
          messageLength: validMessage.length,
        });
        parsedIntent = { intent: 'general_chat', confidence: 0 };
      }

      // ✅ FIX: Validate intent using dynamic handler registry
      // Uses hasHandler() instead of hardcoded array to support regression intents
      if (parsedIntent.intent && !hasHandler(parsedIntent.intent)) {
        logger.warn('[CHAT] No handler for intent, falling back to general_chat', {
          intent: parsedIntent.intent,
          availableIntents: getAvailableIntents(),
          userId,
        });
        parsedIntent.intent = 'general_chat'; // Fallback to safe default
      }

      // Hard guard: platform_test is never valid in editor mode
      if (mode === 'editor' && parsedIntent.intent === 'platform_test') {
        logger.warn('[CHAT] platform_test blocked in editor mode, redirecting to general_chat', { userId });
        parsedIntent.intent = 'general_chat';
      }

      // Hard guard: mobile_test is only valid in editor mode (not from chat)
      if (mode !== 'editor' && parsedIntent.intent === 'mobile_test') {
        logger.warn('[CHAT] mobile_test blocked outside editor mode, redirecting to general_chat', { userId });
        parsedIntent.intent = 'general_chat';
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

  // Post-process: infer agent level from text for api_test when not provided.
  // Chat handler defaults to LIGHT anyway, but keeping it here helps consistency across flows.
  if (parsedIntent?.intent === 'api_test' && !parsedIntent?.agentLevel) {
    const inferred = extractAgentLevelFromText(validMessage);
    if (inferred) {
      parsedIntent.agentLevel = inferred;
      parsedIntent.metadata = {
        ...(parsedIntent.metadata || {}),
        agentLevel: inferred,
      };
    }
  }

  // Emit detailed intent information
  const buildIntentMessageWithLogging = functionLogger
    ? withFunctionLogging(buildIntentMessage, 'buildIntentMessage', functionLogger)
    : buildIntentMessage;
  const intentMessage = buildIntentMessageWithLogging(parsedIntent);
  emitProcessingStepWithLogging(chatSessionId, 'parsing_intent', intentMessage, PROGRESS.INTENT_PARSED);

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
    return 'Understanding your request...';
  }

  const { intent, scope, target, page, apiMethod, apiUrl, clarificationQuestion } = parsedIntent;

  switch (intent) {
    case 'api_test':
      if (apiUrl && apiMethod) {
        return `Got it! Testing ${apiMethod} ${apiUrl}`;
      } else if (apiUrl) {
        return `Got it! Testing API endpoint ${apiUrl}`;
      } else {
        return 'Got it! Testing an API endpoint';
      }

    case 'platform_test':
      if (page && scope && target) {
        return `Got it! Testing ${target} on ${page}`;
      } else if (page && scope) {
        return `Got it! Testing ${scope} on ${page}`;
      } else if (scope && target) {
        return `Got it! Testing ${target} (${scope})`;
      } else if (page) {
        return `Got it! Testing website ${page}`;
      } else {
        return 'Got it! Testing a website';
      }

    case 'needs_clarification':
      if (clarificationQuestion && clarificationQuestion.trim().length > 0) {
        return clarificationQuestion.trim();
      }
      return 'I need a bit more information to help you better';

    case 'editor_action':
      return 'Got it! Executing action on the page...';

    case 'general_chat':
      return buildGeneralChatMessage(parsedIntent);

    case 'save_test':
      return 'Got it! Saving your test...';

    case 'run_regression':
      return 'Got it! Loading saved test...';

    case 'run_plan':
      return 'Got it! Loading regression plan...';

    case 'run_module':
      return 'Got it! Loading test module...';

    case 'run_by_tag':
      return 'Got it! Finding tests by tag...';

    case 'analyze_failure':
      return 'Got it! Investigating the failure...';

    case 'test_recommendations':
      return 'Got it! Analyzing your testing patterns...';

    case 'coverage_analysis':
      return 'Got it! Calculating coverage...';

    case 'create_plan':
      return 'Got it! Creating regression plan...';

    case 'add_to_plan':
      return 'Got it! Updating regression plan...';

    case 'mobile_test':
      return 'Got it! Starting mobile test...';

    case 'mobile_action':
      return 'Got it! Acting on the device...';

    case 'mobile_agent':
      return 'Got it! Working on the mobile screen...';

    case 'api_flow_test':
      return 'Got it! Building API flow from spec...';

    default:
      return 'Intent understood!';
  }
}

/**
 * Build context-aware message for general_chat intent
 * based on keywords in the user's original message.
 */
function buildGeneralChatMessage(parsedIntent: IntentResult): string {
  const msg = (parsedIntent.rawText || '').toLowerCase();

  if (/dashboard|analytics|statist|аналитик|статистик|метрик|heatmap|график/.test(msg)) {
    return 'Got it! Pulling up your data...';
  }
  if (/test\s*case|тест.*кейс|list.*test|покаж.*тест|мои тест/.test(msg)) {
    return 'Got it! Looking up your tests...';
  }
  if (/jira|github|gitlab|slack|telegram|notion|интеграц|integrat/.test(msg)) {
    return 'Got it! Checking your integrations...';
  }
  if (/schedule|расписан|cron|планиров/.test(msg)) {
    return 'Got it! Checking your schedules...';
  }
  if (/fail|error|bug|ошибк|баг|упал|сломал|красн/.test(msg)) {
    return 'Got it! Investigating the issue...';
  }
  if (/coverage|покрыт|recommend|рекоменд|suggest|предлож/.test(msg)) {
    return 'Got it! Running analysis...';
  }
  if (/remember|запомни|memory|помн|забудь|forget/.test(msg)) {
    return 'Got it! Checking my memory...';
  }
  if (/report|отчёт|отчет|result|результат/.test(msg)) {
    return 'Got it! Fetching results...';
  }
  if (/flaky|нестабильн|unstable/.test(msg)) {
    return 'Got it! Checking test stability...';
  }
  if (/what can you|что .*умеешь|что .*можешь|help|помо[гщ]/.test(msg)) {
    return 'Got it! Let me tell you what I can do';
  }

  return 'Got it! Let me help you with that';
}

