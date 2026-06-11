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
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import type { MobileIntentActionType, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { ProjectService } from '@/services/core/project.service';
import { getProjectMobileApp } from '@/services/mobile/project-mobile-app.helper';
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { uploadEditorTrace } from '@/services/testing/ui/preview/editor-trace-upload';
import { refreshIdle, cancelIdle } from '@/services/mobile/mobile-idle.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getIO } from '@/websocket/core/server';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// `installAppOnSession` was extracted to `MobileAppPrepService.prepApp` —
// see `src/services/mobile/mobile-app-prep.service.ts`. The constants and
// `WarmupData` interface remain exported from this file because the
// service imports them.
import { MobileAppPrepService } from '@/services/mobile/mobile-app-prep.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { applyProjectPolicyToSession } from '@/services/mobile/permission-policy.service';

// ── Constants ────────────────────────────────────────────────────────

export const WARMUP_PREFIX = 'mobile_warmup:';
// Kept in lockstep with `IDLE_TTL_MS` in `mobile-idle.service.ts` so an
// active user can't be expired before the in-memory idle timer fires.
export const WARMUP_TTL = 900; // 15 minutes

/**
 * Runner-side Socket.IO handshake auth for the browser to attach.
 *
 * The mobile runner has an `io.use()` middleware that rejects connections
 * without `auth.apiKey` when `API_KEY` is set on its side (runner env). We
 * return the key in the warmup response so the frontend can pass it via
 * `io(url, { auth: { apiKey } })`. Empty string when the runner is in open-
 * auth mode (dev) — the middleware short-circuits on missing config.
 *
 * Yes, this value ends up in the browser. It's intentional — the runner is
 * a per-tenant preview service behind nginx + TLS, not a zero-trust endpoint.
 * If stronger isolation becomes required we'll proxy WebSocket traffic
 * through this backend and drop the shared key entirely.
 */
function getRunnerAuth(): string {
  return env.MOBILE_RUNNER_API_KEY ?? '';
}

/**
 * Derive the current WebSocket URL for the runner from the **live** env.
 *
 * Why not just read `existing.runnerSocketUrl` from Redis? Because warmup
 * entries live 15 minutes, so if the runner moves (env change, DNS flip,
 * fresh deploy that repointed `MOBILE_RUNNER_URL`) every cached entry keeps
 * handing the old URL to the frontend until the TTL elapses. That exact
 * class of regression ate a prod debugging session on 2026-04-21 — the
 * only fix was a manual `redis-cli flushdb`. Now we recompute on every
 * response so cache staleness can never again point browsers at a dead
 * runner.
 */
function currentRunnerSocketUrl(): string {
  return env.MOBILE_RUNNER_URL.replace(/^http/, 'ws').replace(/\/$/, '');
}

/**
 * Pending-install flag: set when an APK is uploaded but the upload-time
 * `autoBootAndInstall` couldn't reach a running emulator. Stores the
 * storagePath of the APK that needs installing. Consumed by the next
 * `installAppOnSession` call (at warmup time) which forces a full install
 * even if Redis thinks the same APK is cached — because in reality the
 * emulator may never have actually received it.
 */
export const PENDING_INSTALL_PREFIX = 'mobile_pending_install:';
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
  /**
   * Audit BUG-1 fix: persist the `deviceSelector` used to BOOT this
   * session so a later warmup can compare against the new request's
   * selector and detect "user wants to switch devices."
   *
   * If the new request asks for a DIFFERENT serial (or source), we
   * MUST NOT reuse this cached session — otherwise the user picks
   * device B in the popover, presses Warmup, and silently keeps
   * landing on device A. Persisting it here lets the cached-reuse
   * branch above invalidate the cache when the selectors disagree.
   *
   * Optional because legacy entries (pre-fix) won't have it; the
   * comparison defaults to "no recorded selector → reuse is safe."
   */
  deviceSelector?: {
    source?: 'local-emulator' | 'local-physical' | 'cloud';
    serial?: string;
  };
}

/**
 * Emit a `preview:session:progress` WebSocket event so the AI editor's
 * PreviewLoadingProgress component can render a real progress bar while
 * the emulator warms up. Mirrors the event shape already used by the web
 * preview path. Non-fatal — a socket hiccup must never fail warmup.
 *
 * Mobile warmup stages (in order) — each maps to a real step so the
 * editor's loading bar shows truthful copy instead of borrowed web names:
 *   boot_emulator       → emulator/simulator is booting or being claimed
 *   installing_app      → APK/IPA install in progress
 *   launching_app       → cold-launching the app
 *   waiting_first_frame → app launched; waiting for the first video frame
 *                         (the frontend flips this to `ready` itself when
 *                          the live stream delivers frame #1)
 *   ready               → complete
 */
