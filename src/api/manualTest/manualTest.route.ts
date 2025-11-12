import { requireAuth, requireCredits } from '@/middleware/auth.middleware';
import { ManualTestService } from '@/services/testing/manualTest.service';
import { TestRunRequest } from '@/types';
import { asyncHandler, handleValidationError } from '@/utils/error-handler';
import { logger } from '@/utils/logger';
import { Request, Response, Router } from 'express';
import { z } from 'zod';

const router = Router();

// Validation schemas
const testRunSchema = z.object({
  url: z.string().url('Invalid URL format'),
  browsers: z.array(z.enum(['chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari'])).min(1, 'At least one browser is required'),
  projectId: z.string().uuid('Invalid project ID format'),
  intelligentMode: z.boolean().optional(),
  testGoal: z.string().optional(),
  options: z.object({
    mobile: z.boolean().optional(),
    viewport: z.object({
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    }).optional(),
    timeout: z.number().positive().optional(),
    retries: z.number().min(0).optional(),
    waitForSelector: z.string().optional(),
    customScripts: z.array(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    credentials: z.object({
      email: z.string().optional(),
      username: z.string().optional(),
      password: z.string(),
    }).optional(),
  }).optional(),
});

const testResultSchema = z.object({
  testId: z.string().uuid('Invalid test ID format'),
  browser: z.enum(['chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari']),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'timeout']),
  screenshot: z.string().optional(),
  dom: z.string().optional(),
  logs: z.array(z.string()).default([]),
  networkLogs: z.array(z.any()).default([]),
  errors: z.array(z.any()).default([]),
  performance: z.any().optional(),
});

const paginationSchema = z.object({
  page: z.string().transform(Number).refine(n => n > 0, 'Page must be positive').optional().default('1'),
  limit: z.string().transform(Number).refine(n => n > 0 && n <= 100, 'Limit must be between 1 and 100').optional().default('20'),
});

/**
 * @swagger
 * /api/v1/manual-test/run:
 *   post:
 *     summary: Запустить ручной тест
 *     description: |
 *       Создает и запускает Playwright тест для веб-приложения.
 *
 *       **Поддерживает два режима:**
 *       - **Standard Mode** - выполнение предопределенных команд
 *       - **Intelligent Mode** - автономное тестирование с GPT-4o Vision
 *
 *       **Стоимость:**
 *       - Standard: 1 кредит
 *       - Intelligent: 20 кредитов
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *               - browsers
 *               - projectId
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *                 description: URL страницы для тестирования
 *                 example: "https://example.com"
 *               browsers:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [chrome, firefox, safari, edge, mobile-chrome, mobile-safari]
 *                 minItems: 1
 *                 description: Список браузеров для тестирования
 *                 example: ["chrome"]
 *               projectId:
 *                 type: string
 *                 format: uuid
 *                 description: ID проекта
 *               intelligentMode:
 *                 type: boolean
 *                 default: false
 *                 description: |
 *                   Включить intelligent testing режим (GPT-4o Vision).
 *                   Если true - AI автономно исследует и тестирует сайт.
 *               testGoal:
 *                 type: string
 *                 description: |
 *                   Цель тестирования для intelligent mode.
 *                   Примеры: "Test login flow", "Check e-commerce cart"
 *               options:
 *                 type: object
 *                 properties:
 *                   mobile:
 *                     type: boolean
 *                     description: Мобильный режим
 *                   viewport:
 *                     type: object
 *                     properties:
 *                       width:
 *                         type: number
 *                       height:
 *                         type: number
 *                   timeout:
 *                     type: number
 *                     description: Таймаут в миллисекундах
 *                   retries:
 *                     type: number
 *                     description: Количество повторных попыток
 *                   waitForSelector:
 *                     type: string
 *                     description: CSS селектор для ожидания
 *                   customScripts:
 *                     type: array
 *                     items:
 *                       type: string
 *                     description: Пользовательские скрипты
 *                   headers:
 *                     type: object
 *                     additionalProperties:
 *                       type: string
 *                     description: HTTP заголовки
 *                   credentials:
 *                     type: object
 *                     properties:
 *                       email:
 *                         type: string
 *                       username:
 *                         type: string
 *                       password:
 *                         type: string
 *                     required:
 *                       - password
 *                     description: Учетные данные для авторизации
 *     responses:
 *       201:
 *         description: Тест успешно создан
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     url:
 *                       type: string
 *                     status:
 *                       type: string
 *                       enum: [pending, running, completed, failed]
 *                     browsers:
 *                       type: array
 *                       items:
 *                         type: string
 *                     intelligentMode:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Ошибка валидации
 *       401:
 *         description: Требуется авторизация
 *       402:
 *         description: Недостаточно кредитов
 *       500:
 *         description: Ошибка сервера
 */
