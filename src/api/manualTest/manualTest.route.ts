import { supabaseAdmin } from '@/db/supabase';
import { requireAuth, requireCredits } from '@/middleware/auth.middleware';
import { testRetryRateLimiter, testRunRateLimiter } from '@/middleware/rate-limiter.middleware';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { IntelligentTestStorageService } from '@/services/testing/results/intelligent-test-storage.service';
import { TestExecutedStepsRedisService } from '@/services/testing/results/test-executed-steps-redis.service';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { NotFoundError, TestRunRequest, ValidationError } from '@/types';
import { asyncHandler, handleValidationError } from '@/utils/core/error-handler';
import { logger } from '@/utils/core/logger';
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
  runId: z.string().uuid().optional(),
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
 *       - **Intelligent Mode** - автономное тестирование с AI Vision
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
 *                   Включить intelligent testing режим (AI Vision).
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
 * ✅ FIX: Added rate limiter to prevent rapid duplicate test creation
 */
router.post('/run', requireAuth, testRunRateLimiter, asyncHandler(async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = testRunSchema.parse(req.body);

    // Use user ID from auth middleware
    const userId = req.user!.id;

    // ✅ FIX: Active-test guard BEFORE credit deduction (prevents double-charging on duplicate start)
    // If an identical test is already pending/running, return it without charging again.
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: existingActiveTest } = await supabaseAdmin
        .from('tests')
        .select('*')
        .eq('user_id', userId)
        .eq('url', validatedData.url)
        .eq('project_id', validatedData.projectId)
        .in('status', ['pending', 'running'])
        .gte('created_at', fiveMinutesAgo)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingActiveTest?.id) {
        res.status(200).json({
          success: true,
          data: existingActiveTest,
          message: 'ACTIVE_TEST_REUSED',
          timestamp: new Date(),
        });
        return;
      }
    } catch (guardError) {
      // Fail-open: if guard check fails, proceed with normal flow
      logger.warn('[MANUAL_TEST_API] Active-test guard check failed, proceeding', {
        error: guardError instanceof Error ? guardError.message : String(guardError),
        userId,
        url: validatedData.url,
      });
    }

    // Deduct credits BEFORE running test
    const uiTestType = validatedData.intelligentMode ? 'intelligent' : 'standard';
    const testId = `ui_direct_${Date.now()}`;

    try {
      await CreditCostTrackerService.deductCreditsForTest({
        userId,
        testType: uiTestType,
        credits: TokenCalculatorService.getTestCreditCost(uiTestType),
        costUSD: uiTestType === 'intelligent' ? 0.08 : 0.001,
        testId,
        description: `${uiTestType} UI test: ${validatedData.url}`,
      });
    } catch (creditError) {
      logger.error('[MANUAL_TEST_API] Failed to deduct credits', {
        error: creditError instanceof Error ? creditError.message : String(creditError),
        userId,
      });
      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        message: creditError instanceof Error ? creditError.message : 'Payment error',
      });
      return;
    }

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
 * ✅ FIX #6: Added authentication - this endpoint should be protected
 * NOTE: This endpoint is DEPRECATED and should not be used.
 * Test results are processed directly in worker via ManualTestService.processTestResult
 * This endpoint is kept for backward compatibility only.
 */
