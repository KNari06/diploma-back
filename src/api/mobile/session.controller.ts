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
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// ── Constants ────────────────────────────────────────────────────────

const WARMUP_PREFIX = 'mobile_warmup:';
const WARMUP_TTL = 900; // 15 minutes

type MobilePermissionPolicy = 'auto_allow' | 'auto_deny' | 'manual';
const VALID_PERMISSION_POLICIES: readonly MobilePermissionPolicy[] = ['auto_allow', 'auto_deny', 'manual'];

/**
 * Resolve the effective permission policy for a session at warmup time.
 *
 * Precedence: test-level override (set later during run) > project default >
 * runner default ('auto_allow'). Since we don't know which test will run
 * during warmup, we seed the session with the project default; per-test
 * overrides can PATCH the runner at run start if they differ.
 *
 * Returns `null` if the stored value is missing or invalid — callers then
 * leave the session on the runner default (avoiding a round-trip).
 */
async function resolveProjectPermissionPolicy(
  projectId: string,
  userId: string,
): Promise<MobilePermissionPolicy | null> {
  try {
    const project = await ProjectService.getProject(projectId, userId);
    const stored = project?.settings?.mobilePermissionPolicy;
    if (typeof stored === 'string' && (VALID_PERMISSION_POLICIES as readonly string[]).includes(stored)) {
      return stored as MobilePermissionPolicy;
    }
  } catch {
    // Swallow — network/db hiccup falls through to the runner default.
  }
  return null;
}

/**
 * Pending-install flag: set when an APK is uploaded but the upload-time
 * `autoBootAndInstall` couldn't reach a running emulator. Stores the
 * storagePath of the APK that needs installing. Consumed by the next
 * `installAppOnSession` call (at warmup time) which forces a full install
 * even if Redis thinks the same APK is cached — because in reality the
 * emulator may never have actually received it.
 */
const PENDING_INSTALL_PREFIX = 'mobile_pending_install:';
const PENDING_INSTALL_TTL = 3600; // 1 hour

export interface WarmupData {
  sessionId: string;
  runnerUrl: string;
  runnerSocketUrl: string;
  platform: MobilePlatform;
  createdAt: string;
  /** Package name currently installed on the emulator */
  installedPackage?: string;
  /** Supabase storage path of the APK currently installed */
  appStoragePath?: string;
}

/**
 * Emit a `preview:session:progress` WebSocket event so the AI editor's
 * PreviewLoadingProgress component can render a real progress bar while
 * the emulator warms up. Mirrors the event shape already used by the web
 * preview path. Non-fatal — a socket hiccup must never fail warmup.
 *
 * Stage strings recognised by the frontend (in order):
 *   launching_browser → stage 1 (emulator ready)
 *   loading_page      → stage 2 (APK install in progress)
 *   extracting_elements → stage 3 (launching app)
 *   ready             → stage 4 (complete)
 */
