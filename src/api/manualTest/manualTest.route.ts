import { optionalAuth, requireAuth, requireCredits } from '@/middleware/auth.middleware';
import { ManualTestService } from '@/services/manualTest.service';
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
 *     description: Создает и запускает Playwright тест для веб-приложения
 *     tags: [Manual Tests]
 *     security:
 *       - bearerAuth: []
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
    };

    const result = await ManualTestService.runTest(testRequest);

    logger.info(`Test created: ${result.data?.id} for URL: ${validatedData.url}`);

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
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user?.id;

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
router.get('/:id/status', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user?.id;

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
