import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { TestService } from '@/services/test.service';
import { asyncHandler, handleValidationError } from '@/utils/error-handler';
import { logger } from '@/utils/logger';
import { TestRunRequest } from '@/types';

const router = Router();

// Validation schemas
const testRunSchema = z.object({
  url: z.string().url('Invalid URL format'),
  browsers: z.array(z.enum(['chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari'])).min(1, 'At least one browser is required'),
  projectId: z.string().uuid('Invalid project ID format'),
  userId: z.string().uuid('Invalid user ID format').optional(),
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
 * POST /tests/run
 * Run a new test
 */
router.post('/run', asyncHandler(async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = testRunSchema.parse(req.body);
    
    // Extract user ID from auth (in real implementation, this would come from JWT)
    const userId = req.headers['x-user-id'] as string || validatedData.userId;
    
    const testRequest: TestRunRequest = {
      url: validatedData.url,
      browsers: validatedData.browsers,
      projectId: validatedData.projectId,
      userId,
      options: validatedData.options,
    };
    
    const result = await TestService.runTest(testRequest);
    
    logger.info(`Test created: ${result.data?.id} for URL: ${validatedData.url}`);
    
    res.status(201).json(result);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * POST /tests/result
 * Receive test result from agent
 */
router.post('/result', asyncHandler(async (req: Request, res: Response) => {
  try {
    // Validate request body
    const validatedData = testResultSchema.parse(req.body);
    
    const result = await TestService.processTestResult(validatedData);
    
    logger.info(`Test result processed: ${validatedData.testId} (${validatedData.browser})`);
    
    res.status(200).json(result);
  } catch (error) {
    handleValidationError(error);
  }
}));

/**
 * GET /tests/:id
 * Get test by ID
 */
router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  const result = await TestService.getTest(id, userId);
  
  res.status(200).json(result);
}));

/**
 * GET /tests/:id/result
 * Get test results
 */
router.get('/:id/result', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  const result = await TestService.getTestResults(id, userId);
  
  res.status(200).json(result);
}));

/**
 * GET /tests/project/:projectId
 * Get tests by project with pagination
 */
router.get('/project/:projectId', asyncHandler(async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'User ID required',
      timestamp: new Date(),
    });
    return;
  }
  
  // Validate pagination parameters
  const pagination = paginationSchema.parse(req.query);
  
  const result = await TestService.getTestsByProject(
    projectId,
    userId,
    pagination.page,
    pagination.limit
  );
  
  res.status(200).json(result);
}));

/**
 * GET /tests/project/:projectId/stats
 * Get test statistics for project
 */
router.get('/project/:projectId/stats', asyncHandler(async (req: Request, res: Response) => {
  const { projectId } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'User ID required',
      timestamp: new Date(),
    });
    return;
  }
  
  const result = await TestService.getTestStats(projectId, userId);
  
  res.status(200).json(result);
}));

/**
 * POST /tests/:id/cancel
 * Cancel a running test
 */
router.post('/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  const result = await TestService.cancelTest(id, userId);
  
  logger.info(`Test cancelled: ${id}`);
  
  res.status(200).json(result);
}));

/**
 * POST /tests/:id/retry
 * Retry a failed test
 */
router.post('/:id/retry', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  const result = await TestService.retryTest(id, userId);
  
  logger.info(`Test retry initiated: ${id}`);
  
  res.status(200).json(result);
}));

/**
 * GET /tests/:id/status
 * Get test status (lightweight endpoint for polling)
 */
router.get('/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  const test = await TestService.getTest(id, userId);
  
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
 * GET /tests/:id/summary
 * Get test summary with AI analysis
 */
router.get('/:id/summary', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.headers['x-user-id'] as string;
  
  const test = await TestService.getTest(id, userId);
  const results = await TestService.getTestResults(id, userId);
  
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