/**
 * POST /manual-test/run
 * Run a new manual test
 */
router.post('/run', requireAuth, requireCredits(1), asyncHandler(async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = testRunSchema.parse(req.body);

    // Use user ID from auth middleware
    const userId = req.user!.id;

    const testRequest: TestRunRequest = {
      url: validatedData.url,
      browsers: validatedData.browsers,
      projectId: validatedData.projectId,
      userId,
      options: validatedData.options,
      intelligentMode: validatedData.intelligentMode,
      testGoal: validatedData.testGoal,
    };

    const result = await ManualTestService.runTest(testRequest);

    logger.info(`Test created: ${result.data?.id} for URL: ${validatedData.url}, intelligentMode: ${validatedData.intelligentMode}`);

    res.status(201).json(result);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * POST /manual-test/result
 * Receive test result from Playwright agent
 */
router.post('/result', asyncHandler(async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = testResultSchema.parse(req.body);

    const result = await ManualTestService.processTestResult(validatedData);

    logger.info(`Test result processed: ${validatedData.testId} (${validatedData.browser})`);

    res.status(200).json(result);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * GET /manual-test/:id
 * Get manual test by ID
 */
router.get('/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.getTest(id, userId);

  res.status(200).json(result);
}));

/**
 * GET /manual-test/:id/result
 * Get manual test results
 */
router.get('/:id/result', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.getTestResults(id, userId);

  res.status(200).json(result);
}));

/**
 * GET /manual-test/project/:projectId
 * Get manual tests by project with pagination
 */
router.get('/project/:projectId', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const userId = req.user!.id;

  // Validate pagination parameters
  const pagination = paginationSchema.parse(req.query);

  const result = await ManualTestService.getTestsByProject(
    projectId,
    userId,
    pagination.page,
    pagination.limit
  );

  res.status(200).json(result);
}));

/**
 * GET /manual-test/project/:projectId/stats
 * Get manual test statistics for project
 */
router.get('/project/:projectId/stats', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.getTestStats(projectId, userId);

  res.status(200).json(result);
}));

/**
 * POST /manual-test/:id/cancel
 * Cancel a running manual test
 */
router.post('/:id/cancel', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.cancelTest(id, userId);

  logger.info(`Test cancelled: ${id}`);

  res.status(200).json(result);
}));

/**
 * POST /manual-test/:id/retry
 * Retry a failed manual test
 */
router.post('/:id/retry', requireAuth, requireCredits(1), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.retryTest(id, userId);

  logger.info(`Test retry initiated: ${id}`);

  res.status(200).json(result);
}));

/**
 * GET /manual-test/:id/status
 * Get manual test status (lightweight endpoint for polling)
 */
router.get('/:id/status', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const test = await ManualTestService.getTest(id, userId);

  // Return only status information
  res.status(200).json({
    success: true,
    data: {
      id: test.data?.id,
      status: test.data?.status,
      progress: test.data?.results?.length || 0,
      totalBrowsers: test.data?.browsers?.length || 0,
    },
    timestamp: new Date(),
  });
}));

/**
 * GET /manual-test/:id/summary
 * Get test summary with AI analysis
 */
router.get('/:id/summary', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const test = await ManualTestService.getTest(id, userId);
  const results = await ManualTestService.getTestResults(id, userId);

  // Calculate summary
  const summary = {
    test: {
      id: test.data?.id,
      url: test.data?.url,
      status: test.data?.status,
      browsers: test.data?.browsers,
      createdAt: test.data?.createdAt,
      completedAt: test.data?.completedAt,
    },
    results: results.data?.map(result => ({
      id: result.id,
      browser: result.browser,
      status: result.status,
      bugsCount: result.aiSummary?.bugs?.length || 0,
      severity: result.aiSummary?.severity,
      confidence: result.aiSummary?.confidence,
      completedAt: result.completedAt,
    })) || [],
    overallStats: {
      totalBrowsers: test.data?.browsers?.length || 0,
      completedBrowsers: results.data?.filter(r => r.status === 'completed').length || 0,
      failedBrowsers: results.data?.filter(r => r.status === 'failed').length || 0,
      totalBugs: results.data?.reduce((sum, r) => sum + (r.aiSummary?.bugs?.length || 0), 0) || 0,
      criticalBugs: results.data?.reduce((sum, r) =>
        sum + (r.aiSummary?.bugs?.filter((b: any) => b.severity === 'critical').length || 0), 0) || 0,
    },
  };

  res.status(200).json({
    success: true,
    data: summary,
    timestamp: new Date(),
  });
}));

export default router;
