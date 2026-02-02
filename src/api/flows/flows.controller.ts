/**
 * Flows Controller
 * API endpoints for test flows CRUD
 */

import { supabaseAdmin } from '@/db/supabase';
import { FlowService } from '@/services/testing/flows/flow.service';
import { ModuleService } from '@/services/testing/modules/module.service';
import { DefaultSuiteService } from '@/services/testing/regression/default-suite.service';
import { NotFoundError, ValidationError } from '@/types';
import type { PlatformKey } from '@/types/testing.types';
import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

/**
 * Create a new test flow
 * Accepts either suiteId (direct) or moduleId (resolves default suite)
 * When moduleId is provided, also creates 1 initial empty test case
 */
export async function createFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId, moduleId, name, description, flowType, tags, priority, preconditions, expectedResult, baseUrl } = req.body;

    // Validate: either suiteId or moduleId required (but not both)
    if (!suiteId && !moduleId) {
      res.status(400).json({ success: false, error: 'Either suiteId or moduleId is required' });
      return;
    }

    if (suiteId && moduleId) {
      res.status(400).json({ success: false, error: 'Provide either suiteId or moduleId, not both' });
      return;
    }

    if (!name) {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }

    const userId = getUserId(req);

    // Resolve suiteId from moduleId if needed
    let resolvedSuiteId = suiteId;
    let platformKey: PlatformKey | undefined;
    let projectId: string | undefined;

    if (moduleId) {
      // Get module info (includes project_id and platform_key)
      const module = await ModuleService.getById(moduleId, userId);
      if (!module) {
        res.status(404).json({ success: false, error: 'Module not found' });
        return;
      }

      platformKey = module.platformKey;
      projectId = module.projectId;

      resolvedSuiteId = await DefaultSuiteService.ensureDefaultSuite(moduleId, userId);
      logger.info('[FLOWS_API] Resolved default suite for module', {
        moduleId,
        suiteId: resolvedSuiteId,
        platformKey,
      });
    }

    // Create flow
    const flow = await FlowService.create({
      suiteId: resolvedSuiteId,
      userId,
      name,
      description,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
    });

    // Create initial test case if moduleId was provided
    // UI test cases are now created in intent_test_cases (unified table)
    let createdTestCaseId: string | undefined;

    if (moduleId && platformKey && projectId) {
      if (platformKey === 'web_ui') {
        // Sanitize baseUrl if provided
        let sanitizedBaseUrl: string | null = null;
        if (baseUrl && typeof baseUrl === 'string' && baseUrl.trim()) {
          try {
            sanitizedBaseUrl = sanitizeUrl(baseUrl);
          } catch (error) {
            logger.warn('[FLOWS_API] Invalid baseUrl provided, skipping URL fields', {
              baseUrl,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Create empty UI test case in intent_test_cases (unified table)
        const { data: testCase, error: testCaseError } = await supabaseAdmin
          .from('intent_test_cases')
          .insert({
            project_id: projectId,
            user_id: userId,
            name: name, // Use flow name as default
            flow_id: flow.id,
            // URL fields (from baseUrl if provided)
            start_url: sanitizedBaseUrl,
            url: sanitizedBaseUrl,
            // Lifecycle/classification
            status: 'draft',
            kind: 'regression_member',
            // Replay fields (empty for new flow)
            replay_strategy: 'commands',
            commands: [],
            steps_json: [],
            // Metadata fields
            preconditions: preconditions || [],
            setup_steps: [],
            teardown_steps: [],
            tags: tags || [],
            priority: priority || null,
            expected_result: expectedResult || null,
            depends_on: [],
          })
          .select('id')
          .single();

        if (testCaseError) {
          logger.error('[FLOWS_API] Failed to create initial test case', {
            error: testCaseError,
            flowId: flow.id,
          });
          // Don't fail the whole request, just log the error
        } else {
          createdTestCaseId = testCase.id;
          logger.info('[FLOWS_API] Created initial intent test case', {
            testCaseId: createdTestCaseId,
            flowId: flow.id,
            hasBaseUrl: !!sanitizedBaseUrl,
          });
        }
      } else {
        // For API platform, defer test case creation (requires endpoint_id)
        logger.info('[FLOWS_API] Skipping initial test case creation for API platform', {
          flowId: flow.id,
          platformKey,
        });
      }
    }

    res.json({
      success: true,
      data: {
        flow,
        createdTestCaseId: createdTestCaseId || null,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to create flow', { error });
    handleError(res, error, 'Failed to create flow');
  }
}

/**
 * Get a flow by ID
 */
export async function getFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const flow = await FlowService.getById(id, userId);
    if (!flow) {
      res.status(404).json({ success: false, error: 'Flow not found' });
      return;
    }

    res.json({ success: true, data: flow, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to get flow', { error });
    handleError(res, error, 'Failed to get flow');
  }
}

/**
 * List flows for a suite
 */
export async function listFlows(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId } = req.query;

    if (!suiteId || typeof suiteId !== 'string') {
      res.status(400).json({ success: false, error: 'suiteId is required' });
      return;
    }

    const userId = getUserId(req);

    const flows = await FlowService.listBySuite(suiteId, userId);

    res.json({ success: true, data: flows, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to list flows', { error });
    handleError(res, error, 'Failed to list flows');
  }
}

/**
 * Update a flow
 */
export async function updateFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, flowType, tags, priority, preconditions, expectedResult, orderIndex } = req.body;
    const userId = getUserId(req);

    const flow = await FlowService.update({
      id,
      userId,
      name,
      description,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
      orderIndex,
    });

    res.json({ success: true, data: flow, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to update flow', { error });
    handleError(res, error, 'Failed to update flow');
  }
}

/**
 * Delete a flow
 */
export async function deleteFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await FlowService.delete(id, userId);

    res.json({ success: true, message: 'Flow deleted', timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to delete flow', { error });
    handleError(res, error, 'Failed to delete flow');
  }
}

/**
 * Reorder flows within a suite
 */
export async function reorderFlows(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId, flowIds } = req.body;

    if (!suiteId || !flowIds || !Array.isArray(flowIds)) {
      res.status(400).json({ success: false, error: 'suiteId and flowIds array are required' });
      return;
    }

    const userId = getUserId(req);

    await FlowService.reorder(suiteId, flowIds, userId);

    res.json({ success: true, message: 'Flows reordered', timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to reorder flows', { error });
    handleError(res, error, 'Failed to reorder flows');
  }
}

function handleError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) return;

  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, error: 'Not found', message: error.message });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({ success: false, error: 'Validation error', message: error.message });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