router.post('/result', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new ValidationError('User ID is required');
    }

    // Validate request body
    const validatedData = testResultSchema.parse(req.body);

    // ✅ FIX #6: Verify that the test belongs to the authenticated user
    const { ManualTestService } = await import('@/services/testing/ui/manualTest.service');
    const testResponse = await ManualTestService.getTest(validatedData.testId, userId);

    if (!testResponse.success || !testResponse.data) {
      logger.warn('[MANUAL_TEST] Unauthorized test result submission attempt', {
        testId: validatedData.testId,
        userId,
      });
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: 'You do not have permission to submit results for this test',
      });
      return;
    }

    const result = await ManualTestService.processTestResult(validatedData);

    logger.info(`Test result processed: ${validatedData.testId} (${validatedData.browser})`);

    res.status(200).json(result);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * @swagger
 * /api/v1/manual-test:
 *   get:
 *     summary: Get all tests for current user
 *     description: |
 *       Returns a paginated list of all tests created by the authenticated user.
 *       Includes tests from all projects and all statuses (pending, running, completed, failed, etc.).
 *     tags: [Manual Tests]
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
 *         description: List of tests retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       url:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [pending, running, completed, failed, cancelled, timeout]
 *                       browsers:
 *                         type: array
 *                         items:
 *                           type: string
 *                       project_id:
 *                         type: string
 *                         format: uuid
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       updated_at:
 *                         type: string
 *                         format: date-time
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 */
router.get('/', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  // Validate pagination parameters
  const pagination = paginationSchema.parse(req.query);

  const result = await ManualTestService.getTestsByUser(
    userId,
    pagination.page,
    pagination.limit,
    pagination.runId,
  );

  res.status(200).json(result);
}));

/**
 * GET /manual-test/:id
 * Get manual test by ID
 * ✅ FIX: Converts base64 screenshots to URLs in test results
 */
router.get('/:id', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.getTest(id, userId);

  // ✅ FIX: Convert base64 screenshots to URLs in test results
  if (result.success && result.data) {
    const test = result.data;
    // Check if test has results with screenshots
    if (test.results && Array.isArray(test.results) && test.results.length > 0) {
      const screenshotUrlMap = await convertScreenshotsToUrls(
        test.results.map((r: any) => ({ id: r.id, screenshot: r.screenshot, browser: r.browser })),
        id,
        userId
      );

      // Update results with converted URLs
      test.results = test.results.map((r: any) => ({
        ...r,
        screenshot: screenshotUrlMap.get(r.id) || undefined,
      }));
    }
  }

  res.status(200).json(result);
}));

/**
 * GET /manual-test/:id/result
 * Get manual test results
 * ✅ FIX: Converts base64 screenshots to URLs
 */
