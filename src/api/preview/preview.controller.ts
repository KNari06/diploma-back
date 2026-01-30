/**
 * Preview Controller
 * API endpoints for step editor preview and intent test cases
 */

import { supabaseAdmin } from '@/db/supabase';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { getPreviewSessionService } from '@/services/testing/ui/preview/preview-session.service';
import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { Request, Response } from 'express';

// ============================================================================
// PREVIEW SESSION ENDPOINTS
// ============================================================================

/**
 * Validation helpers for flow/saved test case linkage
 */

/**
 * Validate flow ownership and project match
 * Returns: { valid: boolean; error?: string }
 */
async function validateFlowLink(params: {
  flowId: string;
  userId: string;
  projectId: string;
}): Promise<{ valid: boolean; error?: string }> {
  const { flowId, userId, projectId } = params;

  // Get flow with its suite to check project
  const { data: flow, error } = await supabaseAdmin
    .from('test_flows')
    .select('id, user_id, suite_id, regression_suites(project_id)')
    .eq('id', flowId)
    .single();

  if (error || !flow) {
    return { valid: false, error: 'Flow not found' };
  }

  // Check ownership
  if (flow.user_id !== userId) {
    return { valid: false, error: 'Flow does not belong to user' };
  }

  // Check project match via suite
  const suiteProjectId = (flow as any).regression_suites?.project_id;
  if (suiteProjectId !== projectId) {
    return { valid: false, error: 'Flow does not belong to the specified project' };
  }

  return { valid: true };
}

/**
 * Validate saved test case ownership and linkage
 * Returns: { valid: boolean; error?: string }
 */
async function validateSavedTestCaseLink(params: {
  savedTestCaseId: string;
  userId: string;
  projectId: string;
  flowId?: string;
}): Promise<{ valid: boolean; error?: string }> {
  const { savedTestCaseId, userId, projectId, flowId } = params;

  // Get saved test case
  const { data: savedTestCase, error } = await supabaseAdmin
    .from('saved_test_cases')
    .select('id, user_id, project_id, flow_id')
    .eq('id', savedTestCaseId)
    .single();

  if (error || !savedTestCase) {
    return { valid: false, error: 'Saved test case not found' };
  }

  // Check ownership
  if (savedTestCase.user_id !== userId) {
    return { valid: false, error: 'Saved test case does not belong to user' };
  }

  // Check project match
  if (savedTestCase.project_id !== projectId) {
    return { valid: false, error: 'Saved test case does not belong to the specified project' };
  }

  // If flowId is provided, check it matches
  if (flowId && savedTestCase.flow_id !== flowId) {
    return { valid: false, error: 'Saved test case is not linked to the specified flow' };
  }

  return { valid: true };
}

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

    const { projectId, name, description, startUrl, steps, flowId, savedTestCaseId } = req.body;

    if (!projectId || !name || !startUrl) {
      res.status(400).json({ error: 'Missing required fields: projectId, name, startUrl' });
      return;
    }

    // Validate flowId if provided
    if (flowId) {
      const flowValidation = await validateFlowLink({ flowId, userId, projectId });
      if (!flowValidation.valid) {
        res.status(400).json({ error: flowValidation.error });
        return;
      }
    }

    // Validate savedTestCaseId if provided
    if (savedTestCaseId) {
      const savedTestCaseValidation = await validateSavedTestCaseLink({
        savedTestCaseId,
        userId,
        projectId,
        flowId,
      });
      if (!savedTestCaseValidation.valid) {
        res.status(400).json({ error: savedTestCaseValidation.error });
        return;
      }
    }

    const safeStartUrl = sanitizeUrl(String(startUrl));

    const testCase = await IntentTestCaseService.create({
      projectId,
      userId,
      name,
      description,
      startUrl: safeStartUrl,
      steps: steps || [],
      flowId,
      savedTestCaseId,
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
 * GET /api/v1/preview/intent-test-cases?projectId=...&flowId=...
 */
export async function listIntentTestCases(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { projectId, flowId, limit, offset } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ error: 'Missing required query param: projectId' });
      return;
    }

    // Validate flowId if provided
    if (flowId && typeof flowId === 'string') {
      const flowValidation = await validateFlowLink({ flowId, userId, projectId });
      if (!flowValidation.valid) {
        res.status(400).json({ error: flowValidation.error });
        return;
      }
    }

    const result = await IntentTestCaseService.listByProject({
      projectId,
      userId,
      flowId: flowId && typeof flowId === 'string' ? flowId : undefined,
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
    const { name, description, startUrl, steps, flowId, savedTestCaseId } = req.body;

    // Get existing test case to get projectId for validation
    const existingTestCase = await IntentTestCaseService.getById(id, userId);
    if (!existingTestCase) {
      res.status(404).json({ error: 'Test case not found' });
      return;
    }

    // Validate flowId if provided
    if (flowId !== undefined) {
      if (flowId) {
        const flowValidation = await validateFlowLink({
          flowId,
          userId,
          projectId: existingTestCase.projectId,
        });
        if (!flowValidation.valid) {
          res.status(400).json({ error: flowValidation.error });
          return;
        }
      }
    }

    // Validate savedTestCaseId if provided
    if (savedTestCaseId !== undefined) {
      if (savedTestCaseId) {
        const savedTestCaseValidation = await validateSavedTestCaseLink({
          savedTestCaseId,
          userId,
          projectId: existingTestCase.projectId,
          flowId: flowId !== undefined ? flowId : existingTestCase.flowId,
        });
        if (!savedTestCaseValidation.valid) {
          res.status(400).json({ error: savedTestCaseValidation.error });
          return;
        }
      }
    }

    const testCase = await IntentTestCaseService.update({
      id,
      userId,
      name,
      description,
      startUrl: startUrl !== undefined ? sanitizeUrl(String(startUrl)) : undefined,
      steps,
      flowId,
      savedTestCaseId,
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
