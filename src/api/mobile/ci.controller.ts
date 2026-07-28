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
import { getMobileRunnerClient, resolveRunnerUrlForHost } from '@/services/mobile/mobile-runner-client';
import { normaliseHostOverride } from '@/services/mobile/project-mobile-app.helper';
import { isPaidUser } from '@/services/core/plan-access.service';
import { PAID_FEATURE_LABELS } from '@/config/features/feature-labels';
import type { FlutterHostPlatform, MobileIntentStep, MobilePlatform, MobileTestJobData, MobileTestMetadata } from '@/services/mobile/mobile-runner.types';
import {
  MobileAppStorageService,
  MobileAppMetadata,
  trimMobileBuildField,
} from '@/services/storage/mobile-app-storage.service';
import { CiRunService } from '@/services/mobile/ci-run.service';
import { ALLOWED_UPLOAD_EXTENSIONS } from '@/services/mobile/mobile-app.service';
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

  // Plan gate — mobile testing is a Pro feature. The CI path queues the runner
  // job directly (bypassing dispatchMobileTest), so it needs its own check.
  if (!(await isPaidUser(userId))) {
    res.status(403).json({
      success: false,
      error: 'Upgrade required',
      code: 'UPGRADE_REQUIRED',
      message: `${PAID_FEATURE_LABELS.MOBILE_TESTING} is available on paid plans. Upgrade to run mobile tests via CI.`,
    });
    return;
  }

  const {
    savedTestCaseIds,
    planId,
    appUrl,
    callbackUrl,
    platform: rawPlatform,
    // Optional git metadata. When provided alongside appUrl, the
    // resulting APK is also recorded in `mobile_app_builds` so future
    // git-triggered runs on the same branch / commit can re-use it
    // without a fresh download.
    branch: rawBranch,
    commitSha: rawCommitSha,
    buildNumber: rawBuildNumber,
    ciRunId: rawCiRunId,
    // Version identity (one of versionName / versionCode required when
    // appUrl is supplied — same contract as the interactive finalize
    // endpoint). The CI variant is forgiving: a CI pipeline almost
    // always has a versionCode equal to the build number, and pipelines
    // that don't are easy to update once.
    versionName: rawVersionName,
    versionCode: rawVersionCode,
  } = req.body as {
    savedTestCaseIds?: string[];
    planId?: string;
    appUrl?: string;
    callbackUrl?: string;
    platform?: string;
    branch?: string;
    commitSha?: string;
    buildNumber?: string;
    ciRunId?: string;
    versionName?: string;
    versionCode?: number | string;
  };

  // Shared normaliser — same helper as mobile.controller.ts so both upload
  // entry points agree on how to treat blank strings, whitespace, etc.
  const branch = trimMobileBuildField(rawBranch);
  const commitSha = trimMobileBuildField(rawCommitSha);
  const buildNumber = trimMobileBuildField(rawBuildNumber);
  const ciRunId = trimMobileBuildField(rawCiRunId);

  const versionName = typeof rawVersionName === 'string' && rawVersionName.trim()
    ? rawVersionName.trim()
    : undefined;
  let versionCode: number | undefined;
  if (typeof rawVersionCode === 'number' && Number.isFinite(rawVersionCode) && rawVersionCode >= 0) {
    versionCode = Math.floor(rawVersionCode);
  } else if (typeof rawVersionCode === 'string' && /^\d+$/.test(rawVersionCode.trim())) {
    versionCode = Number(rawVersionCode.trim());
  }

  const VALID_PLATFORMS: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  const platform: MobilePlatform = VALID_PLATFORMS[rawPlatform ?? ''] ?? 'android';
  const BROWSER_MAP: Record<MobilePlatform, string> = { android: 'mobile-android', ios: 'mobile-ios', flutter: 'mobile-flutter' };
  const browser = BROWSER_MAP[platform];

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
      // Require version identity — same contract as the interactive
      // finalize endpoint. Without this, every CI build looks identical
      // in the audit trail and `pruneOldBuilds` becomes destructive.
      if (!versionName && versionCode === undefined) {
        res.status(400).json({
          success: false,
          error: 'versionName or versionCode is required so this build can be distinguished from earlier uploads.',
        });
        return;
      }

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

        // Validate extension — single source of truth (shared with the editor
        // upload path), so `.zip` (iOS simulator build) support can't diverge.
        const ext = path.extname(originalName).toLowerCase();
        if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
          res.status(400).json({
            success: false,
            error: `Invalid file type: ${ext}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
          });
          return;
        }

        // Upload to Supabase Storage. The previous APK is NOT deleted
        // here — old binaries live until `pruneOldBuilds` rotates them
        // out, so historical CI runs can still be re-installed for
        // debugging.
        const multerLikeFile = {
          buffer,
          originalname: originalName,
          size: buffer.length,
        } as Express.Multer.File;

        // Resolve the lane ONCE and use it for the storage path, the build
        // row and the prune. This branch used to hardcode the literal
        // 'default' lane while the RESOLVE branch below honours
        // `getProjectDefaultVariant` — so a project that promoted a named
        // variant (say `Production`) wrote every CI upload into `default` and
        // then resolved from `Production`, never seeing its own CI builds.
        const uploadVariantLabel = await MobileAppStorageService.getProjectDefaultVariant(
          projectId,
          platform,
        );

        const metadata = await MobileAppStorageService.uploadApp(multerLikeFile, {
          workspaceId,
          projectId,
          platform,
          variantLabel: uploadVariantLabel,
        });
        // Attach version identity onto the metadata so recordBuild +
        // the legacy slot both carry it. uploadApp doesn't know about
        // version fields (its signature is intentionally narrow).
        if (versionName) metadata.versionName = versionName;
        if (typeof versionCode === 'number') metadata.versionCode = versionCode;

        // Record in `mobile_app_builds` BEFORE updating the legacy slot —
        // if the insert fails we don't want a legacy pointer to a build
        // that isn't audit-traceable.
        const recorded = await MobileAppStorageService.recordBuild(
          metadata,
          { branch, commitSha, buildNumber, ciRunId, source: 'ci' },
          { projectId, workspaceId, uploadedBy: userId, variantLabel: uploadVariantLabel },
        );
        if ('error' in recorded) {
          await redisConnection.del(lockKey);
          const isDup = recorded.error.code === '23505';
          res.status(isDup ? 409 : 500).json({
            success: false,
            error: isDup
              ? 'A build for this commit already exists in this project+platform+variant.'
              : `Failed to record build in version history: ${recorded.error.message || 'unknown database error'}`,
          });
          return;
        }
        const buildRow = recorded;

        // Update project settings (legacy slot — points at the newest
        // upload so the editor warm-up resolves to the right binary).
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
          buildId: buildRow.id,
          versionName,
          versionCode,
          branch,
          commitSha,
        });

        // Fire-and-forget prune — must not block CI response, must not
        // throw. Trims storage to BUILD_HISTORY_LIMIT newest per
        // (project, platform, variant); `ON DELETE SET NULL` keeps execution
        // history rows intact. MUST use the same lane the build landed in, or
        // it prunes a lane this upload never wrote to.
        MobileAppStorageService.pruneOldBuilds(projectId, platform, uploadVariantLabel).catch((err) => {
          logger.warn('[CI] pruneOldBuilds failed (non-fatal)', {
            projectId,
            platform,
            variant: uploadVariantLabel,
            error: err instanceof Error ? err.message : String(err),
          });
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
      // No fresh upload — use the Phase 5 resolver to pick the existing build.
      // Resolve WITHIN the project's configured default variant lane (same as
      // the regression dispatcher's project-default fallback) so a project that
      // promoted e.g. 'Production' as its default gets that flavor, not the
      // bare 'default' lane. Returns 'default' when no variant is promoted, so
      // behaviour is unchanged for projects without named variants.
      // Precedence inside the resolver (same as webhook / manual runs):
      //   ctx.commitSha > ctx.branch > legacy project.settings.mobileApp
      // This lets "CI kicks off a run without uploading but with git context"
      // reuse a previously-uploaded build for the same commit / branch. When
      // no git metadata is supplied the resolver falls through to the legacy
      // slot, matching the pre-Phase-5 behaviour for this branch of the flow.
      const variantLabel = await MobileAppStorageService.getProjectDefaultVariant(projectId, platform);
      const resolved = await MobileAppStorageService.resolveAppForRun({
        projectId,
        platform,
        branch,
        commitSha,
        variantLabel,
      });
      if (resolved?.storagePath) {
        appStoragePath = resolved.storagePath;
        appOriginalName = resolved.originalName;
        appPackage = resolved.packageName;
      }
    }

    // ── Step 4: Resolve test cases ─────────────────────────────────
    let testCases: Array<{
      id: string;
      name: string;
      hostPlatform?: string | null;
      intentSteps: MobileIntentStep[];
      metadata?: MobileTestMetadata;
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
          ? 'None of the provided savedTestCaseIds were found or have steps. Make sure the test cases have platform set to "mobile_android", "mobile_ios", or "mobile_flutter".'
          : planId
            ? 'The regression plan contains no mobile test cases with steps. Make sure test cases have platform set to "mobile_android", "mobile_ios", or "mobile_flutter".'
            : 'This project has no saved mobile test cases. Create test cases with platform "mobile_android" or "mobile_ios" in the editor.',
      });
      return;
    }

    // ── Step 4b: Host lanes for a Flutter CI run (ADR-0019) ────────
    // Per-case override > project default. The artifact is resolved PER HOST
    // LANE — at most two resolutions per run (android .apk / ios .app). The
    // run-level `appStoragePath` above stays the android-host artifact
    // (fresh upload or resolver); the ios lane resolves from storage here
    // (an appUrl upload is an .apk and can never serve an ios-host case).
    let ciDefaultFlutterHost: FlutterHostPlatform = 'android';
    let iosLaneApp: { storagePath?: string; originalName?: string; packageName?: string } | null = null;
    if (platform === 'flutter') {
      ciDefaultFlutterHost = await MobileAppStorageService.getProjectDefaultFlutterHost(projectId);
      const needsIosLane = testCases.some(
        (tc) => (normaliseHostOverride(tc.hostPlatform) ?? ciDefaultFlutterHost) === 'ios',
      );
      if (needsIosLane) {
        const iosVariant = await MobileAppStorageService.getProjectDefaultVariant(projectId, 'ios');
        const resolvedIos = await MobileAppStorageService.resolveAppForRun({
          projectId,
          platform: 'ios',
          branch,
          commitSha,
          variantLabel: iosVariant,
        });
        if (resolvedIos?.storagePath) {
          iosLaneApp = {
            storagePath: resolvedIos.storagePath,
            originalName: resolvedIos.originalName,
            packageName: resolvedIos.packageName,
          };
        } else {
          logger.warn('[CI] iOS-host flutter case(s) in run but no ios-slot app build resolved — those cases will run without install', {
            projectId,
          });
        }
      }
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

      // Per-case host lane + lane-matched artifact (flutter only).
      const tcHost: FlutterHostPlatform | undefined =
        platform === 'flutter'
          ? (normaliseHostOverride(tc.hostPlatform) ?? ciDefaultFlutterHost)
          : undefined;
      const laneApp =
        tcHost === 'ios'
          ? iosLaneApp ?? {}
          : { storagePath: appStoragePath, originalName: appOriginalName, packageName: appPackage };

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
          appPackage: laneApp.packageName,
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
        ...(tcHost ? { hostPlatform: tcHost } : {}),
        browser: browser as 'mobile-android' | 'mobile-ios',
        intentSteps: tc.intentSteps,
        runnerUrl: resolveRunnerUrlForHost(tcHost),
        runnerApiKey: env.MOBILE_RUNNER_API_KEY,
        appStoragePath: laneApp.storagePath,
        appOriginalName: laneApp.originalName,
        appPackage: laneApp.packageName,
        ciRunId: runId,
        callbackUrl,
        testCaseId: tc.id,
        testCaseName: tc.name,
        metadata: tc.metadata,
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
): Promise<Array<{ id: string; name: string; hostPlatform?: string | null; intentSteps: MobileIntentStep[]; metadata?: MobileTestMetadata }>> {
  const { data: rows, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, description, expected_result, priority, tags, platform, host_platform, steps_json, commands, graph_ref, replay_strategy')
    .in('id', testCaseIds)
    .eq('project_id', projectId)
    .in('platform', ['mobile_android', 'mobile_ios', 'mobile_flutter']);

  if (error) {
    logger.error('[CI] Failed to fetch test cases', { error, testCaseIds });
    throw new Error(`Failed to fetch test cases: ${error.message}`);
  }

  return (rows || [])
    .map((row: any) => ({
      id: row.id,
      name: row.name || `Test Case ${row.id.slice(0, 8)}`,
      hostPlatform: row.host_platform ?? null,
      intentSteps: extractIntentSteps(row),
      metadata: buildTestMetadata(row),
    }))
    .filter((tc) => tc.intentSteps.length > 0);
}

/** Build metadata object from DB row, omitting undefined/null fields */
function buildTestMetadata(row: any): MobileTestMetadata | undefined {
  const m: MobileTestMetadata = {};
  if (row.description) m.description = row.description;
  if (row.expected_result) m.expectedResult = row.expected_result;
  if (row.priority) m.priority = row.priority;
  if (row.tags?.length) m.tags = row.tags;
  return Object.keys(m).length > 0 ? m : undefined;
}

/**
 * Fetch ALL mobile saved test cases for a project.
 */
async function fetchAllProjectTestCases(
  projectId: string,
): Promise<Array<{ id: string; name: string; hostPlatform?: string | null; intentSteps: MobileIntentStep[]; metadata?: MobileTestMetadata }>> {
  const { data: rows, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, description, expected_result, priority, tags, platform, host_platform, steps_json, commands, graph_ref, replay_strategy')
    .eq('project_id', projectId)
    .in('platform', ['mobile_android', 'mobile_ios', 'mobile_flutter'])
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
      hostPlatform: row.host_platform ?? null,
      intentSteps: extractIntentSteps(row),
      metadata: buildTestMetadata(row),
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
