import { supabaseAdmin } from '@/db/supabase';
import { detectUserApproval, parseNaturalAnswers } from '@/services/ai-helpers.service';
import { executeApiTest } from '@/services/apiTest.service';
import {
  generateApiTestScenarios,
  executeApiTestSuite,
  formatApiTestResults
} from '@/services/api-test-scenarios.service';
import { ApiConfigService } from '@/services/api-config.service';
import { UrlResolverService } from '@/services/url-resolver.service';
import { SmartApiContextService } from '@/services/smart-api-context.service';
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
import { UserCreditsService } from '@/services/user-credits.service';
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
    // Use userId from auth middleware, fallback to body or projectId (for testing/dev)
    // Use projectId as userId for anonymous users so all requests from same project share configurations
    const projectId = (typeof context === 'object' ? context?.projectId : undefined) || 'default';
    const userId = req.user?.id || bodyUserId || `project_${projectId}`;

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
          chatSessionId = undefined; // Will create new session below
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

    // projectId is already defined at the top (line 39)

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

    // Handle smart API context conversations
    if (conversationId && conversationId.startsWith('smart_api_')) {
      logger.info('[CHAT] Handling smart API context conversation', {
        conversationId,
        message: message.substring(0, 100),
      });

      // For now, provide instructions to user to retry with complete information
      // In a full implementation, we would parse the structured responses and create configurations
      res.json({
        reply: `✅ Информация получена! Теперь повторите ваш запрос на тестирование с полными данными.\n\nНапример: \`Протестируй POST https://api.example.com/users\`\n\nЯ сохраню эту конфигурацию для будущих тестов.`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Handle API URL resolution conversations (legacy)
    if (conversationId && (conversationId.startsWith('api_url_') || conversationId.includes('api_url'))) {
      logger.info('[CHAT] Handling API URL resolution conversation', {
        conversationId,
        message: message.substring(0, 100),
      });

      // Parse user response to extract base URL and other info
      const parseResult = UrlResolverService.parseUserResponse(
        '', // We'll extract the original path from conversationId if needed
        message
      );

      if (parseResult.error) {
        res.json({
          reply: `❌ ${parseResult.error}\n\nПример правильного ответа: \`https://api.example.com\` или \`http://localhost:3000\``,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (parseResult.baseUrl) {
        // Try to re-parse the original intent with the new base URL
        // For now, provide instructions to the user
        res.json({
          reply: `✅ Отлично! Базовый URL получен: \`${parseResult.baseUrl}\`\n\nТеперь повторите ваш запрос на тестирование, и я использую этот URL. Например:\n\`Протестируй API ${parseResult.baseUrl}/users\``,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      res.json({
        reply: `❌ Не удалось извлечь URL из вашего ответа.\n\nПожалуйста, укажите базовый URL в формате: \`https://api.example.com\``,
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
        // Smart context analysis for single API test
        const apiContext = await SmartApiContextService.analyzeApiContext(
          parsedIntent,
          userId,
          projectId || 'default'
        );

        // If we need critical information (base URL), ask for it
        if (apiContext.missingInfo.baseUrl) {
          const questions = SmartApiContextService.generateContextQuestions(apiContext, parsedIntent);

          res.json({
            reply: `🔗 Для тестирования API нужен полный URL. Вы указали только путь: \`${parsedIntent.apiUrl}\`\n\nПожалуйста, укажите базовый URL:`,
            needsMoreInfo: true,
            questions,
            conversationId: `smart_api_single_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Use resolved URL
        parsedIntent.apiUrl = apiContext.fullUrl || parsedIntent.apiUrl;

        // Add suggested headers if available
        if (apiContext.suggestedHeaders && Object.keys(apiContext.suggestedHeaders).length > 0) {
          parsedIntent.apiHeaders = {
            ...parsedIntent.apiHeaders,
            ...apiContext.suggestedHeaders,
          };
        }

        logger.info('[CHAT] Using smart context for API testing', {
          originalUrl: parsedIntent.apiUrl,
          resolvedUrl: apiContext.fullUrl,
          hasAuth: apiContext.hasAuthentication,
          confidence: apiContext.confidence,
        });
      } catch (contextError) {
        logger.error('[CHAT] Smart context analysis failed, falling back to basic testing', {
          error: contextError,
          apiUrl: parsedIntent.apiUrl
        });
        // Continue with basic testing
      }
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

        // Auto-create API configuration for future use
        logger.info('[CHAT] Checking auto-create conditions', {
          hasUserId: !!userId,
          userId,
          success: apiTestResult.success,
          hasApiUrl: !!parsedIntent.apiUrl,
          apiUrl: parsedIntent.apiUrl,
        });

        if (userId && apiTestResult.success && parsedIntent.apiUrl) {
          try {
            logger.info('[CHAT] Auto-creating API configuration', {
              userId,
              apiUrl: parsedIntent.apiUrl,
              method: parsedIntent.apiMethod,
              projectId: projectId || 'default',
            });

            const configResult = await ApiConfigService.analyzeAndSuggestConfig(
              userId,
              projectId || 'default',
              parsedIntent.apiUrl,
              parsedIntent.apiMethod || 'GET',
              parsedIntent.apiHeaders,
              parsedIntent.apiBody
            );

            logger.info('[CHAT] API configuration auto-created successfully', {
              environmentId: configResult.environment.id,
              endpointId: configResult.endpoint.id,
              isNew: configResult.isNew,
            });
          } catch (configError: any) {
            logger.error('[CHAT] Failed to auto-create API configuration', {
              error: configError,
              errorMessage: configError?.message,
              errorStack: configError?.stack,
              userId,
              apiUrl: parsedIntent.apiUrl,
            });
            // Don't fail the test if config creation fails
          }
        }

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
    }
    // Check if intent is comprehensive API testing
    else if (parsedIntent?.intent === 'api_test_comprehensive' && parsedIntent.apiUrl) {
      try {
        // Smart context analysis
        logger.info('[CHAT] Starting smart API context analysis', {
          apiUrl: parsedIntent.apiUrl,
          method: parsedIntent.apiMethod,
          userId,
          projectId,
        });

        const apiContext = await SmartApiContextService.analyzeApiContext(
          parsedIntent,
          userId,
          projectId || 'default'
        );

        logger.info('[CHAT] API context analysis completed', {
          confidence: apiContext.confidence,
          strategy: apiContext.testStrategy,
          missingInfo: Object.keys(apiContext.missingInfo).length,
          hasConfig: apiContext.hasEndpointConfig,
        });

        // If we need more information
        if (Object.keys(apiContext.missingInfo).length > 0 && apiContext.confidence < 0.7) {
          const questions = SmartApiContextService.generateContextQuestions(apiContext, parsedIntent);

          const missingItems = Object.keys(apiContext.missingInfo);
          let replyMessage = `🔍 Для качественного тестирования API нужна дополнительная информация:\n\n`;

          if (apiContext.missingInfo.baseUrl) {
            replyMessage += `📍 **Базовый URL**: Вы указали путь \`${parsedIntent.apiUrl}\`, но нужен полный URL\n`;
          }
          if (apiContext.missingInfo.authToken) {
            replyMessage += `🔐 **Авторизация**: API вероятно требует токен для доступа\n`;
          }
          if (apiContext.missingInfo.requestBody) {
            replyMessage += `📝 **Тело запроса**: Для ${parsedIntent.apiMethod} запроса может потребоваться данные\n`;
          }
          if (apiContext.missingInfo.customHeaders) {
            replyMessage += `📋 **Заголовки**: Могут потребоваться специальные заголовки\n`;
          }

          replyMessage += `\nПожалуйста, предоставьте недостающую информацию:`;

          res.json({
            reply: replyMessage,
            needsMoreInfo: true,
            questions,
            conversationId: `smart_api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // We have enough context, proceed with testing
        parsedIntent.apiUrl = apiContext.fullUrl || parsedIntent.apiUrl;

        // Add suggested headers if available
        if (apiContext.suggestedHeaders && Object.keys(apiContext.suggestedHeaders).length > 0) {
          parsedIntent.apiHeaders = {
            ...parsedIntent.apiHeaders,
            ...apiContext.suggestedHeaders,
          };
        }

      } catch (contextError) {
        logger.error('[CHAT] Smart context analysis failed for comprehensive testing', {
          error: contextError,
          apiUrl: parsedIntent.apiUrl
        });
        // Continue with basic testing
      }

      try {
        logger.info('[CHAT] Executing comprehensive API test suite from chat', {
          method: parsedIntent.apiMethod || 'GET',
          url: parsedIntent.apiUrl,
        });

        // Emit: Analyzing configuration
        if (chatSessionId) {
          const stepPayload: ChatProcessingStepPayload = {
            sessionId: chatSessionId,
            step: 'generating_scenarios',
            message: '🔍 Анализирую API и создаю конфигурацию...',
            progress: 50,
            timestamp: new Date().toISOString(),
          };
          webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
        }

        // Analyze and create/find API configuration
        let configResult;
        try {
          configResult = await ApiConfigService.analyzeAndSuggestConfig(
            userId || 'anonymous',
            projectId || 'default',
            parsedIntent.apiUrl,
            parsedIntent.apiMethod || 'GET'
          );

          logger.info('[CHAT] API configuration analyzed', {
            environmentId: configResult.environment.id,
            endpointId: configResult.endpoint.id,
            isNew: configResult.isNew,
            userId,
          });
        } catch (configError) {
          logger.warn('[CHAT] Failed to create API configuration, proceeding with basic testing', {
            error: configError,
            url: parsedIntent.apiUrl,
          });
          configResult = null;
        }

        // Emit: Generating test scenarios
        if (chatSessionId) {
          const stepPayload: ChatProcessingStepPayload = {
            sessionId: chatSessionId,
            step: 'generating_scenarios',
            message: '🧪 Генерирую сценарии тестирования...',
            progress: 60,
            timestamp: new Date().toISOString(),
          };
          webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
        }

        // Generate comprehensive test scenarios
        const testSuite = generateApiTestScenarios(
          parsedIntent.apiUrl,
          parsedIntent.apiMethod || 'GET'
        );

        // Enhance test suite with stored configuration if available
        if (configResult) {
          // Add stored headers to test scenarios
          const storedHeaders = {
            ...configResult.environment.default_headers,
            ...configResult.endpoint.headers,
          };

          // Apply stored configuration to test scenarios
          testSuite.scenarios.forEach(scenario => {
            scenario.request.headers = {
              ...scenario.request.headers,
              ...storedHeaders,
            };

            // Apply timeout from endpoint configuration
            if (configResult!.endpoint.timeout_ms) {
              scenario.request.timeout = configResult!.endpoint.timeout_ms;
            }
          });

          logger.info('[CHAT] Enhanced test scenarios with stored configuration', {
            headersCount: Object.keys(storedHeaders).length,
            timeout: configResult.endpoint.timeout_ms,
          });
        }

        logger.info('[CHAT] Generated API test scenarios', {
          route: testSuite.route,
          method: testSuite.method,
          totalScenarios: testSuite.totalScenarios,
          hasStoredConfig: !!configResult,
        });

        // Emit: Executing test scenarios
        if (chatSessionId) {
          const stepPayload: ChatProcessingStepPayload = {
            sessionId: chatSessionId,
            step: 'executing_tests',
            message: `🚀 Выполняю ${testSuite.totalScenarios} тестовых сценариев...`,
            progress: 70,
            timestamp: new Date().toISOString(),
          };
          webSocketService.emitChatProcessingStep(chatSessionId, stepPayload);
        }

        // Execute test suite (parallel execution for faster results)
        const suiteResults = await executeApiTestSuite(testSuite, {
          parallel: true,
          maxConcurrency: 3, // Limit concurrent requests
          stopOnFirstFailure: false, // Continue testing even if some fail
        });

        logger.info('[CHAT] API test suite completed', {
          route: suiteResults.suite.route,
          total: suiteResults.summary.total,
          passed: suiteResults.summary.passed,
          failed: suiteResults.summary.failed,
          successRate: suiteResults.summary.successRate,
          durationMs: suiteResults.durationMs,
        });

        // Format results for chat response
        let formattedResults = formatApiTestResults(suiteResults);

        // Add configuration info to response if created
        if (configResult && configResult.isNew) {
          formattedResults += `\n\n🔧 **Конфигурация сохранена:**\n`;
          formattedResults += `- Окружение: ${configResult.environment.name}\n`;
          formattedResults += `- Эндпоинт: ${configResult.endpoint.name}\n`;
          formattedResults += `- Теперь вы можете переиспользовать эту конфигурацию для будущих тестов`;
        }

        gptResponse = formattedResults;

        // Store comprehensive test results
        apiTestResult = {
          success: suiteResults.summary.failed === 0,
          status: suiteResults.summary.passed > 0 ? 200 : 500,
          statusText: `${suiteResults.summary.passed}/${suiteResults.summary.total} tests passed`,
          durationMs: suiteResults.durationMs,
          responseHeaders: {},
          responseBody: {
            suite: suiteResults.suite,
            summary: suiteResults.summary,
            results: suiteResults.results.map(r => ({
              scenario: r.scenario.name,
              passed: r.passed,
              status: r.result.status,
              durationMs: r.result.durationMs,
              error: r.result.error,
            })),
            configuration: configResult ? {
              environment_id: configResult.environment.id,
              endpoint_id: configResult.endpoint.id,
              is_new: configResult.isNew,
            } : null,
          },
          matchesExpected: suiteResults.summary.successRate >= 80, // 80% success rate threshold
        };

        // Save comprehensive test results to database
        if (userId && chatSessionId) {
          try {
            await supabaseAdmin.from('api_test_logs').insert({
              user_id: userId,
              method: parsedIntent.apiMethod || 'GET',
              url: parsedIntent.apiUrl,
              status: apiTestResult.status,
              success: apiTestResult.success,
              duration_ms: apiTestResult.durationMs,
              request: {
                method: parsedIntent.apiMethod || 'GET',
                url: parsedIntent.apiUrl,
                comprehensive: true,
                totalScenarios: suiteResults.summary.total,
                environment_id: configResult?.environment.id,
                endpoint_id: configResult?.endpoint.id,
              },
              response: {
                summary: suiteResults.summary,
                results: suiteResults.results.length,
                successRate: suiteResults.summary.successRate,
                configuration_created: configResult?.isNew || false,
              },
            });
            logger.info('Comprehensive API test log saved to database', {
              userId,
              url: parsedIntent.apiUrl,
              scenarios: suiteResults.summary.total,
              configCreated: configResult?.isNew || false,
            });
          } catch (dbError) {
            logger.error('Failed to save comprehensive API test log', dbError);
          }
        }

      } catch (error) {
        logger.error('[CHAT] Comprehensive API test failed in chat', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          parsedIntent: {
            method: parsedIntent.apiMethod || 'GET',
            url: parsedIntent.apiUrl,
          },
        });
        gptResponse = `❌ Ошибка при выполнении комплексного API-тестирования.\n\nОшибка: ${error instanceof Error ? error.message : String(error)}\n\nПроверьте URL и доступность API.`;
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

    // Save user message to database (for authenticated users with valid UUID sessionId)
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

    // Save anonymous user messages (for non-UUID users)
    if (!isValidUUID && userId) {
      try {
        // Get or create anonymous session
        let anonSessionId = sessionId;

        if (!anonSessionId) {
          // Create new anonymous session
          const { data: anonSession, error: sessionError } = await supabaseAdmin
            .from('anonymous_chat_sessions')
            .insert({
              anonymous_id: userId,
              title: message.substring(0, 50),
            })
            .select()
            .single();

          if (!sessionError && anonSession) {
            anonSessionId = anonSession.id;
          }
        } else {
          // Verify session exists
          const { data: existingSession } = await supabaseAdmin
            .from('anonymous_chat_sessions')
            .select('id')
            .eq('id', anonSessionId)
            .eq('anonymous_id', userId)
            .maybeSingle();

          if (!existingSession) {
            // Create new session if not found
            const { data: newSession } = await supabaseAdmin
              .from('anonymous_chat_sessions')
              .insert({
                anonymous_id: userId,
                title: message.substring(0, 50),
              })
              .select()
              .single();

            anonSessionId = newSession?.id;
          }
        }

        if (anonSessionId) {
          // Save user message
          await supabaseAdmin.from('anonymous_chat_messages').insert({
            session_id: anonSessionId,
            role: 'user',
            content: message,
            metadata: { parsedIntent, context },
          });

          // Save AI response
          await supabaseAdmin.from('anonymous_chat_messages').insert({
            session_id: anonSessionId,
            role: 'ai',
            content: gptResponse,
            metadata: { parsedIntent },
          });

          logger.info('Anonymous chat messages saved', {
            anonymousId: userId,
            sessionId: anonSessionId
          });
        }
      } catch (anonError) {
        logger.error('Failed to save anonymous messages', { error: anonError, userId });
      }
    }

    // Add rate limit info for anonymous users
    const rateLimitInfo = (req as any).rateLimitInfo;

    const response = {
      reply: gptResponse,
      timestamp: new Date().toISOString(),
      parsedIntent,
      sessionId: chatSessionId,
      apiTestResult: apiTestResult || undefined,
      playwrightTest: playwrightTestResult || undefined,
      rateLimitInfo: rateLimitInfo ? {
        isAnonymous: rateLimitInfo.isAnonymous,
        limit: rateLimitInfo.limit,
        remaining: rateLimitInfo.remaining,
        message: rateLimitInfo.remaining === 0
          ? '⚠️ Это ваше последнее сообщение. Авторизуйтесь для продолжения!'
          : `💡 У вас осталось ${rateLimitInfo.remaining} ${rateLimitInfo.remaining === 1 ? 'сообщение' : 'сообщения'}. Авторизуйтесь для неограниченного доступа.`
      } : undefined,
    };

    // Deduct credits for authenticated users
    if (req.user?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.user.id)) {
      try {
        const deductResult = await UserCreditsService.deductCredits(
          req.user.id,
          1,
          'Chat message',
          { message, intent: parsedIntent?.intent }
        );

        if (deductResult.success) {
          logger.info('[CHAT] Credits deducted', {
            userId: req.user.id,
            newBalance: deductResult.newBalance,
          });

          // Add credit info to response
          (response as any).creditsDeducted = 1;
          (response as any).creditsRemaining = deductResult.newBalance;
        }
      } catch (creditError) {
        logger.error('[CHAT] Failed to deduct credits', { error: creditError, userId: req.user.id });
      }
    }

    logger.info('Chat response generated', {
      userId,
      replyLength: gptResponse.length,
      intent: parsedIntent?.intent,
      sessionId: chatSessionId,
      isAnonymous: !!rateLimitInfo,
      remaining: rateLimitInfo?.remaining,
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
