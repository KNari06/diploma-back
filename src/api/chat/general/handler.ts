import { buildChatSystemPrompt } from '@/ai/prompts';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { autoEmbedOldMessages, searchChatHistory } from '@/services/ai/chat-embeddings.service';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { ChatService } from '@/services/utils/chat.service';
import { convertRoleForOpenAI } from '@/utils/helpers/chat-helpers';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import { Request, Response } from 'express';
import { CONSTANTS } from '../shared/constants';
import { compressMessageContent, emitProcessingStep, checkChatCredits, deductChatCredits } from '../shared/utils';
import { checkRequestAborted } from '../shared/request-cancellation';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: GENERAL CHAT
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function handleGeneralChat(
  req: Request,
  res: Response,
  params: {
    message: string;
    userId: string;
    chatSessionId?: string;
    context?: any;
    userLanguage?: 'en' | 'ru' | 'neutral'; // Language from intent parser (avoid re-detection)
    abortSignal?: AbortSignal;
  }
): Promise<void> {
  const { message, userId, chatSessionId, context, userLanguage: providedLanguage, abortSignal } = params;

  if (abortSignal) checkRequestAborted(abortSignal);

  logger.info('[GENERAL_CHAT] Handling general conversation', {
    hasSession: !!chatSessionId,
    messageLength: message.length
  });

  emitProcessingStep(chatSessionId, 'generating_response', '💬 Thinking...', 90);

  if (abortSignal) checkRequestAborted(abortSignal);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: BUILD CONTEXT WITH HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let oldContextSummary = '';

  if (chatSessionId) {
    // Get recent messages (last 20) - always needed for conversationHistory
    const recentMessages = await ChatService.getRecentMessages(chatSessionId, userId, CONSTANTS.RECENT_MESSAGES_LIMIT); // SECURITY: Pass userId for verification
    if (abortSignal) checkRequestAborted(abortSignal);

    logger.info('[GENERAL_CHAT] Retrieved recent history', {
      messageCount: recentMessages.length
    });

    // ═══════════════════════════════════════════════════════════════════════
    // VECTOR-BASED CONTEXT RETRIEVAL (Better than GPT summarization!)
    // ═══════════════════════════════════════════════════════════════════════
    // Benefits: 20x faster, 20x cheaper, more accurate semantic search
    // Cost: ~$0.0001 per 1K messages (vs $0.002 for GPT summary)
    // Speed: ~100ms (vs 2-3 sec for GPT summary)
    // ═══════════════════════════════════════════════════════════════════════

    // Check if we need vector search (only if we have old messages beyond last 20)
    // We check recentMessages.length to see if there might be more messages
    if (recentMessages.length >= CONSTANTS.RECENT_MESSAGES_LIMIT && chatSessionId) {
      // Get total message count to confirm we have old messages
      const { count: totalMessageCount, error: countError } = await supabaseAdmin
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', chatSessionId);

      if (countError) {
        logger.error('[GENERAL_CHAT] Failed to count messages', { error: countError });
      }

      const totalMessages = totalMessageCount || 0;

      logger.info('[GENERAL_CHAT] Message count check for vector search', {
        sessionId: chatSessionId,
        totalMessages,
        recentCount: recentMessages.length
      });

      // Only do vector search if we have more than 20 messages
      if (totalMessages > CONSTANTS.RECENT_MESSAGES_LIMIT) {
        logger.info('[GENERAL_CHAT] Chat has old messages, using vector search');

        try {
          // Search for relevant old messages using semantic similarity
          // Note: We don't await autoEmbedOldMessages - it runs in background for NEXT request
          const relevantOldMessages = await searchChatHistory(
            chatSessionId,
            message, // Current user query
            {
              matchCount: 5, // Top 5 (increased from 3 for better recall)
              matchThreshold: 0.4, // Lowered from 0.5 for better recall on vague questions
            }
          );
          if (abortSignal) checkRequestAborted(abortSignal);

          if (relevantOldMessages.length > 0) {
            // Format relevant messages as context
            oldContextSummary = relevantOldMessages
              .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
              .join('\n\n');

            logger.info('[GENERAL_CHAT] Retrieved relevant old context via vectors', {
              retrievedCount: relevantOldMessages.length,
              avgSimilarity: (relevantOldMessages.reduce((sum, m) => sum + m.similarity, 0) / relevantOldMessages.length).toFixed(2),
              oldestDate: relevantOldMessages[0]?.created_at,
            });
          } else {
            logger.info('[GENERAL_CHAT] No relevant old messages found in vector search');
          }
        } catch (vectorError) {
          // Fallback: If vector search fails, continue without old context
          logger.error('[GENERAL_CHAT] Vector search failed, continuing without old context', {
            error: vectorError,
            sessionId: chatSessionId
          });
          oldContextSummary = ''; // No old context
        }
      }
    }

    // Build conversation history with compressed content (use helper for role conversion)
    // ✅ FIX: Include test results from metadata so AI can see them
    conversationHistory = recentMessages.map(msg => {
      let content = compressMessageContent(msg.content);

      // ✅ FIX: If message has test results in metadata, append them to content
      if (msg.metadata?.testResult) {
        const testResult = msg.metadata.testResult;
        const testId = msg.metadata.testId;
        const testType = msg.metadata.testType || 'unknown';

        // Format test results for AI context
        let testResultsText = '\n\n--- TEST RESULTS ---\n';
        testResultsText += `Test ID: ${testId}\n`;
        testResultsText += `Test Type: ${testType}\n`;

        // API Test Results
        if (testResult.statusCode) {
          testResultsText += `HTTP Status: ${testResult.statusCode}\n`;
        }
        if (testResult.responseTime !== undefined) {
          testResultsText += `Response Time: ${testResult.responseTime}ms\n`;
        }
        if (testResult.method) {
          testResultsText += `Method: ${testResult.method}\n`;
        }
        if (testResult.responseBody) {
          // Truncate very long response bodies
          const bodyStr = typeof testResult.responseBody === 'string'
            ? testResult.responseBody
            : JSON.stringify(testResult.responseBody, null, 2);
          const truncatedBody = bodyStr.length > 2000
            ? bodyStr.substring(0, 2000) + '... [truncated]'
            : bodyStr;
          testResultsText += `Response Body: ${truncatedBody}\n`;
        }
        if (testResult.headers) {
          testResultsText += `Headers: ${JSON.stringify(testResult.headers)}\n`;
        }

        // UI Test Results
        if (testResult.status) {
          testResultsText += `Status: ${testResult.status}\n`;
        }
        if (testResult.browsers) {
          testResultsText += `Browsers: ${Array.isArray(testResult.browsers) ? testResult.browsers.join(', ') : testResult.browsers}\n`;
        }
        if (testResult.results && Array.isArray(testResult.results)) {
          testResultsText += `Browser Results:\n`;
          testResult.results.forEach((r: any) => {
            testResultsText += `  - ${r.browser}: ${r.status}`;
            if (r.errors && Array.isArray(r.errors) && r.errors.length > 0) {
              testResultsText += ` (${r.errors.length} errors)`;
            }
            testResultsText += '\n';
          });
        }

        if (testResult.url) {
          testResultsText += `URL: ${testResult.url}\n`;
        }
        if (testResult.error) {
          testResultsText += `Error: ${testResult.error}\n`;
        }
        if (testResult.completedAt) {
          testResultsText += `Completed At: ${testResult.completedAt}\n`;
        }
        if (msg.metadata.fuzzingReport) {
          const fuzz = msg.metadata.fuzzingReport;
          testResultsText += `\nFuzzing Report: ${fuzz.totalTests} tests, ${fuzz.passed} passed, ${fuzz.failed} failed, ${fuzz.issuesFound} issues found, Security Score: ${fuzz.securityScore}\n`;
        }

        content += testResultsText;
      }

      return {
        role: convertRoleForOpenAI(msg.role) as 'user' | 'assistant',
        content,
      };
    }) as Array<{ role: 'user' | 'assistant'; content: string }>;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: SEARCH GLOBAL KB FOR GENERAL CHAT (ALWAYS!)
  // ═══════════════════════════════════════════════════════════════════════
  // TODO: KB Search temporarily disabled - will be re-enabled later

  // KB context variables (disabled)
  const kbContext = '';
  const kbRulesContext = '';

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: BUILD MESSAGES ARRAY FOR OPENAI
  // ═══════════════════════════════════════════════════════════════════════

  const systemPrompt = buildChatSystemPrompt();

  // Enhance system prompt with old context summary
  const enhancedSystemPrompt = oldContextSummary
    ? `${systemPrompt}\n--- Previous Conversation Context ---\n${oldContextSummary}\n\nNote: The above is a summary of earlier messages. Recent messages follow below.`
    : systemPrompt;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: enhancedSystemPrompt },
  ];

  // Add additional context if provided (legacy support)
  const contextString = typeof context === 'string' ? context : undefined;
  if (contextString) {
    messages.push({
      role: 'system',
      content: `Additional Context: ${contextString}`,
    });
  }

  // Add conversation history
  messages.push(...conversationHistory);

  // Add current message
  messages.push({ role: 'user', content: message });

  logger.info('[GENERAL_CHAT] Built context for AI', {
    totalMessages: messages.length,
    hasOldSummary: !!oldContextSummary,
    recentHistoryCount: conversationHistory.length,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2.5: CHECK CREDITS BEFORE OPENAI REQUEST
  // ═══════════════════════════════════════════════════════════════════════
  // Check user has enough credits (1 credit per chat message)
  // This prevents wasting OpenAI API calls if user has no credits

  const hasEnoughCredits = await checkChatCredits(userId, res);
  if (!hasEnoughCredits) {
    return; // Response already sent in checkChatCredits
  }

  if (abortSignal) checkRequestAborted(abortSignal);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: GET AI RESPONSE
  // ═══════════════════════════════════════════════════════════════════════

  let gptResponse: { content: string; usage?: any };
  let shouldDeductCredits = false; // Track if we should deduct credits

  try {
    gptResponse = await getChatCompletionWithMessages(messages, {
      temperature: 0.3, // Lowered from 0.5 for more consistent responses
      max_tokens: 1000,
      abortSignal,
    });

    // Mark that we should deduct credits (only if we got a real response, not fallback)
    shouldDeductCredits = true;
  } catch (openaiError: any) {
    // Check if request was aborted (client closed connection)
    if (openaiError?.message?.includes('cancelled') ||
        openaiError?.message?.includes('aborted') ||
        openaiError?.message?.includes('signal')) {
      logger.warn('[GENERAL_CHAT] Request was cancelled by client', {
        error: openaiError instanceof Error ? openaiError.message : String(openaiError),
        userId,
      });

      // Check if response already sent
      if (res.headersSent) {
        return;
      }

      res.status(499).json({
        success: false,
        error: 'Request was cancelled',
        message: 'The request was cancelled. Please try again.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Fallback response if OpenAI fails
    logger.error('[GENERAL_CHAT] OpenAI API failed, using fallback response', {
      error: openaiError instanceof Error ? openaiError.message : String(openaiError),
      status: openaiError?.status,
      code: openaiError?.code,
      userId,
    });

    // Provide helpful fallback message based on error type
    let fallbackMessage = 'I apologize, but I\'m currently experiencing technical difficulties. Please try again in a few moments.';

    if (openaiError?.status === 401 || openaiError?.code === 'invalid_api_key') {
      fallbackMessage = 'I\'m temporarily unavailable due to a configuration issue. Our team has been notified.';
    } else if (openaiError?.status === 429 || openaiError?.code === 'insufficient_quota') {
      fallbackMessage = 'I\'m temporarily unavailable due to high demand. Please try again in a few minutes.';
    } else if (openaiError?.message?.includes('timeout') || openaiError?.message?.includes('took too long')) {
      fallbackMessage = 'The request took too long to process. Please try again with a shorter message.';
    }

    gptResponse = {
      content: fallbackMessage,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        model: 'fallback',
      },
    };
    // Don't deduct credits for fallback responses
    shouldDeductCredits = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3.5: DEDUCT CREDITS AFTER SUCCESSFUL RESPONSE
  // ═══════════════════════════════════════════════════════════════════════
  // Deduct 1 credit for chat message (fixed cost per message)
  // Only deduct if we got a real OpenAI response (not fallback)

  if (shouldDeductCredits && gptResponse && gptResponse.content) {
    await deductChatCredits(userId, shouldDeductCredits);
  }

  if (abortSignal) checkRequestAborted(abortSignal);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: SAVE MESSAGES
  // ═══════════════════════════════════════════════════════════════════════

  if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: gptResponse.content },
    ]);

    // Auto-generate title for new chats (after first user message)
    // This runs in background, doesn't block response
    ChatService.autoGenerateTitle(chatSessionId).catch(error => {
      logger.warn('[GENERAL_CHAT] Failed to auto-generate title', { error, chatSessionId });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-EMBED OLD MESSAGES (AFTER SAVING - for NEXT request)
    // ═══════════════════════════════════════════════════════════════════════
    // Now that we saved new messages, check if we need to create embeddings
    // This runs in background and prepares embeddings for the NEXT request
    const { count: totalMessageCountAfterSave } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', chatSessionId);

    const totalMessagesNow = totalMessageCountAfterSave || 0;

    // If we now have more than 20 messages, create embeddings for old ones
    if (totalMessagesNow > CONSTANTS.RECENT_MESSAGES_LIMIT) {
      logger.info('[GENERAL_CHAT] Creating embeddings for old messages (background)', {
        sessionId: chatSessionId,
        totalMessages: totalMessagesNow
      });

      // Auto-embed with timeout to prevent memory leak
      // This runs in background and doesn't block the response
      const embedPromise = autoEmbedOldMessages(chatSessionId);
      const embedTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Auto-embed timeout')), CONSTANTS.AUTO_EMBED_TIMEOUT)
      );

      Promise.race([embedPromise, embedTimeout]).catch(error => {
        logger.warn('[GENERAL_CHAT] Failed to auto-embed messages (background)', {
          error: error instanceof Error ? error.message : String(error),
          timeout: CONSTANTS.AUTO_EMBED_TIMEOUT,
          sessionId: chatSessionId
        });
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: RESPOND
  // ═══════════════════════════════════════════════════════════════════════
  // Credits are deducted above (1 credit per chat message)

  // Check if client connection is still alive before sending response
  if (req.aborted || req.socket?.destroyed) {
    logger.warn('[GENERAL_CHAT] Client connection closed, cannot send response', {
      userId,
      chatSessionId,
    });
    return;
  }

  // Check if response already sent
  if (res.headersSent) {
    logger.warn('[GENERAL_CHAT] Response already sent', { userId, chatSessionId });
    return;
  }

  const response: any = {
    success: true, // ← Frontend expects this!
    reply: gptResponse.content,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  };

  // Show user's current credit balance and remaining daily/monthly limits
  if (userId && isValidUUID(userId)) {
    try {
      const credits = await UserCreditsService.getUserCredits(userId);
      const planInfo = await PricingPlansService.getUserPlanInfo(userId);

      response.creditsRemaining = credits?.credits_balance || 0;

      if (planInfo) {
        response.dailyRemaining = planInfo.daily_remaining;
        response.monthlyRemaining = planInfo.monthly_remaining;
      }
    } catch (error) {
      logger.warn('[GENERAL_CHAT] Failed to get credits info', { error, userId });
    }
  }

  res.json(response);
}
