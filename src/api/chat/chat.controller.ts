import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';

// New services
import { CredentialsParserService } from '@/services/api/credentials-parser.service';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ApiTestPlanService } from '@/services/testing/api-test-plan.service';
import { TestChatMappingService } from '@/services/testing/test-chat-mapping.service';
import { TestCompletionHandlerService } from '@/services/testing/test-completion-handler.service';
import { ProjectContextService } from '@/services/utils/project-context.service';

// Existing services
import { detectUserApproval } from '@/services/ai/ai-helpers.service';
import { parseUserIntent } from '@/services/ai/intentParser.service';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { extractUrlFromMessage } from '@/services/kb/context-enrichment.service';
import { searchKB } from '@/services/kb/kb.service';
import { executeApiTest } from '@/services/testing/apiTest.service';
import { confirmAndExecuteTestPlan, requestMissingInformation, runAutonomousExploration } from '@/services/testing/autonomous-orchestrator.service';
import { getTestPlan, saveTestPlan } from '@/services/testing/exploration-cache.service';
import { ManualTestService } from '@/services/testing/manualTest.service';
import { ChatService } from '@/services/utils/chat.service';

// Types
import { ChatProcessingStepPayload, ChatTestUpdatePayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';
import { ChatRequest } from './chat.types';

// Prompts
import { buildChatSystemPrompt } from '@/ai/prompts';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAIN CHAT HANDLER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NEW SIMPLIFIED ARCHITECTURE:
 * 1. Workspace check (mandatory)
 * 2. Parse intent (3 types: platform_test, api_test, general_chat)
 * 3. Route to appropriate handler
 * 4. All tests require test plan approval
 */
export const handleChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, context, sessionId, conversationId, answers } = req.body as ChatRequest;
    const userId = req.user!.id;

    logger.info('[CHAT] Request received', {
      userId,
      messageLength: message.length,
      hasSession: !!sessionId,
      hasConversation: !!conversationId,
      hasAnswers: !!answers,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: WORKSPACE CHECK (MANDATORY!)
    // ═══════════════════════════════════════════════════════════════════════

    const { workspace_id, is_new: isNewWorkspace } = await WorkspaceService.checkOrCreateWorkspace(userId);

    if (isNewWorkspace) {
      logger.info('[CHAT] Created new workspace', { userId, workspace_id });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: CHAT SESSION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    let chatSessionId = await getOrCreateChatSession(userId, sessionId, workspace_id);

    // Emit: Enriching context
    if (chatSessionId) {
      emitProcessingStep(chatSessionId, 'enriching_context', '🔍 Analyzing your request...', 10);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: CHECK FOR PENDING TEST PLAN APPROVAL (MUST BE FIRST!)
    // ═══════════════════════════════════════════════════════════════════════

    // IMPORTANT: Check test plan approval BEFORE parsing intent!
    // If user is responding to test plan, we don't want to parse their "yes" as a new intent
    if (conversationId) {
      const pendingPlan = await getTestPlan(conversationId, userId);

      if (pendingPlan && pendingPlan.status === 'pending_confirmation') {
        // User is responding to test plan - detect approval/rejection
        logger.info('[CHAT] Found pending test plan, checking for approval/rejection', {
          planId: pendingPlan.id,
        });

        const approvalResult = await detectUserApproval(message);

        logger.info('[CHAT] Test plan response detected', {
          planId: pendingPlan.id,
          approved: approvalResult.approved,
          confidence: approvalResult.confidence,
        });

        if (approvalResult.confidence < 0.5) {
          // Unclear response - save to history
          const clarificationMessage = '❓ I didn\'t quite understand. Could you please clarify?\n\n✅ Approve and run the test?\n❌ Cancel?';

          if (chatSessionId) {
            await ChatService.saveChatMessages(chatSessionId, [
              { role: 'user', content: message },
              { role: 'ai', content: clarificationMessage },
            ]);
          }

          res.json({
            reply: clarificationMessage,
            timestamp: new Date().toISOString(),
            sessionId: chatSessionId,
          });
          return;
        }

        if (approvalResult.approved === true) {
          // APPROVED - execute test
          return await executeApprovedTestPlan(req, res, {
            planId: pendingPlan.id,
              userId,
            chatSessionId,
            workspace_id,
          });
        } else if (approvalResult.approved === false) {
          // REJECTED - save to history
          logger.info('[CHAT] Test plan rejected', { planId: pendingPlan.id });

          const rejectionMessage = '❌ Test plan canceled. Feel free to request a different test or ask any questions!';

          if (chatSessionId) {
            await ChatService.saveChatMessages(chatSessionId, [
              { role: 'user', content: message },
              { role: 'ai', content: rejectionMessage },
            ]);
          }

          res.json({
            reply: rejectionMessage,
            timestamp: new Date().toISOString(),
            sessionId: chatSessionId,
          });
          return;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: PARSE INTENT (Only if not responding to test plan)
    // ═══════════════════════════════════════════════════════════════════════

    emitProcessingStep(chatSessionId, 'parsing_intent', '🧠 Understanding what you need...', 20);

    // Parse intent with RAG fallback support
    // Pass workspace_id as projectId for now (can be refined later to actual projectId)
    const parsedIntent = await parseUserIntent(message, undefined, workspace_id);
    const intent = parsedIntent?.intent || 'general_chat';

    logger.info('[CHAT] Intent parsed', {
      intent,
      scope: parsedIntent?.scope,
      target: parsedIntent?.target,
      hasUrl: !!parsedIntent?.page,
      confidence: parsedIntent?.confidence,
      usedRAG: parsedIntent?.metadata?.usedRAG,
      intentChanged: parsedIntent?.metadata?.intentChanged,
      ragChunksCount: parsedIntent?.metadata?.ragChunksCount,
      originalIntent: parsedIntent?.metadata?.originalIntent,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: ROUTE TO APPROPRIATE HANDLER BASED ON INTENT
    // ═══════════════════════════════════════════════════════════════════════

    if (intent === 'platform_test') {
      return await handlePlatformTest(req, res, {
        message,
        parsedIntent,
        userId,
        workspace_id,
        chatSessionId,
        conversationId,
        answers,
      });
    }

    if (intent === 'api_test') {
      return await handleApiTest(req, res, {
        message,
        parsedIntent,
        userId,
        workspace_id,
        chatSessionId,
        conversationId,
        answers,
      });
    }

    // general_chat
    return await handleGeneralChat(req, res, {
      message,
      userId,
      chatSessionId,
      context,
    });

  } catch (error) {
    logger.error('[CHAT] Error handling chat request', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to process chat request',
      message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
  }
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: PLATFORM TEST (UI Testing)
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function handlePlatformTest(
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
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers } = params;

  logger.info('[PLATFORM_TEST] Starting UI test flow', {
    scope: parsedIntent?.scope,
    target: parsedIntent?.target,
    hasUrl: !!parsedIntent?.page,
  });

  emitProcessingStep(chatSessionId, 'checking_autonomous', '🤖 Preparing autonomous exploration...', 30);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 0: LOAD CHAT SESSION CONTEXT (project if exists)
  // ═══════════════════════════════════════════════════════════════════════

  let sessionProject = null;
  if (chatSessionId) {
    const sessionData = await ChatService.getSessionWithProject(chatSessionId);
    sessionProject = sessionData?.project;

    if (sessionProject?.settings?.main_url) {
      logger.info('[PLATFORM_TEST] Found project in session', {
        projectId: sessionProject.id,
        projectName: sessionProject.name,
        projectUrl: sessionProject.settings.main_url,
      });
    }
  }

  // Load all user projects for selection
  const { data: userProjects } = await supabaseAdmin
    .from('projects')
    .select('id, name, settings')
    .eq('user_id', userId)
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
    .limit(10);

  logger.info('[PLATFORM_TEST] Loaded user projects', {
    projectCount: userProjects?.length || 0,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: CHECK IF WE HAVE ALL NEEDED INFO
  // ═══════════════════════════════════════════════════════════════════════

  // If session has project, use its URL as default
  const extractedUrl = parsedIntent?.page || extractUrlFromMessage(message) || sessionProject?.settings?.main_url;
  const hasUrl = !!extractedUrl;
  const hasScope = !!parsedIntent?.scope;

  // If missing info, ask questions (WITH user projects context)
  if (!hasUrl || !hasScope) {
    logger.info('[PLATFORM_TEST] Missing information', { hasUrl, hasScope });

    const result = await requestMissingInformation(message, {
      hasUrl,
      hasScope,
      intent: 'platform_test',
      userProjects: userProjects || [],
    });

    // Save chat messages to history
    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        {
          role: 'ai',
          content: '📝 I need some more information to set up the test:',
          metadata: {
            questions: result.questions,
            conversationId: result.conversationId,
            requiresAnswers: true,
          },
        },
      ]);
    }

      res.json({
      reply: '📝 I need some more information to set up the test:',
      questions: result.questions,
      conversationId: result.conversationId,
        timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
      });
      return;
    }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: FIND OR CREATE PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  const { project_id, is_new: isNewProject } = await ProjectContextService.findOrCreateProject(
    workspace_id,
    extractedUrl,
    userId
  );

  if (isNewProject) {
    logger.info('[PLATFORM_TEST] Created new project', { project_id, url: extractedUrl });
  }

  // Update chat session with project_id (so next time we remember it)
  if (chatSessionId && project_id) {
    await ChatService.updateSessionProject(chatSessionId, project_id);
    logger.info('[PLATFORM_TEST] Updated chat session with project', {
      chatSessionId,
      project_id,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: CHECK FOR SAVED CREDENTIALS
  // ═══════════════════════════════════════════════════════════════════════

  const savedCredentials = await ProjectContextService.getProjectCredentials(project_id, userId);

  if (savedCredentials) {
    logger.info('[PLATFORM_TEST] Found saved credentials', { project_id });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: IF HAVE ANSWERS, RUN AUTONOMOUS EXPLORATION
  // ═══════════════════════════════════════════════════════════════════════

  if (answers && conversationId) {
    logger.info('[PLATFORM_TEST] Running autonomous exploration with answers', {
        conversationId,
        answerCount: Object.keys(answers).length,
    });

    emitProcessingStep(chatSessionId, 'exploring_site', '🌐 Launching browser and exploring...', 50);

    try {
      // Parse credentials if provided in answers
      if (answers.credentials) {
        try {
          const parsedCreds = CredentialsParserService.parseNaturalCredentials(
            typeof answers.credentials === 'string' ? answers.credentials : JSON.stringify(answers.credentials)
          );

          // Save credentials for future use
          await ProjectContextService.saveProjectCredentials(
            project_id,
            userId,
            parsedCreds,
            'Auto-saved from chat'
          );

          logger.info('[PLATFORM_TEST] Parsed and saved credentials', { project_id });
        } catch (error) {
          logger.warn('[PLATFORM_TEST] Failed to parse credentials', { error });
        }
      }

        const explorationResult = await runAutonomousExploration({
          userMessage: message,
          answers,
        userId,
        projectId: project_id,
          sessionId: chatSessionId,
        });

      // Save chat messages
      if (chatSessionId) {
        await ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: message },
          {
            role: 'ai',
            content: explorationResult.message,
            metadata: {
              testPlan: explorationResult.testPlan,
              exploration: {
                url: explorationResult.exploration.url,
                timestamp: explorationResult.exploration.timestamp,
              },
            },
          },
        ]);
      }

        res.json({
          reply: explorationResult.message,
          testPlan: explorationResult.testPlan,
          conversationId,
          timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
        });
        return;
      } catch (error) {
      logger.error('[PLATFORM_TEST] Autonomous exploration failed', { error });

        res.status(500).json({
          success: false,
        error: 'Failed to explore platform',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: NO ANSWERS YET - GENERATE QUESTIONS
  // ═══════════════════════════════════════════════════════════════════════

  logger.info('[PLATFORM_TEST] Generating clarifying questions');

  const result = await requestMissingInformation(message, {
    hasUrl: true,
    hasScope: !!parsedIntent?.scope,
    hasCredentials: !!savedCredentials,
    intent: 'platform_test',
  });

  // Save chat messages to history
  if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      {
        role: 'ai',
        content: '📋 Let me gather some details to set up the perfect test:',
        metadata: {
          questions: result.questions,
          conversationId: result.conversationId,
          requiresAnswers: true,
        },
      },
    ]);
  }

  res.json({
    reply: '📋 Let me gather some details to set up the perfect test:',
    questions: result.questions,
    conversationId: result.conversationId,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: API TEST
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function handleApiTest(
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
  }
): Promise<void> {
  const { message, parsedIntent, userId, workspace_id, chatSessionId, conversationId, answers } = params;

  logger.info('[API_TEST] Starting API test flow', {
    method: parsedIntent?.apiMethod,
    url: parsedIntent?.apiUrl,
  });

  emitProcessingStep(chatSessionId, 'checking_autonomous', '🔍 Analyzing API request...', 30);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: VALIDATE API INFO
  // ═══════════════════════════════════════════════════════════════════════

  if (!parsedIntent?.apiMethod || !parsedIntent?.apiUrl) {
    const errorMessage = '❌ I need more details for the API test.\n\nPlease specify:\n• HTTP Method (GET, POST, etc.)\n• API URL\n\nExample: "Test GET request to https://api.example.com/users"';

    // Save to history
    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: message },
        { role: 'ai', content: errorMessage },
      ]);
    }

          res.json({
      reply: errorMessage,
            timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
          });
          return;
        }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: FIND OR CREATE PROJECT
  // ═══════════════════════════════════════════════════════════════════════

  const { project_id } = await ProjectContextService.findOrCreateProject(
    workspace_id,
    parsedIntent.apiUrl,
    userId
  );

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: GENERATE API TEST PLAN
  // ═══════════════════════════════════════════════════════════════════════

  emitProcessingStep(chatSessionId, 'generating_plan', '📋 Creating test plan...', 60);

  const apiTestPlan = await ApiTestPlanService.generateApiTestPlan({
              method: parsedIntent.apiMethod,
              url: parsedIntent.apiUrl,
                body: parsedIntent.apiBody,
    headers: parsedIntent.apiHeaders,
    userMessage: message,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: CONVERT API TEST PLAN TO UNIFIED TEST PLAN FORMAT
  // ═══════════════════════════════════════════════════════════════════════

  // Convert ApiTestPlan to TestPlan for storage and execution
  const testPlan = convertApiTestPlanToTestPlan(apiTestPlan);

  // Save test plan to database for approval tracking
  await saveTestPlan(testPlan, userId, project_id);

  logger.info('[API_TEST] Test plan saved', { planId: testPlan.id });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: SHOW TEST PLAN TO USER FOR APPROVAL
  // ═══════════════════════════════════════════════════════════════════════

  const formattedPlan = ApiTestPlanService.formatApiTestPlanForConfirmation(apiTestPlan);

  // Save chat messages
  if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      {
        role: 'ai',
        content: formattedPlan,
        metadata: {
          testPlan: apiTestPlan,
          requiresApproval: true,
        },
      },
    ]);
  }

  res.json({
    reply: formattedPlan,
    testPlan: apiTestPlan,
    conversationId: testPlan.id, // Use this to track approval
    requiresApproval: true,
    timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HANDLER: GENERAL CHAT
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function handleGeneralChat(
  req: Request,
  res: Response,
  params: {
    message: string;
    userId: string;
    chatSessionId?: string;
    context?: any;
  }
): Promise<void> {
  const { message, userId, chatSessionId, context } = params;

  logger.info('[GENERAL_CHAT] Handling general conversation', {
    hasSession: !!chatSessionId,
    messageLength: message.length
  });

  emitProcessingStep(chatSessionId, 'generating_response', '💬 Thinking...', 90);

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 1: BUILD CONTEXT WITH HISTORY
  // ═══════════════════════════════════════════════════════════════════════

  let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let oldContextSummary = '';

  if (chatSessionId) {
    // Get total message count first
    const { count: totalMessageCount, error: countError } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', chatSessionId);

    if (countError) {
      logger.error('[GENERAL_CHAT] Failed to count messages', { error: countError });
    }

    const totalMessages = totalMessageCount || 0;

    logger.info('[GENERAL_CHAT] Message count', {
      sessionId: chatSessionId,
      totalMessages
    });

    // Get recent messages (last 20)
    const recentMessages = await getRecentChatHistory(chatSessionId, 20);

    logger.info('[GENERAL_CHAT] Retrieved recent history', {
      messageCount: recentMessages.length
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SMART SUMMARIZATION WITH CACHING
    // ═══════════════════════════════════════════════════════════════════════

    if (totalMessages > 20) {
      logger.info('[GENERAL_CHAT] Chat has old messages, checking cache');

      // Try to get cached summary
      const cachedSummary = await getCachedSummary(chatSessionId);

      if (cachedSummary) {
        const messagesNeedingSummarization = totalMessages - 20;
        const alreadySummarized = cachedSummary.summarizedUpTo;

        // Check if cache is still valid (no new old messages since last summary)
        if (alreadySummarized >= messagesNeedingSummarization) {
          // Cache is valid!
          oldContextSummary = cachedSummary.summary;
          logger.info('[GENERAL_CHAT] Using cached summary', {
            cachedUpTo: alreadySummarized,
            currentOldCount: messagesNeedingSummarization,
            cacheValid: true,
          });
    } else {
          // Cache is outdated, need to re-summarize
          logger.info('[GENERAL_CHAT] Cache outdated, re-summarizing', {
            cachedUpTo: alreadySummarized,
            currentOldCount: messagesNeedingSummarization,
            newMessages: messagesNeedingSummarization - alreadySummarized,
          });

          const oldMessages = await getOldMessages(chatSessionId, 20);
          oldContextSummary = await summarizeOldMessages(oldMessages);

          if (oldContextSummary) {
            // Save new summary to cache
            await saveSummaryToCache(chatSessionId, oldContextSummary, messagesNeedingSummarization);
          }
        }
      } else {
        // No cache, create fresh summary
        logger.info('[GENERAL_CHAT] No cache found, creating fresh summary');

        const oldMessages = await getOldMessages(chatSessionId, 20);
        oldContextSummary = await summarizeOldMessages(oldMessages);

        if (oldContextSummary) {
          const messagesNeedingSummarization = totalMessages - 20;
          // Save to cache for future use
          await saveSummaryToCache(chatSessionId, oldContextSummary, messagesNeedingSummarization);
        }
      }
    }

    // Build conversation history with compressed content
    conversationHistory = recentMessages.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: compressMessageContent(msg.content),
    })) as Array<{ role: 'user' | 'assistant'; content: string }>;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 2: SEARCH GLOBAL KB FOR GENERAL CHAT
  // ═══════════════════════════════════════════════════════════════════════

      let kbContext = '';

  // For general_chat ALWAYS search in Global KB
  try {
    logger.info('[GENERAL_CHAT] Searching Global KB for context', { message: message.substring(0, 100) });

    const kbResults = await searchKB(message, undefined, {
      matchCount: 3,
      matchThreshold: 0.6, // Slightly higher than for intent parsing
          });

          if (kbResults.chunks.length > 0) {
      kbContext = kbResults.chunks
        .map(chunk => chunk.content)
        .join('\n\n');

      logger.info('[GENERAL_CHAT] Found KB context', {
        chunksCount: kbResults.chunks.length,
        sources: kbResults.sources.global,
        contextLength: kbContext.length,
      });
    } else {
      logger.info('[GENERAL_CHAT] No relevant KB context found');
    }
  } catch (error) {
    logger.warn('[GENERAL_CHAT] KB search failed', { error });
          // Continue without KB context
        }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: BUILD MESSAGES ARRAY FOR OPENAI
  // ═══════════════════════════════════════════════════════════════════════

  const systemPrompt = buildChatSystemPrompt();

  // Enhance system prompt with old context summary
  const enhancedSystemPrompt = oldContextSummary
    ? `${systemPrompt}\n\n--- Previous Conversation Context ---\n${oldContextSummary}\n\nNote: The above is a summary of earlier messages. Recent messages follow below.`
    : systemPrompt;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: enhancedSystemPrompt },
  ];

  // Add Global KB context (ALWAYS for general_chat)
  if (kbContext) {
    messages.push({
      role: 'system',
      content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📚 RELEVANT KNOWLEDGE FROM KNOWLEDGE BASE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${kbContext}

Use this knowledge to provide more accurate and helpful responses.`,
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
    hasOldSummary: !!oldContextSummary,
    recentHistoryCount: conversationHistory.length,
    hasKbContext: !!kbContext,
    kbContextLength: kbContext.length,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 3: GET AI RESPONSE
  // ═══════════════════════════════════════════════════════════════════════

  const gptResponse = await getChatCompletionWithMessages(messages, {
    temperature: 0.5,
    max_tokens: 1000,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 4: SAVE MESSAGES
  // ═══════════════════════════════════════════════════════════════════════

    if (chatSessionId) {
    await ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: message },
      { role: 'ai', content: gptResponse.content },
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP 5: RESPOND (NO CREDIT DEDUCTION FOR CHAT!)
  // ═══════════════════════════════════════════════════════════════════════
  // IMPORTANT: Chat messages are FREE
  // Credits are only deducted for TESTS (intelligent, standard, api)

  const response: any = {
    reply: gptResponse.content,
            timestamp: new Date().toISOString(),
    sessionId: chatSessionId,
  };

  // Show user's current credit balance (but don't deduct)
  if (userId && userId !== 'anonymous') {
    try {
      const isValidUUID = userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      if (isValidUUID) {
        const credits = await UserCreditsService.getUserCredits(userId);
        response.creditsRemaining = credits?.credits_balance || 0;
        response.chatIsFree = true; // Indicate that chat is free
      }
    } catch (error) {
      logger.warn('[GENERAL_CHAT] Failed to get credits', { error, userId });
    }
  }

  res.json(response);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: EXECUTE APPROVED TEST PLAN
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function executeApprovedTestPlan(
  req: Request,
  res: Response,
  params: {
    planId: string;
    userId: string;
    chatSessionId?: string;
    workspace_id: string;
  }
): Promise<void> {
  const { planId, userId, chatSessionId, workspace_id } = params;

  logger.info('[EXECUTE] Test plan approved', { planId, userId });

  try {
    // Get the test plan
    const plan = await getTestPlan(planId, userId);

    if (!plan) {
      res.status(404).json({
        success: false,
        error: 'Test plan not found or expired',
            timestamp: new Date().toISOString(),
      });
      return;
    }

    // Determine test type
    const isApiTest = plan.scope === 'api_test' || ((plan as any).metadata && (plan as any).metadata.type === 'api_test');
    const testType = isApiTest ? 'api' : (plan.intelligentMode ? 'intelligent' : 'standard');

    // ═══════════════════════════════════════════════════════════════════════
    // CHECK CREDITS BEFORE RUNNING TEST
    // ═══════════════════════════════════════════════════════════════════════

    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, testType);

    if (!creditCheck.hasEnough) {
      logger.warn('[EXECUTE] Insufficient credits for test', {
        userId,
        testType,
        required: creditCheck.required,
        available: creditCheck.available,
        shortage: creditCheck.shortage,
      });

      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        message: `You need ${creditCheck.required} credits to run this test. You have ${creditCheck.available} credits. Please purchase ${creditCheck.shortage} more credits.`,
        required: creditCheck.required,
        available: creditCheck.available,
        shortage: creditCheck.shortage,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[EXECUTE] Credit check passed', {
      userId,
      testType,
      required: creditCheck.required,
      available: creditCheck.available,
    });

    if (isApiTest) {
      // Execute API test
      emitProcessingStep(chatSessionId, 'executing_test', '🌐 Executing API request...', 70);

      // Confirm plan first
      await confirmAndExecuteTestPlan(planId, userId);

      // Extract API test details from metadata
      const apiDetails = (plan as any).metadata || {};

      const apiTestResult = await executeApiTest({
        method: apiDetails.method || 'GET',
        url: plan.url,
        body: apiDetails.body,
        headers: apiDetails.headers || {},
        expectedStatus: apiDetails.expectedStatus || 200,
      });

      // Generate a unique test ID for API test tracking
      const apiTestId = `api_${planId}_${Date.now()}`;

      // Save test-chat mapping for API test notifications
      if (chatSessionId && userId) {
        await TestChatMappingService.saveTestChatMapping({
          testId: apiTestId,
          chatSessionId,
          userId,
        });
        logger.info('[API_TEST] Test-chat mapping saved', {
          testId: apiTestId,
          chatSessionId,
          userId,
        });
      }

      // ═════════════════════════════════════════════════════════════════════
      // DEDUCT CREDITS FOR API TEST
      // ═════════════════════════════════════════════════════════════════════

      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: 'api',
        credits: TokenCalculatorService.getTestCreditCost('api'),
        costUSD: 0.0011, // Estimated API test cost
        testId: apiTestId,
        description: `API test: ${apiDetails.method} ${plan.url}`,
      });

      logger.info('[API_TEST] Credits deducted', {
              userId,
        testId: apiTestId,
        credits: TokenCalculatorService.getTestCreditCost('api'),
      });

      // Notify completion via TestCompletionHandlerService
      await TestCompletionHandlerService.handleTestCompletion(apiTestId);

      // Save chat messages
    if (chatSessionId) {
        await ChatService.saveChatMessages(chatSessionId, [
          { role: 'user', content: `Approved API test: ${apiDetails.method} ${plan.url}` },
          {
            role: 'ai',
            content: `✅ API test executed!\n\n**Result:**\n- Status: ${(apiTestResult as any).response?.status || 'N/A'}\n- Success: ${apiTestResult.success ? 'Yes' : 'No'}\n\n${(apiTestResult as any).message || 'Test completed'}`,
          metadata: {
              testResult: apiTestResult,
              testId: apiTestId,
              testType: 'api',
            },
          },
        ]);
      }

      res.json({
        reply: `✅ API test executed successfully!\n\n**Status Code:** ${(apiTestResult as any).response?.status || 'N/A'}\n**Success:** ${apiTestResult.success ? 'Yes' : 'No'}\n\n${(apiTestResult as any).message || 'Test completed'}`,
        testResult: apiTestResult,
        testId: apiTestId,
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
    } else {
      // Execute UI test
      emitProcessingStep(chatSessionId, 'executing_test', '⚙️ Launching browser tests...', 70);

      logger.info('🔵 [EXECUTE_FLOW] Step 1: Starting UI test execution', { planId, userId });

      // Confirm and execute test plan
      logger.info('🔵 [EXECUTE_FLOW] Step 2: Confirming test plan');
      const result = await confirmAndExecuteTestPlan(planId, userId);
      logger.info('🔵 [EXECUTE_FLOW] Step 3: Test plan confirmed', { success: result.success });

      if (result.success && plan) {
        // Get project for this test
        logger.info('🔵 [EXECUTE_FLOW] Step 4: Finding/creating project');
        const { project_id } = await ProjectContextService.findOrCreateProject(
          workspace_id,
          plan.url,
          userId
        );
        logger.info('🔵 [EXECUTE_FLOW] Step 5: Project ready', { project_id });

        // Execute test
        const testRequest = {
          url: plan.url,
          browsers: ['chrome' as const],
          projectId: project_id,
          userId,
          options: {},
          commands: plan.commands,
          intent: plan.scope,
          // NEW: Pass intelligent mode if plan has it
          intelligentMode: plan.intelligentMode,
          testGoal: plan.intelligentMode ? plan.summary : undefined,
        };

        logger.info('🔵 [EXECUTE_FLOW] Step 6: Calling ManualTestService.runTest', {
          planId: plan.id,
          intelligentMode: plan.intelligentMode || false,
          url: plan.url,
          scope: plan.scope,
          commandsCount: plan.commands?.length || 0,
        });

        const testCreated = await ManualTestService.runTest(testRequest);

        logger.info('🔵 [EXECUTE_FLOW] Step 7: Test created', {
          testId: testCreated.data?.id,
          success: testCreated.success
        });

        // ═══════════════════════════════════════════════════════════════════
        // DEDUCT CREDITS FOR UI TEST
        // ═══════════════════════════════════════════════════════════════════

        if (testCreated.data?.id) {
          const uiTestType = plan.intelligentMode ? 'intelligent' : 'standard';

          await CreditCostTrackerService.deductCreditsForTest({
            userId,
            testType: uiTestType,
            credits: TokenCalculatorService.getTestCreditCost(uiTestType),
            costUSD: uiTestType === 'intelligent' ? 0.08 : 0.001, // Estimated costs
            testId: testCreated.data.id,
            description: `${uiTestType} UI test: ${plan.url}`,
          });

          logger.info('[UI_TEST] Credits deducted', {
            userId,
            testId: testCreated.data.id,
            testType: uiTestType,
            credits: TokenCalculatorService.getTestCreditCost(uiTestType),
          });
        }

        // Save test-chat mapping for result notifications
        if (chatSessionId && testCreated.data?.id && userId) {
          await TestChatMappingService.saveTestChatMapping({
            testId: testCreated.data.id,
            chatSessionId,
            userId,
          });
          logger.info('[CHAT] Test-chat mapping saved', {
            testId: testCreated.data.id,
            chatSessionId,
            userId,
          });
        }

        // Emit WebSocket event
        if (chatSessionId && testCreated.data?.id) {
          const testModeMessage = plan.intelligentMode
            ? '🤖 Intelligent test started! AI will autonomously explore and adapt to your site.'
            : '✅ Test started! Monitor progress in real-time.';

          const chatTestUpdatePayload: ChatTestUpdatePayload = {
          sessionId: chatSessionId,
            testId: testCreated.data.id,
            message: testModeMessage,
            status: 'created',
            links: {
              fullReport: `/api/v1/manual-test/${testCreated.data.id}/summary`,
            },
          timestamp: new Date().toISOString(),
        };
          webSocketService.emitChatTestUpdate(chatSessionId, chatTestUpdatePayload);
        }

        const testModeInfo = plan.intelligentMode
          ? `\n\n🤖 **Mode:** Intelligent/Adaptive Testing\n📊 **Estimated:** ${plan.estimatedPages || '5-10 pages'}, ${plan.estimatedCost || '$0.10-0.20'}`
          : '';

        const successMessage = `✅ Test plan approved and running!${testModeInfo}\n\nTest ID: ${testCreated.data?.id}\n\nCheck status: GET /api/v1/manual-test/${testCreated.data?.id}/status`;

        // Save to chat history
        if (chatSessionId) {
          await ChatService.saveChatMessages(chatSessionId, [
            { role: 'user', content: 'yes' }, // User approved the test
            {
              role: 'ai',
              content: successMessage,
              metadata: {
                testId: testCreated.data?.id,
                testMode: plan.intelligentMode ? 'intelligent' : 'standard',
              },
            },
          ]);
        }

        res.json({
          reply: successMessage,
          testId: testCreated.data?.id,
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
      } else {
        const failureMessage = result.message || '❌ Failed to execute test plan';

        // Save to chat history
        if (chatSessionId) {
          await ChatService.saveChatMessages(chatSessionId, [
            { role: 'user', content: 'yes' }, // User approved but execution failed
            { role: 'ai', content: failureMessage },
          ]);
        }

        res.json({
          reply: failureMessage,
          timestamp: new Date().toISOString(),
          sessionId: chatSessionId,
        });
      }
    }
  } catch (error) {
    logger.error('[EXECUTE] Error executing test plan', { error, planId });

    res.status(500).json({
      success: false,
      error: 'Failed to execute test plan',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: CHAT HISTORY & CONTEXT
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Get recent chat history for context
 * Returns last N messages in chronological order
 */
async function getRecentChatHistory(
  sessionId: string,
  limit: number = 20
): Promise<Array<{ role: 'user' | 'ai'; content: string; created_at: string }>> {
  try {
    const { data: messages, error } = await supabaseAdmin
        .from('chat_messages')
      .select('role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      logger.error('[CHAT_HISTORY] Error fetching history', { error, sessionId });
      return [];
    }

    // Reverse to get chronological order (oldest first)
    return (messages || []).reverse();
  } catch (error) {
    logger.error('[CHAT_HISTORY] Failed to fetch history', { error, sessionId });
    return [];
  }
}

/**
 * Get count of old messages (older than recent history)
 */
async function getOldMessagesCount(
  sessionId: string,
  recentLimit: number = 20
): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (error) {
      logger.error('[CHAT_HISTORY] Error counting old messages', { error });
      return 0;
    }

    const oldCount = (count || 0) - recentLimit;
    return oldCount > 0 ? oldCount : 0;
  } catch (error) {
    logger.error('[CHAT_HISTORY] Failed to count old messages', { error });
    return 0;
  }
}

/**
 * Get old messages for summarization
 */
async function getOldMessages(
  sessionId: string,
  recentLimit: number = 20
): Promise<Array<{ role: 'user' | 'ai'; content: string }>> {
  try {
    const { data: messages, error } = await supabaseAdmin
      .from('chat_messages')
      .select('role, content, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true }); // Get all in order

    if (error || !messages) {
      return [];
    }

    // Skip the last recentLimit messages
    const oldMessages = messages.slice(0, -recentLimit);
    return oldMessages.length > 0 ? oldMessages : [];
  } catch (error) {
    logger.error('[CHAT_HISTORY] Failed to fetch old messages', { error });
    return [];
  }
}

/**
 * Get cached summary from chat_sessions.context
 */
async function getCachedSummary(
  sessionId: string
): Promise<{ summary: string; summarizedUpTo: number } | null> {
  try {
    const { data: session, error } = await supabaseAdmin
      .from('chat_sessions')
      .select('context')
      .eq('id', sessionId)
      .maybeSingle();

    if (error || !session?.context) {
      return null;
    }

    const context = session.context as any;

    if (context.context_summary && context.summarized_up_to_message) {
      logger.info('[CHAT_CACHE] Found cached summary', {
        sessionId,
        summarizedUpTo: context.summarized_up_to_message,
        summaryLength: context.context_summary.length,
      });

      return {
        summary: context.context_summary,
        summarizedUpTo: context.summarized_up_to_message,
      };
    }

    return null;
  } catch (error) {
    logger.error('[CHAT_CACHE] Failed to get cached summary', { error, sessionId });
    return null;
  }
}

/**
 * Save summary to chat_sessions.context
 * Preserves existing context data and only updates summary fields
 */
async function saveSummaryToCache(
  sessionId: string,
  summary: string,
  summarizedUpTo: number
): Promise<void> {
  try {
    // Get current context to preserve existing data
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('context')
      .eq('id', sessionId)
      .maybeSingle();

    const existingContext = (session?.context as any) || {};

    // Update only summary-related fields
    const updatedContext = {
      ...existingContext,
      context_summary: summary,
      summarized_up_to_message: summarizedUpTo,
      last_summary_update: new Date().toISOString(),
    };

    const { error } = await supabaseAdmin
      .from('chat_sessions')
      .update({ context: updatedContext })
      .eq('id', sessionId);

    if (error) {
      logger.error('[CHAT_CACHE] Failed to save summary to cache', { error, sessionId });
    } else {
      logger.info('[CHAT_CACHE] Summary saved to cache', {
        sessionId,
        summarizedUpTo,
        summaryLength: summary.length,
      });
    }
  } catch (error) {
    logger.error('[CHAT_CACHE] Failed to save summary to cache', { error, sessionId });
  }
}

/**
 * Summarize old messages using AI
 */
async function summarizeOldMessages(
  oldMessages: Array<{ role: 'user' | 'ai'; content: string }>
): Promise<string> {
  if (oldMessages.length === 0) {
    return '';
  }

  try {
    logger.info('[CHAT_SUMMARY] Summarizing old messages', { count: oldMessages.length });

    // Build conversation text
    const conversationText = oldMessages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');

    // Use gpt-3.5-turbo for fast and cheap summarization
    const summaryPrompt = `Summarize the following conversation in a concise way, extracting key facts, URLs, decisions, and context. Focus on information that would be useful for continuing the conversation.

Conversation:
${conversationText}

Provide a brief summary (max 200 words) in the same language as the conversation:`;

    const summary = await getChatCompletionWithMessages(
      [
        {
          role: 'system',
          content: 'You are a helpful assistant that summarizes conversations concisely.',
        },
        {
          role: 'user',
          content: summaryPrompt,
        },
      ],
      {
        model: 'gpt-3.5-turbo',
        temperature: 0.3,
        max_tokens: 500,
      }
    );

    logger.info('[CHAT_SUMMARY] Summary created', {
      originalLength: conversationText.length,
      summaryLength: summary.content.length
    });

    return summary.content;
  } catch (error) {
    logger.error('[CHAT_SUMMARY] Failed to summarize', { error });
    return ''; // Fail gracefully
  }
}

/**
 * Compress long test plans in message content
 */
function compressMessageContent(content: string): string {
  // If content contains a test plan (detected by length and keywords)
  if (content.length > 1000 && (
    content.includes('Test Plan') ||
    content.includes('test plan') ||
    content.includes('✅') && content.includes('❌')
  )) {
    // Extract key info
    const urlMatch = content.match(/https?:\/\/[^\s)]+/);
    const url = urlMatch ? urlMatch[0] : 'URL';

    const approvalMatch = content.match(/approved|rejected/i);
    const status = approvalMatch ? approvalMatch[0] : 'shown';

    return `[Test plan for ${url} - ${status}]`;
  }

  // If content is very long, truncate
  if (content.length > 2000) {
    return content.substring(0, 2000) + '... [truncated]';
  }

  return content;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: CHAT SESSION MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 */

async function getOrCreateChatSession(
  userId: string,
  providedSessionId: string | undefined,
  workspaceId: string
): Promise<string | undefined> {
  const isValidUUID = userId && userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  if (!isValidUUID) {
    // Anonymous user - no session
    return undefined;
  }

  if (providedSessionId) {
    // Verify session exists
    const { data: existing } = await supabaseAdmin
      .from('chat_sessions')
      .select('id')
      .eq('id', providedSessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      return existing.id;
    }
  }

  // Check for existing session
  const { data: existing } = await supabaseAdmin
    .from('chat_sessions')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return existing.id;
  }

  // Create new session
  const { data: newSession } = await supabaseAdmin
    .from('chat_sessions')
        .insert({
      user_id: userId,
      workspace_id: workspaceId,
      title: 'New Chat',
    })
    .select('id')
      .single();

  return newSession?.id;
}

async function saveChatMessages(
  sessionId: string,
  messages: Array<{ role: 'user' | 'ai'; content: string; metadata?: any }>
): Promise<void> {
  try {
    const records = messages.map(msg => ({
      session_id: sessionId,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata || {},
    }));

    await supabaseAdmin.from('chat_messages').insert(records);
  } catch (error) {
    logger.error('[CHAT] Failed to save messages', { error, sessionId });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: TYPE CONVERSIONS
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Convert ApiTestPlan to unified TestPlan format
 * This allows API tests to use the same storage and execution flow as UI tests
 */
function convertApiTestPlanToTestPlan(apiPlan: any): any {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24); // Expire in 24 hours

  return {
    id: apiPlan.id,
    status: 'pending_confirmation',
    url: apiPlan.url,
    scope: 'api_test', // Special scope for API tests
    summary: apiPlan.summary,
    steps: apiPlan.validation_steps.map((step: string, index: number) => ({
      id: `step_${index + 1}`,
      action: 'validate',
      description: step,
    })),
    commands: [], // No Playwright commands for API tests
    estimatedDuration: apiPlan.estimated_duration,
    whatWillBeTested: apiPlan.what_will_be_tested,
    whatWillNotBeTested: [], // Not provided in ApiTestPlan
    risks: apiPlan.potential_issues || [],
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Store API-specific data in metadata
          metadata: {
      type: 'api_test',
      method: apiPlan.method,
      headers: apiPlan.headers,
      body: apiPlan.body,
      expectedStatus: apiPlan.expected_status,
    },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPERS: WEBSOCKET EVENTS
 * ═══════════════════════════════════════════════════════════════════════════
 */

function emitProcessingStep(
  sessionId: string | undefined,
  step: ChatProcessingStepPayload['step'],
  message: string,
  progress: number
): void {
  if (!sessionId) return;

  const payload: ChatProcessingStepPayload = {
    sessionId,
    step,
    message,
    progress,
    timestamp: new Date().toISOString(),
  };

  webSocketService.emitChatProcessingStep(sessionId, payload);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HISTORY AND SESSION HANDLERS (Legacy from backup for routes compatibility)
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Get current chat history (single active session per user)
 */
export const getCurrentChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    // Get user's session
    const { data: session } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, title, created_at')
      .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (!session) {
      res.json({
        success: true,
        data: {
          session: null,
          messages: [],
          pagination: { limit, offset, total: 0, has_more: false },
        },
      });
      return;
    }

    // Get total count
    const { count } = await supabaseAdmin
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id);

    // Get messages (newest first when offset=0)
    const { data: messages } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    res.json({
      success: true,
      data: {
        session,
        messages: messages || [],
        pagination: {
          limit,
          offset,
          total: count || 0,
          has_more: (offset + limit) < (count || 0),
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_HISTORY] Error getting current history', { error });
    res.status(500).json({ error: 'Failed to get chat history' });
  }
};

/**
 * Get all chat sessions for user
 */
export const getChatSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const { data: sessions } = await supabaseAdmin
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        chat_messages (
          id,
          role,
          content,
          created_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const processedSessions = (sessions || []).map((session: any) => ({
        id: session.id,
        title: session.title,
        created_at: session.created_at,
      message_count: session.chat_messages?.length || 0,
      last_message: session.chat_messages?.[0] || null,
    }));

    res.json({
      success: true,
      data: {
        sessions: processedSessions,
        pagination: {
          limit,
          offset,
          total: processedSessions.length,
        },
      },
    });
  } catch (error) {
    logger.error('[CHAT_SESSIONS] Error getting sessions', { error });
    res.status(500).json({ error: 'Failed to get chat sessions' });
  }
};

/**
 * Get chat history by session ID
 */
export const getChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;

    // Verify session belongs to user
    const { data: session } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Get all messages for this session
    const { data: messages } = await supabaseAdmin
      .from('chat_messages')
      .select('id, role, content, metadata, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    res.json({
      success: true,
      data: {
        session,
        messages: messages || [],
      },
    });
  } catch (error) {
    logger.error('[CHAT_HISTORY] Error getting history', { error, sessionId: req.params.sessionId });
    res.status(500).json({ error: 'Failed to get chat history' });
  }
};

/**
 * Debug: Get all chat data for user
 */
export const debugChatData = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId);

    const sessionIds = sessions?.map(s => s.id) || [];
    const { data: messages, error: messagesError } = sessionIds.length > 0
      ? await supabaseAdmin
          .from('chat_messages')
          .select('*')
          .in('session_id', sessionIds)
      : { data: [], error: null };

    res.json({
      success: true,
      debug: {
        userId,
        sessions: sessions || [],
        messages: messages || [],
        errors: {
          sessions: sessionsError?.message,
          messages: messagesError?.message,
        },
      },
    });
  } catch (error) {
    logger.error('[DEBUG] Error getting chat data', { error });
    res.status(500).json({ error: 'Debug failed' });
  }
};
