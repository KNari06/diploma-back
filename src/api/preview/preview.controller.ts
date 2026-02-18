/**
 * Preview Controller
 * API endpoints for step editor preview and intent test cases
 */

import { supabaseAdmin } from '@/db/supabase';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { IntentStepConverterService } from '@/services/testing/ui/preview/intent-step-converter.service';
import { injectAutoWaitForSteps } from '@/services/testing/ui/preview/auto-wait-for.utils';
import { getPreviewSessionService } from '@/services/testing/ui/preview/preview-session.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
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

  // Get flow with its module to check project
  const { data: flow, error } = await supabaseAdmin
    .from('test_flows')
    .select('id, user_id, module_id, test_modules(project_id)')
    .eq('id', flowId)
    .single();

  if (error || !flow) {
    return { valid: false, error: 'Flow not found' };
  }

  // Check ownership
  if (flow.user_id !== userId) {
    return { valid: false, error: 'Flow does not belong to user' };
  }

  // Check project match via module
  const moduleProjectId = (flow as any).test_modules?.project_id;
  if (moduleProjectId !== projectId) {
    return { valid: false, error: 'Flow does not belong to the specified project' };
  }

  return { valid: true };
}

// NOTE: validateSavedTestCaseLink removed - intent_test_cases is now the unified table
// and doesn't reference saved_test_cases anymore.

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

    const { projectId, name, description, startUrl, steps, flowId } = req.body;

    logger.info('[PREVIEW_CONTROLLER] Creating intent test case', {
      userId,
      projectId,
      hasName: name !== undefined,
      hasDescription: description !== undefined,
      hasStartUrl: startUrl !== undefined,
      hasSteps: steps !== undefined,
      stepsCount: Array.isArray(steps) ? steps.length : undefined,
      flowId: flowId || null,
    });

    if (!projectId || !name) {
      res.status(400).json({ error: 'Missing required fields: projectId, name' });
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

    // startUrl is optional now (flow-created cases may not have URL initially)
    const safeStartUrl = startUrl ? sanitizeUrl(String(startUrl)) : undefined;

    const testCase = await IntentTestCaseService.create({
      projectId,
      userId,
      name,
      description,
      startUrl: safeStartUrl,
      steps: steps || [],
      flowId,
    });

    res.status(201).json({
      success: true,
      data: testCase,
      // Compatibility fields for clients that expect id at top-level
      // (some frontends unwrap Axios response differently)
      id: testCase.id,
      intentTestCaseId: testCase.id,
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
    const { name, description, startUrl, url, steps, flowId, status, kind, tags, priority } = req.body;

    logger.info('[PREVIEW_CONTROLLER] Updating intent test case', {
      intentTestCaseId: id,
      userId,
      fieldsProvided: {
        name: name !== undefined,
        description: description !== undefined,
        startUrl: startUrl !== undefined,
        url: url !== undefined,
        steps: steps !== undefined,
        flowId: flowId !== undefined,
        status: status !== undefined,
        kind: kind !== undefined,
        tags: tags !== undefined,
        priority: priority !== undefined,
      },
    });

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

    /**
     * Normalize optional URL fields for update.
     * - undefined => do not update field
     * - null/"" => clear field (set NULL in DB)
     * - string => sanitize + store
     */
    const normalizeOptionalUrl = (value: unknown): string | null | undefined => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      if (!trimmed) return null;
      return sanitizeUrl(trimmed);
    };

    // Validate URL types early (avoid accidental 500s on weird payloads)
    if (
      startUrl !== undefined &&
      startUrl !== null &&
      typeof startUrl !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid startUrl type (expected string|null|undefined)' });
      return;
    }
    if (url !== undefined && url !== null && typeof url !== 'string') {
      res.status(400).json({ error: 'Invalid url type (expected string|null|undefined)' });
      return;
    }

    // Validate status/kind if provided (simple guardrails)
    if (status !== undefined && !['draft', 'published', 'archived'].includes(String(status))) {
      res.status(400).json({ error: 'Invalid status (expected draft|published|archived)' });
      return;
    }
    if (kind !== undefined && !['standalone', 'regression_member'].includes(String(kind))) {
      res.status(400).json({ error: 'Invalid kind (expected standalone|regression_member)' });
      return;
    }
    if (
      priority !== undefined &&
      priority !== null &&
      !['critical', 'high', 'medium', 'low'].includes(String(priority))
    ) {
      res.status(400).json({ error: 'Invalid priority (expected critical|high|medium|low)' });
      return;
    }

    // Normalize steps to avoid DB NOT NULL violation (steps_json is NOT NULL)
    let normalizedSteps: any = undefined;
    if (steps !== undefined) {
      if (steps === null) {
        normalizedSteps = [];
      } else if (Array.isArray(steps)) {
        // Migrate legacy 'fill' to 'type' (defense-in-depth)
        normalizedSteps = steps.map((step: any) => {
          if (step?.type === 'fill') {
            return { ...step, type: 'type' };
          }
          return step;
        });

        // V5: Auto-inject wait_for steps where navigation occurred
        // This ensures stability during background runs without requiring user to add waits manually
        normalizedSteps = injectAutoWaitForSteps(normalizedSteps);
      } else {
        res.status(400).json({ error: 'Invalid steps (expected array|null|undefined)' });
        return;
      }
    }

    const testCase = await IntentTestCaseService.update({
      id,
      userId,
      name,
      description,
      startUrl: normalizeOptionalUrl(startUrl),
      url: normalizeOptionalUrl(url),
      steps: normalizedSteps,
      flowId,
      status: status !== undefined ? (String(status) as any) : undefined,
      kind: kind !== undefined ? (String(kind) as any) : undefined,
      tags: Array.isArray(tags) ? tags : undefined,
      priority: priority !== undefined && priority !== null ? (String(priority) as any) : undefined,
    });

    logger.info('[PREVIEW_CONTROLLER] Successfully updated intent test case', {
      intentTestCaseId: id,
      updatedFields: Object.keys({
        name, description, startUrl, url, steps, flowId, status, kind, tags, priority
      }).filter(k => (req.body as any)[k] !== undefined),
    });

    // IMPORTANT for Frontend: response.data.stepsJson may contain auto-inserted
    // wait_for steps. Frontend MUST replace local editorSteps with this value
    // to show the user the complete step list including auto-waits.
    res.json({
      success: true,
      data: testCase,
      // Compatibility fields for clients that expect id at top-level
      id: testCase.id,
      intentTestCaseId: testCase.id,
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

// ============================================================================
// INTENT TEST CASE RUN ENDPOINT
// ============================================================================

/**
 * Run an intent test case
 * POST /api/v1/preview/intent-test-cases/:id/run
 * 
 * Flow:
 * 1. Load IntentTestCase from DB (steps_json)
 * 2. Convert IntentSteps to PlaywrightCommands (dumb converter)
 * 3. Call ManualTestService.runTest() with commands
 * 
 * The CommandExecutor handles:
 * - compiled.locatorPlan execution (if present and valid)
 * - Fallback to smart-locator + self-healing
 */
export async function runIntentTestCase(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const { browsers = ['chromium'], projectId: overrideProjectId } = req.body;

    logger.info('[PREVIEW_CONTROLLER] Running intent test case', {
      intentTestCaseId: id,
      userId,
      browsers,
    });

    // 1. Load the intent test case
    const testCase = await IntentTestCaseService.getById(id, userId);
    if (!testCase) {
      res.status(404).json({ error: 'Intent test case not found' });
      return;
    }

    // 2. Validate project if override provided
    const projectId = overrideProjectId || testCase.projectId;
    if (overrideProjectId && overrideProjectId !== testCase.projectId) {
      // Verify user has access to the override project
      const { data: project, error: projectError } = await supabaseAdmin
        .from('projects')
        .select('id')
        .eq('id', overrideProjectId)
        .eq('user_id', userId)
        .single();

      if (projectError || !project) {
        res.status(403).json({ error: 'Access denied to specified project' });
        return;
      }
    }

    // 3. Check if there are steps to run
    if (!testCase.stepsJson || testCase.stepsJson.length === 0) {
      res.status(400).json({ error: 'No steps to run in this test case' });
      return;
    }

    // 3.5. Check if there's a valid URL (prefer url, fallback to startUrl)
    const targetUrl = testCase.url || testCase.startUrl;
    if (!targetUrl) {
      res.status(400).json({ error: 'No URL specified for this test case' });
      return;
    }

    // 4. Convert IntentSteps to PlaywrightCommands (dumb converter - no resolution)
    // Pass intentTestCaseId for heal persistence
    const commands = IntentStepConverterService.convertToCommands(
      testCase.stepsJson,
      targetUrl,
      id // intentTestCaseId for heal persistence
    );

    logger.info('[PREVIEW_CONTROLLER] Converted intent steps to commands', {
      intentTestCaseId: id,
      stepsCount: testCase.stepsJson.length,
      commandsCount: commands.length,
      stepsWithCompiled: testCase.stepsJson.filter(s => !!s.compiled).length,
    });

    // 5. Build test request for ManualTestService
    // NOTE: Credits check/deduction should be handled by CreditCostTrackerService
    // before calling this endpoint (similar to other test run flows)
    const testRequest = {
      url: targetUrl,
      projectId,
      userId,
      browsers,
      // Pass commands for execution
      commands,
      // Additional metadata
      testGoal: testCase.description || `Run intent test: ${testCase.name}`,
      intelligentMode: false, // Intent tests use pre-defined steps, not AI exploration
      options: {
        mode: 'lite' as const,
      },
      // Link back to intent test case for reporting
      metadata: {
        intentTestCaseId: id,
        intentTestCaseName: testCase.name,
        source: 'intent_test_case',
      },
    };

    // 6. Run the test via ManualTestService
    const result = await ManualTestService.runTest(testRequest as any);

    if (!result.success) {
      logger.error('[PREVIEW_CONTROLLER] Failed to run intent test case', {
        intentTestCaseId: id,
        error: result.message,
      });
      res.status(500).json({ error: result.message || 'Failed to run test' });
      return;
    }

    logger.info('[PREVIEW_CONTROLLER] Intent test case run started', {
      intentTestCaseId: id,
      testId: result.data?.id,
      browsers,
    });

    res.json({
      success: true,
      data: {
        testId: result.data?.id,
        intentTestCaseId: id,
        browsers,
        stepsCount: testCase.stepsJson.length,
        commandsCount: commands.length,
      },
      message: result.message === 'ACTIVE_TEST_REUSED' 
        ? 'Existing active test reused' 
        : 'Test run started',
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Failed to run intent test case', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const message = error instanceof Error ? error.message : 'Failed to run test case';
    const statusCode = (error as any)?.name === 'ValidationError' ? 400 : 500;
    res.status(statusCode).json({ error: message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V2: BATCH RUN - Multiple test cases in parallel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run multiple intent test cases in parallel
 * 
 * POST /api/v1/preview/intent-test-cases/batch-run
 * 
 * Body:
 * {
 *   testCaseIds: string[],   // Array of intent test case IDs to run
 *   browsers?: string[],     // Optional browser override
 *   concurrency?: number     // Max parallel runs (default: 3)
 * }
 */
export async function batchRunIntentTestCases(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { 
      testCaseIds, 
      browsers = ['chromium'], 
      concurrency = 3 
    } = req.body;

    // Validate input
    if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) {
      res.status(400).json({ error: 'testCaseIds must be a non-empty array' });
      return;
    }

    if (testCaseIds.length > 20) {
      res.status(400).json({ error: 'Maximum 20 test cases per batch' });
      return;
    }

    logger.info('[PREVIEW_CONTROLLER] Starting batch run', {
      userId,
      testCaseCount: testCaseIds.length,
      browsers,
      concurrency: Math.min(concurrency, 5),
    });

    // Load all test cases in parallel
    const testCasePromises = testCaseIds.map(id => IntentTestCaseService.getById(id, userId));
    const testCases = await Promise.all(testCasePromises);

    // Filter out not-found cases
    const validTestCases = testCases.filter(tc => tc !== null);
    const notFoundIds = testCaseIds.filter((_, i) => testCases[i] === null);

    if (validTestCases.length === 0) {
      res.status(404).json({ error: 'No valid test cases found' });
      return;
    }

    // Run tests with controlled concurrency
    const maxConcurrency = Math.min(concurrency, 5);
    const results: Array<{
      intentTestCaseId: string;
      testId?: string;
      success: boolean;
      error?: string;
    }> = [];

    // Process in batches for concurrency control
    for (let i = 0; i < validTestCases.length; i += maxConcurrency) {
      const batch = validTestCases.slice(i, i + maxConcurrency);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (testCase) => {
          try {
            // Get target URL (prefer url, fallback to startUrl)
            const targetUrl = testCase!.url || testCase!.startUrl;
            if (!targetUrl) {
              throw new Error(`No URL specified for test case ${testCase!.id}`);
            }

            // Convert steps to commands
            const commands = IntentStepConverterService.convertToCommands(
              testCase!.stepsJson,
              targetUrl,
              testCase!.id
            );

            // Build test request
            const testRequest = {
              url: targetUrl,
              projectId: testCase!.projectId,
              userId,
              browsers,
              commands,
              testGoal: testCase!.description || `Run intent test: ${testCase!.name}`,
              intelligentMode: false,
              options: { mode: 'lite' as const },
              metadata: {
                intentTestCaseId: testCase!.id,
                intentTestCaseName: testCase!.name,
                source: 'intent_test_case',
                batchRun: true,
              },
            };

            // Run test
            const result = await ManualTestService.runTest(testRequest as any);

            return {
              intentTestCaseId: testCase!.id,
              testId: result.data?.id,
              success: result.success,
              error: result.success ? undefined : result.message,
            };
          } catch (error) {
            return {
              intentTestCaseId: testCase!.id,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );

      // Collect results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // This shouldn't happen with our try/catch, but just in case
          results.push({
            intentTestCaseId: 'unknown',
            success: false,
            error: result.reason?.message || 'Unknown error',
          });
        }
      }
    }

    // Summary
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    logger.info('[PREVIEW_CONTROLLER] Batch run completed', {
      userId,
      totalRequested: testCaseIds.length,
      successCount,
      failureCount,
      notFoundCount: notFoundIds.length,
    });

    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: testCaseIds.length,
          started: successCount,
          failed: failureCount,
          notFound: notFoundIds.length,
          notFoundIds,
        },
      },
      message: `Batch run started: ${successCount} tests running, ${failureCount} failed`,
    });
  } catch (error) {
    logger.error('[PREVIEW_CONTROLLER] Batch run failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const message = error instanceof Error ? error.message : 'Batch run failed';
    res.status(500).json({ error: message });
  }
}
