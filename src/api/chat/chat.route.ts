import { optionalAuth } from '@/middleware/auth.middleware';
import { checkAnonymousLimit } from '@/middleware/rate-limiter.middleware';
import { asyncHandler, handleValidationError } from '@/utils/error-handler';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { handleChat, getChatHistory, getChatSessions, getCurrentChatHistory, debugChatData } from './chat.controller';

const router = Router();

// Validation schema for chat request
const chatRequestSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty').max(5000, 'Message too long'),
  context: z.union([z.string(), z.record(z.any())]).optional(),
  sessionId: z.string().optional(),
  conversationId: z.string().optional(),
  answers: z.record(z.any()).optional(),
  userId: z.string().optional(),
});

/**
 * @swagger
 * /api/v1/chat:
 *   post:
 *     summary: Отправить сообщение в AI чат
 *     description: Чат с AI + автоматическое распознавание намерений и выполнение API-тестов
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
 *                 example: "Проверь, что GET запрос на https://api.example.com/users возвращает статус 200"
 *               context:
 *                 type: string
 *                 description: Дополнительный контекст для RAG (опционально)
 *               sessionId:
 *                 type: string
 *                 format: uuid
 *                 description: ID существующей сессии чата (опционально, для продолжения диалога)
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
 *                   example: "✅ Запрос выполнен. Метод: GET, URL: https://api.example.com/users, Код ответа: 200..."
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 parsedIntent:
 *                   type: object
 *                   properties:
 *                     intent:
 *                       type: string
 *                       example: "api_test"
 *                     apiMethod:
 *                       type: string
 *                       example: "GET"
 *                     apiUrl:
 *                       type: string
 *                       example: "https://api.example.com/users"
 *                 sessionId:
 *                   type: string
 *                   format: uuid
 *                 apiTestResult:
 *                   type: object
 *                   description: Результат API-теста (если был выполнен)
 *       400:
 *         description: Ошибка валидации
 *       500:
 *         description: Ошибка сервера
 */
/**
 * POST /api/v1/chat
 * Send message to AI chat
 */
router.post('/',
  optionalAuth,           // Check if user is authenticated (optional)
  checkAnonymousLimit,    // Check rate limit for anonymous users
  asyncHandler(async (req: Request, res: Response) => {
    try {
      // Validate request body
      const validatedData = chatRequestSchema.parse(req.body);

      // User ID comes from auth middleware (req.user)
      await handleChat(req, res);
    } catch (error) {
      handleValidationError(error);
    }
  })
);

/**
 * @swagger
 * /api/v1/chat/history:
 *   get:
 *     summary: Получить историю текущего чата пользователя с пагинацией
 *     description: Возвращает историю единственного активного чата пользователя. Поддерживает как авторизованных пользователей (Bearer token), так и анонимных (по IP). offset=0 возвращает ПОСЛЕДНИЕ сообщения. Внутри каждой страницы сообщения отсортированы хронологически (старые → новые)
 *     tags: [Chat]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 100
 *         description: Количество сообщений для возврата
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Смещение для пагинации. 0 = последние сообщения, 50 = более старые сообщения
 *     responses:
 *       200:
 *         description: История текущего чата
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
 *                       description: Сообщения в хронологическом порядке внутри страницы (старые → новые). offset=0 дает последние сообщения
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
router.get('/history', optionalAuth, asyncHandler(getCurrentChatHistory));

/**
 * @swagger
 * /api/v1/chat/sessions:
 *   get:
 *     summary: Получить список чат-сессий пользователя
 *     description: Возвращает список всех чат-сессий текущего пользователя с метаданными. Поддерживает как авторизованных пользователей (Bearer token), так и анонимных (по IP)
 *     tags: [Chat]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
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
 *       401:
 *         description: Не авторизован
 */
router.get('/sessions', optionalAuth, asyncHandler(getChatSessions));

/**
 * @swagger
 * /api/v1/chat/history/{sessionId}:
 *   get:
 *     summary: Получить историю чата по ID сессии
 *     description: Возвращает все сообщения в указанной чат-сессии. Поддерживает как авторизованных пользователей (Bearer token), так и анонимных (по IP)
 *     tags: [Chat]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID чат-сессии
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
 *       400:
 *         description: Неверный ID сессии
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Сессия не найдена
 */
router.get('/history/:sessionId', optionalAuth, asyncHandler(getChatHistory));

// Debug route - remove in production
router.get('/debug', optionalAuth, asyncHandler(debugChatData));

export default router;
