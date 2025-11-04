import { optionalAuth } from '@/middleware/auth.middleware';
import { asyncHandler, handleValidationError } from '@/utils/error-handler';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { handleChat } from './chat.controller';

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
router.post('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = chatRequestSchema.parse(req.body);

    // User ID comes from auth middleware (req.user)
    await handleChat(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

export default router;
