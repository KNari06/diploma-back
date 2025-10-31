import { Request, Response } from 'express';
import { executeApiTest } from '@/services/apiTest.service';
import { logger } from '@/utils/logger';
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
