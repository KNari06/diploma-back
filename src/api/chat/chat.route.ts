import { requireAuth } from '@/middleware/auth.middleware';
import { asyncHandler, handleValidationError } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  clearWorkspaceChat,
  deleteChatSession,
  getChatSessionById,
  getWorkspaceChat,
  listUserChatSessions,
  updateChatSessionTitle,
} from './chat-sessions.controller';
import { debugChatData, getChatHistory, getCurrentChatHistory, handleChat } from './chat.controller';

const router = Router();

// ============================================================================
// MULTER CONFIGURATION FOR CHAT FILE UPLOADS
// ============================================================================

const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_DOCUMENT_MIMES = [
  'text/plain',
  'application/json',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const ALLOWED_MIMES = [...ALLOWED_IMAGE_MIMES, ...ALLOWED_DOCUMENT_MIMES];

const chatFileFilter = (
  _req: any,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type "${file.mimetype}" is not allowed. Allowed: images (JPEG, PNG, GIF, WebP) and documents (TXT, JSON, MD, PDF, DOCX).`));
  }
};

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max per file
    files: 5, // max 5 files per message
  },
  fileFilter: chatFileFilter,
});

// Validation schema for chat request
const chatRequestSchema = z.object({
  message: z.string().max(5000, 'Message too long'), // min(0): files-only messages allowed
  context: z.union([z.string(), z.record(z.any())]).optional(),
  sessionId: z.string().optional(),
  conversationId: z.string().optional(),
  answers: z.record(z.any()).optional(),
  userId: z.string().optional(),
  mode: z.enum(['lite', 'pro', 'editor']).optional().default('lite'), // Test execution mode
  executionStrategy: z.enum(['standard', 'exploration']).optional(), // Execution strategy from frontend
});

/**
 * @swagger
 * /api/v1/chat:
 *   post:
 *     summary: Отправить сообщение в AI чат
 *     description: |
 *       Чат с AI поддерживает:
 *       - **Intelligent Testing** - автономное тестирование с AI Vision
 *       - **API Testing** - тестирование API endpoints
 *       - **General Chat** - обычный разговор с AI
 *
 *       **Стоимость:**
 *       - Чат: 1 кредит за сообщение
 *       - Intelligent тест: 20 кредитов (~50 тестов/месяц за $39)
 *       - Standard тест: 1 кредит (~1000 тестов/месяц)
 *       - API тест: 2 кредита (~500 тестов/месяц)
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - message
 *             properties:
 *               message:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 5000
 *                 description: Сообщение пользователя
 *                 examples:
 *                   - "Test my login flow on https://example.com"
 *                   - "Check GET https://api.example.com/users returns 200"
 *                   - "How to write better tests?"
 *               context:
 *                 oneOf:
 *                   - type: string
 *                   - type: object
 *                 description: Дополнительный контекст (projectId, workspaceId)
 *               sessionId:
 *                 type: string
 *                 format: uuid
 *                 description: ID существующей сессии чата для продолжения диалога
 *               conversationId:
 *                 type: string
 *                 description: Альтернативный ID для группировки сообщений
 *               answers:
 *                 type: object
 *                 description: Ответы на вопросы AI (credentials, URLs, etc.)
 *               userId:
 *                 type: string
 *                 description: ID пользователя (если не из auth middleware)
 *               mode:
 *                 type: string
 *                 enum: [lite, pro]
 *                 default: lite
 *                 description: Test execution mode (lite - simplified agentic loop, pro - advanced orchestrator)
 *     responses:
 *       200:
 *         description: Успешный ответ
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reply:
 *                   type: string
 *                   description: Ответ AI
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   required: true
 *                   description: Timestamp of AI reply (ISO 8601 format)
 *                 userMessageTimestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Timestamp when user message was saved (ISO 8601 format, optional)
 *                 sessionId:
 *                   type: string
 *                   format: uuid
 *                   description: ID сессии чата
 *                 parsedIntent:
 *                   type: object
 *                   properties:
 *                     intent:
 *                       type: string
 *                       enum: [platform_test, api_test, general_chat]
 *                       description: Распознанное намерение
 *                     scope:
 *                       type: string
 *                       enum: [full, page, element, flow, general]
 *                       description: Область тестирования
 *                     page:
 *                       type: string
 *                       nullable: true
 *                       description: URL страницы для тестирования
 *                     target:
 *                       type: string
 *                       description: Конкретный элемент или флоу
 *                     needsAuth:
 *                       type: boolean
 *                       description: Требуется ли авторизация
 *                     intelligentMode:
 *                       type: boolean
 *                       description: Использовать ли intelligent testing
 *                     confidence:
 *                       type: number
 *                       description: Уверенность парсинга (0-1)
 *                 testPlan:
 *                   type: object
 *                   description: План тестирования (требует подтверждения)
 *                   properties:
 *                     planId:
 *                       type: string
 *                     summary:
 *                       type: string
 *                     steps:
 *                       type: array
 *                       items:
 *                         type: string
 *                     estimatedDuration:
 *                       type: string
 *                     intelligentMode:
 *                       type: boolean
 *                     estimatedCost:
 *                       type: string
 *                       description: Стоимость в кредитах
 *                     mode:
 *                       type: string
 *                       enum: [lite, pro]
 *                       description: Test execution mode (lite - simplified, pro - advanced)
 *                 creditsRemaining:
 *                   type: number
 *                   description: Остаток кредитов после операции
 *       400:
 *         description: Ошибка валидации
 *       402:
 *         description: Недостаточно кредитов для выполнения теста
 *       409:
 *         description: Уже есть активный запрос обработки сообщения
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Request already in progress"
 *                 message:
 *                   type: string
 *                   example: "Another request is currently being processed. Please cancel it first or wait for completion."
 *       499:
 *         description: Запрос был отменен пользователем
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Request cancelled"
 *                 message:
 *                   type: string
 *                   example: "The request was cancelled by user"
 *       500:
 *         description: Ошибка сервера
 */
/**
 * POST /api/v1/chat
 * Send message to AI chat
 */
router.post('/',
  requireAuth,
  chatUpload.array('files', 5),
  asyncHandler(async (req: Request, res: Response) => {
  try {
    // When sent as multipart/form-data, JSON fields may arrive as strings — parse them
    if (typeof req.body.context === 'string' && req.body.context.startsWith('{')) {
      try { req.body.context = JSON.parse(req.body.context); } catch { /* keep as string */ }
    }
    if (typeof req.body.answers === 'string' && req.body.answers.startsWith('{')) {
      try { req.body.answers = JSON.parse(req.body.answers); } catch { /* keep as string */ }
    }

    // Validate request body (validation happens via schema.parse)
    chatRequestSchema.parse(req.body);

    // User ID comes from auth middleware (req.user)
    await handleChat(req, res);
  } catch (error) {
    // Handle multer errors with friendly messages
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ success: false, error: 'File too large. Maximum file size is 20MB.' });
        return;
      }
      if (error.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({ success: false, error: 'Too many files. Maximum 5 files per message.' });
        return;
      }
    }
    // fileFilter throws plain Error (not MulterError) for disallowed file types
    if (error instanceof Error && error.message.includes('File type')) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    handleValidationError(error);
  }
  })
);

/**
 * @swagger
 * /api/v1/chat/cancel:
 *   post:
 *     summary: Отменить текущий запрос обработки сообщения и все запущенные тесты
 *     description: |
 *       Отменяет активный HTTP-запрос обработки сообщения (парсинг интента, генерация плана, выполнение теста)
 *       и все запущенные тесты для указанной чат-сессии.
 *
 *       **Критически важно:**
 *       - Вызывается при нажатии кнопки "Отменить" на фронтенде
 *       - Можно вызвать **параллельно** с основным запросом `/api/v1/chat` (не блокируется)
 *       - Останавливает обработку запроса на любом этапе (intent parsing, AI calls, test execution)
 *       - Отменяет все тесты со статусом 'pending' или 'running' (статус меняется на 'cancelled')
 *
 *       **Поведение:**
 *       1. Отменяет активный HTTP-запрос обработки сообщения (через AbortController)
 *       2. Отменяет все запущенные тесты для чат-сессии
 *       3. Возвращает информацию о том, что было отменено
 *
 *       **После отмены:**
 *       - Фронтенд должен разблокировать поле ввода
 *       - Пользователь может отправить новое сообщение
 *       - Отмененный запрос `/api/v1/chat` вернет HTTP 499 (Request cancelled)
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *                 format: uuid
 *                 description: ID чат-сессии (опционально, если не указан - используется последняя сессия пользователя)
 *     responses:
 *       200:
 *         description: Результат отмены запроса и тестов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 requestCancelled:
 *                   type: boolean
 *                   description: Был ли отменен активный HTTP-запрос обработки сообщения
 *                   example: true
 *                 testsCancelled:
 *                   type: number
 *                   description: Количество отмененных тестов
 *                   example: 2
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Ошибки при отмене (если были)
 *                   example: []
 *                 message:
 *                   type: string
 *                   description: Описание того, что было отменено
 *                   example: "Cancelled request processing and 2 test(s)"
 *       400:
 *         description: Ошибка валидации (например, нет чат-сессии)
 *       500:
 *         description: Ошибка сервера
 */
router.post('/cancel',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { sessionId, testId } = req.body || {};

    // ✅ FIX #1: Validate sessionId format if provided
    const { isValidUUID } = await import('@/utils/validation/validation');
    if (sessionId && !isValidUUID(sessionId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid sessionId format (must be UUID)',
      });
      return;
    }

    // ✅ FIX: Validate testId format if provided
    if (testId && !isValidUUID(testId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid testId format (must be UUID)',
      });
      return;
    }

    // Get chat session ID
    let chatSessionId = sessionId;

    // If sessionId not provided, get the latest session for user
    if (!chatSessionId) {
      try {
        const { getOrCreateChatSession } = await import('./shared/utils');
        const { checkWorkspace } = await import('./shared/validation');

        const workspace_id = await checkWorkspace(userId);
        chatSessionId = await getOrCreateChatSession(userId, undefined, workspace_id, false);

        if (!chatSessionId) {
          res.status(400).json({
            success: false,
            error: 'No chat session found. Please provide sessionId or create a new chat session.',
          });
          return;
        }
      } catch (error) {
        logger.error('[CHAT] Failed to get chat session for cancel', {
          error: error instanceof Error ? error.message : String(error),
          userId,
        });
        res.status(500).json({
          success: false,
          error: 'Failed to get chat session',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        return;
      }
    } else {
      // ✅ FIX #2: Verify user owns this chat session (per-user chat model)
      try {
        const { supabaseAdmin } = await import('@/db/supabase');
        const { data: session, error: sessionError } = await supabaseAdmin
          .from('chat_sessions')
          .select('id, workspace_id, user_id')
          .eq('id', chatSessionId)
          .maybeSingle();

        if (sessionError || !session) {
          res.status(404).json({
            success: false,
            error: 'Chat session not found',
          });
          return;
        }

        if (session.user_id !== userId) {
          res.status(403).json({
            success: false,
            error: 'Access denied to this chat session',
          });
          return;
        }
      } catch (error) {
        logger.error('[CHAT] Failed to verify session access', {
          error: error instanceof Error ? error.message : String(error),
          sessionId: chatSessionId,
        });
        res.status(500).json({
          success: false,
          error: 'Failed to verify session access',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        return;
      }
    }

    // ✅ CRITICAL: Cancel active request processing first
    // ✅ FIX #3: Handle errors from cancelActiveRequest
    let requestCancelResult: { cancelled: boolean; message?: string } = {
      cancelled: false,
      message: undefined
    };
    try {
      const { cancelActiveRequest } = await import('./shared/request-cancellation');
      requestCancelResult = await cancelActiveRequest(chatSessionId, userId);
    } catch (error) {
      logger.error('[CHAT] Failed to cancel active request', {
        error: error instanceof Error ? error.message : String(error),
        chatSessionId,
        userId,
      });
      // Continue - try to cancel tests anyway
    }

    // Cancel running tests (chatSessionId is guaranteed to be set at this point)
    // ✅ FIX: If testId is provided, cancel it directly (safe fallback when mapping is missing)
    const testCancelResult = { success: true, cancelledCount: 0, errors: [] as string[] };
    try {
      const { ManualTestService } = await import('@/services/testing/ui/manualTest.service');

      if (testId) {
        try {
          const directCancel = await ManualTestService.cancelTest(testId, userId);
          if (directCancel?.success) {
            testCancelResult.cancelledCount += 1;
          } else {
            testCancelResult.success = false;
            testCancelResult.errors.push(
              directCancel?.message ? `Failed to cancel test ${testId}: ${directCancel.message}` : `Failed to cancel test ${testId}`
            );
          }
        } catch (directError) {
          testCancelResult.success = false;
          testCancelResult.errors.push(
            `Failed to cancel test ${testId}: ${directError instanceof Error ? directError.message : String(directError)}`
          );
        }
      }

      // Cancel other running tests linked to the chat session via mappings
      const sessionCancel = await ManualTestService.cancelAllRunningTestsForChatSession(chatSessionId!, userId);
      testCancelResult.cancelledCount += sessionCancel.cancelledCount;
      testCancelResult.errors.push(...(sessionCancel.errors || []));
      testCancelResult.success = testCancelResult.success && sessionCancel.success;
    } catch (error) {
      logger.warn('[CHAT] Failed to cancel tests', {
        error: error instanceof Error ? error.message : String(error),
      });
      testCancelResult.errors.push(error instanceof Error ? error.message : String(error));
      testCancelResult.success = false;
    }

    // ✅ FIX #4: Cancel regression runs for chat session
    // Note: Regression runs create regular tests via ManualTestService.runTest,
    // so those tests are already cancelled above. We also cancel the regression_run records
    // that were triggered via chat and are still running.
    const regressionCancelResult = { cancelledCount: 0, errors: [] as string[] };
    try {
      const { supabaseAdmin } = await import('@/db/supabase');

      // Find regression runs triggered via chat that are still running
      // These are linked to tests in this session through test_chat_mappings
      const { data: regressionRuns, error: runsError } = await supabaseAdmin
        .from('regression_runs')
        .select('id, status, trigger')
        .eq('user_id', userId)
        .eq('trigger', 'chat')
        .in('status', ['running', 'pending'])
        .order('created_at', { ascending: false })
        .limit(50); // Limit to prevent too many updates

      if (!runsError && regressionRuns && regressionRuns.length > 0) {
        // Get test IDs from this chat session to verify linkage (for future use)
        // const { data: testMappings } = await supabaseAdmin
        //   .from('test_chat_mappings')
        //   .select('test_id')
        //   .eq('chat_session_id', chatSessionId!);
        // const sessionTestIds = new Set(testMappings?.map(m => m.test_id) || []);

        // Cancel regression runs (they create tests that are linked to session)
        for (const run of regressionRuns) {
          try {
            // Update regression run status to cancelled
            const { error: updateError } = await supabaseAdmin
              .from('regression_runs')
              .update({
                status: 'cancelled',
                completed_at: new Date().toISOString(),
              })
              .eq('id', run.id)
              .eq('user_id', userId);

            if (updateError) {
              regressionCancelResult.errors.push(`Failed to cancel regression run ${run.id}: ${updateError.message}`);
            } else {
              regressionCancelResult.cancelledCount++;
              logger.info('[CHAT] Cancelled regression run', { runId: run.id, chatSessionId });
            }
          } catch (error) {
            regressionCancelResult.errors.push(`Error cancelling regression run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } catch (error) {
      logger.warn('[CHAT] Failed to cancel regression runs', {
        error: error instanceof Error ? error.message : String(error),
      });
      regressionCancelResult.errors.push(error instanceof Error ? error.message : String(error));
    }

    // Combine all errors
    const allErrors = [...testCancelResult.errors, ...regressionCancelResult.errors];
    const totalCancelled = testCancelResult.cancelledCount + regressionCancelResult.cancelledCount;

    logger.info(`[CHAT] Cancelled request and tests via cancel endpoint`, {
      chatSessionId,
      userId,
      requestCancelled: requestCancelResult.cancelled,
      testsCancelled: testCancelResult.cancelledCount,
      regressionRunsCancelled: regressionCancelResult.cancelledCount,
      totalCancelled,
      errorsCount: allErrors.length,
    });

    // ✅ FIX #5: Return success=false if there were critical errors
    const hasCriticalErrors = allErrors.length > 0 && !requestCancelResult.cancelled && totalCancelled === 0;

    res.status(hasCriticalErrors ? 500 : 200).json({
      success: !hasCriticalErrors,
      requestCancelled: requestCancelResult.cancelled,
      testsCancelled: testCancelResult.cancelledCount,
      regressionRunsCancelled: regressionCancelResult.cancelledCount,
      totalCancelled,
      errors: allErrors,
      message: requestCancelResult.cancelled
        ? `Cancelled request processing${totalCancelled > 0 ? ` and ${totalCancelled} test(s)/run(s)` : ''}`
        : totalCancelled > 0
        ? `Cancelled ${totalCancelled} test(s)/run(s)`
        : 'No active request or tests to cancel',
    });
  })
);