router.get('/:id/result', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.getTestResults(id, userId);

  // ✅ FIX: Convert base64 screenshots to URLs
  if (result.success && result.data && Array.isArray(result.data)) {
    // Supabase returns snake_case fields; service types are camelCase.
    // Treat results as raw DB rows here to avoid TypeScript mismatch.
    const rawResults = result.data as any[];

    const screenshotUrlMap = await convertScreenshotsToUrls(
      rawResults.map(r => ({ id: r.id, screenshot: r.screenshot, browser: r.browser })),
      id,
      userId
    );

    // Update results with converted URLs and ensure video/trace URLs are available
    // ✅ FIX: Map snake_case (DB) to camelCase (TypeScript) for consistency
    result.data = rawResults.map(r => ({
      ...r,
      screenshot: screenshotUrlMap.get(r.id) || undefined,
      // ✅ NEW: Ensure video_url and trace_url are available (from DB snake_case)
      videoUrl: r.video_url || r.videoUrl, // Support both formats
      traceUrl: r.trace_url || r.traceUrl, // Support both formats
      video_url: r.video_url || r.videoUrl, // Keep snake_case for API consistency
      trace_url: r.trace_url || r.traceUrl, // Keep snake_case for API consistency
    }));
  }

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
 * @swagger
 * /api/v1/manual-test/{id}/cancel:
 *   post:
 *     summary: Отменить запущенный тест
 *     description: |
 *       Отменяет запущенный или ожидающий тест.
 *
 *       **Действия:**
 *       - Обновляет статус теста на 'cancelled'
 *       - Удаляет все связанные задачи из очереди
 *       - Останавливает активные процессы тестирования
 *       - Отправляет WebSocket уведомление
 *
 *       **Ограничения:**
 *       - Нельзя отменить уже завершенный тест
 *       - Требуется авторизация
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID теста для отмены
 *     responses:
 *       200:
 *         description: Тест успешно отменен
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
 *                   description: Информация об отмененном тесте
 *                 message:
 *                   type: string
 *                   example: "Test cancelled successfully"
 *       400:
 *         description: Тест уже завершен или отменен
 *       403:
 *         description: Доступ запрещен
 *       404:
 *         description: Тест не найден
 */
router.post('/:id/cancel', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.cancelTest(id, userId);

  logger.info(`Test cancelled: ${id}`);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /api/v1/manual-test/cancel-all:
 *   post:
 *     summary: Отменить все запущенные тесты пользователя
 *     description: |
 *       Отменяет все тесты пользователя со статусом 'pending' или 'running'.
 *
 *       **Действия:**
 *       - Находит все запущенные тесты пользователя
 *       - Отменяет каждый тест
 *       - Возвращает количество отмененных тестов
 *
 *       **Ограничения:**
 *       - Требуется авторизация
 *       - Отменяются только тесты текущего пользователя
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Результат отмены всех тестов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 cancelledCount:
 *                   type: number
 *                   example: 3
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: []
 *       500:
 *         description: Ошибка при отмене тестов
 */
router.post('/cancel-all', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const result = await ManualTestService.cancelAllRunningTestsForUser(userId);

  logger.info(`Cancelled ${result.cancelledCount} tests for user: ${userId}`);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /api/v1/manual-test/cancel-all-chat:
 *   post:
 *     summary: Отменить все запущенные тесты для чат-сессии
 *     description: |
 *       Отменяет все тесты, связанные с указанной чат-сессией, со статусом 'pending' или 'running'.
 *
 *       **Действия:**
 *       - Находит все запущенные тесты для чат-сессии
 *       - Отменяет каждый тест
 *       - Возвращает количество отмененных тестов
 *
 *       **Ограничения:**
 *       - Требуется авторизация
 *       - Отменяются только тесты текущего пользователя
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
 *               - chatSessionId
 *             properties:
 *               chatSessionId:
 *                 type: string
 *                 format: uuid
 *                 description: ID чат-сессии
 *     responses:
 *       200:
 *         description: Результат отмены всех тестов
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 cancelledCount:
 *                   type: number
 *                   example: 2
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: []
 *       400:
 *         description: Не указан chatSessionId
 *       500:
 *         description: Ошибка при отмене тестов
 */
router.post('/cancel-all-chat', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { chatSessionId } = req.body;

  if (!chatSessionId) {
    res.status(400).json({
      success: false,
      error: 'chatSessionId is required',
    });
    return;
  }

  const result = await ManualTestService.cancelAllRunningTestsForChatSession(chatSessionId, userId);

  logger.info(`Cancelled ${result.cancelledCount} tests for chat session: ${chatSessionId}`);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /api/v1/manual-test/{id}/retry:
 *   post:
 *     summary: Повторить тест
 *     description: |
 *       Повторяет выполнение теста (только для failed тестов).
 *
 *       **Действия:**
 *       - Создает новые задачи в очереди для всех браузеров
 *       - Обновляет статус теста на 'pending'
 *       - Списывает 1 кредит
 *
 *       **Стоимость:**
 *       - Standard mode: 1 кредит
 *       - Intelligent mode: 20 кредитов
 *
 *       **Требования:**
 *       - Тест должен иметь статус 'failed'
 *       - У пользователя должны быть кредиты
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID теста для повтора
 *     responses:
 *       200:
 *         description: Тест успешно перезапущен
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
 *                   description: Информация о перезапущенном тесте
 *                 message:
 *                   type: string
 *                   example: "Test retry initiated successfully"
 *       400:
 *         description: Тест не failed или недостаточно кредитов
 *       403:
 *         description: Доступ запрещен
 *       404:
 *         description: Тест не найден
 */
// ✅ FIX: Added rate limiter to prevent rapid retry spam
router.post('/:id/retry', requireAuth, testRetryRateLimiter, requireCredits(1), asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const result = await ManualTestService.retryTest(id, userId);

  logger.info(`Test retry initiated: ${id}`);

  res.status(200).json(result);
}));

/**
 * @swagger
 * /api/v1/manual-test/{id}/status:
 *   get:
 *     summary: Получить статус теста (легковесный endpoint)
 *     description: |
 *       Возвращает только статус теста без полной информации.
 *
 *       **Использование:**
 *       - Идеален для polling (проверка статуса каждые N секунд)
 *       - Минимальная нагрузка на БД
 *       - Быстрый ответ
 *
 *       **Возвращает:**
 *       - id - ID теста
 *       - status - текущий статус (pending, running, completed, failed, cancelled)
 *       - progress - количество завершенных браузеров
 *       - totalBrowsers - общее количество браузеров
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID теста
 *     responses:
 *       200:
 *         description: Статус теста получен
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
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     status:
 *                       type: string
 *                       enum: [pending, running, completed, failed, cancelled]
 *                       example: running
 *                     progress:
 *                       type: number
 *                       description: Количество завершенных браузеров
 *                       example: 1
 *                     totalBrowsers:
 *                       type: number
 *                       description: Общее количество браузеров
 *                       example: 3
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       403:
 *         description: Доступ запрещен
 *       404:
 *         description: Тест не найден
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
 * @swagger
 * /api/v1/manual-test/{testId}/full:
 *   get:
 *     summary: Get complete test data with all details
 *     description: |
 *       Returns comprehensive information about a specific test including:
 *       - Test basic information (id, url, status, browsers)
 *       - Test results for each browser (screenshots, DOM, videos, traces)
 *       - Generated Playwright test code (from report)
 *       - Intelligent test session data (if intelligent mode was used)
 *       - All screenshots, videos, logs, network logs, and errors
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: testId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Test ID
 *     responses:
 *       200:
 *         description: Complete test data retrieved successfully
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
 *                     test:
 *                       type: object
 *                       description: Basic test information
 *                     results:
 *                       type: array
 *                       description: Test results for each browser
 *                     report:
 *                       type: object
 *                       nullable: true
 *                       description: Test report with generated code
 *                       properties:
 *                         generatedCode:
 *                           type: object
 *                         artifacts:
 *                           type: object
 *                         analysis:
 *                           type: object
 *                         summary:
 *                           type: object
 *                     intelligentSession:
 *                       type: object
 *                       nullable: true
 *                       description: Intelligent test session data
 *                     traceFiles:
 *                       type: array
 *                       description: Playwright trace files
 *                     screenshots:
 *                       type: array
 *                       description: All screenshots from test execution
 *                     videos:
 *                       type: array
 *                       description: All videos from test execution
 *                     logs:
 *                       type: array
 *                       description: All logs grouped by browser
 *                     networkLogs:
 *                       type: array
 *                       description: Network logs grouped by browser
 *                     errors:
 *                       type: array
 *                       description: All errors grouped by browser
 *       404:
 *         description: Test not found
 *       401:
 *         description: Unauthorized
 */
/**
 * ✅ OPTIMIZED: Helper to convert base64 screenshots to URLs
 * - Converts once and caches result
 * - Updates DB to avoid re-conversion on next request
 * - Uses parallel uploads for speed
 */
function isBase64Screenshot(screenshot: string): boolean {
  // Check for data URL format
  if (screenshot.startsWith('data:image/')) return true;
  // Check for raw base64 (PNG signature in base64 is "iVBORw0K")
  if (screenshot.startsWith('iVBORw0K')) return true;
  // Check for raw base64 (JPEG signature is "/9j/")
  if (screenshot.startsWith('/9j/')) return true;
  return false;
}

async function convertScreenshotsToUrls(
  results: Array<{ id: string; screenshot?: string | null; browser: string }>,
  testId: string,
  userId: string
): Promise<Map<string, string | null>> {
  const urlMap = new Map<string, string | null>();
  const conversionsNeeded: Array<{ resultId: string; screenshot: string; index: number }> = [];

  // First pass: identify what needs conversion
  results.forEach((r, index) => {
    if (!r.screenshot) {
      urlMap.set(r.id, null);
    } else if (r.screenshot.startsWith('http://') || r.screenshot.startsWith('https://')) {
      // Already a URL
      urlMap.set(r.id, r.screenshot);
    } else if (isBase64Screenshot(r.screenshot)) {
      // Needs conversion
      conversionsNeeded.push({ resultId: r.id, screenshot: r.screenshot, index });
    } else {
      // Unknown format, skip
      urlMap.set(r.id, null);
    }
  });

  if (conversionsNeeded.length === 0) {
    return urlMap;
  }

  logger.info('[MANUAL_TEST] Converting base64 screenshots to URLs', {
    testId,
    count: conversionsNeeded.length,
  });

  const startTime = Date.now();

  try {
    const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

    // Convert in parallel for speed
    const uploadResults = await Promise.allSettled(
      conversionsNeeded.map(async ({ resultId, screenshot, index }) => {
        const url = await uploadScreenshotToStorage(screenshot, testId, userId, index);
        return { resultId, url };
      })
    );

    // Process results and update DB
    for (const result of uploadResults) {
      if (result.status === 'fulfilled') {
        const { resultId, url } = result.value;
        urlMap.set(resultId, url);

        // Update DB to store URL instead of base64 (async, don't wait)
        // This ensures next request returns URL directly without conversion
        (async () => {
          try {
            await supabaseAdmin
              .from('test_results')
              .update({ screenshot: url })
              .eq('id', resultId);
            logger.debug('[MANUAL_TEST] Updated DB with screenshot URL', { resultId });
          } catch (err) {
            logger.warn('[MANUAL_TEST] Failed to update DB with screenshot URL', {
              resultId,
              error: err,
            });
          }
        })();
      } else {
        // Find the resultId from the failed promise
        const failedIndex = uploadResults.indexOf(result);
        const failedConversion = conversionsNeeded[failedIndex];
        if (failedConversion) {
          urlMap.set(failedConversion.resultId, null);
          logger.error('[MANUAL_TEST] Screenshot upload failed', {
            resultId: failedConversion.resultId,
            error: result.reason,
          });
        }
      }
    }

    logger.info('[MANUAL_TEST] Screenshot conversion completed', {
      testId,
      count: conversionsNeeded.length,
      duration: `${Date.now() - startTime}ms`,
    });
  } catch (error) {
    logger.error('[MANUAL_TEST] Screenshot conversion failed', {
      testId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Set all pending to null
    conversionsNeeded.forEach(({ resultId }) => {
      if (!urlMap.has(resultId)) {
        urlMap.set(resultId, null);
      }
    });
  }

  return urlMap;
}

router.get('/:id/full', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    // 1. Get test basic info
    const testResponse = await ManualTestService.getTest(id, userId);
    if (!testResponse.success || !testResponse.data) {
      res.status(404).json({
        success: false,
        error: 'Test not found',
      });
      return;
    }

    const test = testResponse.data;

    // DEBUG: Log raw test data from Supabase
    logger.info('[MANUAL_TEST_FULL] Raw test data keys', {
      testId: id,
      keys: Object.keys(test as any),
      status: test.status,
      has_executed_steps: !!(test as any).executed_steps,
      has_executedSteps: !!(test as any).executedSteps,
      has_started_at: !!(test as any).started_at,
      has_completed_at: !!(test as any).completed_at,
      has_test_goal: !!(test as any).test_goal,
      has_intelligent_mode: !!(test as any).intelligent_mode,
    });

    // 2. Get test results with all details
    const resultsResponse = await ManualTestService.getTestResults(id, userId);
    const results = resultsResponse.data || [];

    // DEBUG: Log raw results from Supabase
    logger.info('[MANUAL_TEST_FULL] Raw results data', {
      testId: id,
      resultsCount: results.length,
      firstResultKeys: results.length > 0 ? Object.keys(results[0] as any) : [],
      firstResult: results.length > 0 ? {
        id: (results[0] as any).id,
        status: (results[0] as any).status,
        has_video_url: !!(results[0] as any).video_url,
        has_videoUrl: !!(results[0] as any).videoUrl,
        has_trace_url: !!(results[0] as any).trace_url,
        has_screenshot: !!(results[0] as any).screenshot,
        has_ai_summary: !!(results[0] as any).ai_summary,
        has_aiSummary: !!(results[0] as any).aiSummary,
        has_network_logs: !!(results[0] as any).network_logs,
        has_networkLogs: !!(results[0] as any).networkLogs,
        logs: (results[0] as any).logs,
        errors_count: ((results[0] as any).errors || []).length,
      } : null,
    });

    // 3. Get test report (includes generated code)
    let report = null;
    try {
      report = await TestReportGeneratorService.getReportByTestId(id);
    } catch (error) {
      logger.warn('[MANUAL_TEST] Report not found or error getting report', {
        testId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 4. Get intelligent test session (if exists)
    let intelligentSession = null;
    try {
      const { data: sessions, error: sessionError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('test_id', id)
        .limit(1);

      logger.info('[MANUAL_TEST_FULL] Intelligent session query result', {
        testId: id,
        sessionError: sessionError?.message,
        sessionsCount: sessions?.length || 0,
        sessionIds: sessions?.map((s: any) => s.id) || [],
      });

      if (!sessionError && sessions && sessions.length > 0) {
        intelligentSession = await IntelligentTestStorageService.getTestSession(sessions[0].id);
        logger.info('[MANUAL_TEST_FULL] Intelligent session loaded', {
          testId: id,
          hasSession: !!intelligentSession?.session,
          pagesCount: intelligentSession?.pages?.length || 0,
          findingsCount: intelligentSession?.findings?.length || 0,
          hasGraphData: !!(intelligentSession?.session as any)?.graph_data,
        });
      }
    } catch (error) {
      logger.warn('[MANUAL_TEST] Error getting intelligent session', {
        testId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 5. Get trace files (for videos/traces)
    const { data: traceFiles, error: traceError } = await supabaseAdmin
      .from('trace_files')
      .select(`
        id, test_id, user_id, file_name, storage_path, file_size,
        browser, status, public_url, parsed_data, parsed_at, created_at
      `)
      .eq('test_id', id)
      .order('created_at', { ascending: false });

    if (traceError) {
      logger.warn('[MANUAL_TEST] Error getting trace files', {
        testId: id,
        error: traceError,
      });
    }

    // 6. Convert all screenshots ONCE (avoid duplicate conversions)
    // ✅ OPTIMIZED: Convert once and reuse, update DB for future requests
    const screenshotUrlMap = await convertScreenshotsToUrls(
      results.map(r => ({ id: r.id, screenshot: r.screenshot, browser: r.browser })),
      id,
      userId
    );

    // Collect all screenshots from results using pre-converted URLs
    const screenshots = (results as any[])
      .filter(r => r.screenshot)
      .map(r => ({
        browser: r.browser,
        screenshot: screenshotUrlMap.get(r.id) || null,
        status: r.status,
        completed_at: r.completedAt ?? r.completed_at,
      }))
      .filter(s => s.screenshot !== null);

    // 7. Collect all videos from results and trace files
    // ✅ FIX: Use video_url from DB (snake_case) - Supabase returns snake_case
    const videos = [
      ...(results as any[]).filter(r => r.video_url || r.videoUrl).map(r => ({
        browser: r.browser,
        video_url: r.video_url || r.videoUrl, // Support both formats for compatibility
        status: r.status,
        completed_at: r.completedAt ?? r.completed_at,
      })),
      ...(traceFiles || []).filter(tf => tf.public_url && tf.file_name?.endsWith('.webm')).map(tf => ({
        browser: tf.browser,
        video_url: tf.public_url,
        file_name: tf.file_name,
        file_size: tf.file_size,
        created_at: tf.created_at,
      })),
    ];

    // 8. Collect all logs from results
    const allLogs = results
      .filter(r => (r.logs || []) && Array.isArray(r.logs) && r.logs.length > 0)
      .map(r => ({
        browser: r.browser,
        logs: r.logs || [],
        status: r.status,
      }));

    // 9. Collect all network logs
    const networkLogs = results
      .filter((r: any) => {
        const nl = r.network_logs ?? r.networkLogs;
        return nl && Array.isArray(nl) && nl.length > 0;
      })
      .map((r: any) => ({
        browser: r.browser,
        network_logs: r.network_logs ?? r.networkLogs ?? [],
        status: r.status,
      }));

    // 10. Collect all errors
    const errors = results
      .filter(r => (r.errors || []) && Array.isArray(r.errors) && r.errors.length > 0)
      .map(r => ({
        browser: r.browser,
        errors: r.errors || [],
        status: r.status,
      }));

    // 10.5 Live executed steps fallback (Redis) for running tests
    const rawExecutedSteps = (test as any).executed_steps ?? (test as any).executedSteps ?? null;
    const isRunning = test.status === 'running' || test.status === 'pending';
    const executedSteps = (isRunning && (!rawExecutedSteps || (Array.isArray(rawExecutedSteps) && rawExecutedSteps.length === 0)))
      ? await TestExecutedStepsRedisService.getLive(id)
      : rawExecutedSteps;

    // Build comprehensive response
    // Note: Convert TypeScript camelCase to snake_case for API response (DB format)
    const fullTestData = {
      test: {
        id: test.id,
        url: test.url,
        project_id: (test as any).project_id ?? (test as any).projectId,
        user_id: (test as any).user_id ?? (test as any).userId,
        status: test.status,
        browsers: test.browsers,
        options: test.options,
        created_at: (test as any).created_at ?? (test as any).createdAt,
        updated_at: (test as any).updated_at ?? (test as any).updatedAt,
        started_at: (test as any).started_at ?? (test as any).startedAt,
        completed_at: (test as any).completed_at ?? (test as any).completedAt,
        intelligent_mode: (test as any).intelligent_mode ?? (test as any).intelligentMode,
        test_goal: (test as any).test_goal ?? (test as any).testGoal,
        executed_steps: executedSteps,
      },
      // ✅ OPTIMIZED: Use pre-converted URLs (no duplicate conversion)
      // ✅ FIX: Use video_url/trace_url from DB (snake_case) - Supabase returns snake_case
      results: (results as any[]).map(r => ({
        id: r.id,
        test_id: r.test_id ?? r.testId,
        browser: r.browser,
        status: r.status,
        screenshot: screenshotUrlMap.get(r.id) || null,
        dom: r.dom,
        video_url: r.video_url ?? r.videoUrl,
        trace_url: r.trace_url ?? r.traceUrl,
        performance: r.performance,
        ai_summary: r.ai_summary ?? r.aiSummary ?? null,
        logs: r.logs || [],
        network_logs: r.network_logs ?? r.networkLogs ?? [],
        errors: r.errors || [],
        created_at: r.created_at ?? r.createdAt,
        completed_at: r.completed_at ?? r.completedAt,
      })),
      report: report ? {
        generatedCode: report.generatedCode,
        artifacts: report.artifacts,
        analysis: report.analysis,
        summary: report.summary,
      } : null,
      intelligentSession,
      traceFiles: traceFiles || [],
      screenshots,
      videos,
      logs: allLogs,
      networkLogs,
      errors,
    };

    res.status(200).json({
      success: true,
      data: fullTestData,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Handle NotFoundError with proper 404 response
    if (error instanceof NotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Test not found',
        message: error.message,
      });
      return;
    }

    // Handle ValidationError (e.g., access denied)
    if (error instanceof ValidationError) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: error.message,
      });
      return;
    }

    logger.error('[MANUAL_TEST] Error getting full test data', {
      error: error instanceof Error ? error.message : String(error),
      testId: id,
      userId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get full test data',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
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
