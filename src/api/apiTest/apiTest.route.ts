import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runApiTest, getApiTests, getApiTestById, getApiTestsByProject } from './apiTest.controller';
import { asyncHandler, handleValidationError } from '@/utils/error-handler';
import { requireAuth } from '@/middleware/auth.middleware';

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
 *     security:
 *       - bearerAuth: []
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
router.post('/run', requireAuth, asyncHandler(async (req: Request, res: Response) => {
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

/**
 * @swagger
 * /api/v1/api-test:
 *   get:
 *     summary: Get all API tests for current user
 *     description: |
 *       Returns a paginated list of all API tests executed by the authenticated user.
 *       Tests are retrieved from chat messages where testType = 'api'.
 *     tags: [API Test]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of tests per page
 *     responses:
 *       200:
 *         description: List of API tests retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       testId:
 *                         type: string
 *                       method:
 *                         type: string
 *                       url:
 *                         type: string
 *                       status:
 *                         type: integer
 *                       statusText:
 *                         type: string
 *                       durationMs:
 *                         type: integer
 *                       success:
 *                         type: boolean
 *                       executedAt:
 *                         type: string
 *                         format: date-time
 *                       chatSessionId:
 *                         type: string
 *                       fuzzingReport:
 *                         type: object
 *                         nullable: true
 *                 pagination:
 *                   type: object
 *       401:
 *         description: Unauthorized
 */
/**
 * GET /api-test
 * Get all API tests for current user
 */
router.get('/', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await getApiTests(req, res);
}));

/**
 * @swagger
 * /api/v1/api-test/{id}:
 *   get:
 *     summary: Get API test details by ID
 *     description: |
 *       Returns detailed information about a specific API test including:
 *       - Request details (method, URL, headers, body)
 *       - Response details (status, headers, body)
 *       - Execution metadata
 *       - Fuzzing report (if available)
 *     tags: [API Test]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Test ID
 *     responses:
 *       200:
 *         description: API test details retrieved successfully
 *       404:
 *         description: API test not found
 *       401:
 *         description: Unauthorized
 */
/**
 * GET /api-test/:id
 * Get API test by ID
 */
router.get('/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await getApiTestById(req, res);
}));

/**
 * @swagger
 * /api/v1/api-test/project/{projectId}:
 *   get:
 *     summary: Get API tests by project
 *     description: Returns a paginated list of API tests for a specific project
 *     tags: [API Test]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *     responses:
 *       200:
 *         description: List of API tests for project
 *       401:
 *         description: Unauthorized
 */
/**
 * GET /api-test/project/:projectId
 * Get API tests by project
 */
router.get('/project/:projectId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  await getApiTestsByProject(req, res);
}));

export default router;
