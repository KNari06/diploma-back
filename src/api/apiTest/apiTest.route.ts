import { Router } from 'express';
import { z } from 'zod';
import { runApiTest } from './apiTest.controller';
import { asyncHandler, handleValidationError } from '@/utils/error-handler';

const router = Router();

// Validation schema for API test request
const apiTestRequestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  url: z.string().url('Invalid URL format'),
  headers: z.record(z.string()).optional(),
  body: z.any().optional(),
  expectedStatus: z.number().int().positive().optional(),
  timeout: z.number().int().positive().max(30000).optional(),
});

/**
 * @swagger
 * /api/v1/api-test/run:
 *   post:
 *     summary: Выполнить API-тест
 *     description: Прямое выполнение HTTP-запроса (без чата). Поддерживает GET, POST, PUT, DELETE, PATCH
 *     tags: [API Test]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - method
 *               - url
 *             properties:
 *               method:
 *                 type: string
 *                 enum: [GET, POST, PUT, DELETE, PATCH]
 *                 example: GET
 *               url:
 *                 type: string
 *                 format: uri
 *                 example: "https://api.example.com/users"
 *               headers:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *                 example:
 *                   Authorization: "Bearer token"
 *                   Content-Type: "application/json"
 *               body:
 *                 type: object
 *                 description: Тело запроса (для POST, PUT, PATCH)
 *                 example:
 *                   email: "test@test.com"
 *                   password: "password123"
 *               expectedStatus:
 *                 type: integer
 *                 description: Ожидаемый HTTP статус код
 *                 example: 200
 *               timeout:
 *                 type: integer
 *                 description: Таймаут в миллисекундах (макс 30000)
 *                 default: 10000
 *                 example: 10000
 *     responses:
 *       200:
 *         description: Результат API-теста
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 statusText:
 *                   type: string
 *                   example: "OK"
 *                 durationMs:
 *                   type: integer
 *                   example: 173
 *                 responseHeaders:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                 responseBody:
 *                   type: object
 *                   description: Тело ответа (парсится из JSON если возможно)
 *                 matchesExpected:
 *                   type: boolean
 *                   description: Соответствует ли статус ожидаемому (если указан)
 *                 error:
 *                   type: string
 *                   description: Сообщение об ошибке (если есть)
 *       400:
 *         description: Ошибка валидации
 *       500:
 *         description: Ошибка сервера
 */
/**
 * POST /api-test/run
 * Execute API test request
 */
router.post('/run', asyncHandler(async (req, res) => {
  try {
    // Validate request body
    const validatedData = apiTestRequestSchema.parse(req.body);

    // Build request with validated data
    const apiTestRequest = {
      method: validatedData.method,
      url: validatedData.url,
      headers: validatedData.headers,
      body: validatedData.body,
      expectedStatus: validatedData.expectedStatus,
      timeout: validatedData.timeout,
    };

    await runApiTest(req, res);
  } catch (error) {
    handleValidationError(error);
  }
}));

export default router;
