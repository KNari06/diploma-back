/**
 * CI/CD Mobile Test Controller
 *
 * Endpoints for triggering mobile tests from external CI/CD pipelines.
 * Auth: project-level API key (requireCiApiKey middleware).
 *
 * POST /api/v1/mobile/ci/run         — trigger test run
 * GET  /api/v1/mobile/ci/run/:runId/status — poll for results
 */

import { env } from '@/config/environment/env';
import { QueueManager, redisConnection } from '@/config/infrastructure/queues';
import { dbAdminService, supabaseAdmin } from '@/db/supabase';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import type { MobileIntentStep, MobilePlatform, MobileTestJobData } from '@/services/mobile/mobile-runner.types';
import { MobileAppStorageService, MobileAppMetadata } from '@/services/storage/mobile-app-storage.service';
import { CiRunService } from '@/services/mobile/ci-run.service';
import { ProjectService } from '@/services/core/project.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

// ── Rate limit for APK uploads (1 per project per 5 min) ───────────

const APK_UPLOAD_LOCK_PREFIX = 'ci_apk_upload:';
const APK_UPLOAD_LOCK_TTL = 300; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER CI RUN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/ci/run
 *
 * Trigger a mobile test run from CI/CD.
 * Accepts: savedTestCaseIds, planId, appUrl, callbackUrl, platform.
 */