function emitWarmupProgress(
  userId: string,
  stage: 'launching_browser' | 'loading_page' | 'extracting_elements' | 'ready',
  progress: number,
): void {
  try {
    webSocketService.emitToUser(userId, 'preview:session:progress', { stage, progress });
  } catch {
    // Best-effort — never let a socket error break warmup.
  }
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

    // Check if there's already a warmed session for this project+user.
    // Use SET NX to atomically claim the slot — prevents two concurrent warmup
    // requests from both reading null and creating duplicate sessions.
    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;
    const lockKey = `${redisKey}:lock`;
    const lockAcquired = await redisConnection.set(lockKey, '1', 'EX', 60, 'NX');
    if (!lockAcquired) {
      // Another warmup is in progress — wait briefly then check for the result
      logger.info('[MOBILE_SESSION] Concurrent warmup detected, waiting for result', { projectId, userId });
      await new Promise((r) => setTimeout(r, 3000));
      const waitResult = await redisConnection.get(redisKey);
      if (waitResult) {
        const parsed: WarmupData = JSON.parse(waitResult);
        if (parsed.sessionId && parsed.sessionId !== '_booting') {
          await redisConnection.del(lockKey);
          res.json({
            success: true,
            sessionId: parsed.sessionId,
            runnerSocketUrl: parsed.runnerSocketUrl,
            platform: parsed.platform,
            reused: true,
          });
          return;
        }
      }
      // Lock expired or boot still in progress — fall through to create
      await redisConnection.del(lockKey);
    }

    const existingRaw = await redisConnection.get(redisKey);
    if (existingRaw) {
      const existing: WarmupData = JSON.parse(existingRaw);

      if (!existing.sessionId) {
        // Stale entry without a valid sessionId — discard and create fresh
        logger.warn('[MOBILE_SESSION] Discarding stale warmed session (missing sessionId)', { projectId, userId });
        await redisConnection.del(redisKey);
      } else if (existing.sessionId === '_booting') {
        // Auto-boot from APK upload is in progress — poll until it completes
        logger.info('[MOBILE_SESSION] Emulator boot in progress (auto-boot), waiting...', { projectId, userId });
        const POLL_INTERVAL = 2000;
        const MAX_WAIT = 90_000; // 90s max wait for boot
        const waitStart = Date.now();

        let bootedSessionId: string | null = null;
        while (Date.now() - waitStart < MAX_WAIT) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          const refreshRaw = await redisConnection.get(redisKey);
          if (!refreshRaw) break; // Redis key gone — boot failed or expired
          const refreshed: WarmupData = JSON.parse(refreshRaw);
          if (refreshed.sessionId && refreshed.sessionId !== '_booting') {
            bootedSessionId = refreshed.sessionId;
            break;
          }
        }

        if (bootedSessionId) {
          const refreshRaw = await redisConnection.get(redisKey);
          const refreshed: WarmupData = refreshRaw ? JSON.parse(refreshRaw) : existing;
          logger.info('[MOBILE_SESSION] Auto-boot completed, reusing session', { projectId, sessionId: bootedSessionId });
          res.json({
            success: true,
            sessionId: bootedSessionId,
            runnerSocketUrl: refreshed.runnerSocketUrl,
            platform: refreshed.platform,
            reused: true,
          });
          return;
        }

        // Boot didn't complete in time — clean up and fall through to create fresh
        logger.warn('[MOBILE_SESSION] Auto-boot timed out, creating fresh session', { projectId, userId });
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

          // Run install+launch_app BEFORE responding, so the preview stream shows
          // the app already open. On a reused session this usually hits the fast
          // path (Redis match or device check) and just issues launch_app.
          emitWarmupProgress(userId, 'launching_browser', 15);
          try {
            await installAppOnSession(client, existing.sessionId, projectId, userId, appPackage);
          } catch (err) {
            logger.warn('[MOBILE_SESSION] App install/launch on reused session failed (non-fatal)', {
              sessionId: existing.sessionId,
              projectId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          emitWarmupProgress(userId, 'ready', 100);

          res.json({
            success: true,
            sessionId: existing.sessionId,
            runnerSocketUrl: existing.runnerSocketUrl,
            platform: existing.platform,
            reused: true,
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

    // Try pool first (instant claim of a pre-booted emulator); fall back to
    // createSession only if the pool is disabled / exhausted / unreachable.
    // Mirrors the 3-tier pattern used by mobile-test-run.job.ts.
    let session: Awaited<ReturnType<typeof client.createSession>>;
    try {
      session = await client.claimSession(platform);
      logger.info('[MOBILE_SESSION] Pool session claimed for warmup', {
        projectId,
        sessionId: session.sessionId,
        platform,
      });
    } catch (poolErr) {
      logger.debug('[MOBILE_SESSION] Pool claim failed, cold-booting', {
        projectId,
        error: poolErr instanceof Error ? poolErr.message : String(poolErr),
      });
      session = await client.createSession(platform);
    }

    // Emulator is up — nudge the loader past the "preparing env" stage.
    emitWarmupProgress(userId, 'launching_browser', 15);

    // Propagate project-level permission policy to the runner. Best-effort:
    // the runner defaults to 'auto_allow' when the patch fails, which is the
    // same behaviour a newly-created project gets, so we never block warmup
    // on this call. Tests may later override the policy at run time.
    try {
      const policy = await resolveProjectPermissionPolicy(projectId, userId);
      if (policy) {
        await client.setPermissionPolicy(session.sessionId, policy);
      }
    } catch (err) {
      logger.debug('[MOBILE_SESSION] Failed to propagate permission policy (non-fatal)', {
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

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

    // Release the warmup lock now that the session is stored
    await redisConnection.del(lockKey).catch(() => {});

    logger.info('[MOBILE_SESSION] Emulator warmed up', {
      projectId,
      userId,
      sessionId: session.sessionId,
      platform,
    });

    // Install the project's mobile app and run launch_app BEFORE returning, so the
    // preview stream shows the app already open when the frontend connects.
    // Non-fatal: on failure we still return the session so the user can retry.
    try {
      await installAppOnSession(client, session.sessionId, projectId, userId, appPackage);
    } catch (err) {
      logger.warn('[MOBILE_SESSION] App install/launch during warmup failed (non-fatal)', {
        sessionId: session.sessionId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    emitWarmupProgress(userId, 'ready', 100);

    res.status(201).json({
      success: true,
      sessionId: session.sessionId,
      runnerSocketUrl,
      platform,
      reused: false,
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

    // Close editor trace file for this session
    await EditorTraceService.close(`mobile-${sessionId}`).catch(() => {});

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
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { type, params } = req.body as { type?: string; params?: Record<string, unknown> };

  if (!sessionId || typeof type !== 'string' || type.length === 0) {
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
    const rawDescription = (stepDraft.elementDescription || stepDraft.description || '').trim();

    if (!rawDescription) {
      res.json({ success: true, status: 'not_found', message: 'No element description provided' });
      return;
    }

    // Normalize: strip surrounding quotes ("'Search' navigation" → "Search navigation")
    const description = rawDescription.replace(/['"]+([^'"]+)['"]+/g, '$1').trim();

    // Map frontend step kind → mobile runner actionType for element resolution context.
    // The actionType tells the LLM what the user intends to do with the element,
    // which affects how it scores candidates (e.g., clickable for tap, editable for type).
    const ACTION_TYPE_MAP: Record<string, string> = {
      // Core actions
      tap: 'tap',
      click: 'tap',
      type: 'type_text',
      fill: 'type_text',
      scroll: 'scroll',
      swipe: 'swipe',
      long_press: 'long_press',
      double_tap: 'double_tap',
      drag: 'drag',
      press: 'press_key',
      // Assertions
      assert: 'assert_visible',
      ai_check: 'assert_visible',
      // Navigation (no element resolution needed, but pass through)
      go_back: 'go_back',
      go_home: 'go_home',
      navigate: 'open_url',
      open_app: 'launch_app',
      close_app: 'close_app',
      // Device actions (no element resolution needed)
      biometric: 'biometric',
      otp: 'otp',
      permission: 'permission_dialog',
      network: 'set_network_condition',
      pinch: 'pinch_zoom',
      clipboard: 'set_clipboard',
      upload: 'upload_file',
    };
    const actionType = ACTION_TYPE_MAP[stepType] || 'tap';

    // Trace logging for mobile editor
    const traceSessionId = `mobile-${sessionId}`;
    const trace = EditorTraceService.getOrCreate(traceSessionId, req.user.id);
    trace.writeMobileLintRequest({ description, actionType, sessionId });
    const lintStart = Date.now();

    // Use the dedicated lint endpoint — fast, non-destructive, returns bounding box.
    // This replaces the old runSteps(assert_visible) approach which was 3-5x slower.
    const lintResult = await client.lintElement(sessionId, description, actionType);

    // Log the result for debugging element resolution issues
    trace.writeMobileLintResult({
      description,
      actionType,
      sessionId,
      latencyMs: Date.now() - lintStart,
      result: {
        status: lintResult.status,
        confidence: lintResult.confidence,
        resolvedVia: lintResult.resolvedVia,
        elementText: lintResult.elementText,
        elementType: lintResult.elementType,
        boundingBox: lintResult.boundingBox,
        message: lintResult.message,
      },
    });

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
    // Trace logging for mobile editor
    const traceSessionId = `mobile-${sessionId}`;
    const trace = EditorTraceService.getOrCreate(traceSessionId, req.user!.id);
    const rawStepType = stepDraft.type || stepDraft.kind || 'click';
    const description = (stepDraft.elementDescription || stepDraft.description || '')
      .replace(/['"]+([^'"]+)['"]+/g, '$1')
      .trim();
    trace.writeMobileApplyRequest({
      stepId: stepDraft.id || `apply_${Date.now()}`,
      stepType: rawStepType,
      description,
      value: stepDraft.value,
      sessionId,
    });
    const applyStart = Date.now();

    // Delegate to shared service — REST and WS both use this path.
    const { MobileStepApplyService } = await import('@/services/mobile/mobile-step-apply.service');
    const output = await MobileStepApplyService.apply({
      sessionId,
      stepDraft,
      userId: req.user!.id,
    });

    trace.writeMobileApplyResult({
      stepId: stepDraft.id || `apply_${Date.now()}`,
      sessionId,
      latencyMs: Date.now() - applyStart,
      result: {
        success: output.stepResult?.success ?? false,
        error: output.stepResult?.error,
        resolvedVia: output.stepResult?.resolvedVia,
        durationMs: output.stepResult?.durationMs,
      },
    });

    res.json({
      success: output.success,
      stepResult: output.stepResult,
      appliedStep: output.appliedStep,
      status: output.status,
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
// AUTO-BOOT: Boot emulator + install APK immediately after upload
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Called after APK upload to immediately boot an emulator and install the app.
 * If an emulator session already exists for this project+user, reuses it and
 * just reinstalls the new APK. Emits WebSocket progress events to the user.
 *
 * Fire-and-forget — errors are logged but not thrown to the caller.
 */
export async function autoBootAndInstall(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
): Promise<void> {
  const emit = (stage: string, message: string, sessionId?: string) => {
    webSocketService.emitToUser(userId, 'mobile:boot:status', { projectId, stage, message, sessionId });
  };

  // Helper: set pending-install flag so the next warmup re-runs the install.
  // Used whenever upload-time boot/install can't complete and the user
  // should still get their APK installed next time they open the editor.
  const setPendingInstall = async (storagePath: string | undefined) => {
    if (!storagePath) return;
    const pendingKey = `${PENDING_INSTALL_PREFIX}${projectId}:${userId}`;
    await redisConnection.set(pendingKey, storagePath, 'EX', PENDING_INSTALL_TTL).catch(() => {});
  };

  try {
    if (!env.MOBILE_RUNNER_ENABLED) return;

    const client = getMobileRunnerClient();
    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;

    // Load app so we know which storagePath to pend if we fail early
    const project = await ProjectService.getProject(projectId, userId);
    const appStoragePath = project?.settings?.mobileApp?.storagePath;

    // Check for existing session
    let sessionId: string | null = null;
    const existingRaw = await redisConnection.get(redisKey);
    if (existingRaw) {
      const existing: WarmupData = JSON.parse(existingRaw);
      if (existing.sessionId && existing.sessionId !== '_booting') {
        const alive = await client.sessionExists(existing.sessionId);
        if (alive) {
          sessionId = existing.sessionId;
          logger.info('[MOBILE_AUTO_BOOT] Reusing existing session for reinstall', { projectId, sessionId });
        }
      }
    }

    // Boot new emulator if no existing session
    if (!sessionId) {
      emit('booting', 'Starting emulator...');

      const healthy = await client.isHealthy();
      if (!healthy) {
        // Runner offline: don't hold the user's response for a 60s timeout.
        // Mark the APK as pending-install so the next warmup picks it up.
        await setPendingInstall(appStoragePath);
        emit('error', 'Mobile runner is offline — the app will install when you open the editor');
        logger.warn('[MOBILE_AUTO_BOOT] Runner unhealthy, pending install queued', { projectId });
        return;
      }

      // Set a "booting" placeholder in Redis BEFORE starting the emulator.
      // This prevents warmupSession from creating a duplicate emulator if
      // the user opens the editor while the boot is still in progress.
      const runnerSocketUrl = env.MOBILE_RUNNER_URL.replace(/^http/, 'ws').replace(/\/$/, '');
      const bootingData: WarmupData = {
        sessionId: '_booting',
        runnerUrl: env.MOBILE_RUNNER_URL,
        runnerSocketUrl,
        platform,
        createdAt: new Date().toISOString(),
      };
      await redisConnection.set(redisKey, JSON.stringify(bootingData), 'EX', WARMUP_TTL);

      const session = await client.createSession(platform);
      sessionId = session.sessionId;

      // Update Redis with the real session ID
      bootingData.sessionId = sessionId;
      await redisConnection.set(redisKey, JSON.stringify(bootingData), 'EX', WARMUP_TTL);

      logger.info('[MOBILE_AUTO_BOOT] Emulator created', { projectId, sessionId });
    }

    // Install the app
    emit('installing', 'Installing app...', sessionId);
    await installAppOnSession(client, sessionId, projectId, userId);

    emit('ready', 'Emulator ready', sessionId);
    logger.info('[MOBILE_AUTO_BOOT] App installed, emulator ready', { projectId, sessionId });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit('error', `Setup failed: ${message}`);
    logger.error('[MOBILE_AUTO_BOOT] Failed', { projectId, userId, error: message });

    // Mark APK as pending so the next warmup re-attempts the install.
    try {
      const project = await ProjectService.getProject(projectId, userId);
      await setPendingInstall(project?.settings?.mobileApp?.storagePath);
    } catch { /* best-effort */ }

    // Clean up the _booting placeholder so warmup doesn't wait forever
    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;
    const raw = await redisConnection.get(redisKey);
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data.sessionId === '_booting') {
          await redisConnection.del(redisKey);
        }
      } catch { /* ignore parse error */ }
    }
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
  // Nudge the UI past "preparing env" as soon as install logic starts.
  emitWarmupProgress(userId, 'launching_browser', 25);

  const project = await ProjectService.getProject(projectId, userId);
  const mobileApp = project?.settings?.mobileApp;

  if (!mobileApp?.storagePath) {
    logger.debug('[MOBILE_SESSION] No mobile app configured for project, skipping install', { projectId });
    return;
  }

  // Check Redis for what's currently installed on this emulator
  const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;
  const warmupRaw = await redisConnection.get(redisKey);
  const warmup: WarmupData | null = warmupRaw ? JSON.parse(warmupRaw) : null;

  // Check for a pending-install flag (set by autoBootAndInstall when the upload
  // couldn't reach the emulator). If present AND matches the current APK, we
  // must NOT trust the Redis/device dedup fast paths — force a full install.
  const pendingKey = `${PENDING_INSTALL_PREFIX}${projectId}:${userId}`;
  const pendingStoragePath = await redisConnection.get(pendingKey);
  const hasPendingInstall = pendingStoragePath === mobileApp.storagePath;
  if (hasPendingInstall) {
    logger.info('[MOBILE_SESSION] Pending-install flag detected — forcing full install', {
      sessionId,
      projectId,
      storagePath: mobileApp.storagePath,
    });
  }

  // If the same APK is already installed (Redis knows), just relaunch — skip download + install.
  // BUT: respect the pending-install flag which means we can't trust Redis state.
  if (!hasPendingInstall && warmup?.appStoragePath === mobileApp.storagePath && warmup?.installedPackage) {
    logger.debug('[MOBILE_SESSION] Same APK already installed (Redis), relaunching', {
      sessionId,
      projectId,
      package: warmup.installedPackage,
    });
    emitWarmupProgress(userId, 'extracting_elements', 75);
    await client.executeBatchCommands(sessionId, [
      { type: 'launch_app', params: { packageName: appPackageOverride || warmup.installedPackage } },
    ], { timeoutMs: 60_000 });
    return;
  }

  // If Redis expired but we know the package name, check the DEVICE directly.
  // This avoids expensive re-download + re-install when the app is still on the emulator.
  // Skipped when a pending-install flag is set (we don't trust device state in that case).
  const knownPackage = appPackageOverride || mobileApp.packageName;
  if (knownPackage && !hasPendingInstall) {
    try {
      const checkResult = await client.executeBatchCommands(sessionId, [
        { type: 'check_package', params: { packageName: knownPackage } },
      ], { timeoutMs: 10_000 });
      const isInstalled = !!(checkResult?.results?.[0] as any)?.data?.installed;
      if (isInstalled) {
        logger.info('[MOBILE_SESSION] Package still on device (Redis expired), relaunching without reinstall', {
          sessionId,
          projectId,
          package: knownPackage,
        });
        emitWarmupProgress(userId, 'extracting_elements', 75);
        await client.executeBatchCommands(sessionId, [
          { type: 'launch_app', params: { packageName: knownPackage } },
        ], { timeoutMs: 60_000 });

        // Restore Redis cache so next warmup skips too
        if (warmup) {
          warmup.installedPackage = knownPackage;
          warmup.appStoragePath = mobileApp.storagePath;
          await redisConnection.set(redisKey, JSON.stringify(warmup), 'EX', WARMUP_TTL);
        }

        // Persist packageName to project settings so future warmups can hit
        // this fast path even after Redis expires (knownPackage may have come
        // from appPackageOverride when mobileApp.packageName was null).
        await persistPackageName(projectId, userId, mobileApp, knownPackage);

        return;
      }
    } catch (err) {
      logger.debug('[MOBILE_SESSION] Device package check failed, proceeding with install', {
        error: (err as Error).message,
      });
    }
  }

  logger.info('[MOBILE_SESSION] Installing app on session', {
    sessionId,
    projectId,
    originalName: mobileApp.originalName,
    oldPackage: warmup?.installedPackage || '(none)',
  });
  emitWarmupProgress(userId, 'loading_page', 45);

  const fileBuffer = await MobileAppStorageService.downloadApp(mobileApp.storagePath);
  const uploaded = await client.uploadApp(fileBuffer, mobileApp.originalName);

  // Prefer explicit package from warmup request or upload metadata
  const explicitPackage = appPackageOverride || mobileApp.packageName;

  // Always uninstall the old package if we know it from a previous install.
  // This ensures clean state even when:
  // - Package name changed between uploads
  // - packageName was never provided by the user (common — frontend doesn't send it)
  // - Same package but different signature (would fail with INSTALL_FAILED_UPDATE_INCOMPATIBLE)
  const oldPackage = warmup?.installedPackage;
  const shouldUninstallOld = !!oldPackage;

  const installResult = await client.executeBatchCommands(sessionId, [
    {
      type: 'install_app',
      params: {
        apkPath: uploaded.path,
        reinstall: true, // use -r as safety net — if uninstall failed silently, install still works
        clearData: true, // always wipe app data for clean state after install
        autoLaunch: false, // always launch via an explicit launch_app command below for determinism
        ...(shouldUninstallOld ? { uninstallOldPackage: oldPackage } : {}),
      },
    },
  ], { timeoutMs: 120_000 }); // 2 min — adb install can take 60s+ for large APKs

  // Runner wraps every command result as { success, data, durationMs, ... }.
  // The install handler returns { installed, packageName } inside `data`.
  const detected = (installResult?.results?.[0] as any)?.data?.packageName as string | undefined;
  const packageName = explicitPackage || detected;

  // Always issue an explicit launch_app — never rely on install's auto-launch.
  // Gives us one deterministic code path regardless of whether we knew the
  // package name up front.
  if (packageName) {
    emitWarmupProgress(userId, 'extracting_elements', 75);
    await client.executeBatchCommands(sessionId, [
      { type: 'launch_app', params: { packageName } },
    ], { timeoutMs: 60_000 });
  }

  // Update Redis with the installed package so future warmups know what's on the emulator
  if (warmup && packageName) {
    warmup.installedPackage = packageName;
    warmup.appStoragePath = mobileApp.storagePath;
    await redisConnection.set(redisKey, JSON.stringify(warmup), 'EX', WARMUP_TTL);
  }

  // Persist packageName to project.settings.mobileApp so future warmups can
  // use the check_package fast path even after Redis TTL expires, avoiding a
  // full APK re-download on every expiry.
  if (packageName) {
    await persistPackageName(projectId, userId, mobileApp, packageName);
  }

  // Pending-install flag (if any) has now been consumed — clear it.
  if (hasPendingInstall) {
    await redisConnection.del(pendingKey);
  }

  logger.info('[MOBILE_SESSION] App installed on session', {
    sessionId,
    projectId,
    packageName: packageName || '(auto-launched by runner)',
  });
}

/**
 * Write the detected Android package name back to `project.settings.mobileApp`
 * so subsequent warmups (after Redis TTL expiry) can hit the `check_package`
 * fast path instead of re-downloading the APK. No-op when the value is
 * already up to date. Failures are logged but swallowed — this is a cache
 * warm, not a correctness-critical write.
 */
async function persistPackageName(
  projectId: string,
  userId: string,
  currentMobileApp: { packageName?: string } & Record<string, unknown>,
  packageName: string,
): Promise<void> {
  if (!packageName || currentMobileApp.packageName === packageName) return;
  try {
    await ProjectService.updateProject(projectId, userId, {
      settings: {
        mobileApp: {
          ...currentMobileApp,
          packageName,
        } as unknown as Record<string, unknown>,
      },
    });
    logger.info('[MOBILE_SESSION] Persisted packageName to project settings', {
      projectId,
      packageName,
    });
  } catch (err) {
    logger.warn('[MOBILE_SESSION] Failed to persist packageName (non-fatal)', {
      projectId,
      packageName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// RUN TEST CASE (all steps) ON MOBILE EMULATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/:sessionId/run-test-case
 *
 * Run all steps of an intent test case on the mobile emulator.
 * Body: { intentTestCaseId: string }
 * Returns: { success, totalSteps, passedSteps, failedSteps, skippedSteps, steps, durationMs }
 */
export async function runTestCaseOnSession(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { intentTestCaseId } = req.body as { intentTestCaseId?: string };

  if (!sessionId || !intentTestCaseId) {
    res.status(400).json({ success: false, error: 'sessionId and intentTestCaseId are required' });
    return;
  }

  try {
    // Load test case from DB
    const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
    const testCase = await IntentTestCaseService.getByIdInternal(intentTestCaseId);

    if (!testCase) {
      res.status(404).json({ success: false, error: 'Test case not found' });
      return;
    }

    const steps = testCase.stepsJson || [];
    if (!steps.length) {
      res.status(400).json({ success: false, error: 'Test case has no steps' });
      return;
    }

    logger.info('[MOBILE_SESSION] Running test case on emulator', {
      sessionId,
      intentTestCaseId,
      stepCount: steps.length,
      stepTypes: steps.map((s: any) => s.type),
      userId,
    });

    const client = getMobileRunnerClient();
    const runStart = Date.now();

    // Stream NDJSON so frontend can show per-step progress
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    const sendEvent = (event: Record<string, unknown>) => {
      res.write(JSON.stringify(event) + '\n');
    };

    // Notify frontend which steps will run
    sendEvent({
      type: 'started',
      totalSteps: steps.length,
      stepIds: steps.map((s: any) => s.id),
    });

    // Execute steps sequentially using the same lint-then-execute approach
    // as applySession (single step). This ensures consistent element resolution.
    const LINT_TYPES = new Set(['click', 'tap', 'double_tap', 'long_press', 'open', 'toggle', 'check', 'uncheck', 'select', 'hover', 'type', 'fill']);
    const ACTION_TYPE_MAP: Record<string, string> = {
      click: 'tap', tap: 'tap', double_tap: 'tap', long_press: 'tap',
      open: 'tap', toggle: 'tap', check: 'tap', uncheck: 'tap',
      select: 'tap', hover: 'tap', type: 'type_text', fill: 'type_text',
    };
    const RAW_CMD_MAP: Record<string, string> = {
      click: 'tap', tap: 'tap', open: 'tap', toggle: 'tap',
      check: 'tap', uncheck: 'tap', select: 'tap', hover: 'tap',
      double_tap: 'double_tap', long_press: 'long_press',
    };
    const STEP_TYPE_MAP: Record<string, string> = { tap: 'click', fill: 'type' };

    const stepResults: Array<{ stepId: string; success: boolean; error?: string; durationMs: number }> = [];
    let passedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as any;

      // If a previous step failed, skip remaining
      if (failedSteps > 0) {
        stepResults.push({ stepId: step.id, success: false, error: 'Skipped (previous step failed)', durationMs: 0 });
        skippedSteps++;
        sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'skipped', durationMs: 0 });
        continue;
      }

      // Notify frontend this step is now running
      sendEvent({ type: 'step_running', stepId: step.id, stepIndex: i });

      const stepStart = Date.now();
      const rawType = step.type || 'click';
      const description = (step.description || '').replace(/['"]+([^'"]+)['"]+/g, '$1').trim();

      try {
        // If the step has a compiled plan from a prior apply, skip lint and
        // go straight to runSteps — the runner's tryCompiledFastPath() will
        // short-circuit the LLM pipeline in ~5ms, beating a 200-500ms lint
        // round-trip. Only steps WITHOUT compiled use the lint fast-path.
        const hasCompiled = !!(step as any).compiled;

        // Fast path: lint to find element, then execute by coordinates (same as applySession).
        // Only for steps WITHOUT a compiled plan (first run / manual adds).
        if (!hasCompiled && description && LINT_TYPES.has(rawType)) {
          const lintActionType = ACTION_TYPE_MAP[rawType] || 'tap';
          const lintResult = await client.lintElement(sessionId, description, lintActionType);

          if (lintResult.status === 'resolved' && lintResult.boundingBox) {
            const bb = lintResult.boundingBox;
            const centerX = Math.round(bb.x + bb.width / 2);
            const centerY = Math.round(bb.y + bb.height / 2);

            const commands: Array<{ type: string; params: Record<string, unknown> }> = [];

            if (rawType === 'type' || rawType === 'fill') {
              commands.push({ type: 'tap', params: { x: centerX, y: centerY } });
              if (step.value) {
                commands.push({
                  type: 'type_text',
                  params: {
                    // Forward coordinates so the runner's dispatch picks the
                    // 'coordinates' branch (re-tap + waitForKeyboardReady +
                    // typeText) instead of 'direct' blind input. Without x/y
                    // the IME may still be animating after the preceding tap
                    // and the first characters get dropped — VTE then reads
                    // back stale text and burns two retries typing the same
                    // wrong value.
                    x: centerX,
                    y: centerY,
                    text: step.value,
                    clearFirst: !!(step.options?.replaceContent),
                  },
                });
                if (step.options?.pressEnter) {
                  commands.push({ type: 'press_key', params: { keycode: 'KEYCODE_ENTER' } });
                }
              }
            } else {
              commands.push({ type: RAW_CMD_MAP[rawType] || 'tap', params: { x: centerX, y: centerY } });
            }

            await client.executeBatchCommands(sessionId, commands);
            const durationMs = Date.now() - stepStart;
            stepResults.push({ stepId: step.id, success: true, durationMs });
            passedSteps++;
            sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'pass', durationMs });

            logger.info(`[MOBILE_SESSION] Step ${i + 1}/${steps.length} passed (lint path)`, {
              stepId: step.id, type: rawType, description, durationMs,
            });
            continue;
          }
          // Lint didn't resolve — fall through to runSteps
        }

        // Fallback: use runSteps pipeline for this single step.
        // CRITICAL: forward `compiled` so the runner's fast-path resolver
        // can short-circuit LLM on subsequent regression runs.
        const stepType = STEP_TYPE_MAP[rawType] || rawType;
        const intentStep = {
          id: step.id,
          type: stepType,
          description,
          value: step.value,
          assertionText: step.assertionText,
          options: step.options,
          bindingHints: step.bindingHints || {},
          compiled: (step as any).compiled,
        };

        const result = await client.runSteps(sessionId, [intentStep], {
          screenshotEachStep: true,
          stopOnFailure: true,
        });

        const stepResult = result.steps?.[0];
        const durationMs = Date.now() - stepStart;

        if (stepResult?.success) {
          stepResults.push({ stepId: step.id, success: true, durationMs });
          passedSteps++;
          sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'pass', durationMs });
          logger.info(`[MOBILE_SESSION] Step ${i + 1}/${steps.length} passed (runSteps fallback)`, {
            stepId: step.id, type: rawType, description, durationMs,
          });

          // Auto-persist compiled plan when the runner (re)built one — without this
          // every regression run re-pays the LLM cost until the user hits Save.
          if (stepResult.compiledPlan && intentTestCaseId) {
            try {
              const { IntentTestCaseService } = await import(
                '@/services/testing/ui/preview/intent-test-case.service'
              );
              const enrichedStep = {
                ...(step as any),
                compiled: stepResult.compiledPlan,
              };
              await IntentTestCaseService.updateStepFromPreviewApply({
                intentTestCaseId,
                appliedStep: enrichedStep,
                userId,
              });
            } catch (persistError) {
              logger.warn('[MOBILE_SESSION] Failed to auto-persist compiled plan', {
                stepId: step.id,
                error: persistError instanceof Error ? persistError.message : String(persistError),
              });
            }
          }
        } else {
          const errorMsg = stepResult?.error || 'Step failed';
          stepResults.push({ stepId: step.id, success: false, error: errorMsg, durationMs });
          failedSteps++;
          sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'fail', error: errorMsg, durationMs });
          logger.warn(`[MOBILE_SESSION] Step ${i + 1}/${steps.length} failed`, {
            stepId: step.id, type: rawType, description, error: errorMsg, durationMs,
          });
        }
      } catch (stepError) {
        const durationMs = Date.now() - stepStart;
        const errorMsg = stepError instanceof Error ? stepError.message : String(stepError);
        stepResults.push({
          stepId: step.id,
          success: false,
          error: errorMsg,
          durationMs,
        });
        failedSteps++;
        sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'fail', error: errorMsg, durationMs });
        logger.warn(`[MOBILE_SESSION] Step ${i + 1}/${steps.length} threw error`, {
          stepId: step.id, error: errorMsg,
        });
      }
    }

    const totalDurationMs = Date.now() - runStart;

    logger.info('[MOBILE_SESSION] Test case run completed', {
      sessionId,
      intentTestCaseId,
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      skippedSteps,
      durationMs: totalDurationMs,
    });

    sendEvent({
      type: 'completed',
      success: failedSteps === 0 && skippedSteps === 0,
      totalSteps: steps.length,
      passedSteps,
      failedSteps,
      skippedSteps,
      durationMs: totalDurationMs,
    });
    res.end();
  } catch (error) {
    logger.error('[MOBILE_SESSION] Run test case failed', {
      sessionId,
      intentTestCaseId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to run test case',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
