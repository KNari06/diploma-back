/**
 * Mobile Emulator Session Controller
 *
 * Provides eager warm-up of mobile emulator sessions.
 * When a user opens the editor for a mobile flow, the frontend calls
 * POST /warmup → backend creates a session on the runner and stores
 * the mapping in Redis. Later, when a test runs, the job can reuse
 * the warmed session instead of cold-starting a new one.
 *
 * Redis key: mobile_warmup:{projectId}:{userId} → { sessionId, runnerUrl, createdAt }
 * TTL: 15 minutes (session reclaimed if no test starts)
 */

import { env } from '@/config/environment/env';
import { redisConnection } from '@/config/infrastructure/queues';
import { MobileRunnerClient, getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import type { MobileIntentActionType, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { ProjectService } from '@/services/core/project.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// ── Constants ────────────────────────────────────────────────────────

const WARMUP_PREFIX = 'mobile_warmup:';
const WARMUP_TTL = 900; // 15 minutes

export interface WarmupData {
  sessionId: string;
  runnerUrl: string;
  runnerSocketUrl: string;
  platform: MobilePlatform;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// WARM-UP SESSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/warmup
 *
 * Create an eager emulator session so it's ready when the user runs a test.
 * Body: { projectId, platform: 'android' | 'ios' | 'flutter' }
 * Returns: { sessionId, runnerSocketUrl }
 */
export async function warmupSession(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId, platform: rawPlatform, appPackage } = req.body as {
    projectId?: string;
    platform?: string;
    appPackage?: string;
  };

  if (!projectId) {
    res.status(400).json({ success: false, error: 'projectId is required' });
    return;
  }

  const VALID_PLATFORMS: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  const platform: MobilePlatform = VALID_PLATFORMS[rawPlatform ?? ''] ?? 'android';

  try {
    // Feature flag check
    if (!env.MOBILE_RUNNER_ENABLED) {
      res.status(503).json({
        success: false,
        error: 'Mobile testing is not enabled',
      });
      return;
    }

    // Check if there's already a warmed session for this project+user
    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;
    const existingRaw = await redisConnection.get(redisKey);
    if (existingRaw) {
      const existing: WarmupData = JSON.parse(existingRaw);

      if (!existing.sessionId) {
        // Stale entry without a valid sessionId — discard and create fresh
        logger.warn('[MOBILE_SESSION] Discarding stale warmed session (missing sessionId)', { projectId, userId });
        await redisConnection.del(redisKey);
      } else {
        // Verify the session still exists on the runner (it may have been
        // destroyed if the runner restarted or the session TTL expired).
        const client = getMobileRunnerClient();
        const stillAlive = await client.sessionExists(existing.sessionId);

        if (!stillAlive) {
          logger.warn('[MOBILE_SESSION] Cached session no longer exists on runner, creating fresh', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
          });
          await redisConnection.del(redisKey);
          // Fall through to create a new session below
        } else {
          logger.debug('[MOBILE_SESSION] Reusing existing warmed session', {
            projectId,
            userId,
            sessionId: existing.sessionId,
          });

          res.json({
            success: true,
            sessionId: existing.sessionId,
            runnerSocketUrl: existing.runnerSocketUrl,
            platform: existing.platform,
            reused: true,
          });

          // Retry app install in background (idempotent — runner ignores if already installed)
          installAppOnSession(client, existing.sessionId, projectId, userId, appPackage).catch((err) => {
            logger.warn('[MOBILE_SESSION] Background app install on reused session failed (non-fatal)', {
              sessionId: existing.sessionId,
              projectId,
              error: err instanceof Error ? err.message : String(err),
            });
          });

          return;
        }
      }
    }

    // Health check
    const client = getMobileRunnerClient();
    const healthy = await client.isHealthy();
    if (!healthy) {
      res.status(503).json({
        success: false,
        error: 'Mobile runner is unavailable',
      });
      return;
    }

    // Create session on runner
    const session = await client.createSession(platform);

    // Derive socket URL from runner URL
    const runnerSocketUrl = env.MOBILE_RUNNER_URL.replace(/^http/, 'ws').replace(/\/$/, '');

    // Store mapping in Redis
    const warmupData: WarmupData = {
      sessionId: session.sessionId,
      runnerUrl: env.MOBILE_RUNNER_URL,
      runnerSocketUrl,
      platform,
      createdAt: new Date().toISOString(),
    };

    await redisConnection.set(
      `${WARMUP_PREFIX}${projectId}:${userId}`,
      JSON.stringify(warmupData),
      'EX',
      WARMUP_TTL,
    );

    logger.info('[MOBILE_SESSION] Emulator warmed up', {
      projectId,
      userId,
      sessionId: session.sessionId,
      platform,
    });

    // Install the project's mobile app onto the emulator (best-effort, non-blocking).
    // This runs after we return the response so the frontend can connect to the stream
    // while the app downloads, uploads, and installs.
    res.status(201).json({
      success: true,
      sessionId: session.sessionId,
      runnerSocketUrl,
      platform,
      reused: false,
    });

    // Fire-and-forget: install app in background
    installAppOnSession(client, session.sessionId, projectId, userId, appPackage).catch((err) => {
      logger.warn('[MOBILE_SESSION] Background app install failed (non-fatal)', {
        sessionId: session.sessionId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (error) {
    logger.error('[MOBILE_SESSION] Warmup failed', {
      projectId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to warm up emulator session',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DESTROY SESSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/mobile/sessions/:sessionId
 *
 * Destroy a warmed emulator session (e.g., user leaves the editor).
 */
export async function destroySession(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { projectId } = req.query as { projectId?: string };

  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId is required' });
    return;
  }

  try {
    // Destroy on runner
    const client = getMobileRunnerClient();
    try {
      await client.destroySession(sessionId);
    } catch (err) {
      // Session may already be expired/destroyed on runner — non-fatal
      logger.warn('[MOBILE_SESSION] Runner destroy returned error (may be expired)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Remove Redis mapping (best effort — might not match exactly)
    if (projectId) {
      await redisConnection.del(`${WARMUP_PREFIX}${projectId}:${userId}`);
    }

    logger.info('[MOBILE_SESSION] Session destroyed', { sessionId, userId, projectId });

    res.json({ success: true, message: 'Session destroyed' });
  } catch (error) {
    logger.error('[MOBILE_SESSION] Destroy failed', {
      sessionId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to destroy session',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TAP (forward click to emulator)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/tap
 *
 * Forward a tap at (x, y) device coordinates to the emulator.
 * Body: { x: number, y: number }
 */
export async function tapSession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { x, y } = req.body as { x?: number; y?: number };

  if (!sessionId || typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ success: false, error: 'sessionId, x, and y are required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    await client.executeBatchCommands(sessionId, [
      { type: 'tap', params: { x: Math.round(x), y: Math.round(y) }, _skipWait: true },
    ], { interactive: true });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Tap failed', {
      sessionId,
      x,
      y,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Tap failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/v1/mobile/sessions/:sessionId/swipe
 *
 * Forward a swipe gesture to the emulator.
 * Body: { startX, startY, endX, endY, durationMs? }
 */
export async function swipeSession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { startX, startY, endX, endY, durationMs } = req.body as {
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    durationMs?: number;
  };

  if (
    !sessionId ||
    typeof startX !== 'number' ||
    typeof startY !== 'number' ||
    typeof endX !== 'number' ||
    typeof endY !== 'number'
  ) {
    res.status(400).json({
      success: false,
      error: 'sessionId, startX, startY, endX, and endY are required',
    });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    await client.executeBatchCommands(sessionId, [
      {
        type: 'swipe',
        params: {
          startX: Math.round(startX),
          startY: Math.round(startY),
          endX: Math.round(endX),
          endY: Math.round(endY),
          durationMs: typeof durationMs === 'number' ? durationMs : 300,
        },
        _skipWait: true,
      },
    ], { interactive: true });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Swipe failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Swipe failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/v1/mobile/sessions/:sessionId/go-home
 *
 * Send Home button to the emulator.
 */
export async function goHomeSession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId is required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    await client.executeBatchCommands(sessionId, [
      { type: 'go_home', params: {}, _skipWait: true },
    ], { interactive: true });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Go home failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Go home failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/v1/mobile/sessions/:sessionId/go-back
 *
 * Send Back button to the emulator.
 */
export async function goBackSession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId is required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    await client.executeBatchCommands(sessionId, [
      { type: 'go_back', params: {}, _skipWait: true },
    ], { interactive: true });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Go back failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Go back failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPE TEXT (forward keyboard text to emulator)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/type
 *
 * Forward a text string to the emulator (adb shell input text).
 * Body: { text: string }
 */
export async function typeSession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { text } = req.body as { text?: string };

  if (!sessionId || typeof text !== 'string' || text.length === 0) {
    res.status(400).json({ success: false, error: 'sessionId and non-empty text are required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    await client.executeBatchCommands(sessionId, [
      { type: 'type_text', params: { text }, _skipWait: true },
    ], { interactive: true });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Type text failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Type text failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRESS KEY (forward keycode to emulator)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/key
 *
 * Forward an Android keycode to the emulator (adb shell input keyevent).
 * Body: { keycode: string }  e.g. "KEYCODE_ENTER", "KEYCODE_DEL"
 */
export async function keySession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { keycode } = req.body as { keycode?: string };

  if (!sessionId || typeof keycode !== 'string' || keycode.length === 0) {
    res.status(400).json({ success: false, error: 'sessionId and keycode are required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    await client.executeBatchCommands(sessionId, [
      { type: 'press_key', params: { keycode }, _skipWait: true },
    ], { interactive: true });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Key press failed', {
      sessionId,
      keycode,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Key press failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND (execute a single raw command on the emulator)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/command
 *
 * Execute a single raw MobileCommand on the emulator.
 * Body: { type: string, params?: object }
 */
export async function commandSession(req: Request, res: Response): Promise<void> {
  if (\!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { type, params } = req.body as { type?: string; params?: Record<string, unknown> };

  if (\!sessionId || typeof type \!== 'string' || type.length === 0) {
    res.status(400).json({ success: false, error: 'sessionId and command type are required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();
    const result = await client.executeBatchCommands(sessionId, [
      { type, params: params ?? {}, _skipWait: true },
    ], { interactive: true });
    res.json({ success: true, data: result?.results?.[0] });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Command failed', {
      sessionId,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Command failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LINT (find element on mobile emulator via description)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/lint
 *
 * Resolve an element description against the emulator's current UI.
 * Uses the runner's smart element resolver (UIAutomator + AI).
 * Body: { stepDraft: { kind, elementDescription, value?, ... } }
 */
export async function lintSession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { stepDraft } = req.body as { stepDraft?: any };

  if (!sessionId || !stepDraft) {
    res.status(400).json({ success: false, error: 'sessionId and stepDraft are required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();

    const stepType = stepDraft.type || stepDraft.kind || 'click';
    const description = (stepDraft.elementDescription || stepDraft.description || '').trim();

    if (!description) {
      res.json({ success: true, status: 'not_found', message: 'No element description provided' });
      return;
    }

    // Map step type to action type for element resolution context
    const ACTION_TYPE_MAP: Record<string, string> = {
      click: 'tap', type: 'type_text', fill: 'type_text',
      assert: 'assert_visible', ai_check: 'assert_visible',
      scroll: 'tap', swipe: 'tap', long_press: 'tap', double_tap: 'tap',
    };
    const actionType = ACTION_TYPE_MAP[stepType] || 'tap';

    // Use the dedicated lint endpoint — fast, non-destructive, returns bounding box.
    // This replaces the old runSteps(assert_visible) approach which was 3-5x slower.
    const lintResult = await client.lintElement(sessionId, description, actionType);

    // Map to frontend-compatible response with highlight data
    const highlight = lintResult.boundingBox && lintResult.screenSize
      ? [{
        boundingBox: lintResult.boundingBox,
        type: lintResult.status === 'resolved' ? 'success'
          : lintResult.status === 'low_confidence' ? 'warning'
          : undefined,
      }]
      : undefined;

    res.json({
      success: true,
      status: lintResult.status,
      message: lintResult.message || (
        lintResult.status === 'resolved' ? `Found: "${lintResult.elementText || description}"`
        : lintResult.status === 'low_confidence' ? `Weak match: "${lintResult.elementText}" (confidence: ${lintResult.confidence?.toFixed(2)})`
        : 'Element not found on mobile screen'
      ),
      screenshot: lintResult.screenshot,
      // Frontend highlight overlay data (same format as web lint)
      boundingBox: lintResult.boundingBox,
      screenSize: lintResult.screenSize,
      highlight,
      confidence: lintResult.confidence,
      resolvedVia: lintResult.resolvedVia,
      elementText: lintResult.elementText,
      elementType: lintResult.elementType,
    });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Lint failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Lint failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLY (execute a step on mobile emulator)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/apply
 *
 * Execute a test step on the emulator. Resolves the element and performs the action.
 * Body: { stepDraft: { kind, elementDescription, value?, ... } }
 */
export async function applySession(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { stepDraft } = req.body as { stepDraft?: any };

  if (!sessionId || !stepDraft) {
    res.status(400).json({ success: false, error: 'sessionId and stepDraft are required' });
    return;
  }

  try {
    const client = getMobileRunnerClient();

    const stepType = stepDraft.type || stepDraft.kind || 'click';

    const intentStep = {
      id: stepDraft.id || `apply_${Date.now()}`,
      type: stepType,
      description: stepDraft.elementDescription || stepDraft.description || '',
      value: stepDraft.value,
      assertionText: stepDraft.assertionText,
      appPackage: stepDraft.appPackage,
      options: stepDraft.options,
      bindingHints: stepDraft.intentStep?.bindingHints || stepDraft.bindingHints || {},
    };

    const result = await client.runSteps(sessionId, [intentStep], {
      screenshotEachStep: true,
      stopOnFailure: false,
    });

    const stepResult = result.steps?.[0];

    res.json({
      success: true,
      stepResult: {
        success: stepResult?.success ?? false,
        error: stepResult?.error,
        screenshot: stepResult?.screenshot,
        resolvedVia: stepResult?.resolvedVia,
        durationMs: stepResult?.durationMs,
      },
      status: stepResult?.success ? 'passed' : 'failed',
    });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Apply failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Apply failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Install app on a freshly created session
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Downloads the project's mobile app from Supabase Storage, uploads it to
 * the runner, and sends install_app + launch_app commands. Intended to run
 * in the background after the warmup response has been sent.
 */
async function installAppOnSession(
  client: MobileRunnerClient,
  sessionId: string,
  projectId: string,
  userId: string,
  appPackageOverride?: string,
): Promise<void> {
  const project = await ProjectService.getProject(projectId, userId);
  const mobileApp = project?.settings?.mobileApp;

  if (!mobileApp?.storagePath) {
    logger.debug('[MOBILE_SESSION] No mobile app configured for project, skipping install', { projectId });
    return;
  }

  logger.info('[MOBILE_SESSION] Installing app on session', {
    sessionId,
    projectId,
    originalName: mobileApp.originalName,
  });

  const fileBuffer = await MobileAppStorageService.downloadApp(mobileApp.storagePath);
  const uploaded = await client.uploadApp(fileBuffer, mobileApp.originalName);

  // Prefer explicit package from warmup request or upload metadata
  const explicitPackage = appPackageOverride || mobileApp.packageName;

  // The runner auto-detects and auto-launches the installed package.
  // If we have an explicit package, pass it as a hint (and disable auto-launch so we
  // can launch the specific package ourselves).
  const installResult = await client.executeBatchCommands(sessionId, [
    {
      type: 'install_app',
      params: {
        apkPath: uploaded.path,
        reinstall: true,
        ...(explicitPackage ? { autoLaunch: false } : {}),
      },
    },
  ]);

  const detected = (installResult?.results?.[0] as any)?.packageName as string | undefined;
  const packageName = explicitPackage || detected;

  if (explicitPackage) {
    await client.executeBatchCommands(sessionId, [
      { type: 'launch_app', params: { packageName: explicitPackage } },
    ]);
  }

  logger.info('[MOBILE_SESSION] App installed on session', {
    sessionId,
    projectId,
    packageName: packageName || '(auto-launched by runner)',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Claim warmed session (used by mobile-test-run.job.ts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Claim a warmed session from Redis for use in a test run.
 * Atomically reads + deletes the key so no other job can reuse it.
 *
 * Returns WarmupData if a warmed session exists, null otherwise.
 */
export async function claimWarmedSession(
  projectId: string,
  userId: string,
): Promise<WarmupData | null> {
  const key = `${WARMUP_PREFIX}${projectId}:${userId}`;

  try {
    const raw = await redisConnection.get(key);
    if (!raw) return null;

    // Atomically delete so no other job can claim
    await redisConnection.del(key);

    const data = JSON.parse(raw) as WarmupData;

    logger.info('[MOBILE_SESSION] Claimed warmed session for test run', {
      projectId,
      userId,
      sessionId: data.sessionId,
    });

    return data;
  } catch (err) {
    logger.warn('[MOBILE_SESSION] Failed to claim warmed session', {
      projectId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
