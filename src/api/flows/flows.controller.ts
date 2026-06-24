/**
 * Flows Controller
 * API endpoints for test flows CRUD
 */

import { supabaseAdmin } from '@/db/supabase';
import { FlowService } from '@/services/testing/flows/flow.service';
import { ModuleService } from '@/services/testing/modules/module.service';
import { getProjectMobileApp } from '@/services/mobile/project-mobile-app.helper';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { emitFlowMutated, emitTestCaseMutated } from '@/websocket/helpers/project-mutation-emit';
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
    const { moduleId, name, flowType, platform, tags, priority, preconditions, expectedResult, baseUrl, settings, mobileVariantLabel } = req.body;

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

    // Mobile gate: validate the package name when an app IS uploaded for
    // the requested platform.
    //
    // History — this gate used to also reject flow creation when no
    // binary was uploaded at all (`MOBILE_APP_MISSING`). That was too
    // strict for the dual-platform workflow: teams routinely scaffold
    // iOS test cases BEFORE the first .ipa is built and signed, using
    // the editor on a bare simulator to validate the runner + WDA path.
    // The editor (frontend `TestSuitesMobile.tsx`) and runner already
    // handle the no-binary case gracefully — editor shows a warning
    // toast and warmup boots a blank simulator. Blocking flow creation
    // here would force a chicken-and-egg state: you can't scaffold iOS
    // tests without an .ipa, and you can't validate that the runner can
    // host iOS tests without a scaffolded flow.
    //
    // We DO still reject when a binary exists but its packageName is
    // missing — that's a known-broken upload (rare; happens for very
    // old slot rows where packageName was optional at upload time).
    // The check_package fast path would loop forever in that state.
    if (isMobilePlatform) {
      const { data: projectRow, error: projectErr } = await supabaseAdmin
        .from('projects')
        .select('settings')
        .eq('id', projectId)
        .single();
      if (projectErr || !projectRow) {
        res.status(404).json({ success: false, error: 'Project not found' });
        return;
      }
      const PLATFORM_MAP: Record<string, MobilePlatform> = { mobile_ios: 'ios', mobile_flutter: 'flutter' };
      const mobilePlatform: MobilePlatform = PLATFORM_MAP[platform ?? ''] ?? 'android';
      const mobileApp = getProjectMobileApp(projectRow.settings as Record<string, unknown> | undefined, mobilePlatform);
      if (mobileApp?.storagePath
        && (!mobileApp.packageName || !String(mobileApp.packageName).trim())) {
        res.status(400).json({
          success: false,
          error: 'The uploaded mobile app has no package name. Set it in settings before creating a mobile test case.',
          code: 'MOBILE_APP_PACKAGE_NAME_MISSING',
        });
        return;
      }
    }

    // Create flow
    const flow = await FlowService.create({
      moduleId,
      userId,
      name,
      platform,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
      ...(mobileVariantLabel !== undefined ? { mobileVariantLabel } : {}),
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

    // Live cache invalidation for other open editors (best-effort).
    emitFlowMutated({ projectId, action: 'created', id: flow.id, name, moduleId });
    if (createdTestCaseId) {
      emitTestCaseMutated({
        projectId,
        action: 'created',
        id: createdTestCaseId,
        name,
        flowId: flow.id,
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
 * Resolve a flow's projectId via its module — flows don't carry projectId
 * directly. Best-effort: returns null on any failure so emit callers skip.
 */
async function resolveFlowProjectId(moduleId: string, userId: string): Promise<string | null> {
  try {
    const module = await ModuleService.getById(moduleId, userId);
    return module?.projectId ?? null;
  } catch {
    return null;
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
    const { name, moduleId, flowType, tags, priority, preconditions, expectedResult, orderIndex, mobileVariantLabel } = req.body;
    const userId = getUserId(req);

    const flow = await FlowService.update({
      id,
      userId,
      name,
      moduleId,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
      orderIndex,
      ...(mobileVariantLabel !== undefined ? { mobileVariantLabel } : {}),
    });

    const projectId = await resolveFlowProjectId(flow.moduleId, userId);
    if (projectId) {
      emitFlowMutated({
        projectId,
        action: 'updated',
        id: flow.id,
        name: flow.name,
        moduleId: flow.moduleId,
      });
    }

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

    const projectId = await resolveFlowProjectId(flow.moduleId, userId);
    if (projectId) {
      emitFlowMutated({
        projectId,
        action: 'created',
        id: flow.id,
        name: flow.name,
        moduleId: flow.moduleId,
      });
    }

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

    // Capture module/project BEFORE delete — needed for the invalidation emit.
    let projectId: string | null = null;
    let moduleId: string | undefined;
    try {
      const existing = await FlowService.getById(id, userId);
      if (existing) {
        moduleId = existing.moduleId;
        projectId = await resolveFlowProjectId(existing.moduleId, userId);
      }
    } catch {
      // Best-effort — proceed with delete regardless.
    }

    await FlowService.delete(id, userId);

    if (projectId) {
      emitFlowMutated({ projectId, action: 'deleted', id, moduleId });
    }

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