/**
 * @swagger
 * /api/v1/chat/history:
 *   get:
 *     summary: Get current user's chat history (paginated)
 *     description: Returns the history of the user's single active chat session. Supports both authenticated users (Bearer token) and anonymous users (by IP). offset=0 returns the MOST RECENT messages. Within each page, messages are sorted chronologically (old → new).
 *     tags: [Chat]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 100
 *         description: Number of messages to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Pagination offset. 0 = latest messages, 50 = older messages
 *     responses:
 *       200:
 *         description: Current chat history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     session:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         title:
 *                           type: string
 *                         created_at:
 *                           type: string
 *                           format: date-time
 *                     messages:
 *                       type: array
 *                       description: Messages in chronological order within the page (old → new). offset=0 returns the latest messages
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           role:
 *                             type: string
 *                             enum: [user, ai]
 *                           content:
 *                             type: string
 *                           metadata:
 *                             type: object
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                             required: true
 *                             description: Message timestamp (ISO 8601 format, always present)
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         limit:
 *                           type: integer
 *                           example: 50
 *                         offset:
 *                           type: integer
 *                           example: 0
 *                         total:
 *                           type: integer
 *                           example: 150
 *                         has_more:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Не авторизован
 */
router.get('/history', requireAuth, asyncHandler(getCurrentChatHistory));