function emitWarmupProgress(
  userId: string,
  stage: 'boot_emulator' | 'installing_app' | 'launching_app' | 'waiting_first_frame' | 'ready',
  progress: number,
  error?: string,
): void {
  try {
    webSocketService.emitToUser(userId, 'preview:session:progress', {
      stage,
      progress,
      ...(error ? { error } : {}),
    });
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
  const warmupStart = Date.now();
  // Per-phase timing accumulator. Populated as we go and emitted on the
  // single final `warmup response` log line so operators can spot which
  // step dominates a slow warmup without scattering grep-able log lines.
  const timings: Record<string, number> = {};
  const time = async <T>(label: string, op: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await op();
    } finally {
      timings[label] = (timings[label] ?? 0) + (Date.now() - start);
    }
  };
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const {
    projectId,
    platform: rawPlatform,
    appPackage,
    deviceSelector: rawDeviceSelector,
    prelaunch: rawPrelaunch,
  } = req.body as {
    projectId?: string;
    platform?: string;
    appPackage?: string;
    deviceSelector?: unknown;
    /**
     * If `false`, the warmup installs the APK but does NOT auto-launch it.
     * Callers (frontend) can then trigger `launch_app` explicitly when the
     * preview surface actually becomes visible. Saves 5-10s on the warmup
     * critical path. Defaults to `true` to preserve the existing contract
     * for callers that haven't opted in.
     */
    prelaunch?: boolean;
  };
  const prelaunch = rawPrelaunch !== false; // default true

  if (!projectId) {
    res.status(400).json({ success: false, error: 'projectId is required' });
    return;
  }

  const VALID_PLATFORMS: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  let platform: MobilePlatform = VALID_PLATFORMS[rawPlatform ?? ''] ?? 'android';
  // Self-correct: the editor may warm up with platform='android' for a project
  // whose app is actually Flutter (e.g. opened from an old android-typed test
  // case). Without upgrading here, the warmup creates a plain android session,
  // skips attach-flutter below, and the preview/editor reads an empty native
  // tree. Upgrade android→flutter from the detected framework; never downgrade.
  if (platform === 'android') {
    const framework = await MobileAppStorageService.getDetectedFramework(projectId).catch(
      () => undefined,
    );
    if (framework === 'flutter') {
      logger.info('[MOBILE_SESSION] warmup upgrading android→flutter from detectedFramework', {
        projectId,
      });
      platform = 'flutter';
    }
  }
  // Flutter sessions are created as a NATIVE android session first, then
  // upgraded via `attachFlutter` (install → launch → VM Service detect).
  // The runner's direct `createSession('flutter')` probes the VM Service
  // before the app is installed (chicken-and-egg → always fails), and the
  // pool never warms 'flutter' anyway. So we always ask the runner for
  // 'android' and keep `platform` ('flutter') only as the logical label
  // stored in Redis + returned to the frontend.
  const isFlutter = platform === 'flutter';
  const sessionCreatePlatform: MobilePlatform = isFlutter ? 'android' : platform;

  // Phase 2.6: validate `deviceSelector` if present. Inline validator to
  // match this file's existing style (no zod). Rejects malformed selectors
  // up front so the runner doesn't return a confusing INVALID_INPUT 400
  // through our error pipeline. Both fields are optional but cannot be
  // wrong-typed when supplied — empty-string serial in particular slips
  // through `if (selector.serial)` checks downstream.
  let deviceSelector: { source?: 'local-emulator' | 'local-physical' | 'cloud'; serial?: string } | undefined;
  if (rawDeviceSelector !== undefined && rawDeviceSelector !== null) {
    if (typeof rawDeviceSelector !== 'object' || Array.isArray(rawDeviceSelector)) {
      res.status(400).json({ success: false, error: 'deviceSelector must be an object' });
      return;
    }
    const sel = rawDeviceSelector as { source?: unknown; serial?: unknown };
    const validSources = ['local-emulator', 'local-physical', 'cloud'] as const;
    if (sel.source !== undefined && !validSources.includes(sel.source as typeof validSources[number])) {
      res.status(400).json({
        success: false,
        error: `deviceSelector.source must be one of ${validSources.join(', ')}`,
      });
      return;
    }
    if (sel.serial !== undefined && (typeof sel.serial !== 'string' || sel.serial.trim() === '')) {
      res.status(400).json({
        success: false,
        error: 'deviceSelector.serial must be a non-empty string',
      });
      return;
    }
    deviceSelector = {
      source: sel.source as 'local-emulator' | 'local-physical' | 'cloud' | undefined,
      serial: typeof sel.serial === 'string' ? sel.serial : undefined,
    };
  }

  // iOS-specific default: when the frontend doesn't pin a deviceSelector,
  // assume simulator. Why this is here and not at the runner: the runner's
  // default-source policy can flip to 'local-physical' when an iPhone is
  // hotplugged via USB (the iOS device watcher reports it). For a *create-
  // test* warmup that's never what the user wants — they want a fresh
  // simulator. Backend is the right layer to disambiguate because it's the
  // first stop where we know "this is a warmup, not a debug-physical-device
  // session". Android is left alone (the Android default already lands on
  // an emulator). Physical-iOS callers must pin `source: 'local-physical'`
  // explicitly; this default never overrides that.
  if (platform === 'ios' && deviceSelector === undefined) {
    deviceSelector = { source: 'local-emulator' };
    logger.debug('[MOBILE_SESSION] defaulting iOS deviceSelector to local-emulator', {
      userId,
      projectId,
    });
  }

  logger.info('[MOBILE_SESSION] warmup request', {
    userId,
    projectId,
    platform,
    appPackage: appPackage ?? null,
    runnerUrl: env.MOBILE_RUNNER_URL,
    runnerAuthEnabled: !!env.MOBILE_RUNNER_API_KEY,
  });

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
    const lockAcquired = await time('redis_lock', () => redisConnection.set(lockKey, '1', 'EX', 60, 'NX'));
    if (!lockAcquired) {
      // Another warmup is in progress — wait briefly then check for the result
      logger.info('[MOBILE_SESSION] Concurrent warmup detected, waiting for result', { projectId, userId });
      await new Promise((r) => setTimeout(r, 3000));
      const waitResult = await redisConnection.get(redisKey);
      if (waitResult) {
        const parsed: WarmupData = JSON.parse(waitResult);
        if (parsed.sessionId && parsed.sessionId !== '_booting') {
          await redisConnection.del(lockKey);
          const runnerSocketUrl = currentRunnerSocketUrl();
          logger.info('[MOBILE_SESSION] warmup response (path=concurrent_wait)', {
            userId, projectId,
            sessionId: parsed.sessionId,
            runnerSocketUrl,
            tookMs: Date.now() - warmupStart,
            timings,
          });
          // Active editor → start the per-user idle timer.
          try { refreshIdle(userId, getIO()); } catch { /* non-fatal */ }
          res.json({
            success: true,
            sessionId: parsed.sessionId,
            runnerSocketUrl,
            runnerApiKey: getRunnerAuth(),
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
          const runnerSocketUrl = currentRunnerSocketUrl();
          logger.info('[MOBILE_SESSION] warmup response (path=booting_wait)', {
            userId, projectId,
            sessionId: bootedSessionId,
            runnerSocketUrl,
            tookMs: Date.now() - warmupStart,
            timings,
          });
          try { refreshIdle(userId, getIO()); } catch { /* non-fatal */ }
          res.json({
            success: true,
            sessionId: bootedSessionId,
            runnerSocketUrl,
            runnerApiKey: getRunnerAuth(),
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
        const stillAlive = await time('session_exists_check', () => client.sessionExists(existing.sessionId));

        if (!stillAlive) {
          logger.warn('[MOBILE_SESSION] Cached session no longer exists on runner, creating fresh', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
          });
          await redisConnection.del(redisKey);
          // Fall through to create a new session below
        } else if (
          // Audit BUG-1 fix: when the caller pinned a new
          // `deviceSelector` that DOESN'T match what booted this
          // cached session, we must NOT reuse it — otherwise picking
          // device B in the popover and pressing Warmup silently lands
          // back on device A. Compare serial + source: a serial
          // mismatch is the loud "user explicitly chose differently"
          // case; a source mismatch (e.g. physical vs emulator on the
          // same project) is the same intent at a coarser granularity.
          //
          // Asymmetric: a request WITHOUT a selector (Default) reuses
          // anything (intentional — "Default" means "I don't care").
          // A request WITH a selector requires a match.
          deviceSelector
          && (
            (deviceSelector.serial !== undefined
              && existing.deviceSelector?.serial !== deviceSelector.serial)
            || (deviceSelector.source !== undefined
              && existing.deviceSelector?.source !== deviceSelector.source)
          )
        ) {
          logger.info('[MOBILE_SESSION] Selector changed — invalidating cached session', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
            previousSelector: existing.deviceSelector ?? null,
            requestedSelector: deviceSelector,
          });
          // Audit follow-up: drop the Redis pointer FIRST, then destroy
          // the runner-side session. Reversing the historical order
          // closes a concurrent-warmup race:
          //
          //   A: starts destroy() ───────── del(redisKey) ──> done
          //   B:                  read(redisKey) → STILL POINTS AT A's
          //                       being-destroyed session, then issues
          //                       install/launch on it → 404 from runner.
          //
          // With del-first, B reads "no session" and falls through to
          // create a fresh one. The destroy() then runs best-effort
          // (errors already swallowed) — at worst we leak a session
          // that the runner's TTL/unplug-watchdog will reap anyway.
          await redisConnection.del(redisKey);
          try {
            await client.destroySession(existing.sessionId, { userId });
          } catch (err) {
            logger.warn('[MOBILE_SESSION] destroySession during selector-switch failed (non-fatal)', {
              sessionId: existing.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // Fall through to create a new session below
        } else if (existing.platform !== platform) {
          // Platform mismatch — the cached session's platform must match the
          // requested one, in BOTH directions:
          //   - Flutter request, non-flutter cached: a plain android/ios
          //     session has no Dart VM Service connection.
          //   - Non-flutter request, flutter cached: a flutter session
          //     (android host upgraded via attachFlutter) reports
          //     platform='flutter' and must NOT be handed to an android/ios
          //     run. (The earlier one-directional check missed this case and
          //     reused a flutter session for an android request.)
          // Invalidate and fall through to a fresh create. For flutter the
          // create path does android → install → attachFlutter.
          logger.info('[MOBILE_SESSION] Cached session platform mismatch — recreating', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
            cachedPlatform: existing.platform,
            requestedPlatform: platform,
          });
          await redisConnection.del(redisKey);
          try {
            await client.destroySession(existing.sessionId, { userId });
          } catch (err) {
            logger.warn('[MOBILE_SESSION] destroySession during flutter-mismatch invalidation failed (non-fatal)', {
              sessionId: existing.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
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
          emitWarmupProgress(userId, 'boot_emulator', 15);
          // Skip re-prep for a reused Flutter session: it's already a live,
          // attached Flutter session (app installed + running + VM Service
          // connected). Re-running install/launch here would reinstall over
          // the running app and tear down the FlutterClient connection.
          if (!isFlutter) {
            try {
              await time('prep_app_reuse', () => MobileAppPrepService.prepApp({
                client,
                sessionId: existing.sessionId,
                projectId,
                userId,
                appPackage,
                platform,
                skipLaunch: !prelaunch,
                onProgress: (stage, progress) => emitWarmupProgress(userId, stage, progress),
              }));
            } catch (err) {
              logger.warn('[MOBILE_SESSION] App install/launch on reused session failed (non-fatal)', {
                sessionId: existing.sessionId,
                projectId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          // App is launched; the response goes out next and the frontend
          // subscribes to the video stream. It flips to `ready` (100%)
          // itself on the first real frame, so we stop at 95% here.
          emitWarmupProgress(userId, 'waiting_first_frame', 95);

          const runnerSocketUrl = currentRunnerSocketUrl();
          logger.info('[MOBILE_SESSION] warmup response (path=cached_reuse)', {
            userId, projectId,
            sessionId: existing.sessionId,
            runnerSocketUrl,
            tookMs: Date.now() - warmupStart,
            timings,
          });
          try { refreshIdle(userId, getIO()); } catch { /* non-fatal */ }
          res.json({
            success: true,
            sessionId: existing.sessionId,
            runnerSocketUrl,
            runnerApiKey: getRunnerAuth(),
            platform: existing.platform,
            reused: true,
          });

          return;
        }
      }
    }

    // Health check
    const client = getMobileRunnerClient();
    const healthy = await time('runner_health_check', () => client.isHealthy());
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
    //
    // ownerId scopes the runner's Android multi-user so each backend user
    // sees only their own apps on a shared redroid container. See
    // qait-mobile-runner/docs/multi-user-known-risks.md. Gated by
    // MOBILE_MULTI_USER_ISOLATION — default OFF (shared workspace, ~5-15s
    // faster claim, no `pm create-user` "Maximum user limit" risk).
    //
    // Phase 2.6: when the caller pinned a `deviceSelector`, the pool
    // path is only meaningful if NO specific serial was requested.
    //
    // Bypass cases:
    //   1. `source === 'local-physical'` — pre-booted emulators can't
    //      be retargeted to a USB phone.
    //   2. ANY `serial` pinned — even for `source === 'local-emulator'`,
    //      because the pool may have a DIFFERENT emulator pre-booted
    //      and the runner has no contract to re-acquire a specific
    //      serial out of the pool. Audit BUG-4: shipping the
    //      "show emulators in popover" UX without this gate would
    //      silently use whatever's pre-booted instead of the user's
    //      explicit pick. Default (no selector) keeps pool fast-path.
    const effectiveOwnerId = env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined;
    let session: Awaited<ReturnType<typeof client.createSession>>;
    const skipPoolForPhysical = deviceSelector?.source === 'local-physical' || !!deviceSelector?.serial;

    // Emit boot_emulator BEFORE the (blocking) create/claim call — not after.
    // createSession can take ~60s and may crash-loop; emitting only after it
    // returns meant the frontend never saw a real boot event during the boot
    // window and fell back to its timer animation (the fake green stepper from
    // the bug report). Firing it here makes the boot step truthful: the loader
    // sits on "Booting device" for as long as the device is actually booting,
    // and a crash surfaces as a real failure (catch block below) instead of a
    // phantom-complete checklist.
    emitWarmupProgress(userId, 'boot_emulator', 10);
    if (skipPoolForPhysical) {
      logger.info('[MOBILE_SESSION] Pinned selector — bypassing pool', {
        projectId,
        deviceSelector,
      });
      session = await time('create_session_pinned', () => client.createSession(sessionCreatePlatform, {
        ownerId: effectiveOwnerId,
        deviceSelector,
        userId,
      }));
    } else {
      try {
        session = await time('pool_claim', () => client.claimSession(sessionCreatePlatform, { ownerId: effectiveOwnerId, userId }));
        logger.info('[MOBILE_SESSION] Pool session claimed for warmup', {
          projectId,
          sessionId: session.sessionId,
          platform,
          ownerId: effectiveOwnerId ?? null,
          multiUserIsolation: env.MOBILE_MULTI_USER_ISOLATION,
        });
      } catch (poolErr) {
        logger.debug('[MOBILE_SESSION] Pool claim failed, cold-booting', {
          projectId,
          error: poolErr instanceof Error ? poolErr.message : String(poolErr),
        });
        session = await time('create_session_cold', () => client.createSession(sessionCreatePlatform, {
          ownerId: effectiveOwnerId,
          deviceSelector,
          userId,
        }));
      }
    }

    // Emulator/simulator is now actually up (createSession/claim returned) —
    // advance the boot stage toward done. The next emit is `installing_app`
    // from prepApp/MobileAppPrepService.
    emitWarmupProgress(userId, 'boot_emulator', 30);

    // Propagate project-level permission policy to the runner. Delegates
    // to the shared service so warmup, regression worker, and CI runs
    // all read from the same precedence chain (project default →
    // runner default). Non-fatal: any failure logs at debug and leaves
    // the session on the runner default.
    await time('permission_policy', () => applyProjectPolicyToSession({
      client,
      sessionId: session.sessionId,
      projectId,
      userId,
      context: { source: 'warmup' },
    }));

    const runnerSocketUrl = currentRunnerSocketUrl();

    // Store mapping in Redis
    const warmupData: WarmupData = {
      sessionId: session.sessionId,
      runnerUrl: env.MOBILE_RUNNER_URL,
      runnerSocketUrl,
      platform,
      createdAt: new Date().toISOString(),
      // Audit BUG-1 fix: persist the selector so the next warmup can
      // detect "user wants a different device" and invalidate the
      // cache instead of silently reusing the wrong device. Only
      // stored when a non-default selector was actually used.
      ...(deviceSelector ? { deviceSelector } : {}),
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
    // For Flutter we install but DON'T launch here — `attachFlutter` below
    // clears logcat and launches so the one-time VM Service log line is
    // inside the detection window.
    let preppedPackage: string | undefined;
    try {
      preppedPackage = await time('prep_app_fresh', () => MobileAppPrepService.prepApp({
        client,
        sessionId: session.sessionId,
        projectId,
        userId,
        appPackage,
        platform,
        skipLaunch: isFlutter ? true : !prelaunch,
        onProgress: (stage, progress) => emitWarmupProgress(userId, stage, progress),
      }));
    } catch (err) {
      logger.warn('[MOBILE_SESSION] App install/launch during warmup failed (non-fatal)', {
        sessionId: session.sessionId,
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Flutter: upgrade the native session into a Flutter session (launch →
    // VM Service detect → connect). FATAL — a Flutter test can't run without
    // the driver connection, and the runner destroys the native session on
    // failure, so drop the Redis pointer and surface the runner's status
    // (422 FLUTTER_NOT_DETECTED when the build isn't debug/profile).
    if (isFlutter) {
      const flutterPackage = appPackage || preppedPackage;
      if (!flutterPackage) {
        await redisConnection.del(`${WARMUP_PREFIX}${projectId}:${userId}`).catch(() => {});
        res.status(400).json({
          success: false,
          error: 'No mobile app uploaded for this project — cannot start a Flutter session.',
        });
        return;
      }
      try {
        await time('attach_flutter', () => client.attachFlutter(
          session.sessionId,
          { packageName: flutterPackage },
          { userId },
        ));
      } catch (err) {
        await redisConnection.del(`${WARMUP_PREFIX}${projectId}:${userId}`).catch(() => {});
        const status = (err instanceof MobileRunnerError && err.statusCode) ? err.statusCode : 500;
        logger.warn('[MOBILE_SESSION] Flutter attach failed during warmup', {
          sessionId: session.sessionId,
          projectId,
          userId,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(status).json({
          success: false,
          error: err instanceof Error ? err.message : 'Flutter attach failed',
          ...(err instanceof MobileRunnerError ? { code: err.code } : {}),
        });
        return;
      }
    }
    // App launched on the fresh session; warmup is about to respond and the
    // frontend will subscribe to the live stream. It promotes this to
    // `ready` (100%) on the first decoded frame.
    emitWarmupProgress(userId, 'waiting_first_frame', 95);

    logger.info('[MOBILE_SESSION] warmup response (path=fresh_create)', {
      userId, projectId,
      sessionId: session.sessionId,
      runnerSocketUrl,
      tookMs: Date.now() - warmupStart,
      timings,
    });

    try { refreshIdle(userId, getIO()); } catch { /* non-fatal */ }
    res.status(201).json({
      success: true,
      sessionId: session.sessionId,
      runnerSocketUrl,
      runnerApiKey: getRunnerAuth(),
      platform,
      reused: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[MOBILE_SESSION] Warmup failed', {
      projectId,
      userId,
      error: message,
    });

    // Tell the loader the boot stage FAILED so it stops the spinner and shows
    // the real reason (e.g. "Emulator crashed during startup") instead of the
    // fallback timer optimistically completing the checklist. `boot_emulator`
    // is the right stage label: this catch fires for createSession/claim
    // failures (the boot window) — install/launch failures are swallowed as
    // non-fatal above and never reach here.
    emitWarmupProgress(userId, 'boot_emulator', 0, message);

    res.status(500).json({
      success: false,
      error: 'Failed to warm up emulator session',
      message,
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
      await client.destroySession(sessionId, { userId });
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

    // Close editor trace file for this session and upload it, mirroring the
    // web editor's recording:stop path. uploadEditorTrace skips Supabase in
    // development (keeps the local file) and is fire-and-forget so a slow
    // upload never delays the destroy response.
    await EditorTraceService.close(`mobile-${sessionId}`)
      .then((meta) => {
        if (meta) {
          uploadEditorTrace({
            filePath: meta.filePath,
            userId: meta.userId,
            previewSessionId: `mobile-${sessionId}`,
            traceType: 'editor',
          }).catch((err) => logger.error('[MOBILE_SESSION] Editor trace upload failed on destroy', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      })
      .catch(() => {});

    // User explicitly closed the editor → cancel any pending idle timer.
    try { cancelIdle(userId); } catch { /* non-fatal */ }

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
    ], { interactive: true, userId: req.user.id });
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
    ], { interactive: true, userId: req.user.id });
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
    ], { interactive: true, userId: req.user.id });
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
    ], { interactive: true, userId: req.user.id });
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
    ], { interactive: true, userId: req.user.id });
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
    ], { interactive: true, userId: req.user.id });
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
    ], { interactive: true, userId: req.user.id });
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

    // Normalize: strip surrounding quotes (handles whole-wrap + balanced inline pairs).
    // See normalize-description.ts for failure modes the previous regex had.
    const { normalizeMobileDescription } = await import('@/services/mobile/normalize-description');
    const description = normalizeMobileDescription(rawDescription);

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
      // `dismiss` closes the top modal without resolving an element.
      // The `actionType` here is only used to tell the resolver what the
      // user intended; for dismiss there's nothing to resolve, but we
      // still pass it through so the schema validator accepts the step.
      dismiss: 'dismiss',
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

    // Pull bindingHints off the draft — the frontend sends either the
    // authored-from-recording set nested under intentStep, or the
    // locally-edited flat set if the user has been tweaking. Prefer the
    // locally-edited one so `label`/`selector` edits in the inspector
    // immediately bust the runner's lint / resolver caches. Falls back to
    // the recorded hints when the step is clean.
    const bindingHints: Record<string, unknown> | undefined = (() => {
      const edited = stepDraft?.bindingHints;
      if (edited && typeof edited === 'object' && Object.keys(edited).length > 0) {
        return edited as Record<string, unknown>;
      }
      const recorded = stepDraft?.intentStep?.bindingHints;
      if (recorded && typeof recorded === 'object' && Object.keys(recorded).length > 0) {
        return recorded as Record<string, unknown>;
      }
      return undefined;
    })();

    // Use the dedicated lint endpoint — fast, non-destructive, returns bounding box.
    // This replaces the old runSteps(assert_visible) approach which was 3-5x slower.
    const lintResult = await client.lintElement(sessionId, description, actionType, bindingHints, { userId: req.user.id });

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
        visibleNodeCount: lintResult.visibleNodeCount,
        topNodes: lintResult.topNodes,
        intentWords: lintResult.intentWords,
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
      // Forward the runner-built compiled plan when it succeeded. Frontend
      // can persist it onto the IntentStep on save so the next regression
      // run goes through fast-path (~5ms) instead of re-paying the lint
      // round-trip. Only forwarded when the plan is meaningful — i.e. the
      // resolve actually succeeded; on `not_found` / `error` / failed lint
      // there's no plan to share. Optional field, ignored by older frontends.
      ...(lintResult.compiledPlan ? { compiled: lintResult.compiledPlan } : {}),
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
  const { stepDraft, intentTestCaseId } = req.body as {
    stepDraft?: any;
    /**
     * Optional `intent_test_cases.id`. When present, a successful apply
     * persists the freshly-built `compiledPlan` back onto
     * `intent_test_cases.steps_json[].compiled` — same pattern as the
     * web preview WS handler (preview.handler.ts:1925). Without this,
     * mobile editor runs never seed compiled plans for subsequent
     * regression runs, so regression always pays the full LLM cost on
     * every step. On Gemini-503 days that cascades into "no element
     * found" failures even though the editor session passed.
     */
    intentTestCaseId?: string;
  };

  if (!sessionId || !stepDraft) {
    res.status(400).json({ success: false, error: 'sessionId and stepDraft are required' });
    return;
  }

  try {
    // Trace logging for mobile editor
    const traceSessionId = `mobile-${sessionId}`;
    const trace = EditorTraceService.getOrCreate(traceSessionId, req.user!.id);
    const rawStepType = stepDraft.type || stepDraft.kind || 'click';
    // Normalize description identically to the lint path so trace logs and
    // dispatch coords agree on the same canonical text.
    const { normalizeMobileDescription: normalizeForApply } = await import('@/services/mobile/normalize-description');
    const description = normalizeForApply(stepDraft.elementDescription || stepDraft.description);
    trace.writeMobileApplyRequest({
      stepId: stepDraft.id || `apply_${Date.now()}`,
      stepType: rawStepType,
      description,
      value: stepDraft.value,
      sessionId,
    });
    const applyStart = Date.now();

    // Propagate client-disconnect to the runner so its step loop exits
    // promptly and releases the session mutex. Without this, hitting Stop
    // during a run followed by a quick Run can race into 'busy' because
    // the prior step is still executing on the runner.
    const abortController = new AbortController();
    const onReqClose = () => {
      if (!res.writableEnded) abortController.abort();
    };
    req.on('close', onReqClose);

    // Delegate to shared service — REST and WS both use this path.
    const { MobileStepApplyService } = await import('@/services/mobile/mobile-step-apply.service');
    let output;
    try {
      output = await MobileStepApplyService.apply({
        sessionId,
        stepDraft,
        userId: req.user!.id,
        signal: abortController.signal,
      });
    } finally {
      req.off('close', onReqClose);
    }

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

    // Auto-persist compiled plan to `intent_test_cases.steps_json[].compiled`
    // when the apply succeeded AND the caller passed `intentTestCaseId`.
    // Mirrors the web preview WS handler at preview.handler.ts:1920-1937 —
    // without this, mobile editor sessions never save compiled plans, so
    // every subsequent regression run hits the LLM/vision resolvers fresh
    // (visible as `llm resolver timeout` / `vision resolver timeout` /
    // `tapByText: no element found` cascades on the runner).
    //
    // Caller-opt-in via `intentTestCaseId` so editor traffic that isn't
    // tied to a saved test case (one-off probes) doesn't bloat the DB.
    // Mutex-safe: updateStepFromPreviewApply takes withTestCaseMutex so
    // it serializes against batchUpdateStepsFromRun (regression worker).
    if (output.success && output.appliedStep && intentTestCaseId) {
      try {
        const { IntentTestCaseService } = await import(
          '@/services/testing/ui/preview/intent-test-case.service'
        );
        // Cast: mobile's `appliedStep` shape (mobile-step-apply.service.ts:208)
        // is structurally a subset of web's IntentStep — `id`, `type`,
        // `description`, `value`, `options`, `bindingHints`, `evidence`,
        // `compiled`. The service merges by stepId, so extra/missing fields
        // are non-fatal; this cast just satisfies the type at the boundary.
        const persisted = await IntentTestCaseService.updateStepFromPreviewApply({
          intentTestCaseId,
          appliedStep: output.appliedStep as unknown as Parameters<
            typeof IntentTestCaseService.updateStepFromPreviewApply
          >[0]['appliedStep'],
          userId: req.user!.id,
        });
        if (persisted) {
          logger.info('[MOBILE_SESSION] Auto-persisted appliedStep to intent_test_cases', {
            intentTestCaseId,
            stepId: output.appliedStep.id,
            hasCompiled: !!output.appliedStep.compiled,
          });
        }
      } catch (persistError) {
        // Non-fatal — the user already saw the apply succeed. Log so a
        // sudden spike in persist failures (RLS regression, etc.) is
        // observable without breaking the editor flow.
        logger.warn('[MOBILE_SESSION] Failed to auto-persist appliedStep (non-fatal)', {
          intentTestCaseId,
          stepId: output.appliedStep?.id,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
    }

    if (!res.writableEnded) {
      res.json({
        success: output.success,
        stepResult: output.stepResult,
        appliedStep: output.appliedStep,
        status: output.status,
      });
    }
  } catch (error) {
    // If the client aborted, there's nothing to respond to — just log.
    if (res.writableEnded) {
      logger.info('[MOBILE_SESSION] Apply aborted by client', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
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

    // Load app so we know which storagePath to pend if we fail early.
    // Reads the platform-sharded slot when available so an Android+iOS
    // dual-platform project pends the correct binary instead of always
    // the legacy singular one (which is whatever was uploaded last).
    const project = await ProjectService.getProject(projectId, userId);
    const projectAppForPend = getProjectMobileApp(project?.settings, platform);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyApp = (project?.settings as any)?.mobileApp;
    const appStoragePath = projectAppForPend?.storagePath ?? legacyApp?.storagePath;

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
      const runnerSocketUrl = currentRunnerSocketUrl();
      const bootingData: WarmupData = {
        sessionId: '_booting',
        runnerUrl: env.MOBILE_RUNNER_URL,
        runnerSocketUrl,
        platform,
        createdAt: new Date().toISOString(),
      };
      await redisConnection.set(redisKey, JSON.stringify(bootingData), 'EX', WARMUP_TTL);

      const autoBootOwnerId = env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined;
      const session = await client.createSession(platform, { ownerId: autoBootOwnerId, userId });
      sessionId = session.sessionId;

      // Update Redis with the real session ID
      bootingData.sessionId = sessionId;
      await redisConnection.set(redisKey, JSON.stringify(bootingData), 'EX', WARMUP_TTL);

      logger.info('[MOBILE_AUTO_BOOT] Emulator created', {
        projectId,
        sessionId,
        ownerId: autoBootOwnerId ?? null,
        multiUserIsolation: env.MOBILE_MULTI_USER_ISOLATION,
      });
    }

    // Install the app, but DO NOT launch it yet — we want the very
    // first frame the user sees in the preview to be the cold-launch
    // UI of a freshly data-wiped app. Auto-launching here and then
    // wiping would leak ~1-2s of stale UI (prior session's logged-in
    // state, last-visited screen, etc.) into the preview before the
    // wipe lands.
    emit('installing', 'Installing app...', sessionId);
    const installedPackage = await MobileAppPrepService.prepApp({
      client,
      sessionId,
      projectId,
      userId,
      platform,
      skipLaunch: true,
      onProgress: (stage, progress) => emitWarmupProgress(userId, stage, progress),
    });

    // Wipe app data, then launch fresh. The preview now sees exactly
    // one transition: home screen → first-launch app UI. No stale data
    // ever reaches the user.
    //
    // - close_app(hard:true) → runner runs `pm clear --user N` which
    //   wipes /data/user/N/<pkg> (SharedPreferences, accounts, caches,
    //   DBs) and revokes runtime permissions (auto-re-granted by the
    //   runner per the session's permission policy). Idempotent
    //   regardless of whether the app is currently running, since
    //   `pm clear` implicitly force-stops.
    // - launch_app → cold start, lands on the app's first-run UI.
    //
    // Best-effort: a wipe-and-launch failure shouldn't block 'ready'
    // since the app is installed and launchable either way.
    if (installedPackage) {
      try {
        // Audit fix (Bug #3): bumped 30s → 60s. `pm clear --user N` on a
        // multi-MB app with cold filesystem caches can take 5-15s; cold
        // `am start` on multi-user adds another 10-20s for first-launch
        // dex optimization. 30s was the smallest budget in this helper —
        // matches the 60s used elsewhere in installAppOnSession.
        await client.executeBatchCommands(sessionId, [
          { type: 'close_app', params: { packageName: installedPackage, hard: true } },
          { type: 'launch_app', params: { packageName: installedPackage } },
        ], { timeoutMs: 60_000, userId });
        logger.info('[MOBILE_AUTO_BOOT] App wiped + launched on warmup', {
          projectId,
          sessionId,
          packageName: installedPackage,
        });
      } catch (err) {
        // Audit fix (Bug #2): on wipe+launch failure the app is in an
        // undefined state (data-wiped but not relaunched, or worse). The
        // install side-effect at the end of installAppOnSession already
        // CLEARED the pending-install flag, so the next warmup would hit
        // the cached fast path and again skip the launch — silently
        // wedged. Re-set the pending flag so the next warmup forces a
        // full install + launch path.
        await setPendingInstall(appStoragePath);
        logger.warn('[MOBILE_AUTO_BOOT] Wipe+launch failed — re-flagged pending install for next warmup', {
          projectId,
          sessionId,
          packageName: installedPackage,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    emit('ready', 'Emulator ready', sessionId);
    logger.info('[MOBILE_AUTO_BOOT] App installed, emulator ready', { projectId, sessionId });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit('error', `Setup failed: ${message}`);
    logger.error('[MOBILE_AUTO_BOOT] Failed', { projectId, userId, error: message });

    // Mark APK as pending so the next warmup re-attempts the install.
    // CRITICAL: read the platform-sharded slot, not the legacy singular
    // one. The legacy slot mirrors the latest upload across all
    // platforms, so on a dual-platform project this could point at the
    // wrong-platform binary — pending-install would then force-install
    // an .apk on an iOS session (or vice versa) on the next warmup.
    try {
      const project = await ProjectService.getProject(projectId, userId);
      const shardedApp = getProjectMobileApp(project?.settings, platform);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const legacyApp = (project?.settings as any)?.mobileApp;
      const pendingPath = shardedApp?.storagePath ?? legacyApp?.storagePath;
      await setPendingInstall(pendingPath);
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
// HELPER: Claim warmed session (used by mobile-test-run.job.ts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Claim a warmed session from Redis for use in a test run.
 * Atomically reads + deletes the key so no other job can reuse it,
 * THEN verifies with the runner that the session is still alive before
 * handing it back. Without the liveness check the worker would happily
 * grab a session id that the runner had already destroyed (idle timer
 * fired, user closed the editor, runner restarted) and every step of
 * the resulting regression would return `Session not found: <id>`
 * because the runner's `sessions` map doesn't have it. The Redis entry
 * has its own 15-min TTL, but it's a TTL on the WARMUP record, not on
 * runner-side session aliveness — they can drift.
 *
 * Returns WarmupData if a warmed session exists AND the runner still has
 * it; null otherwise (caller falls through to pool/cold-start).
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

    // Skip the liveness check for placeholder rows that autoBootAndInstall
    // writes BEFORE the real session id is available. Returning a literal
    // "_booting" string here would just make the worker's runSteps target
    // the placeholder and 404. Treating it as "no warmup" lets the worker
    // fall through cleanly to its own session acquisition path.
    if (!data.sessionId || data.sessionId === '_booting') {
      logger.debug('[MOBILE_SESSION] Warmed session row was a booting placeholder — discarding', {
        projectId,
        userId,
      });
      return null;
    }

    // Liveness check — ask the runner whether it still has this session.
    // If the runner says no, the Redis row was stale and we MUST NOT hand
    // the dead id back. Use the same `getMobileRunnerClient()` instance
    // the warmup created the session with so the URL/auth match.
    let alive = false;
    try {
      const client = getMobileRunnerClient();
      alive = await client.sessionExists(data.sessionId);
    } catch (probeErr) {
      // Probe fail → treat as not-alive. Worker will cold-start. Better
      // than handing back an id we can't verify.
      logger.warn('[MOBILE_SESSION] Session liveness probe failed — discarding warmed session', {
        projectId,
        userId,
        sessionId: data.sessionId,
        error: probeErr instanceof Error ? probeErr.message : String(probeErr),
      });
      return null;
    }

    if (!alive) {
      logger.warn('[MOBILE_SESSION] Warmed session no longer alive on runner — discarding', {
        projectId,
        userId,
        sessionId: data.sessionId,
      });
      return null;
    }

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
  logger.info('RUN MOBILE TEST STEPS')
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

    // Per-step summary of the persisted shape — deterministic oracle for
    // diagnosing "optional step still halts the run" complaints. On a failed
    // run, this line tells us whether the DB record actually carries the
    // optional flag (`options.continueOnError` or legacy top-level).
    logger.info('[MOBILE_SESSION] Run steps summary', {
      intentTestCaseId,
      steps: steps.map((s: any) => ({
        id: s.id,
        type: s.type,
        optional: !!(s.options?.continueOnError ?? s.continueOnError),
      })),
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
    // Optional steps (step.options.continueOnError === true) don't halt the
    // run when they fail — they're recorded as failed but the loop keeps going.
    // `hardFailed` tracks whether a *required* step has failed so remaining
    // steps get short-circuited to 'skipped'.
    let hardFailed = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as any;

      // If a previous *required* step failed, skip remaining.
      if (hardFailed) {
        stepResults.push({ stepId: step.id, success: false, error: 'Skipped (previous step failed)', durationMs: 0 });
        skippedSteps++;
        sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'skipped', durationMs: 0 });
        continue;
      }

      // Tolerant of both the canonical shape (options.continueOnError) and a
      // legacy top-level `continueOnError` some older save paths wrote.
      const isOptional = !!(step.options?.continueOnError ?? step.continueOnError);

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
          const lintResult = await client.lintElement(sessionId, description, lintActionType, undefined, { userId });

          if (lintResult.status === 'resolved' && lintResult.boundingBox) {
            const bb = lintResult.boundingBox;
            const centerX = Math.round(bb.x + bb.width / 2);
            const centerY = Math.round(bb.y + bb.height / 2);

            // Forward `intent` AND `coordsConfidence` so the runner's
            // smartResolve can re-validate when the lint confidence is
            // below the trust threshold (0.9). Sequential runs accumulate
            // small drift over many steps — without this each step's
            // command bypasses the runner's safety net (no-intent → early
            // passthrough), and a low-confidence lint silently dispatches
            // to coordinates that may already be stale.
            // Mirrors the same fix in MobileStepApplyService Path A.
            const coordsConfidence = typeof lintResult.confidence === 'number'
              ? lintResult.confidence
              : undefined;
            const coordParams: Record<string, unknown> = {
              x: centerX,
              y: centerY,
              intent: description,
            };
            if (coordsConfidence !== undefined) coordParams.coordsConfidence = coordsConfidence;

            const commands: Array<{ type: string; params: Record<string, unknown> }> = [];

            if (rawType === 'type' || rawType === 'fill') {
              commands.push({ type: 'tap', params: { ...coordParams } });
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
                    ...coordParams,
                    text: step.value,
                    clearFirst: !!(step.options?.replaceContent),
                    // Editor "type like a human" toggle → runner typing realism.
                    ...(step.options?.typeMode ? { typeMode: step.options.typeMode } : {}),
                  },
                });
                if (step.options?.pressEnter) {
                  commands.push({ type: 'press_key', params: { keycode: 'KEYCODE_ENTER' } });
                }
              }
            } else {
              commands.push({ type: RAW_CMD_MAP[rawType] || 'tap', params: { ...coordParams } });
            }

            await client.executeBatchCommands(sessionId, commands, { userId });
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
          userId,
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
        } else {
          const errorMsg = stepResult?.error || 'Step failed';
          stepResults.push({ stepId: step.id, success: false, error: errorMsg, durationMs });
          failedSteps++;
          if (!isOptional) hardFailed = true;
          sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'fail', error: errorMsg, durationMs, optional: isOptional });
          logger.warn(`[MOBILE_SESSION] Step ${i + 1}/${steps.length} failed${isOptional ? ' (optional — continuing)' : ''}`, {
            stepId: step.id, type: rawType, description, error: errorMsg, durationMs, optional: isOptional,
          });
        }

        // ── Auto-persist compiled plan ───────────────────────────────
        // Persist when:
        //   (a) step succeeded AND a plan was emitted, OR
        //   (b) step FAILED but resolveVia ∈ {compiled,compiled_fast_path,
        //       cache} — i.e. the plan was already validated against the
        //       current tree before this run; the failure was downstream of
        //       resolution (dispatch, VTE, app crash) and the plan itself is
        //       still good. Throwing it away would force the next run to
        //       re-pay full LLM cost for nothing.
        // We deliberately do NOT persist on failure when resolveVia was a
        // fresh LLM/vision/thinking pass — locking in a possibly-wrong plan
        // hurts more than it helps.
        if (stepResult?.compiledPlan && intentTestCaseId) {
          const PROVEN: ReadonlySet<string> = new Set(['compiled', 'compiled_fast_path', 'cache']);
          const planIsProven = !!stepResult.resolvedVia && PROVEN.has(stepResult.resolvedVia);
          // Runner can mark a plan stale post-dispatch (VTE mismatch /
          // foreground mismatch). Skip persistence in that case — saving
          // a "successful dispatch but wrong element" plan locks in the bug.
          const planIsStale = !!stepResult.planStaleReason;
          const shouldPersist = !planIsStale && (stepResult.success === true || planIsProven);
          if (shouldPersist) {
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
        if (!isOptional) hardFailed = true;
        sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'fail', error: errorMsg, durationMs, optional: isOptional });
        logger.warn(`[MOBILE_SESSION] Step ${i + 1}/${steps.length} threw error${isOptional ? ' (optional — continuing)' : ''}`, {
          stepId: step.id, error: errorMsg, optional: isOptional,
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
