import { buildChatSystemPrompt } from '@/ai/prompts';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { autoEmbedOldMessages, searchChatHistory } from '@/services/ai/embeddings/chat-embeddings.service';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { getSummariesForContext, summarizeOldMessages } from '@/services/ai/summarization/chat-summarization.service';
import { formatPageContextForChat, getPageContext, type PageContext } from '@/services/chat/editor-context.service';
import { searchKB } from '@/services/kb/kb.service';
import { ChatService } from '@/services/utils/chat.service';
import { FunctionLogger, withFunctionLogging } from '@/utils/core/function-logger';
import { logger } from '@/utils/core/logger';
import { convertRoleForOpenAI } from '@/utils/helpers/chat-helpers';
import { isValidUUID } from '@/utils/validation/validation';
import { Request, Response } from 'express';
import { CONSTANTS } from '../shared/constants';
import { checkRequestAborted } from '../shared/request-cancellation';
import { compressMessageContent, deductChatCredits, emitProcessingStep } from '../shared/utils';
import { withAIContext } from '@/services/ai/tracking/ai-context';
import { AIUsageTracker } from '@/services/ai/tracking/ai-usage-tracker';

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
    logger?: FunctionLogger;
    mode?: 'lite' | 'pro' | 'editor'; // Test execution mode
  }
): Promise<void> {
  const { message, userId, chatSessionId, context: rawContext, abortSignal, logger: functionLogger, mode } = params;

  // Normalize context: parse JSON string into object if needed (frontend may send stringified JSON)
  let context: any = rawContext;
  if (typeof rawContext === 'string' && rawContext.startsWith('{')) {
    try {
      context = JSON.parse(rawContext);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  logger.info('[GENERAL_CHAT] Handling general conversation', {
    hasSession: !!chatSessionId,
    messageLength: message.length
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: BUILD CONTEXT WITH HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let oldContextSummary = '';

  if (chatSessionId) {
    // Get recent messages (last 20) - always needed for conversationHistory
    const getRecentMessagesWithLogging = functionLogger
      ? withFunctionLogging(ChatService.getRecentMessages.bind(ChatService), 'ChatService.getRecentMessages', functionLogger)
      : ChatService.getRecentMessages.bind(ChatService);
    const recentMessages = await getRecentMessagesWithLogging(chatSessionId, userId, CONSTANTS.RECENT_MESSAGES_LIMIT); // SECURITY: Pass userId for verification
    if (abortSignal) {
      const checkRequestAbortedWithLogging = functionLogger
        ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
        : checkRequestAborted;
      checkRequestAbortedWithLogging(abortSignal);
    }

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
    // If recentMessages returned exactly LIMIT messages, there are likely more old messages
    if (recentMessages.length >= CONSTANTS.RECENT_MESSAGES_LIMIT && chatSessionId) {
      logger.info('[GENERAL_CHAT] Recent messages at limit, using vector search for old context', {
        sessionId: chatSessionId,
        recentCount: recentMessages.length
      });

      // recentMessages.length >= LIMIT implies there are older messages
      {
        logger.info('[GENERAL_CHAT] Chat has old messages, using vector search');

        try {
          // Search for relevant old messages using semantic similarity
          // Note: We don't await autoEmbedOldMessages - it runs in background for NEXT request
          const searchChatHistoryWithLogging = functionLogger
            ? withFunctionLogging(searchChatHistory, 'searchChatHistory', functionLogger)
            : searchChatHistory;
          const relevantOldMessages = await searchChatHistoryWithLogging(
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
  // STEP 2: SEARCH KNOWLEDGE BASE (ALWAYS!)
  // ═══════════════════════════════════════════════════════════════════════
  // KB search provides persistent background context from global + project KB.
  // Non-fatal: continues without KB on error.

  let kbContext = '';
  const projectId = typeof context === 'object' ? context?.projectId : undefined;

  try {
    const kbResults = await searchKB(message, projectId, {
      matchThreshold: 0.5,
      matchCount: 3,
    });

    if (kbResults.chunks.length > 0) {
      kbContext = kbResults.chunks.map(chunk => chunk.content).join('\n---\n');
      logger.info('[GENERAL_CHAT] KB search returned results', {
        chunksCount: kbResults.chunks.length,
        sources: {
          global: kbResults.sources.global.length,
          project: kbResults.sources.project.length,
        },
      });
    }
  } catch (kbError) {
    logger.warn('[GENERAL_CHAT] KB search failed, continuing without KB context', {
      error: kbError instanceof Error ? kbError.message : String(kbError),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2.5: LOAD AGENT MEMORY (SUMMARIES)
  // ═══════════════════════════════════════════════════════════════════════
  let agentMemory = '';
  if (chatSessionId) {
    agentMemory = await getSummariesForContext(chatSessionId);
    if (agentMemory) {
      logger.info('[GENERAL_CHAT] Loaded agent memory (summaries)', {
        memoryLength: agentMemory.length,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2.6: LOAD WORKSPACE MEMORY (PERSISTENT SEMANTIC MEMORY)
  // ═══════════════════════════════════════════════════════════════════════
  let workspaceMemory = '';
  const workspaceId = typeof context === 'object' && context !== null && !Array.isArray(context)
    ? context?.workspaceId || context?.workspace_id
    : undefined;

  if (workspaceId) {
    try {
      const { WorkspaceMemoryService } = await import('@/services/ai/memory/workspace-memory.service');
      workspaceMemory = await WorkspaceMemoryService.getMemoryForContext(workspaceId, 2000);
      if (workspaceMemory) {
        logger.info('[GENERAL_CHAT] Loaded workspace memory', {
          workspaceId,
          memoryLength: workspaceMemory.length,
        });
      }
    } catch (memoryError) {
      logger.warn('[GENERAL_CHAT] Failed to load workspace memory', {
        error: memoryError instanceof Error ? memoryError.message : String(memoryError),
        workspaceId,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2.7: EDITOR MODE — GET PAGE CONTEXT
  // ═══════════════════════════════════════════════════════════════════════
  let editorPageContext: PageContext | null = null;
  const parsedContext = typeof context === 'object' && context !== null && !Array.isArray(context)
    ? context as Record<string, any>
    : undefined;

  if (mode === 'editor' && parsedContext?.previewSessionId) {
    try {
      editorPageContext = await getPageContext(parsedContext.previewSessionId, userId);

      // Merge frontend-provided pageContext (test steps, title) if available
      if (editorPageContext && parsedContext.pageContext) {
        if (parsedContext.pageContext.title) editorPageContext.title = parsedContext.pageContext.title;
        if (parsedContext.pageContext.testSteps) editorPageContext.testSteps = parsedContext.pageContext.testSteps;
      }

      if (editorPageContext) {
        logger.info('[GENERAL_CHAT] Editor mode: page context loaded', {
          url: editorPageContext.url,
          domSummaryLength: editorPageContext.domSummary.length,
          hasTestSteps: !!editorPageContext.testSteps?.length,
        });
      }
    } catch (editorError) {
      logger.warn('[GENERAL_CHAT] Editor mode: failed to get page context', {
        error: editorError instanceof Error ? editorError.message : String(editorError),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: BUILD MESSAGES ARRAY FOR OPENAI
  // ═══════════════════════════════════════════════════════════════════════
  // Context assembly order:
  // 1. System prompt (+ editor instructions if applicable)
  // 2. Agent Memory (summaries from chat_summaries)
  // 3. KB Context (global + project knowledge base)
  // 4. Editor page context (DOM, URL, test steps)
  // 5. Vector search old context
  // 6. Additional context (legacy)
  // 7. Conversation history (recent messages)
  // 8. Current user message

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2.8: COLLECT AVAILABLE TOOLS (SKILLS + MEMORY)
  // ═══════════════════════════════════════════════════════════════════════
  let availableTools: any[] = [];
  let skillDescriptions = '';

  if (workspaceId) {
    try {
      const { SkillRegistry } = await import('@/services/skills');
      const { MEMORY_TOOLS } = await import('@/services/ai/memory/memory-tools');

      // Get available skill tools
      const skillContext = { userId, workspaceId, chatSessionId };
      const skillTools = await SkillRegistry.getAvailableTools(skillContext);
      skillDescriptions = await SkillRegistry.getSkillDescriptions(skillContext);

      // Combine skill tools + memory tools
      availableTools = [...skillTools, ...MEMORY_TOOLS];

      logger.info('[GENERAL_CHAT] Tools collected', {
        totalTools: availableTools.length,
        skillTools: skillTools.length,
        memoryTools: MEMORY_TOOLS.length,
      });
    } catch (toolsError) {
      logger.warn('[GENERAL_CHAT] Failed to load tools, continuing without them', {
        error: toolsError instanceof Error ? toolsError.message : String(toolsError),
      });
    }
  }

  const buildChatSystemPromptWithLogging = functionLogger
    ? withFunctionLogging(buildChatSystemPrompt, 'buildChatSystemPrompt', functionLogger)
    : buildChatSystemPrompt;
  let systemPrompt = buildChatSystemPromptWithLogging(skillDescriptions);

  // Append editor-specific instructions if in editor mode
  if (mode === 'editor') {
    systemPrompt += `\n\n--- EDITOR MODE (CRITICAL) ---
You are connected to the user's AI Editor with a live browser preview.
You CAN see the current page. A "CURRENT PAGE CONTEXT" system message contains the URL and interactive elements (buttons, inputs, links) visible on the page right now.
NEVER say "I can't view the page" or "I don't have the ability to view web pages" — you DO have page context provided below.
When the user asks about elements on the page, ALWAYS refer to the page context provided to you.
When referencing page elements, use their ref IDs (e.g., ref=b1, ref=i3).
You can suggest test actions like "click button ref=b1" or "type 'hello' into input ref=i2".
If the user asks to test something on the current page, prefer platform_test intent with the current URL.`;
  }

  // Enhance system prompt with old context summary from vector search
  const enhancedSystemPrompt = oldContextSummary
    ? `${systemPrompt}\n--- Previous Conversation Context ---\n${oldContextSummary}\n\nNote: The above is a summary of earlier messages. Recent messages follow below.`
    : systemPrompt;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: enhancedSystemPrompt },
  ];

  // Add agent memory (summaries of old conversations)
  if (agentMemory) {
    messages.push({
      role: 'system',
      content: `--- Agent Memory (Conversation History Summaries) ---\n${agentMemory}\n\nThis is a compressed summary of earlier conversations in this workspace chat.`,
    });
  }

  // Add workspace memory (persistent semantic memory)
  if (workspaceMemory) {
    messages.push({
      role: 'system',
      content: `--- Workspace Memory (Persistent Facts & Preferences) ---\n${workspaceMemory}\n\nThese are important facts, preferences, and patterns you've remembered about this workspace.`,
    });
  }

  // Add KB context if available (persistent background knowledge)
  if (kbContext) {
    messages.push({
      role: 'system',
      content: `--- Knowledge Base ---\n${kbContext}\nUse this documentation for accurate, product-specific answers.`,
    });
  }

  // Add editor page context if available
  if (editorPageContext) {
    messages.push({
      role: 'system',
      content: formatPageContextForChat(editorPageContext),
    });
  }

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
    hasAgentMemory: !!agentMemory,
    hasOldSummary: !!oldContextSummary,
    hasKBContext: !!kbContext,
    hasEditorContext: !!editorPageContext,
    isEditorMode: mode === 'editor',
    recentHistoryCount: conversationHistory.length,
  });

  // NOTE: Credit check removed here — already performed in chat.controller.ts
  // (Step 1.5) before any handler is invoked. No need to check twice.

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: AGENTIC TOOL-CALLING LOOP
  // ═══════════════════════════════════════════════════════════════════════
  const emitProcessingStepWithLogging = functionLogger
    ? withFunctionLogging(emitProcessingStep, 'emitProcessingStep', functionLogger)
    : emitProcessingStep;
  emitProcessingStepWithLogging(chatSessionId, 'generating_response', '💬 Thinking...', 90);

  let gptResponse: { content: string; usage?: any };
  let shouldDeductCredits = false;
  let requestCancelled = false;
  const MAX_TOOL_ROUNDS = 5; // Prevent infinite loops

  // Wrap AI calls with tracking context
  const executeAgenticLoop = async () => {
    // Begin AI usage tracking session (only if workspaceId exists)
    const trackingSessionId = workspaceId ? chatSessionId : null;
    if (trackingSessionId && workspaceId) {
      AIUsageTracker.beginSession(trackingSessionId, {
        workspaceId,
        userId,
        operationType: 'chat',
      });
    }

    try {
      let toolRound = 0;
      let finalResponse: string | null = null;

      // Agentic loop: keep calling OpenAI until no more tool calls
      while (toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;

      logger.info('[GENERAL_CHAT] Tool round', { round: toolRound, messagesCount: messages.length });

      const getChatCompletionWithMessagesWithLogging = functionLogger
        ? withFunctionLogging(getChatCompletionWithMessages, 'getChatCompletionWithMessages', functionLogger)
        : getChatCompletionWithMessages;

      // Call OpenAI with tools (if available)
      const response = await getChatCompletionWithMessagesWithLogging(messages, {
        temperature: 0.3,
        max_tokens: 2000,
        abortSignal,
        tools: availableTools.length > 0 ? availableTools : undefined,
        tool_choice: availableTools.length > 0 ? 'auto' : undefined,
      });

      // Check for tool calls
      const toolCalls = response.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls - this is the final text response
        finalResponse = response.content;
        break;
      }

      // Execute tool calls
      logger.info('[GENERAL_CHAT] Executing tool calls', {
        count: toolCalls.length,
        tools: toolCalls.map((tc) => tc.function.name),
      });

      // Add assistant message with tool calls to history
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: toolCalls,
      } as any);

      // Execute each tool call
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        logger.info('[GENERAL_CHAT] Executing tool', {
          toolName,
          args: JSON.stringify(toolArgs),
        });

        try {
          let toolResult: any;

          // Route to appropriate executor
          if (['remember_fact', 'search_memory', 'forget_fact'].includes(toolName)) {
            // Memory tools
            const { executeMemoryTool } = await import('@/services/ai/memory/memory-tools');
            toolResult = await executeMemoryTool(toolName, toolArgs, workspaceId!, userId);
          } else {
            // Skill tools
            const { SkillRegistry } = await import('@/services/skills');
            const skillContext = { userId, workspaceId: workspaceId!, chatSessionId };
            toolResult = await SkillRegistry.executeTool(toolName, toolArgs, skillContext);
          }

          // Add tool result to messages
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          } as any);

          logger.info('[GENERAL_CHAT] Tool executed', {
            toolName,
            success: toolResult.success,
          });
        } catch (toolError) {
          logger.error('[GENERAL_CHAT] Tool execution error', {
            toolName,
            error: toolError instanceof Error ? toolError.message : String(toolError),
          });

          // Add error result to messages
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              success: false,
              message: `Tool execution failed: ${toolError instanceof Error ? toolError.message : String(toolError)}`,
            }),
          } as any);
        }
      }

      // Continue loop to get next response from OpenAI
    }

    if (!finalResponse) {
      // Max rounds reached without final response
      finalResponse = "I've completed the requested actions. Is there anything else you'd like me to help with?";
      logger.warn('[GENERAL_CHAT] Max tool rounds reached', { rounds: MAX_TOOL_ROUNDS });
    }

    gptResponse = { content: finalResponse, usage: undefined };
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
      if (!res.headersSent) {
        res.status(499).json({
          success: false,
          error: 'Request was cancelled',
          message: 'The request was cancelled. Please try again.',
          timestamp: new Date().toISOString(),
        });
      }

      // Signal to outer handler that request was cancelled
      requestCancelled = true;
      return {
        gptResponse: { content: '', usage: undefined },
        shouldDeductCredits: false,
      };
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
    } finally {
      // End AI usage tracking session
      if (trackingSessionId) {
        const usageStats = await AIUsageTracker.endSession(trackingSessionId);
        if (usageStats) {
          logger.info('[GENERAL_CHAT] AI usage stats', {
            chatSessionId: trackingSessionId,
            workspaceId,
            ...usageStats,
          });
        }
      }
    }

    return { gptResponse, shouldDeductCredits };
  };

  // Execute agentic loop within AI tracking context
  if (workspaceId) {
    const agenticResult = await withAIContext(
      { workspaceId, userId, operationType: 'chat' },
      executeAgenticLoop
    );
    gptResponse = agenticResult.gptResponse;
    shouldDeductCredits = agenticResult.shouldDeductCredits;
  } else {
    const agenticResult = await executeAgenticLoop();
    gptResponse = agenticResult.gptResponse;
    shouldDeductCredits = agenticResult.shouldDeductCredits;
  }

  // If request was cancelled, stop all further processing (no message saving, no response)
  if (requestCancelled) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3.5: DEDUCT CREDITS AFTER SUCCESSFUL RESPONSE
  // ═══════════════════════════════════════════════════════════════════════
  // Deduct 1 credit for chat message (fixed cost per message)
  // Only deduct if we got a real OpenAI response (not fallback)

  if (shouldDeductCredits && gptResponse && gptResponse.content) {
    const deductChatCreditsWithLogging = functionLogger
      ? withFunctionLogging(deductChatCredits, 'deductChatCredits', functionLogger)
      : deductChatCredits;
    await deductChatCreditsWithLogging(userId, shouldDeductCredits);
  }

  if (abortSignal) {
    const checkRequestAbortedWithLogging = functionLogger
      ? withFunctionLogging(checkRequestAborted, 'checkRequestAborted', functionLogger)
      : checkRequestAborted;
    checkRequestAbortedWithLogging(abortSignal);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: SAVE MESSAGES
  // ═══════════════════════════════════════════════════════════════════════

  let userMessageTimestamp: string | undefined;
  let aiReplyTimestamp: string | undefined;

  if (chatSessionId) {
    const saveChatMessagesWithLogging = functionLogger
      ? withFunctionLogging(ChatService.saveChatMessages.bind(ChatService), 'ChatService.saveChatMessages', functionLogger)
      : ChatService.saveChatMessages.bind(ChatService);
    const timestamps = await saveChatMessagesWithLogging(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: gptResponse.content },
    ]);

    // Extract timestamps: first is user message, second is AI reply
    if (timestamps.length >= 2) {
      userMessageTimestamp = timestamps[0];
      aiReplyTimestamp = timestamps[1];
    }

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

    // ═══════════════════════════════════════════════════════════════════════
    // AUTO-SUMMARIZE OLD MESSAGES (AFTER SAVING - "Agent Memory")
    // ═══════════════════════════════════════════════════════════════════════
    // If total messages exceed threshold, summarize oldest batch in background.
    // Fire-and-forget — doesn't block the response.
    if (totalMessagesNow > CONSTANTS.SUMMARIZE_THRESHOLD) {
      logger.info('[GENERAL_CHAT] Triggering auto-summarization (background)', {
        sessionId: chatSessionId,
        totalMessages: totalMessagesNow,
      });
      // summarizeOldMessages() already does threshold check internally, no need to call shouldSummarize()
      summarizeOldMessages(chatSessionId).catch(error => {
        logger.warn('[GENERAL_CHAT] Background summarization failed', {
          error: error instanceof Error ? error.message : String(error),
          sessionId: chatSessionId,
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
    timestamp: aiReplyTimestamp || new Date().toISOString(), // Use saved timestamp or fallback
    userMessageTimestamp: userMessageTimestamp, // Include user message timestamp
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