/**
 * @swagger
 * /api/v1/chat/sessions:
 *   get:
 *     summary: Получить список всех чат-сессий пользователя (с multi-chat support)
 *     description: |
 *       Возвращает список всех чат-сессий с метаданными, отсортированный по последней активности (updated_at).
 *
 *       **NEW:** Теперь сортировка по updated_at вместо created_at для показа активных чатов вверху.
 *     tags: [Chat Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 100
 *         description: Количество сессий для возврата
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Смещение для пагинации
 *     responses:
 *       200:
 *         description: Список чат-сессий
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     sessions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           title:
 *                             type: string
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                             required: true
 *                             description: Message timestamp (ISO 8601 format, always present)
 *                           updated_at:
 *                             type: string
 *                             format: date-time
 *                           message_count:
 *                             type: integer
 *                           last_message:
 *                             type: object
 *                             properties:
 *                               content:
 *                                 type: string
 *                               role:
 *                                 type: string
 *                                 enum: [user, ai]
 *                               created_at:
 *                                 type: string
 *                                 format: date-time
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         limit:
 *                           type: integer
 *                         offset:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         has_more:
 *                           type: boolean
 *       401:
 *         description: Не авторизован
 */
router.get('/sessions', requireAuth, asyncHandler(listUserChatSessions)); // Updated to use new multi-chat endpoint

