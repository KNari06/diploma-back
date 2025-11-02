import { supabaseAdmin } from '@/db/supabase';
import { executeApiTest } from '@/services/apiTest.service';
import { parseUserIntent } from '@/services/intentParser.service';
import { getChatCompletion } from '@/services/openai.service';
import { buildChatPrompt } from '@/utils/buildChatPrompt';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';
import { ChatRequest } from './chat.types';

/**
 * Handle chat request from user
 */
export const handleChat = async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, context, sessionId } = req.body as ChatRequest & { sessionId?: string };
    const userId = req.user?.id; // From auth middleware

    logger.info('Chat request received', { userId, messageLength: message.length, sessionId });

    // Get or create chat session
    let chatSessionId = sessionId;
    if (userId && !chatSessionId) {
      // Create new session if userId provided but no sessionId
      const { data: newSession, error: sessionError } = await supabaseAdmin
        .from('chat_sessions')
        .insert({
          user_id: userId,
          title: message.substring(0, 50), // Use first 50 chars as title
        })
        .select()
        .single();

      if (sessionError) {
        logger.error('Failed to create chat session', sessionError);
      } else {
        chatSessionId = newSession.id;
      }
    }

    // Parse user intent from natural language
    const parsedIntent = await parseUserIntent(message);

    let gptResponse: string;
    let apiTestResult: any = null;

    // Check if intent is API test
    if (parsedIntent?.intent === 'api_test' && parsedIntent.apiMethod && parsedIntent.apiUrl) {
      try {
        logger.info('Executing API test from chat', {
          method: parsedIntent.apiMethod,
          url: parsedIntent.apiUrl,
        });

        // Execute API test
        apiTestResult = await executeApiTest({
          method: parsedIntent.apiMethod,
          url: parsedIntent.apiUrl,
          headers: parsedIntent.apiHeaders,
          body: parsedIntent.apiBody,
          expectedStatus: parsedIntent.expectedStatus,
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

        logger.info('API test completed from chat', {
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
        logger.error('API test failed in chat', error);
        gptResponse = `❌ Ошибка при выполнении API-запроса: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
