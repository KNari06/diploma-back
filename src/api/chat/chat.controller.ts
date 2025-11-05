import { supabaseAdmin } from '@/db/supabase';
import { detectUserApproval, parseNaturalAnswers } from '@/services/ai-helpers.service';
import { executeApiTest } from '@/services/apiTest.service';
import {
  confirmAndExecuteTestPlan,
  needsAutonomousMode,
  rejectPlan,
  requestMissingInformation,
  runAutonomousExploration
} from '@/services/autonomous-orchestrator.service';
import { enrichContextForCommands, extractUrlFromMessage } from '@/services/context-enrichment.service';
import { getTestPlan } from '@/services/exploration-cache.service';
import { parseUserIntent } from '@/services/intentParser.service';
import { ManualTestService } from '@/services/manualTest.service';
import { getChatCompletion } from '@/services/openai.service';
import { buildChatPrompt } from '@/utils/buildChatPrompt';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';
import { ChatRequest } from './chat.types';
import { webSocketService } from '@/websocket/websocket.service';
import { ChatTestUpdatePayload, ChatProcessingStepPayload } from '@/websocket/types';

/**
 * Handle chat request from user
 */
export const handleChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, context, sessionId, conversationId, answers, userId: bodyUserId } = req.body as ChatRequest;
    // Use userId from auth middleware, fallback to body (for testing/dev)
    const userId = req.user?.id || bodyUserId;

    logger.info('Chat request received', {
      userId,
      messageLength: message.length,
      sessionId,
      hasConversationId: !!conversationId,
      hasAnswers: !!answers
    });

    // Get or create chat session
    let chatSessionId = sessionId;
    const isValidUUID = userId && userId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);


    if (isValidUUID) {
      if (chatSessionId) {
        // Verify session exists and belongs to user
        const { data: existingSession } = await supabaseAdmin
          .from('chat_sessions')
          .select('id')
          .eq('id', chatSessionId)
          .eq('user_id', userId)
          .maybeSingle();

        if (!existingSession) {
          logger.warn('Session not found or not owned by user, creating new one', {
            providedSessionId: chatSessionId,
            userId
          });
          chatSessionId = null; // Will create new session below
        }
      }

      if (!chatSessionId) {
        // Check if user has existing session (single chat per user)
        const { data: existingSession } = await supabaseAdmin
          .from('chat_sessions')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existingSession) {
          // Use existing session
          chatSessionId = existingSession.id;
          logger.info('Using existing chat session', { sessionId: chatSessionId, userId });
        } else {
          // Create new session
          const { data: newSession, error: sessionError } = await supabaseAdmin
            .from('chat_sessions')
            .insert({
              user_id: userId,
              title: message.substring(0, 50),
            })
            .select()
            .single();

          if (sessionError) {
            logger.error('Failed to create chat session', sessionError);
          } else {
            chatSessionId = newSession.id;
            logger.info('Created new chat session', { sessionId: chatSessionId, userId });
          }
        }
      }
    }

    // Extract URL from message for context enrichment
    const urlFromMessage = extractUrlFromMessage(message);
    const contextUrl = urlFromMessage || (typeof context === 'object' && context?.currentUrl) || undefined;

    // Get projectId from context or user
    const projectId = (typeof context === 'object' && context?.projectId) || userId || 'default';

    // Emit: Enriching context
    if (chatSessionId) {
      const stepPayload: ChatProcessingStepPayload = {
        sessionId: chatSessionId,
        step: 'enriching_context',
        message: '🔍 Обогащаю контекст из Knowledge Base и traces...',
        progress: 10,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
    }

    // Enrich context with RAG + Traces before parsing intent
    logger.info('Enriching context before intent parsing', {
      hasUrl: !!contextUrl,
      projectId
    });

    const enrichedContext = await enrichContextForCommands(
      message,
      projectId,
      contextUrl
    );

    // === AUTONOMOUS MODE HANDLING ===

    // Check if there's a pending test plan for this conversation
    let pendingPlan = null;
    if (conversationId) {
      pendingPlan = await getTestPlan(conversationId, userId || 'anonymous');

      if (pendingPlan && pendingPlan.status === 'pending_confirmation') {
        logger.info('Found pending plan, detecting user approval', {
          conversationId,
          planId: pendingPlan.id,
          message: message.substring(0, 50),
        });

        // AI-powered approval detection - user can write ANYTHING
        const approvalResult = await detectUserApproval(message);

        logger.info('Approval detection result', {
          approved: approvalResult.approved,
          confidence: approvalResult.confidence,
          reasoning: approvalResult.reasoning,
        });

        // Process based on confidence
        if (approvalResult.confidence < 0.5) {
          // Too unclear - ask for clarification
          res.json({
            reply: `❓ Не совсем понял ваш ответ.\n\n✅ Подтвердить тест план?\n❌ Отклонить?`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (approvalResult.approved === true) {
          // APPROVED - execute test plan
          logger.info('User approved test plan', { planId: pendingPlan.id });

          const planId = pendingPlan.id;
        // Confirm and execute test plan
        const result = await confirmAndExecuteTestPlan(planId, userId || 'anonymous');

        if (result.success) {
          // Get confirmed plan
          const plan = await getTestPlan(planId, userId || 'anonymous');

          if (plan) {
            // Emit: Executing test
            if (chatSessionId) {
              const stepPayload: ChatProcessingStepPayload = {
                sessionId: chatSessionId,
                step: 'executing_test',
                message: '⚙️ Запускаю тест в браузере...',
                progress: 70,
                timestamp: new Date().toISOString(),
              };
              webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
            }

            // Execute test with plan commands
            const testRequest = {
              url: plan.url,
              browsers: ['chrome' as const],
              projectId,
              userId,
              options: {},
              commands: plan.commands,
              intent: plan.scope,
            };

            const testCreated = await ManualTestService.runTest(testRequest);

            // Emit WebSocket: chat test update
            if (chatSessionId && testCreated.data?.id) {
              const chatTestUpdatePayload: ChatTestUpdatePayload = {
                sessionId: chatSessionId,
                testId: testCreated.data.id,
                message: '✅ Тест запущен! Следите за прогрессом в real-time.',
                status: 'created',
                links: {
                  fullReport: `/api/v1/manual-test/${testCreated.data.id}/summary`,
                },
                timestamp: new Date().toISOString(),
              };
              webSocketService.emitChatTestUpdate(chatSessionId, chatTestUpdatePayload);
            }

            res.json({
              reply: `✅ Test plan подтвержден и запущен!\n\nTest ID: ${testCreated.data?.id}\n\nПроверь статус:\nGET /api/v1/manual-test/${testCreated.data?.id}/status`,
              timestamp: new Date().toISOString(),
              testId: testCreated.data?.id,
            });
            return;
          }
        }

          res.json({
            reply: result.message,
            timestamp: new Date().toISOString(),
          });
          return;
        } else if (approvalResult.approved === false) {
          // REJECTED
          logger.info('User rejected test plan', { planId: pendingPlan.id });

          const reason = message || 'User rejected';
          const result = await rejectPlan(pendingPlan.id, userId || 'anonymous', reason);

          res.json({
            reply: result.message,
            timestamp: new Date().toISOString(),
          });
          return;
        } else {
          // NULL - very unclear, but confidence is >= 0.5 (shouldn't happen normally)
          res.json({
            reply: `❓ Не понял ваш ответ. Пожалуйста, ответьте чётче:\n\n✅ Подтвердить?\n❌ Отклонить?`,
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }
    }

    // Emit: Parsing intent
    if (chatSessionId) {
      const stepPayload: ChatProcessingStepPayload = {
        sessionId: chatSessionId,
        step: 'parsing_intent',
        message: '🤖 Анализирую ваш запрос с помощью AI...',
        progress: 20,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
    }

    // Parse user intent from natural language with enriched context
    const parsedIntent = await parseUserIntent(message, enrichedContext);

    logger.info('[CHAT] Parsed intent result', {
      intent: parsedIntent?.intent,
      hasCommands: !!parsedIntent?.commands,
      commandsCount: parsedIntent?.commands?.length || 0,
      action: parsedIntent?.action,
      apiMethod: parsedIntent?.apiMethod,
      apiUrl: parsedIntent?.apiUrl,
    });

    // Emit: Checking autonomous mode
    if (chatSessionId) {
      const stepPayload: ChatProcessingStepPayload = {
        sessionId: chatSessionId,
        step: 'checking_autonomous',
        message: '🔎 Проверяю нужен ли автономный режим...',
        progress: 30,
        metadata: { intent: parsedIntent?.intent },
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
    }

    // Check if autonomous mode is needed
    const hasTraces = !!(enrichedContext.knownSelectors && Object.keys(enrichedContext.knownSelectors).length > 0);
    const hasDocumentation = !!(enrichedContext.documentation && enrichedContext.documentation.length > 0);

    const needsAutonomous = needsAutonomousMode({
      hasUrl: !!contextUrl,
      hasTraces,
      hasDocumentation,
      intent: parsedIntent?.intent || 'unknown',
    });

    logger.info('[CHAT] Autonomous mode check', {
      needsAutonomous,
      hasUrl: !!contextUrl,
      hasTraces,
      hasDocumentation,
      intent: parsedIntent?.intent,
    });

    // If autonomous mode needed and no answers provided yet
    if (needsAutonomous && !answers) {
      logger.info('Autonomous mode activated - requesting information', {
        hasUrl: !!contextUrl,
        intent: parsedIntent?.intent,
      });

      // Emit: Generating questions
      if (chatSessionId) {
        const stepPayload: ChatProcessingStepPayload = {
          sessionId: chatSessionId,
          step: 'generating_questions',
          message: '❓ Генерирую уточняющие вопросы...',
          progress: 40,
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
      }

      const questionResult = await requestMissingInformation(message, {
        hasUrl: !!contextUrl,
        hasScope: !!(parsedIntent?.page || parsedIntent?.elementLabel),
        intent: parsedIntent?.intent,
      });

      res.json({
        reply: '🤔 Мне нужна дополнительная информация для создания теста:\n\n' +
               questionResult.questions.map((q, i) =>
                 `${i + 1}. ${q.question}${q.required ? ' (обязательно)' : ''}`
               ).join('\n'),
        needsMoreInfo: true,
        questions: questionResult.questions,
        conversationId: questionResult.conversationId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // If we have conversationId but no structured answers, try natural language parsing
    if (needsAutonomous && conversationId && !answers) {
      logger.info('Attempting natural language answer parsing', {
        conversationId,
        message: message.substring(0, 50),
      });

      // Get questions from conversation (would need to store in cache/session)
      // For now, use common questions
      const commonQuestions = [
        { id: 'url', question: 'URL', type: 'url' },
        { id: 'scope', question: 'Scope', type: 'text' },
        { id: 'needs_auth', question: 'Auth', type: 'boolean' },
      ];

      const parsedAnswers = await parseNaturalAnswers(message, commonQuestions);

      if (Object.keys(parsedAnswers).length > 0) {
        logger.info('Natural language answers parsed successfully', {
          fields: Object.keys(parsedAnswers),
        });

        const explorationResult = await runAutonomousExploration({
          userMessage: message,
          answers: parsedAnswers,
          userId: userId || 'anonymous',
          projectId,
        });

        res.json({
          reply: explorationResult.message,
          testPlan: explorationResult.testPlan,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    // If we have structured answers, run autonomous exploration
    if (needsAutonomous && answers && conversationId) {
      logger.info('Running autonomous exploration with user answers', {
        conversationId,
        answerCount: Object.keys(answers).length,
        answers: JSON.stringify(answers),
      });

      // Emit: Exploring site
      if (chatSessionId) {
        const stepPayload: ChatProcessingStepPayload = {
          sessionId: chatSessionId,
          step: 'exploring_site',
          message: '🌐 Запускаю браузер и исследую сайт...',
          progress: 50,
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
      }

      try {
        const explorationResult = await runAutonomousExploration({
          userMessage: message,
          answers,
          userId: userId || 'anonymous',
          projectId,
          sessionId: chatSessionId,
        });

        res.json({
          reply: explorationResult.message,
          testPlan: explorationResult.testPlan,
          conversationId,
          timestamp: new Date().toISOString(),
        });
        return;
      } catch (error) {
        logger.error('Autonomous exploration failed in controller', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          answers,
        });

        res.status(500).json({
          success: false,
          error: 'Autonomous exploration failed',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    let gptResponse: string;
    let apiTestResult: any = null;
    let playwrightTestResult: any = null;

    // Check if intent is UI testing (Playwright)
    const uiTestIntents = ['check_element', 'fill_form', 'login_flow', 'navigate', 'assert_ui'];
    if (parsedIntent && uiTestIntents.includes(parsedIntent.intent)) {
      try {
        // Extract URL from intent or context
        const testUrl = parsedIntent.page ||
                       (typeof context === 'object' ? context.url : undefined) ||
                       parsedIntent.metadata?.url;

        // Extract projectId from context
        const projectId = typeof context === 'object' ? context.projectId : undefined;

        if (!testUrl) {
          gptResponse = `❌ Для создания теста нужно указать URL.\n\nПример: "Проверь что кнопка Buy видна на https://example.com"`;
        } else if (!projectId) {
          gptResponse = `❌ Для создания теста нужно указать projectId в контексте.`;
        } else {
          logger.info('[CHAT] Creating Playwright test from chat', {
            intent: parsedIntent.intent,
            action: parsedIntent.action,
            url: testUrl,
            projectId,
            hasCommands: !!parsedIntent.commands,
            commandsCount: parsedIntent.commands?.length || 0,
          });

          // Determine browser based on viewport
          const browsers = parsedIntent.viewport === 'mobile'
            ? ['mobile-chrome' as const]
            : ['chrome' as const];

          // Create manual test
          const testRequest = {
            url: testUrl,
            browsers,
            projectId,
            userId,
            options: {
              mobile: parsedIntent.viewport === 'mobile',
            },
            // Pass Playwright commands if available
            commands: parsedIntent.commands,
            intent: parsedIntent.intent,
          };

          const testCreated = await ManualTestService.runTest(testRequest);
          playwrightTestResult = testCreated.data;

          // Format response
          const browserText = browsers[0] === 'mobile-chrome' ? 'мобильном браузере' : 'браузере Chrome';
          gptResponse = `✅ Тест создан и отправлен на выполнение!

📋 Детали:
- ID теста: ${testCreated.data?.id}
- URL: ${testUrl}
- Браузер: ${browserText}
- Статус: ${testCreated.data?.status}
- Действие: ${parsedIntent.action || 'проверка'}
${parsedIntent.elementLabel ? `- Элемент: ${parsedIntent.elementLabel}` : ''}

⏳ Тест выполняется... Проверь статус через:
GET /api/v1/manual-test/${testCreated.data?.id}/status

Или получи результаты:
GET /api/v1/manual-test/${testCreated.data?.id}/result`;

          logger.info('Playwright test created from chat', {
            testId: testCreated.data?.id,
            url: testUrl,
            intent: parsedIntent.intent,
          });
        }
      } catch (error) {
        logger.error('Failed to create Playwright test from chat', error);
        gptResponse = `❌ Ошибка при создании теста: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }
    // Check if intent is API test
    else if (parsedIntent?.intent === 'api_test' && parsedIntent.apiMethod && parsedIntent.apiUrl) {
      try {
        logger.info('[CHAT] Executing API test from chat', {
          method: parsedIntent.apiMethod,
          url: parsedIntent.apiUrl,
          headers: parsedIntent.apiHeaders,
          body: parsedIntent.apiBody,
        });

        // Execute API test
        apiTestResult = await executeApiTest({
          method: parsedIntent.apiMethod,
          url: parsedIntent.apiUrl,
          headers: parsedIntent.apiHeaders,
          body: parsedIntent.apiBody,
          expectedStatus: parsedIntent.expectedStatus,
        });

        logger.info('[CHAT] API test executed successfully', {
          success: apiTestResult.success,
          status: apiTestResult.status,
        });

        // Format API test result for chat response
        const statusEmoji = apiTestResult.success ? '✅' : '❌';
        const matchesExpected = parsedIntent.expectedStatus
          ? (apiTestResult.matchesExpected ? 'Да, как ожидалось' : 'Нет, не соответствует ожиданиям')
          : undefined;

        gptResponse = `${statusEmoji} Запрос выполнен.

- Метод: ${parsedIntent.apiMethod}
- URL: ${parsedIntent.apiUrl}
- Код ответа: ${apiTestResult.status}
${apiTestResult.statusText ? `- Статус: ${apiTestResult.statusText}` : ''}
${matchesExpected !== undefined ? `- Успешность: ${matchesExpected}` : ''}
- Время: ${apiTestResult.durationMs} мс`;

        if (apiTestResult.error) {
          gptResponse += `\n- Ошибка: ${apiTestResult.error}`;
        }

        // Add response body preview if available
        if (apiTestResult.responseBody) {
          const bodyPreview = typeof apiTestResult.responseBody === 'string'
            ? apiTestResult.responseBody.substring(0, 200)
            : JSON.stringify(apiTestResult.responseBody).substring(0, 200);
          gptResponse += `\n\nТело ответа (первые 200 символов):\n${bodyPreview}...`;
        }

        logger.info('[CHAT] API test completed from chat', {
          status: apiTestResult.status,
          success: apiTestResult.success,
          durationMs: apiTestResult.durationMs,
        });

        // Save API test log to database
        if (userId && chatSessionId) {
          try {
            await supabaseAdmin.from('api_test_logs').insert({
              user_id: userId,
              method: parsedIntent.apiMethod,
              url: parsedIntent.apiUrl,
              status: apiTestResult.status,
              success: apiTestResult.success,
              duration_ms: apiTestResult.durationMs,
              request: {
                method: parsedIntent.apiMethod,
                url: parsedIntent.apiUrl,
                headers: parsedIntent.apiHeaders,
                body: parsedIntent.apiBody,
                expectedStatus: parsedIntent.expectedStatus,
              },
              response: {
                status: apiTestResult.status,
                statusText: apiTestResult.statusText,
                headers: apiTestResult.responseHeaders,
                body: apiTestResult.responseBody,
                error: apiTestResult.error,
                matchesExpected: apiTestResult.matchesExpected,
              },
            });
            logger.info('API test log saved to database', { userId, url: parsedIntent.apiUrl });
          } catch (dbError) {
            logger.error('Failed to save API test log', dbError);
          }
        }
      } catch (error) {
        logger.error('[CHAT] API test failed in chat', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          parsedIntent: {
            method: parsedIntent.apiMethod,
            url: parsedIntent.apiUrl,
          },
        });
        gptResponse = `❌ Ошибка при выполнении API-запроса.\n\nОшибка: ${error instanceof Error ? error.message : String(error)}\n\nПроверьте URL и параметры.`;
      }
    } else {
      // Regular chat flow with RAG
      const prompt = buildChatPrompt({
        message,
        context: context as string | { projectId?: string; [key: string]: any } | undefined
      });

      // Get KB context if available
      let kbContext = '';
      if (userId) {
        try {
          const { searchKB } = await import('@/services/kb.service');

          // Get user's current project (if in context)
          const projectId = typeof context === 'object' ? context?.projectId : undefined;

          // Search KB (global first, then project)
          const kbResults = await searchKB(message, projectId, {
            matchThreshold: 0.7,
            matchCount: 5,
          });

          if (kbResults.chunks.length > 0) {
            kbContext = '\n\n--- Knowledge Base Context ---\n';
            kbContext += kbResults.chunks.map((chunk, idx) => {
              const source = chunk.source_file || chunk.file_name || 'Unknown';
              const sourceType = chunk.source_file ? 'Global' : 'Project';
              return `[${sourceType} - ${source}]:\n${chunk.content}`;
            }).join('\n\n');

            logger.info('KB context retrieved', {
              globalSources: kbResults.sources.global.length,
              projectSources: kbResults.sources.project.length,
              chunkCount: kbResults.chunks.length,
            });
          }
        } catch (kbError) {
          logger.warn('Failed to retrieve KB context', kbError);
          // Continue without KB context
        }
      }

      const finalContext = context
        ? (typeof context === 'string' ? `${context}${kbContext}` : kbContext)
        : kbContext;

      // Emit: Generating response
      if (chatSessionId) {
        const stepPayload: ChatProcessingStepPayload = {
          sessionId: chatSessionId,
          step: 'generating_response',
          message: '✍️ Формирую ответ...',
          progress: 90,
          timestamp: new Date().toISOString(),
        };
        webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
      }

      gptResponse = await getChatCompletion(prompt, finalContext);
    }

    // Save user message to database

    if (chatSessionId) {
      const { error: userMsgError } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          session_id: chatSessionId,
          role: 'user',
          content: message,
          metadata: {
            parsedIntent,
            context,
          },
        });

      if (userMsgError) {
        logger.error('Failed to save user message', userMsgError);
      }

      // Save AI response to database
      const { error: aiMsgError } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          session_id: chatSessionId,
          role: 'ai',
          content: gptResponse,
          metadata: {
            parsedIntent,
          },
        });

      if (aiMsgError) {
        logger.error('Failed to save AI message', aiMsgError);
      } else {
        logger.info('Chat messages saved to database', { sessionId: chatSessionId });
      }
    }

    const response = {
      reply: gptResponse,
      timestamp: new Date().toISOString(),
      parsedIntent,
      sessionId: chatSessionId,
      apiTestResult: apiTestResult || undefined,
      playwrightTest: playwrightTestResult || undefined,
    };

    logger.info('Chat response generated', {
      userId,
      replyLength: gptResponse.length,
      intent: parsedIntent?.intent,
      sessionId: chatSessionId,
    });

    res.json(response);
  } catch (error) {
    logger.error('Chat error:', error);
    res.status(500).json({ error: 'AI chat failed' });
  }
};

/**
 * Get chat history by session ID
 * GET /chat/history/:sessionId
 */
export const getChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: 'Session ID is required',
      });
      return;
    }

    // Get chat session with messages
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        chat_messages (
          id,
          role,
          content,
          metadata,
          created_at
        )
      `)
      .eq('id', sessionId)
      .eq('user_id', userId) // Only user's own sessions
      .single();

    if (sessionError) {
      logger.error('Failed to get chat session', sessionError);
      res.status(404).json({
        success: false,
        error: 'Chat session not found',
      });
      return;
    }

    // Sort messages by creation time
    const messages = session.chat_messages?.sort((a: any, b: any) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ) || [];

    logger.info('Chat history retrieved', {
      sessionId,
      userId,
      messageCount: messages.length,
    });

    res.json({
      success: true,
      data: {
        session: {
          id: session.id,
          title: session.title,
          created_at: session.created_at,
        },
        messages,
      },
    });
  } catch (error) {
    logger.error('Get chat history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get chat history',
    });
  }
};

/**
 * Get user's current chat history (single active chat) with pagination
 * GET /chat/history?limit=50&offset=0
 */
export const getCurrentChatHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { limit = 50, offset = 0 } = req.query;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    // Validate pagination parameters
    const limitNum = Math.min(Math.max(Number(limit), 1), 100); // 1-100 range
    const offsetNum = Math.max(Number(offset), 0);

    logger.info('Getting chat history for user', {
      userId,
      limit: limitNum,
      offset: offsetNum,
    });

    // Get user's most recent (active) chat session
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('chat_sessions')
      .select('id, title, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    logger.info('Chat session query result', {
      userId,
      sessionFound: !!session,
      sessionId: session?.id,
      sessionTitle: session?.title,
      sessionError: sessionError?.message,
    });

    if (sessionError) {
      logger.error('Failed to get current chat session', sessionError);
      res.status(500).json({
        success: false,
        error: 'Failed to get chat history',
      });
      return;
    }

    // If no session exists, return empty history
    if (!session) {
      res.json({
        success: true,
        data: {
          session: null,
          messages: [],
          pagination: {
            limit: limitNum,
            offset: offsetNum,
            total: 0,
            has_more: false,
          },
        },
      });
      return;
    }

    // Get total message count for pagination
    const { count: totalMessages, error: countError } = await supabaseAdmin
      .from('chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', session.id);

    logger.info('Message count query result', {
      sessionId: session.id,
      totalMessages,
      countError: countError?.message,
    });

    // Get messages with pagination - newest first, then reverse for chronological display
    const { data: messages, error: messagesError } = await supabaseAdmin
      .from('chat_messages')
      .select(`
        id,
        role,
        content,
        metadata,
        created_at
      `)
      .eq('session_id', session.id)
      .order('created_at', { ascending: false }) // Newest first for pagination
      .range(offsetNum, offsetNum + limitNum - 1);

    // Reverse to show chronological order (oldest → newest) in UI
    const chronologicalMessages = messages ? [...messages].reverse() : [];

    if (messagesError) {
      logger.error('Failed to get chat messages', messagesError);
      res.status(500).json({
        success: false,
        error: 'Failed to get chat messages',
      });
      return;
    }

    const hasMore = (offsetNum + limitNum) < (totalMessages || 0);

    logger.info('Current chat history retrieved', {
      userId,
      sessionId: session.id,
      messageCount: messages?.length || 0,
      chronologicalMessageCount: chronologicalMessages.length,
      totalMessages,
      limit: limitNum,
      offset: offsetNum,
      hasMore,
      sessionTitle: session.title,
    });

    res.json({
      success: true,
      data: {
        session: {
          id: session.id,
          title: session.title,
          created_at: session.created_at,
        },
        messages: chronologicalMessages,
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          total: totalMessages || 0,
          has_more: hasMore,
        },
      },
    });
  } catch (error) {
    logger.error('Get current chat history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get chat history',
    });
  }
};

/**
 * Get user's chat sessions list
 * GET /chat/sessions
 */
export const getChatSessions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const { limit = 20, offset = 0 } = req.query;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    // Get user's chat sessions with message count and last message
    const { data: sessions, error } = await supabaseAdmin
      .from('chat_sessions')
      .select(`
        id,
        title,
        created_at,
        chat_messages (
          id,
          content,
          role,
          created_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (error) {
      logger.error('Failed to get chat sessions', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get chat sessions',
      });
      return;
    }

    // Process sessions to add metadata
    const processedSessions = sessions?.map((session: any) => {
      const messages = session.chat_messages || [];
      const lastMessage = messages.length > 0
        ? messages.sort((a: any, b: any) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          )[0]
        : null;

      return {
        id: session.id,
        title: session.title,
        created_at: session.created_at,
        message_count: messages.length,
        last_message: lastMessage ? {
          content: lastMessage.content.substring(0, 100), // Preview
          role: lastMessage.role,
          created_at: lastMessage.created_at,
        } : null,
      };
    }) || [];

    logger.info('Chat sessions retrieved', {
      userId,
      sessionCount: processedSessions.length,
      limit,
      offset,
    });

    res.json({
      success: true,
      data: {
        sessions: processedSessions,
        pagination: {
          limit: Number(limit),
          offset: Number(offset),
          total: processedSessions.length,
        },
      },
    });
  } catch (error) {
    logger.error('Get chat sessions error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get chat sessions',
    });
  }
};

/**
 * Debug: Get all chat data for user
 * GET /chat/debug
 */
export const debugChatData = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Get all sessions for user
    const { data: sessions, error: sessionsError } = await supabaseAdmin
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId);

    // Get all messages for user's sessions
    const sessionIds = sessions?.map(s => s.id) || [];
    const { data: messages, error: messagesError } = sessionIds.length > 0
      ? await supabaseAdmin
          .from('chat_messages')
          .select('*')
          .in('session_id', sessionIds)
      : { data: [], error: null };

    logger.info('Debug chat data', {
      userId,
      sessionsCount: sessions?.length || 0,
      messagesCount: messages?.length || 0,
      sessionIds,
    });

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
    logger.error('Debug chat data error:', error);
    res.status(500).json({ error: 'Debug failed' });
  }
};