/**
 * @swagger
 * /api/v1/chat/history/{sessionId}:
 *   get:
 *     summary: Получить историю чата по ID сессии (legacy endpoint)
 *     description: |
 *       Возвращает сообщения в указанной чат-сессии с поддержкой пагинации.
 *
 *       **DEPRECATED:** Используйте `/api/v1/chat/sessions/{sessionId}` вместо этого.
 *       Этот endpoint сохранен для backward compatibility.
 *
 *       **Пагинация:** Если `limit` или `offset` не указаны, возвращаются все сообщения (для обратной совместимости).
 *     tags: [Chat]
 *     deprecated: true
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID чат-сессии
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Количество сообщений для возврата (опционально, по умолчанию - все)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Смещение для пагинации (опционально)
 *     responses:
 *       200:
 *         description: История чата
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     session:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         title:
 *                           type: string
 *                         created_at:
 *                           type: string
 *                           format: date-time
 *                     messages:
 *                       type: array
 *                       description: Сообщения в хронологическом порядке (старые → новые)
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           role:
 *                             type: string
 *                             enum: [user, ai]
 *                           content:
 *                             type: string
 *                           metadata:
 *                             type: object
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                             required: true
 *                             description: Message timestamp (ISO 8601 format, always present)
 *                     pagination:
 *                       type: object
 *                       description: Информация о пагинации (только если указаны limit/offset)
 *                       properties:
 *                         limit:
 *                           type: integer
 *                           example: 50
 *                         offset:
 *                           type: integer
 *                           example: 0
 *                         total:
 *                           type: integer
 *                           example: 150
 *                         has_more:
 *                           type: boolean
 *                           example: true
 *       400:
 *         description: Неверный ID сессии
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Сессия не найдена
 */
