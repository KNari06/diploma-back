import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION CONTROLLER - API endpoints for regression testing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Provides REST API for:
 * - Saving completed tests as reusable test cases
 * - Creating regression suites from multiple test cases
 * - Running saved test cases and suites
 * - Listing saved test cases, suites, and runs for a project
 */

// Extended Request type with authenticated user
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

/**
 * Extract and validate user ID from authenticated request
 * @throws {Error} If user ID is missing (auth middleware should prevent this)
 */
function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new Error('User ID not found - authentication failed');
  }
  return userId;
}

/**
 * Save a test as a regression test case
 *
 * @route POST /api/v1/regression/save
 * @body {string} sourceTestId - ID of completed test to save
 * @body {string} name - Display name for saved test case
 * @body {string} [description] - Optional description
 * @body {string} [kind='standalone'] - 'standalone' or 'regression_member'
 * @returns {savedTestCaseId, projectId, replayStrategy, parametersCount}
 */
export async function saveTestCase(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { sourceTestId, name, description, kind } = req.body;

    // Validate required inputs
    if (!sourceTestId || !name) {
      res.status(400).json({
        success: false,
        error: 'sourceTestId and name are required',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Saving test case', { sourceTestId, name, userId });

    const result = await RegressionSaveService.saveTestCase({
      sourceTestId,
      userId,
      name,
      description,
      kind: kind || 'standalone',
    });

    res.json({
      success: true,
      data: {
        savedTestCaseId: result.savedTestCaseId,
        projectId: result.projectId,
        replayStrategy: result.replayStrategy,
        parametersCount: result.parametersCount,
        message: 'Test case saved successfully',
        nextActions: [
          `Run test case: POST /api/v1/regression/run with savedTestCaseId="${result.savedTestCaseId}"`,
          `Add to suite: POST /api/v1/regression/suites with testCaseIds=["${result.savedTestCaseId}"]`,
        ],
      },
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Test case saved successfully', {
      savedTestCaseId: result.savedTestCaseId,
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to save test case', { error });
    handleControllerError(res, error, 'Failed to save test case');
  }
}

/**
 * Create a regression suite
 *
 * @route POST /api/v1/regression/suites
 * @body {string} projectId - Project ID for the suite
 * @body {string} name - Display name for the suite
 * @body {string} [description] - Optional description
 * @body {string[]} testCaseIds - Array of saved test case IDs to include
 * @returns {suiteId, projectId, testCasesCount}
 */
export async function createSuite(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, name, description, testCaseIds } = req.body;

    // Validate required inputs
    if (!projectId || !name || !testCaseIds || !Array.isArray(testCaseIds)) {
      res.status(400).json({
        success: false,
        error: 'projectId, name, and testCaseIds array are required',
      });
      return;
    }

    if (testCaseIds.length === 0) {
      res.status(400).json({
        success: false,
        error: 'testCaseIds array cannot be empty',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Creating suite', { projectId, name, userId });

    const result = await RegressionSaveService.createSuite({
      projectId,
      userId,
      name,
      description,
      testCaseIds,
    });

    res.json({
      success: true,
      data: {
        suiteId: result.suiteId,
        projectId,
        testCasesCount: testCaseIds.length,
        message: 'Suite created successfully',
        nextActions: [
          `Run suite: POST /api/v1/regression/run with suiteId="${result.suiteId}"`,
        ],
      },
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Suite created successfully', {
      suiteId: result.suiteId,
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to create suite', { error });
    handleControllerError(res, error, 'Failed to create suite');
  }
}

/**
 * Run a saved test case or suite
 *
 * @route POST /api/v1/regression/run
 * @body {string} [savedTestCaseId] - ID of saved test case to run
 * @body {string} [suiteId] - ID of suite to run
 * @body {string} [trigger='manual'] - 'manual' or 'chat'
 * @body {object} [parameters] - Runtime parameters for test execution
 * @returns {runId, testId?, testIds?}
 */
export async function runRegression(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId, savedTestCaseId, trigger, parameters } = req.body;

    // Validate that exactly one of suiteId or savedTestCaseId is provided
    if (!suiteId && !savedTestCaseId) {
      res.status(400).json({
        success: false,
        error: 'Either suiteId or savedTestCaseId is required',
      });
      return;
    }

    if (suiteId && savedTestCaseId) {
      res.status(400).json({
        success: false,
        error: 'Cannot specify both suiteId and savedTestCaseId',
      });
      return;
    }

    const userId = getUserId(req);

    logger.info('[REGRESSION_API] Running regression', {
      suiteId,
      savedTestCaseId,
      userId,
    });

    let result: { runId: string; testId?: string; testIds?: string[] };

    if (savedTestCaseId) {
      result = await RegressionRunService.runSavedTestCase({
        savedTestCaseId,
        userId,
        trigger: trigger || 'manual',
        parameters: parameters || {},
      });
    } else {
      result = await RegressionRunService.runSuite({
        suiteId: suiteId!,
        userId,
        trigger: trigger || 'manual',
        parameters: parameters || {},
      });
    }

    res.json({
      success: true,
      data: {
        runId: result.runId,
        testId: result.testId,
        testIds: result.testIds,
        message: suiteId
          ? `Suite run started with ${result.testIds?.length || 0} tests`
          : 'Test case run started',
      },
      timestamp: new Date(),
    });

    logger.info('[REGRESSION_API] Regression run started', { runId: result.runId });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to run regression', { error });
    handleControllerError(res, error, 'Failed to run regression');
  }
}

/**
 * List saved test cases for project
 *
 * @route GET /api/v1/regression/saved-test-cases?projectId=<uuid>
 * @query {string} projectId - Project ID to list test cases for
 * @returns {array} List of saved test cases
 */
export async function listSavedTestCases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const cases = await RegressionRunService.listSavedTestCases(projectId, userId);

    res.json({
      success: true,
      data: cases,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to list saved test cases', { error });
    handleControllerError(res, error, 'Failed to list saved test cases');
  }
}

/**
 * List suites for project
 *
 * @route GET /api/v1/regression/suites?projectId=<uuid>
 * @query {string} projectId - Project ID to list suites for
 * @returns {array} List of regression suites
 */
export async function listSuites(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const suites = await RegressionRunService.listSuites(projectId, userId);

    res.json({
      success: true,
      data: suites,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to list suites', { error });
    handleControllerError(res, error, 'Failed to list suites');
  }
}

/**
 * List runs for project
 *
 * @route GET /api/v1/regression/runs?projectId=<uuid>
 * @query {string} projectId - Project ID to list runs for
 * @returns {array} List of regression runs with status and summary
 */
export async function listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({
        success: false,
        error: 'projectId query parameter is required',
      });
      return;
    }

    const userId = getUserId(req);

    const runs = await RegressionRunService.listRuns(projectId, userId);

    res.json({
      success: true,
      data: runs,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[REGRESSION_API] Failed to list runs', { error });
    handleControllerError(res, error, 'Failed to list runs');
  }
}

/**
 * Centralized error handler for regression controller
 * Maps error types to appropriate HTTP status codes and formats responses consistently
 *
 * @param res - Express response object
 * @param error - Error to handle
 * @param defaultMessage - Default error message if error type is unknown
 */
function handleControllerError(
  res: Response,
  error: unknown,
  defaultMessage: string
): void {
  // Don't send response if already sent
  if (res.headersSent) {
    logger.warn('[REGRESSION_API] Response already sent, cannot send error response');
    return;
  }

  // Handle known error types
  if (error instanceof NotFoundError) {
    res.status(404).json({
      success: false,
      error: 'Resource not found',
      message: error.message,
    });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({
      success: false,
      error: 'Validation error',
      message: error.message,
    });
    return;
  }

  // Handle generic errors
  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
