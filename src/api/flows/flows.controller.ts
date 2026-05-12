/**
 * Flows Controller
 * API endpoints for test flows CRUD
 */

import { supabaseAdmin } from '@/db/supabase';
import { FlowService } from '@/services/testing/flows/flow.service';
import { ModuleService } from '@/services/testing/modules/module.service';
import { NotFoundError, ValidationError } from '@/types';
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
 * Accepts moduleId and creates a flow under that module
 * Also creates 1 initial empty test case
 */
export async function createFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { moduleId, name, description, flowType, platform, tags, priority, preconditions, expectedResult, baseUrl, settings } = req.body;

    // Validate moduleId required
    if (!moduleId) {
      res.status(400).json({ success: false, error: 'moduleId is required' });
      return;
    }

    if (!name) {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }

    const userId = getUserId(req);

    // Get module info (includes project_id and platform_key)
    const module = await ModuleService.getById(moduleId, userId);
    if (!module) {
      res.status(404).json({ success: false, error: 'Module not found' });
      return;
    }

    const platformKey = module.platformKey;
    const projectId = module.projectId;

    const isMobilePlatform = typeof platform === 'string' && platform.startsWith('mobile_');

    // Create flow
    const flow = await FlowService.create({
      moduleId,
      userId,
      name,
      description,
      platform,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
    });

    // Create initial test case
    // UI test cases (web + mobile) are created in intent_test_cases (unified table)
    let createdTestCaseId: string | undefined;

    if (platformKey === 'web_ui' || isMobilePlatform) {
        // Sanitize baseUrl if provided (only relevant for web flows)
        let sanitizedBaseUrl: string | null = null;
        if (!isMobilePlatform && baseUrl && typeof baseUrl === 'string' && baseUrl.trim()) {
          try {
            sanitizedBaseUrl = sanitizeUrl(baseUrl);
          } catch (error) {
            logger.warn('[FLOWS_API] Invalid baseUrl provided, skipping URL fields', {
              baseUrl,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Build insert payload
        const insertPayload: Record<string, any> = {
          project_id: projectId,
          user_id: userId,
          name,
          flow_id: flow.id,
          start_url: sanitizedBaseUrl,
          url: sanitizedBaseUrl,
          status: 'draft',
          kind: 'regression_member',
          replay_strategy: 'commands',
          commands: [],
          steps_json: [],
          preconditions: preconditions || [],
          // Phase A (May 2026) — setup_steps / teardown_steps inline-on-test-case
          // are being deprecated in favour of `scenario_setup` test_resource
          // bindings (which compile into the same `phase:'setup'` prologue at
          // run time but are reusable across many tests). We stop seeding the
          // empty literals here — the columns still exist and default to `[]`
          // at the DB level, so no read path breaks. Phase B will drop the
          // remaining stitchPhases() callsites; Phase C will drop the columns.
          tags: tags || [],
          priority: priority || null,
          expected_result: expectedResult || null,
          depends_on: [],
        };

        if (isMobilePlatform) {
          insertPayload.platform = platform; // 'mobile_android' | 'mobile_ios'
        }

        // Auto-attach workspace-configured resources matching this flow's
        // scope (e.g. Login for this domain). See test_resource feature.
        //
        // mobile_flutter is intentionally skipped — no resource adapter
        // supports it yet; falling back to web/ios defaults would silently
        // bind the wrong profile.
        const scopePlatform: 'web' | 'android' | 'ios' | null =
          !isMobilePlatform
            ? 'web'
            : platform === 'mobile_android'
              ? 'android'
              : platform === 'mobile_ios'
                ? 'ios'
                : null;
        if (scopePlatform !== null) {
          try {
            const { enrichBindingsWithDefaults } = await import(
              '@/services/test-resource/test-resource.service'
            );
            const bindings = await enrichBindingsWithDefaults({
              userId,
              projectId,
              bindings: [],
              scope: {
                platform: scopePlatform,
                url: sanitizedBaseUrl,
              },
            });
            if (bindings.length > 0) {
              insertPayload.resource_bindings = bindings;
            }
          } catch (enrichErr) {
            logger.warn('[FLOWS_API] Resource enrichment failed (non-fatal)', {
              error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr),
            });
          }
        }

        const { data: testCase, error: testCaseError } = await supabaseAdmin
          .from('intent_test_cases')
          .insert(insertPayload)
          .select('id')
          .single();

        if (testCaseError) {
          logger.error('[FLOWS_API] Failed to create initial test case, rolling back flow', {
            error: testCaseError,
            flowId: flow.id,
          });
          try {
            await FlowService.delete(flow.id, userId);
            logger.info('[FLOWS_API] Rolled back orphaned flow', { flowId: flow.id });
          } catch (rollbackError) {
            logger.error('[FLOWS_API] Failed to rollback orphaned flow', {
              flowId: flow.id,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
          res.status(500).json({
            success: false,
            error: 'Failed to create flow with initial test case',
            details: testCaseError.message,
          });
          return;
        } else {
          createdTestCaseId = testCase.id;
          logger.info('[FLOWS_API] Created initial intent test case', {
            testCaseId: createdTestCaseId,
            flowId: flow.id,
            platform: isMobilePlatform ? platform : 'web',
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
 * List flows for a module
 */
export async function listFlows(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { moduleId } = req.query;

    if (!moduleId || typeof moduleId !== 'string') {
      res.status(400).json({ success: false, error: 'moduleId is required' });
      return;
    }

    const userId = getUserId(req);

    const flows = await FlowService.listByModule(moduleId, userId);

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
 * Duplicate a flow (deep-copy flow + all intent_test_cases).
 * Appends " (Copy)" to the flow name.
 */
export async function duplicateFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const flow = await FlowService.duplicate(id, userId);

    res.json({ success: true, data: { flow }, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to duplicate flow', { error });
    handleError(res, error, 'Failed to duplicate flow');
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
 * Reorder flows within a module
 */
export async function reorderFlows(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { moduleId, flowIds } = req.body;

    if (!moduleId || !flowIds || !Array.isArray(flowIds)) {
      res.status(400).json({ success: false, error: 'moduleId and flowIds array are required' });
      return;
    }

    const userId = getUserId(req);

    await FlowService.reorder(moduleId, flowIds, userId);

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