router.get('/history/:sessionId', requireAuth, asyncHandler(getChatHistory)); // Legacy - kept for backward compatibility

// Debug route - remove in production
router.get('/debug', requireAuth, asyncHandler(debugChatData));

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTI-CHAT SESSIONS MANAGEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * @swagger
 * /api/v1/chat/sessions/new:
 *   post:
 *     summary: Создать новую чат-сессию (multi-chat support)
 *     description: Создает новую изолированную чат-сессию для пользователя. Позволяет вести несколько независимых диалогов как в ChatGPT
 *     tags: [Chat Sessions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Новая чат-сессия создана
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     sessionId:
 *                       type: string
 *                       format: uuid
 *                       description: ID новой чат-сессии
 *                     title:
 *                       type: string
 *                       example: "New Chat"
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                 message:
 *                   type: string
 *                   example: "New chat session created"
 *       401:
 *         description: Не авторизован
 *       500:
 *         description: Ошибка сервера
 */
// POST /sessions/new removed — workspace chat is auto-created
// Replaced by GET /workspace-chat which auto-creates the single workspace session
router.get('/workspace-chat', requireAuth, asyncHandler(getWorkspaceChat));


/**
 * @swagger
 * /api/v1/chat/sessions/{sessionId}:
 *   get:
 *     summary: Получить чат-сессию с сообщениями (с поддержкой пагинации)
 *     description: |
 *       Возвращает детали чат-сессии включая сообщения с поддержкой пагинации.
 *
 *       **Пагинация:** Если `limit` или `offset` не указаны, возвращаются все сообщения (для обратной совместимости).
 *       Сообщения отсортированы в хронологическом порядке (старые → новые).
 *     tags: [Chat Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID чат-сессии
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Количество сообщений для возврата (опционально, по умолчанию - все)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Смещение для пагинации (опционально)
 *     responses:
 *       200:
 *         description: Чат-сессия с сообщениями
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     session:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         title:
 *                           type: string
 *                         created_at:
 *                           type: string
 *                           format: date-time
 *                         updated_at:
 *                           type: string
 *                           format: date-time
 *                     messages:
 *                       type: array
 *                       description: Сообщения в хронологическом порядке (старые → новые)
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           role:
 *                             type: string
 *                             enum: [user, ai]
 *                           content:
 *                             type: string
 *                           metadata:
 *                             type: object
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *                             required: true
 *                             description: Message timestamp (ISO 8601 format, always present)
 *                     pagination:
 *                       type: object
 *                       description: Информация о пагинации (только если указаны limit/offset)
 *                       properties:
 *                         limit:
 *                           type: integer
 *                           example: 50
 *                         offset:
 *                           type: integer
 *                           example: 0
 *                         total:
 *                           type: integer
 *                           example: 150
 *                         has_more:
 *                           type: boolean
 *                           example: true
 *       404:
 *         description: Чат-сессия не найдена
 *       401:
 *         description: Не авторизован
 */
router.get('/sessions/:sessionId', requireAuth, asyncHandler(getChatSessionById));

/**
 * @swagger
 * /api/v1/chat/sessions/{sessionId}:
 *   patch:
 *     summary: Обновить название чат-сессии
 *     description: Изменяет название (title) чат-сессии
 *     tags: [Chat Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID чат-сессии
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *             properties:
 *               title:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 200
 *                 description: Новое название чат-сессии
 *                 example: "API Testing Discussion"
 *     responses:
 *       200:
 *         description: Название обновлено
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     sessionId:
 *                       type: string
 *                       format: uuid
 *                     title:
 *                       type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Неверные данные
 *       404:
 *         description: Чат-сессия не найдена
 *       401:
 *         description: Не авторизован
 */
router.patch('/sessions/:sessionId', requireAuth, asyncHandler(updateChatSessionTitle));

/**
 * @swagger
 * /api/v1/chat/sessions/{sessionId}:
 *   delete:
 *     summary: Удалить чат-сессию и все сообщения
 *     description: Безвозвратно удаляет чат-сессию и все связанные сообщения (CASCADE)
 *     tags: [Chat Sessions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID чат-сессии для удаления
 *     responses:
 *       200:
 *         description: Чат-сессия удалена
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Chat session deleted"
 *       404:
 *         description: Чат-сессия не найдена
 *       401:
 *         description: Не авторизован
 */
router.post('/sessions/:sessionId/clear', requireAuth, asyncHandler(clearWorkspaceChat));
router.delete('/sessions/:sessionId', requireAuth, asyncHandler(deleteChatSession));

export default router;
