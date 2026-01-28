/**
 * Preview Controller
 * API endpoints for step editor preview and intent test cases
 */

import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { getPreviewSessionService } from '@/services/testing/ui/preview/preview-session.service';
import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { Request, Response } from 'express';

// ============================================================================
// PREVIEW SESSION ENDPOINTS
// ============================================================================

/**
 * Start a preview session
 * POST /api/v1/preview/start
 */
export async function startPreview(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { projectId, startUrl } = req.body;

    if (!projectId || !startUrl) {
      res.status(400).json({ error: 'Missing required fields: projectId, startUrl' });
      return;
    }

    const safeStartUrl = sanitizeUrl(String(startUrl));

    const sessionService = getPreviewSessionService();
    const result = await sessionService.startSession({
      userId,
      projectId,
      startUrl: safeStartUrl,
    });

    // Get viewport metadata for coordinate mapping
    const viewportMeta = sessionService.getViewportMetadata(result.previewSessionId, userId);

    res.json({
      success: true,
      data: {
        ...result,
        viewport: viewportMeta ? {
          width: viewportMeta.width,
          height: viewportMeta.height,
        } : { width: 1280, height: 720 },
        devicePixelRatio: viewportMeta?.devicePixelRatio || 1,
      },
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to start preview', {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : 'Failed to start preview';
    const statusCode = (error as any)?.name === 'ValidationError' ? 400 : 500;
    res.status(statusCode).json({ error: message });
  }
}

/**
 * Stop a preview session
 * POST /api/v1/preview/stop
 */
export async function stopPreview(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { previewSessionId } = req.body;

    if (!previewSessionId) {
      res.status(400).json({ error: 'Missing required field: previewSessionId' });
      return;
    }

    const sessionService = getPreviewSessionService();
    await sessionService.stopSession(previewSessionId, userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to stop preview', {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : 'Failed to stop preview';
    const statusCode = message.toLowerCase().includes('forbidden') ? 403 : 500;
    res.status(statusCode).json({ error: message });
  }
}

// ============================================================================
// INTENT TEST CASE ENDPOINTS
// ============================================================================

/**
 * Create a new intent test case
 * POST /api/v1/preview/intent-test-cases
 */
export async function createIntentTestCase(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { projectId, name, description, startUrl, steps } = req.body;

    if (!projectId || !name || !startUrl) {
      res.status(400).json({ error: 'Missing required fields: projectId, name, startUrl' });
      return;
    }

    const safeStartUrl = sanitizeUrl(String(startUrl));

    const testCase = await IntentTestCaseService.create({
      projectId,
      userId,
      name,
      description,
      startUrl: safeStartUrl,
      steps: steps || [],
    });

    res.status(201).json({
      success: true,
      data: testCase,
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to create intent test case', {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : 'Failed to create test case';
    const statusCode = (error as any)?.name === 'ValidationError' ? 400 : 500;
    res.status(statusCode).json({ error: message });
  }
}

/**
 * Get an intent test case by ID
 * GET /api/v1/preview/intent-test-cases/:id
 */
export async function getIntentTestCase(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    const testCase = await IntentTestCaseService.getById(id, userId);

    if (!testCase) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }

    res.json({
      success: true,
      data: testCase,
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to get intent test case', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to get test case',
    });
  }
}

/**
 * List intent test cases for a project
 * GET /api/v1/preview/intent-test-cases?projectId=...
 */
export async function listIntentTestCases(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { projectId, limit, offset } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: 'Missing required query param: projectId' });
      return;
    }

    const result = await IntentTestCaseService.listByProject({
      projectId,
      userId,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json({
      success: true,
      data: result.items,
      total: result.total,
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to list intent test cases', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list test cases',
    });
  }
}

/**
 * Update an intent test case
 * PATCH /api/v1/preview/intent-test-cases/:id
 */
export async function updateIntentTestCase(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { name, description, startUrl, steps } = req.body;

    const testCase = await IntentTestCaseService.update({
      id,
      userId,
      name,
      description,
      startUrl: startUrl !== undefined ? sanitizeUrl(String(startUrl)) : undefined,
      steps,
    });

    res.json({
      success: true,
      data: testCase,
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to update intent test case', {
      error: error instanceof Error ? error.message : String(error),
    });
    const message = error instanceof Error ? error.message : 'Failed to update test case';
    const statusCode = (error as any)?.name === 'ValidationError' ? 400 : 500;
    res.status(statusCode).json({ error: message });
  }
}

/**
 * Delete an intent test case
 * DELETE /api/v1/preview/intent-test-cases/:id
 */
export async function deleteIntentTestCase(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;

    await IntentTestCaseService.delete(id, userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to delete intent test case', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to delete test case',
    });
  }
}
