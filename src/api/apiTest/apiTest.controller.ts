import { Request, Response } from 'express';
import { executeApiTest } from '@/services/testing/api/apiTest.service';
import { ApiTestHistoryService } from '@/services/testing/api/api-test-history.service';
import { logger } from '@/utils/core/logger';
import { ApiTestRequest } from '@/types';

/**
 * Handle API test request
 */
export const runApiTest = async (req: Request, res: Response): Promise<void> => {
  try {
    const { method, url, headers, body, expectedStatus, timeout } = req.body as ApiTestRequest;

    // Validate required fields
    if (!method || !url) {
      res.status(400).json({
        success: false,
        error: 'Method and URL are required',
      });
      return;
    }

    logger.info('API test request received', { method, url, expectedStatus });

    // Execute API test
    const result = await executeApiTest({
      method,
      url,
      headers,
      body,
      expectedStatus,
      timeout,
    });

    res.json(result);
  } catch (error) {
    logger.error('API test error:', error);
    res.status(500).json({
      success: false,
      error: 'API test failed',
      status: 0,
      durationMs: 0,
      responseHeaders: {},
      responseBody: null,
    });
  }
};

/**
 * Get all API tests for current user
 */
export const getApiTests = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    // Validate pagination parameters
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const result = await ApiTestHistoryService.getApiTestsByUser(userId, page, limit);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[API_TEST] Failed to get API tests', {
      error: error instanceof Error ? error.message : String(error),
      userId: req.user?.id,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get API tests',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Get API test by ID
 */
export const getApiTestById = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: 'Test ID is required',
      });
      return;
    }

    const result = await ApiTestHistoryService.getApiTestById(id, userId);

    if (!result.data) {
      res.status(404).json({
        success: false,
        error: 'API test not found',
      });
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    logger.error('[API_TEST] Failed to get API test by ID', {
      error: error instanceof Error ? error.message : String(error),
      testId: req.params.id,
      userId: req.user?.id,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get API test',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Get API tests by project
 */
export const getApiTestsByProject = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { projectId } = req.params;

    if (!projectId) {
      res.status(400).json({
        success: false,
        error: 'Project ID is required',
      });
      return;
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const result = await ApiTestHistoryService.getApiTestsByProject(projectId, userId, page, limit);

    res.status(200).json(result);
  } catch (error) {
    logger.error('[API_TEST] Failed to get API tests by project', {
      error: error instanceof Error ? error.message : String(error),
      projectId: req.params.projectId,
      userId: req.user?.id,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get API tests',
      timestamp: new Date().toISOString(),
    });
  }
};