export async function triggerCiRun(req: Request, res: Response): Promise<void> {
  const project = req.ciProject!;
  const userId = req.ciUserId!;
  const projectId = project.id;
  const workspaceId = project.workspace_id;

  const {
    savedTestCaseIds,
    planId,
    appUrl,
    callbackUrl,
    platform: rawPlatform,
  } = req.body as {
    savedTestCaseIds?: string[];
    planId?: string;
    appUrl?: string;
    callbackUrl?: string;
    platform?: string;
  };

  const platform: MobilePlatform = (rawPlatform === 'ios' ? 'ios' : 'android');
  const browser = platform === 'ios' ? 'mobile-ios' : 'mobile-android';

  try {
    // ── Step 1: Feature flag ───────────────────────────────────────
    if (!env.MOBILE_RUNNER_ENABLED) {
      res.status(503).json({
        success: false,
        error: 'Mobile testing is not enabled',
        message: 'Contact support to enable mobile testing for your workspace.',
      });
      return;
    }

    // ── Step 2: Health check ───────────────────────────────────────
    const client = getMobileRunnerClient();
    const healthy = await client.isHealthy();
    if (!healthy) {
      res.status(503).json({
        success: false,
        error: 'Mobile runner is unavailable',
        message: 'The mobile runner service is currently offline. Please try again later.',
      });
      return;
    }

    // ── Step 3: APK from URL (optional) ────────────────────────────
    let appStoragePath: string | undefined;
    let appOriginalName: string | undefined;
    let appPackage: string | undefined;

    if (appUrl) {
      // Rate limit: 1 APK upload per project per 5 min
      const lockKey = `${APK_UPLOAD_LOCK_PREFIX}${projectId}`;
      const lockResult = await redisConnection.set(lockKey, '1', 'EX', APK_UPLOAD_LOCK_TTL, 'NX');
      if (lockResult !== 'OK') {
        res.status(429).json({
          success: false,
          error: 'APK upload rate limited',
          message: 'Only one APK upload per project per 5 minutes. Please wait and try again.',
        });
        return;
      }

      logger.info('[CI] Downloading APK from URL', { projectId, appUrl });

      try {
        // Download APK from URL
        const appResponse = await fetch(appUrl, {
          signal: AbortSignal.timeout(120_000), // 2 min timeout
        });

        if (!appResponse.ok) {
          res.status(400).json({
            success: false,
            error: `Failed to download APK: HTTP ${appResponse.status}`,
          });
          return;
        }

        const contentLength = appResponse.headers.get('content-length');
        const maxSize = 500 * 1024 * 1024; // 500MB
        if (contentLength && parseInt(contentLength) > maxSize) {
          res.status(400).json({
            success: false,
            error: `APK too large: ${Math.round(parseInt(contentLength) / 1024 / 1024)}MB (max 500MB)`,
          });
          return;
        }

        const arrayBuffer = await appResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Determine filename from URL
        const urlPath = new URL(appUrl).pathname;
        const originalName = path.basename(urlPath) || 'app.apk';

        // Validate extension
        const ext = path.extname(originalName).toLowerCase();
        if (!['.apk', '.ipa', '.aab'].includes(ext)) {
          res.status(400).json({
            success: false,
            error: `Invalid file type: ${ext}. Allowed: .apk, .ipa, .aab`,
          });
          return;
        }

        // Delete previous app if exists
        const existingApp = project.settings?.mobileApp as MobileAppMetadata | undefined;
        if (existingApp?.storagePath) {
          await MobileAppStorageService.deleteApp(existingApp.storagePath);
        }

        // Upload to Supabase Storage
        const multerLikeFile = {
          buffer,
          originalname: originalName,
          size: buffer.length,
        } as Express.Multer.File;

        const metadata = await MobileAppStorageService.uploadApp(multerLikeFile, {
          workspaceId,
          projectId,
          platform,
        });

        // Update project settings
        await ProjectService.updateProject(projectId, userId, {
          settings: {
            mobileApp: metadata as unknown as Record<string, unknown>,
          },
        });

        appStoragePath = metadata.storagePath;
        appOriginalName = metadata.originalName;
        appPackage = metadata.packageName;

        logger.info('[CI] APK uploaded from URL', {
          projectId,
          appUrl,
          storagePath: appStoragePath,
          size: buffer.length,
        });
      } catch (err) {
        // Release rate limit lock on failure
        await redisConnection.del(lockKey);

        if (err instanceof Error && err.name === 'AbortError') {
          res.status(408).json({
            success: false,
            error: 'APK download timed out (2 min limit)',
          });
          return;
        }

        logger.error('[CI] Failed to download/upload APK from URL', {
          projectId,
          appUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(400).json({
          success: false,
          error: `Failed to process APK from URL: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    } else {
      // Use existing project APK
      const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;
      if (mobileApp?.storagePath) {
        appStoragePath = mobileApp.storagePath;
        appOriginalName = mobileApp.originalName;
        appPackage = mobileApp.packageName;
      }
    }

    // ── Step 4: Resolve test cases ─────────────────────────────────
    let testCases: Array<{
      id: string;
      name: string;
      intentSteps: MobileIntentStep[];
    }> = [];

    if (savedTestCaseIds && savedTestCaseIds.length > 0) {
      // Fetch specific saved test cases
      testCases = await fetchTestCaseSteps(savedTestCaseIds, projectId);
    } else if (planId) {
      // Expand regression plan → test cases
      testCases = await expandPlanToMobileTestCases(planId, projectId, userId);
    } else {
      // Fetch ALL saved test cases for project
      testCases = await fetchAllProjectTestCases(projectId);
    }

    if (testCases.length === 0) {
      res.status(400).json({
        success: false,
        error: 'No mobile test cases found',
        message: savedTestCaseIds
          ? 'None of the provided savedTestCaseIds were found or have steps. Make sure the test cases have platform set to "mobile_android" or "mobile_ios".'
          : planId
            ? 'The regression plan contains no mobile test cases with steps. Make sure test cases have platform set to "mobile_android" or "mobile_ios".'
            : 'This project has no saved mobile test cases. Create test cases with platform "mobile_android" or "mobile_ios" in the editor.',
      });
      return;
    }

    // ── Step 5: Create CI run ──────────────────────────────────────
    const runId = await CiRunService.createRun({
      projectId,
      workspaceId,
      userId,
      platform,
      callbackUrl,
    });

    // ── Step 6: Create test records + queue jobs ───────────────────
    const testIds: string[] = [];

    for (const tc of testCases) {
      const testId = uuidv4();
      testIds.push(testId);

      // Create test record in DB
      await dbAdminService.createTest({
        id: testId,
        url: `mobile://${platform}`,
        project_id: projectId,
        user_id: userId,
        status: 'pending',
        browsers: [browser as any],
        options: {
          mode: 'lite',
          platform,
          trigger: 'ci',
          ciRunId: runId,
          appPackage,
        },
        intelligent_mode: false,
        test_goal: `CI: ${tc.name} (${platform})`,
        commands: [],
      });

      // Track in CI run
      await CiRunService.addTestToRun(runId, testId, tc.id, tc.name);

      // Queue BullMQ job
      const jobData: MobileTestJobData = {
        testId,
        userId,
        workspaceId,
        projectId,
        platform,
        browser: browser as 'mobile-android' | 'mobile-ios',
        intentSteps: tc.intentSteps,
        runnerUrl: env.MOBILE_RUNNER_URL,
        runnerApiKey: env.MOBILE_RUNNER_API_KEY,
        appStoragePath,
        appOriginalName,
        appPackage,
        ciRunId: runId,
        callbackUrl,
        testCaseId: tc.id,
        testCaseName: tc.name,
      };

      await QueueManager.addMobileTestRunJob(jobData);
    }

    logger.info('[CI] Run triggered successfully', {
      runId,
      projectId,
      totalTests: testCases.length,
      platform,
      hasAppUrl: !!appUrl,
      hasCallback: !!callbackUrl,
    });

    // ── Step 7: Respond ────────────────────────────────────────────
    res.status(202).json({
      success: true,
      runId,
      testIds,
      totalTests: testCases.length,
      platform,
      statusUrl: `/api/v1/mobile/ci/run/${runId}/status`,
    });
  } catch (error) {
    logger.error('[CI] Failed to trigger run', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to trigger CI run',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GET CI RUN STATUS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/ci/run/:runId/status
 *
 * Poll for CI run results.
 */
export async function getCiRunStatus(req: Request, res: Response): Promise<void> {
  const { runId } = req.params;

  try {
    const status = await CiRunService.getRunStatus(runId);

    if (!status) {
      res.status(404).json({
        success: false,
        error: 'Run not found',
        message: 'CI run not found or expired (runs expire after 24 hours).',
      });
      return;
    }

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    logger.error('[CI] Failed to get run status', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get run status',
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS: Fetch test case steps
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch specific saved test cases by IDs and extract their IntentSteps.
 * Filters to mobile platform test cases only.
 */
async function fetchTestCaseSteps(
  testCaseIds: string[],
  projectId: string,
): Promise<Array<{ id: string; name: string; intentSteps: MobileIntentStep[] }>> {
  const { data: rows, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, platform, steps_json, commands, graph_ref, replay_strategy')
    .in('id', testCaseIds)
    .eq('project_id', projectId)
    .in('platform', ['mobile_android', 'mobile_ios']);

  if (error) {
    logger.error('[CI] Failed to fetch test cases', { error, testCaseIds });
    throw new Error(`Failed to fetch test cases: ${error.message}`);
  }

  return (rows || [])
    .map((row: any) => ({
      id: row.id,
      name: row.name || `Test Case ${row.id.slice(0, 8)}`,
      intentSteps: extractIntentSteps(row),
    }))
    .filter((tc) => tc.intentSteps.length > 0);
}

/**
 * Fetch ALL mobile saved test cases for a project.
 */
async function fetchAllProjectTestCases(
  projectId: string,
): Promise<Array<{ id: string; name: string; intentSteps: MobileIntentStep[] }>> {
  const { data: rows, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, platform, steps_json, commands, graph_ref, replay_strategy')
    .eq('project_id', projectId)
    .in('platform', ['mobile_android', 'mobile_ios'])
    .neq('status', 'archived')
    .limit(50);

  if (error) {
    logger.error('[CI] Failed to fetch project test cases', { error, projectId });
    throw new Error(`Failed to fetch test cases: ${error.message}`);
  }

  return (rows || [])
    .map((row: any) => ({
      id: row.id,
      name: row.name || `Test Case ${row.id.slice(0, 8)}`,
      intentSteps: extractIntentSteps(row),
    }))
    .filter((tc) => tc.intentSteps.length > 0);
}

/**
 * Expand a regression plan to mobile test cases.
 * Reuses RegressionPlanService.expandPlan() → filters UI cases → fetches steps.
 */
async function expandPlanToMobileTestCases(
  planId: string,
  projectId: string,
  userId: string,
): Promise<Array<{ id: string; name: string; intentSteps: MobileIntentStep[] }>> {
  try {
    const { RegressionPlanService } = await import(
      '@/services/testing/plans/regression-plan.service'
    );

    const expanded = await RegressionPlanService.expandPlan(planId);

    // Filter to UI test cases only (mobile doesn't run API tests)
    const uiCases = expanded.filter((tc: any) => tc.testType === 'ui');

    if (uiCases.length === 0) return [];

    const testCaseIds = uiCases.map((tc: any) => tc.testCaseId);
    return fetchTestCaseSteps(testCaseIds, projectId);
  } catch (err) {
    logger.error('[CI] Failed to expand plan', {
      planId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Failed to expand regression plan: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract MobileIntentStep[] from a test case row.
 *
 * Priority:
 *   1. steps_json (IntentStep[] from editor — native format for mobile)
 *   2. commands (Playwright commands — would need conversion, skip for mobile MVP)
 *   3. graph_ref.steps (graph extract — similar to steps_json)
 */
function extractIntentSteps(row: any): MobileIntentStep[] {
  // Prefer steps_json — this is the native IntentStep format used by the editor
  if (Array.isArray(row.steps_json) && row.steps_json.length > 0) {
    return row.steps_json.map((step: any, index: number) => ({
      id: step.id || `step_${index}`,
      type: step.type || 'click',
      description: step.description || step.text || `Step ${index + 1}`,
      value: step.value,
      assertionText: step.assertionText,
      bindingHints: step.bindingHints,
      options: step.options,
      isAutoInjected: step.isAutoInjected,
      expectedOutcome: step.expectedOutcome,
    }));
  }

  // Fallback: graph_ref steps (similar structure)
  if (row.replay_strategy === 'graph_extract' && Array.isArray(row.graph_ref?.steps) && row.graph_ref.steps.length > 0) {
    return row.graph_ref.steps.map((step: any, index: number) => ({
      id: step.id || `step_${index}`,
      type: step.type || 'click',
      description: step.description || `Step ${index + 1}`,
      value: step.value,
      assertionText: step.assertionText,
      bindingHints: step.bindingHints,
      options: step.options,
    }));
  }

  // commands (Playwright format) — not directly usable for mobile runner
  // In the future, a reverse converter could be added
  return [];
}
