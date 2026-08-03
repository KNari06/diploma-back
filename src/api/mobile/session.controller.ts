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

import { randomUUID } from 'crypto';
import { env } from '@/config/environment/env';
import { redisConnection, QueueManager } from '@/config/infrastructure/queues';
import { getMobileRunnerClient, MobileRunnerClient, resolveRunnerUrlForHost, RESOLVE_DISPATCH_TIMEOUT_MS, type IMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { CompanionRunnerClient } from '@/services/mobile/companion/companion-runner-client';
import { companionRegistry } from '@/services/mobile/companion/companion-registry';
import {
  getMobileRunnerClientForSession,
  storeSessionRunnerBinding,
  clearSessionRunnerBinding,
  runnerUrlToSocketUrl,
} from '@/services/mobile/session-runner-routing';
import { resolveDedicatedDevice } from '@/services/mobile/dedicated-device.service';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import type { MobileIntentActionType, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { normalizeMobileBriefing } from '@/services/mobile/mobile-briefing.util';
import { toRunnerActionType } from '@/services/mobile/lint-action-type';
import { ProjectService } from '@/services/core/project.service';
import { getProjectMobileApp, getFlutterDefaultHost, getDefaultVariantLabel, resolveFlutterHost } from '@/services/mobile/project-mobile-app.helper';
import { sendMobileRunnerError, isSessionGoneError } from './mobile-error-mapper';
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { uploadEditorTrace, closeAndUploadEditorTrace } from '@/services/testing/ui/preview/editor-trace-upload';
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
import { track as trackSessionInFlight } from '@/services/mobile/session-inflight.registry';
import { CompanionFeature } from '@/config/features/companion';

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
 * Return the Socket.IO URL for a session's runner.
 *
 * For shared-pool sessions: recompute from live env (2026-04-21 stale-URL
 * lesson — cached WarmupData.runnerSocketUrl can lag if the env changes).
 * For dedicated-runner sessions: use WarmupData.runnerSocketUrl; the
 * dedicated URL comes from the DB row, not an env var, so there is no
 * env-drift concern and the cached value is authoritative.
 */
function getEffectiveRunnerSocketUrl(
  warmupData?: Pick<WarmupData, 'isDedicated' | 'runnerBindingKind' | 'runnerSocketUrl'>,
): string | null {
  if (warmupData?.runnerBindingKind === 'companion') {
    return null;
  }
  if (warmupData?.isDedicated) {
    return warmupData.runnerSocketUrl;
  }
  return currentRunnerSocketUrl();
}

function getEffectiveRunnerApiKey(
  warmupData?: Pick<WarmupData, 'isDedicated' | 'runnerBindingKind' | 'runnerApiKey'>,
): string {
  if (warmupData?.runnerBindingKind === 'companion') {
    return '';
  }
  if (warmupData?.isDedicated) {
    return warmupData.runnerApiKey ?? '';
  }
  return getRunnerAuth();
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

/**
 * Record a runner-RECLAIMED session expiry into the editor trace.
 *
 * When an editor action returns 410 SESSION_EXPIRED because the runner no
 * longer has the session, the runner reclaimed it on its own (its 25-min TTL,
 * a pool eviction, or a redeploy) — the backend teardown paths (idle timer /
 * disconnect grace) never ran, so `mobile_session_teardown` is absent and the
 * expiry leaves NO trace (only an ephemeral local `[MOBILE_SESSION]` log line).
 * That's why these expiries are invisible in Supabase. Write the event under
 * the same `mobile-${sessionId}` key the action used, then flush the trace so
 * it actually reaches storage. Fire-and-forget: callers `void` this AFTER
 * responding so it never delays the 410. Best-effort — never throws.
 */
async function traceMobileSessionExpiry(
  sessionId: string,
  userId: string,
  surfacedBy: 'apply' | 'lint',
  runnerCode?: string,
  reason?: string | null,
): Promise<void> {
  // NOTE: the queryable Loki `session.expired` audit line is emitted by
  // `sendMobileRunnerError` (the single funnel every session-gone path passes
  // through). This helper only writes the richer JSONL trace event.
  try {
    EditorTraceService.getOrCreate(`mobile-${sessionId}`, userId)
      .writeMobileSessionExpiredSurfaced({ sessionId, surfacedBy, runnerCode, reason: reason ?? 'unknown' });
    await closeAndUploadEditorTrace(`mobile-${sessionId}`);
  } catch (err) {
    logger.warn('[MOBILE_SESSION] expiry trace write failed (non-fatal)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Release a warmup lock ONLY if it is still ours (compare-and-del by token).
 *
 * The 2026-06-29 incident was a concurrent warmup deleting a lock it didn't
 * own and then stomping the live session. The mirror risk is the holder
 * deleting a lock that a LATER warmup re-acquired after the holder's TTL
 * lapsed. Atomic check-then-del via Lua closes both: we delete the key only
 * when its value equals our token. Best-effort — a Redis error just leaves the
 * lock to expire on its 60s TTL, which is safe.
 */
async function releaseWarmupLock(lockKey: string, token: string | null): Promise<void> {
  if (!token) return; // we never held it (e.g. failed before acquiring)
  try {
    await redisConnection.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
      1,
      lockKey,
      token,
    );
  } catch (err) {
    logger.debug('[MOBILE_SESSION] warmup lock release failed (non-fatal, TTL backstop)', {
      lockKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface WarmupData {
  sessionId: string;
  /** True when the session lives on a dedicated runner (workspace_dedicated_device). */
  isDedicated?: boolean;
  /** Companion-backed sessions route through the user's outbound companion socket. */
  runnerBindingKind?: 'direct' | 'companion';
  companionUserId?: string;
  runnerUrl: string;
  runnerSocketUrl: string | null;
  runnerApiKey?: string;
  platform: MobilePlatform;
  /**
   * For a Flutter session, the HOST the session was booted on ('android' /
   * 'ios'). `platform` is always 'flutter' for both hosts, so it can't tell an
   * Android-emulator session from an iOS-simulator one — a later warmup that
   * switched the host toggle would otherwise reuse the wrong-host session (the
   * reuse path skips re-prep for Flutter). Compared in the reuse gate to force
   * a recreate on host switch. Optional: legacy/non-flutter entries omit it and
   * default to 'android' in the comparison.
   */
  hostPlatform?: 'android' | 'ios';
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
    hostPlatform: rawHostPlatform,
    appPackage,
    deviceSelector: rawDeviceSelector,
    prelaunch: rawPrelaunch,
    variantLabel: rawVariantLabel,
  } = req.body as {
    projectId?: string;
    platform?: string;
    /**
     * HOST platform for a `flutter` warmup — `android` (default) or `ios`. Picks
     * whether the runner acquires an Android emulator or an iOS simulator, and
     * which artifact slot (`android` .apk vs `ios` .app) prepApp installs.
     * Ignored for non-Flutter platforms (they already ARE their host).
     */
    hostPlatform?: string;
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
    /**
     * Named build-variant lane to install (e.g. 'Staging'). When set, prep
     * installs that lane's resolved build instead of the project default, so
     * the editor preview matches the build the flow is pinned to. Absent →
     * project default lane (pre-variant behaviour).
     */
    variantLabel?: string;
  };
  const prelaunch = rawPrelaunch !== false; // default true
  // Trim to a non-empty label; '' / whitespace means "no variant" (default lane).
  const variantLabel = typeof rawVariantLabel === 'string' && rawVariantLabel.trim()
    ? rawVariantLabel.trim()
    : undefined;

  if (!projectId) {
    logger.warn('[MOBILE_SESSION] warmup rejected: projectId is required', {
      userId,
      reason: 'missing_projectId',
      status: 400,
    });
    res.status(400).json({ success: false, error: 'projectId is required' });
    return;
  }

  // IDOR guard: projectId comes from the request body, so a caller could pass
  // any project's id. Verify the user actually has access BEFORE deriving any
  // project-scoped state (workspace, app, dedicated device). getProject returns
  // null when the user is not a member of the project's workspace (no info
  // leak). Without this, a user could warm a session against another tenant's
  // project — and, with dedicated-emulator routing, reach another workspace's
  // pinned device.
  const accessibleProject = await ProjectService.getProject(projectId, userId);
  if (!accessibleProject) {
    // 404 here means the project doesn't exist OR the user isn't a member of
    // its workspace (getProject is access-scoped, no info leak). Either way the
    // editor shows the generic "Failed to start session" — log so we can tell
    // an IDOR/stale-project case apart from a runner failure without guessing.
    logger.warn('[MOBILE_SESSION] warmup rejected: project not found or no access', {
      userId,
      projectId,
      platform: rawPlatform,
      reason: 'project_not_found_or_forbidden',
      status: 404,
    });
    res.status(404).json({ success: false, error: 'Project not found' });
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
  // HOST lane for a Flutter test: android (default) or ios. A Flutter app is a
  // NATIVE session under the hood (upgraded via attach-flutter), so we acquire
  // the host platform, not 'flutter'. Precedence: explicit request-body host >
  // project default (`settings.flutterDefaultHost`) > android. The frontend
  // always sends the host, so the project-default fallback only matters for raw
  // API callers — without it they silently got android even for an iOS project.
  const flutterHostPlatform: 'android' | 'ios' = resolveFlutterHost(
    rawHostPlatform,
    accessibleProject.settings,
  );
  const sessionCreatePlatform: MobilePlatform = isFlutter ? flutterHostPlatform : platform;

  // Phase 2.6: validate `deviceSelector` if present. Inline validator to
  // match this file's existing style (no zod). Rejects malformed selectors
  // up front so the runner doesn't return a confusing INVALID_INPUT 400
  // through our error pipeline. Both fields are optional but cannot be
  // wrong-typed when supplied — empty-string serial in particular slips
  // through `if (selector.serial)` checks downstream.
  let deviceSelector: { source?: 'local-emulator' | 'local-physical' | 'cloud'; serial?: string } | undefined;
  if (rawDeviceSelector !== undefined && rawDeviceSelector !== null) {
    if (typeof rawDeviceSelector !== 'object' || Array.isArray(rawDeviceSelector)) {
      logger.warn('[MOBILE_SESSION] warmup rejected: malformed deviceSelector', {
        userId,
        projectId,
        platform,
        reason: 'deviceSelector_not_object',
        status: 400,
      });
      res.status(400).json({ success: false, error: 'deviceSelector must be an object' });
      return;
    }
    const sel = rawDeviceSelector as { source?: unknown; serial?: unknown };
    const validSources = ['local-emulator', 'local-physical', 'cloud'] as const;
    if (sel.source !== undefined && !validSources.includes(sel.source as typeof validSources[number])) {
      logger.warn('[MOBILE_SESSION] warmup rejected: invalid deviceSelector.source', {
        userId,
        projectId,
        platform,
        source: sel.source,
        reason: 'deviceSelector_bad_source',
        status: 400,
      });
      res.status(400).json({
        success: false,
        error: `deviceSelector.source must be one of ${validSources.join(', ')}`,
      });
      return;
    }
    if (sel.serial !== undefined && (typeof sel.serial !== 'string' || sel.serial.trim() === '')) {
      logger.warn('[MOBILE_SESSION] warmup rejected: invalid deviceSelector.serial', {
        userId,
        projectId,
        platform,
        reason: 'deviceSelector_bad_serial',
        status: 400,
      });
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
  if (sessionCreatePlatform === 'ios' && deviceSelector === undefined) {
    deviceSelector = { source: 'local-emulator' };
    logger.debug('[MOBILE_SESSION] defaulting iOS deviceSelector to local-emulator', {
      userId,
      projectId,
    });
  }

  // Dedicated emulator: if this project's workspace has an active dedicated
  // device, pin the warmed session to it and force ownerId=workspaceId. Setting
  // a `serial` makes the create/claim block below take the pinned path (skips
  // the shared pool). Inert (null) unless the feature flag is on AND a row
  // exists. workspaceId is derived from the access-checked project above — never
  // from the request body (tenancy invariant).
  const dedicatedWorkspaceId: string | undefined = accessibleProject.workspace_id ?? undefined;
  const dedicated = await resolveDedicatedDevice(dedicatedWorkspaceId, sessionCreatePlatform);
  if (dedicated) {
    deviceSelector = { serial: dedicated.serial };
    logger.info('[MOBILE_SESSION] warmup pinned to dedicated device', {
      projectId,
      workspaceId: dedicatedWorkspaceId,
      platform,
    });
  }
  // Route to the companion when the user either explicitly pinned their physical
  // phone OR left the picker on "Default/auto" — because on auto the frontend
  // sends no deviceSelector, yet pairing a companion is itself an explicit act
  // (ran the CLI + entered a code), so auto should prefer the paired phone.
  // Explicitly picking the emulator (source: 'local-emulator'/'cloud') opts out.
  // `useCompanionRunner` still gates on an actually-connected companion, so this
  // is a no-op for anyone without one. Flutter qualifies — sessionCreatePlatform
  // is 'android' for it (Flutter runs on an Android session + attach-flutter).
  const wantsPhysicalOrAuto = !deviceSelector?.source
    || deviceSelector.source === 'local-physical';
  const companionRequested = !dedicated
    && sessionCreatePlatform === 'android'
    && wantsPhysicalOrAuto;
  const useCompanionRunner = companionRequested
    && CompanionFeature.isEnabled()
    && await companionRegistry.isConnected(userId);
  if (useCompanionRunner) {
    logger.info('[MOBILE_SESSION] warmup routing through connected companion', {
      userId,
      projectId,
      platform,
      deviceSelector,
    });
  }

  logger.info('[MOBILE_SESSION] warmup request', {
    userId,
    projectId,
    platform,
    appPackage: appPackage ?? null,
    variantLabel: variantLabel ?? null,
    runnerUrl: env.MOBILE_RUNNER_URL,
    runnerAuthEnabled: !!env.MOBILE_RUNNER_API_KEY,
  });

  // Warmup lock identity — declared out here so the catch can release OUR lock
  // (compare-and-del) on failure. Assigned once the lock is acquired below.
  const lockKey = `${WARMUP_PREFIX}${projectId}:${userId}:lock`;
  let lockToken: string | null = null;

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
    //
    // INCIDENT 2026-06-29 (Flutter, repeated "session gone on first lint"):
    // a user reloading the editor fires a fresh /warmup per reload. A real
    // warmup takes ~24-27s (pool_claim ~15s + attach_flutter ~7s). The OLD code
    // waited only 3s for the in-flight warmup, then `del(lockKey)` — DELETING A
    // LOCK IT DOESN'T OWN — and fell through to create its OWN session. Two
    // warmups then ran in parallel on the same project+user; the second one's
    // cache-invalidation `destroySession` killed the session the editor was
    // already holding → 410 SESSION_EXPIRED on the first lint, every reload.
    //
    // Fix: (1) POLL for the holder's result long enough to cover a real warmup
    // instead of giving up at 3s; (2) NEVER `del` a lock we don't own — if the
    // holder is still alive we either return its result or 409 (let the client
    // retry), and only create fresh when the lock has genuinely EXPIRED (holder
    // died), which `SET NX` will then let us re-acquire.
    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;
    // lockKey is the hoisted const above; mint a unique token so we only ever
    // release OUR lock (compare-and-del), never a concurrent warmup's.
    const myLockToken = randomUUID();
    const LOCK_TTL_SECONDS = 60;
    const lockAcquired = await time('redis_lock', () => redisConnection.set(lockKey, myLockToken, 'EX', LOCK_TTL_SECONDS, 'NX'));
    if (lockAcquired) {
      lockToken = myLockToken;
      // Trace marker: this warmup OWNS the lock for this project+user. Pair with
      // the final `warmup response (path=...)` line (same projectId+userId) to
      // confirm exactly one warmup ran per reload — a second `lock acquired`
      // before the first's response = the concurrent path the 2026-06-29 fix
      // closed. `lockToken` correlates acquire↔release across log lines.
      logger.info('[MOBILE_SESSION] warmup lock acquired', { projectId, userId, lockToken: myLockToken });
    } else {
      // Another warmup holds the lock. Poll the result for up to the holder's
      // full lock lifetime — a real Flutter warmup runs ~24-27s, far longer
      // than the old 3s. Reuse the holder's session the moment it lands.
      const CONCURRENT_POLL_INTERVAL_MS = 1500;
      const CONCURRENT_POLL_MAX_MS = (LOCK_TTL_SECONDS - 5) * 1000; // stay inside the lock TTL
      logger.info('[MOBILE_SESSION] Concurrent warmup detected, polling for holder result', {
        projectId, userId, pollMaxMs: CONCURRENT_POLL_MAX_MS,
      });
      const concurrentWaitStart = Date.now();
      let reusedSession: WarmupData | null = null;
      let holderGone = false;
      while (Date.now() - concurrentWaitStart < CONCURRENT_POLL_MAX_MS) {
        await new Promise((r) => setTimeout(r, CONCURRENT_POLL_INTERVAL_MS));
        const waitRaw = await redisConnection.get(redisKey);
        if (waitRaw) {
          const parsed: WarmupData = JSON.parse(waitRaw);
          if (parsed.sessionId && parsed.sessionId !== '_booting') {
            reusedSession = parsed;
            break;
          }
        }
        // If the lock vanished WITHOUT a result, the holder died mid-warmup —
        // stop polling and fall through to create fresh (we'll SET NX below).
        const lockStillHeld = await redisConnection.get(lockKey);
        if (!lockStillHeld) {
          holderGone = true;
          break;
        }
      }

      if (reusedSession) {
        // Companion/dedicated-aware: a reused session may be bound to a companion
        // (runnerSocketUrl null) or a dedicated runner — honor its binding.
        const runnerSocketUrl = getEffectiveRunnerSocketUrl(reusedSession);
        logger.info('[MOBILE_SESSION] warmup response (path=concurrent_wait)', {
          userId, projectId,
          sessionId: reusedSession.sessionId,
          runnerSocketUrl,
          waitedMs: Date.now() - concurrentWaitStart,
          tookMs: Date.now() - warmupStart,
          timings,
        });
        try { refreshIdle(userId, getIO()); } catch { /* non-fatal */ }
        res.json({
          success: true,
          sessionId: reusedSession.sessionId,
          runnerSocketUrl,
          runnerApiKey: getEffectiveRunnerApiKey(reusedSession),
          runnerBindingKind: reusedSession.runnerBindingKind ?? 'direct',
          platform: reusedSession.platform,
          reused: true,
          createdAt: reusedSession.createdAt,
        });
        return;
      }

      if (!holderGone) {
        // Holder is still alive but hasn't produced a session within the poll
        // window. Do NOT delete its lock and stomp it — tell the client to
        // retry. The editor's own retry/reopen will pick up the holder's
        // session via path=concurrent_wait once it lands.
        logger.warn('[MOBILE_SESSION] Concurrent warmup still in progress, asking client to retry', {
          projectId, userId, waitedMs: Date.now() - concurrentWaitStart,
        });
        res.status(409).json({
          success: false,
          code: 'WARMUP_IN_PROGRESS',
          error: 'A session is already starting for this project. Please wait a moment.',
          retryAfterMs: 3000,
        });
        return;
      }

      // holderGone: the lock expired without a result. Try to acquire it fresh;
      // if another warmup beat us to it, bail to retry rather than racing.
      logger.info('[MOBILE_SESSION] Prior warmup holder died — acquiring fresh lock', { projectId, userId });
      const reacquired = await redisConnection.set(lockKey, myLockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
      if (!reacquired) {
        res.status(409).json({
          success: false,
          code: 'WARMUP_IN_PROGRESS',
          error: 'A session is already starting for this project. Please wait a moment.',
          retryAfterMs: 3000,
        });
        return;
      }
      lockToken = myLockToken;
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
          const runnerSocketUrl = getEffectiveRunnerSocketUrl(refreshed);
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
            runnerApiKey: getEffectiveRunnerApiKey(refreshed),
            runnerBindingKind: refreshed.runnerBindingKind ?? 'direct',
            platform: refreshed.platform,
            reused: true,
            createdAt: refreshed.createdAt,
          });
          return;
        }

        // Boot didn't complete in time — clean up and fall through to create fresh
        logger.warn('[MOBILE_SESSION] Auto-boot timed out, creating fresh session', { projectId, userId });
        await redisConnection.del(redisKey);
      } else {
        // Verify the session still exists on the runner (it may have been
        // destroyed if the runner restarted or the session TTL expired).
        const client = await getMobileRunnerClientForSession(existing.sessionId);
        const stillAlive = await time('session_exists_check', () => client.sessionExists(existing.sessionId));

        if (!stillAlive) {
          logger.warn('[MOBILE_SESSION] Cached session no longer exists on runner, creating fresh', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
          });
          await redisConnection.del(redisKey);
          try { cancelIdle(userId); } catch { /* non-fatal */ }
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
          clearSessionRunnerBinding(existing.sessionId).catch(() => {});
          try {
            await client.destroySession(existing.sessionId, { userId });
          } catch (err) {
            logger.warn('[MOBILE_SESSION] destroySession during selector-switch failed (non-fatal)', {
              sessionId: existing.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          try { cancelIdle(userId); } catch { /* non-fatal */ }
          // Fall through to create a new session below
        } else if (
          // Routing mismatch: the cached session was born on a different runner
          // than this request now wants. The common case: a session created on
          // the shared/direct runner BEFORE a companion connected — now the gate
          // wants the companion, but reusing the cached session would keep
          // handing back the direct socket URL and run on the wrong runner
          // (the "Reset doesn't switch to my phone" bug). Recreate so the
          // session's runner matches the routing decision.
          (useCompanionRunner ? 'companion' : 'direct') !== (existing.runnerBindingKind ?? 'direct')
        ) {
          logger.info('[MOBILE_SESSION] Runner routing changed — invalidating cached session', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
            cachedBindingKind: existing.runnerBindingKind ?? 'direct',
            wantCompanion: useCompanionRunner,
          });
          await redisConnection.del(redisKey);
          clearSessionRunnerBinding(existing.sessionId).catch(() => {});
          try {
            await client.destroySession(existing.sessionId, { userId });
          } catch (err) {
            logger.warn('[MOBILE_SESSION] destroySession during routing-switch failed (non-fatal)', {
              sessionId: existing.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          try { cancelIdle(userId); } catch { /* non-fatal */ }
          // Fall through to create a new session below
        } else if (
          existing.platform !== platform
          // Flutter HOST switch (android↔ios): both hosts report
          // platform='flutter', so the check above can't tell them apart. A
          // session warmed on the iOS simulator must NOT be reused for an
          // android-host request (or vice versa) — the reuse path skips re-prep
          // for Flutter, so nothing would correct the host. Legacy entries with
          // no recorded host default to 'android'.
          || (isFlutter && (existing.hostPlatform ?? 'android') !== flutterHostPlatform)
        ) {
          // Platform mismatch — the cached session's platform (and, for Flutter,
          // its host) must match the requested one, in BOTH directions:
          //   - Flutter request, non-flutter cached: a plain android/ios
          //     session has no Dart VM Service connection.
          //   - Non-flutter request, flutter cached: a flutter session
          //     (host upgraded via attachFlutter) reports platform='flutter'
          //     and must NOT be handed to an android/ios run.
          //   - Flutter request, flutter cached on the OTHER host: wrong device.
          // Invalidate and fall through to a fresh create. For flutter the
          // create path does host-native → install → attachFlutter.
          logger.info('[MOBILE_SESSION] Cached session platform/host mismatch — recreating', {
            projectId,
            userId,
            staleSessionId: existing.sessionId,
            cachedPlatform: existing.platform,
            requestedPlatform: platform,
            cachedHost: existing.hostPlatform ?? null,
            requestedHost: isFlutter ? flutterHostPlatform : null,
          });
          await redisConnection.del(redisKey);
          clearSessionRunnerBinding(existing.sessionId).catch(() => {});
          try {
            await client.destroySession(existing.sessionId, { userId });
          } catch (err) {
            logger.warn('[MOBILE_SESSION] destroySession during flutter-mismatch invalidation failed (non-fatal)', {
              sessionId: existing.sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          try { cancelIdle(userId); } catch { /* non-fatal */ }
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
                hostPlatform: flutterHostPlatform,
                variantLabel,
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

          // Refresh the per-session binding TTL for dedicated-runner sessions so
          // calls that follow this warmup reuse (tap/apply/lint) keep routing to
          // the right runner even when the original binding has expired.
          if (existing.runnerBindingKind === 'companion' && existing.companionUserId) {
            storeSessionRunnerBinding(
              existing.sessionId,
              { kind: 'companion', userId: existing.companionUserId },
              WARMUP_TTL,
            ).catch(() => {});
          } else if (existing.isDedicated) {
            storeSessionRunnerBinding(
              existing.sessionId,
              { runnerUrl: existing.runnerUrl, runnerApiKey: existing.runnerApiKey ?? null },
              WARMUP_TTL,
            ).catch(() => {});
          }

          const runnerSocketUrl = getEffectiveRunnerSocketUrl(existing);
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
            runnerApiKey: getEffectiveRunnerApiKey(existing),
            runnerBindingKind: existing.runnerBindingKind ?? 'direct',
            platform: existing.platform,
            reused: true,
            createdAt: existing.createdAt,
          });

          return;
        }
      }
    }

    // Health check — use the dedicated runner if one is configured, otherwise
    // fall back to the env-singleton. dedicated is already resolved above.
    const dedicatedRunnerUrl = dedicated?.runnerUrl ?? null;
    const dedicatedRunnerApiKey = dedicated?.runnerApiKey ?? null;
    // Host-lane routing (ADR-0019 deferred half): an ios-host Flutter warmup
    // targets MOBILE_RUNNER_IOS_URL when configured. Locally inert — the var
    // is unset, so hostRunnerUrl === env.MOBILE_RUNNER_URL and the singleton
    // is used as before. Dedicated/companion still take precedence.
    const hostRunnerUrl = resolveRunnerUrlForHost(isFlutter ? flutterHostPlatform : undefined);
    const isDistinctHostRunner = hostRunnerUrl !== env.MOBILE_RUNNER_URL;
    const client: IMobileRunnerClient = useCompanionRunner
      ? new CompanionRunnerClient(userId)
      : dedicatedRunnerUrl
      ? new MobileRunnerClient({ baseUrl: dedicatedRunnerUrl, apiKey: dedicatedRunnerApiKey ?? '' })
      : isDistinctHostRunner
      ? new MobileRunnerClient({ baseUrl: hostRunnerUrl })
      : getMobileRunnerClient();
    const healthy = await time('runner_health_check', () => client.isHealthy());
    if (!healthy) {
      // isHealthy() swallows the underlying cause (timeout / ECONNREFUSED /
      // non-200), so this is the one place an operator can see that the editor's
      // "Failed to start session" was the runner being down vs. unreachable.
      // error level so it also lands in error.log, not just mobile-session.log.
      logger.error('[MOBILE_SESSION] warmup aborted: mobile runner health check failed', {
        userId,
        projectId,
        platform,
        runnerUrl: env.MOBILE_RUNNER_URL,
        healthCheckMs: timings.runner_health_check,
        reason: 'runner_unhealthy',
        status: 503,
      });
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
    // ownerId: a dedicated session forces ownerId=workspaceId (per-workspace
    // multi-user isolation on the dedicated container); otherwise the existing
    // MOBILE_MULTI_USER_ISOLATION gate decides whether to pass the user's owner.
    const effectiveOwnerId = dedicated
      ? dedicatedWorkspaceId
      : (env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined);
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
        ...(dedicated ? { dedicated: true } : {}),
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

    // Determine effective runner URL/socket/key for this session.
    // Dedicated runner: use the row's values so the frontend connects to the
    // right socket without staleness risk (dedicated URL is DB-sourced, not an
    // env var that can drift). Shared pool: derive socket URL from live env
    // (2026-04-21 stale-cache lesson).
    const effectiveRunnerUrl = dedicatedRunnerUrl ?? hostRunnerUrl;
    const effectiveRunnerSocketUrl = useCompanionRunner
      ? null
      : dedicatedRunnerUrl
      ? runnerUrlToSocketUrl(dedicatedRunnerUrl)
      : isDistinctHostRunner
      ? runnerUrlToSocketUrl(hostRunnerUrl)
      : currentRunnerSocketUrl();

    // Store mapping in Redis
    const warmupData: WarmupData = {
      sessionId: session.sessionId,
      isDedicated: !!dedicatedRunnerUrl,
      ...(useCompanionRunner ? { runnerBindingKind: 'companion' as const, companionUserId: userId } : {}),
      runnerUrl: effectiveRunnerUrl,
      runnerSocketUrl: effectiveRunnerSocketUrl,
      runnerApiKey: dedicatedRunnerApiKey ?? undefined,
      platform,
      // Record the Flutter host so a later warmup that flipped the host toggle
      // recreates instead of reusing the wrong-host session (reuse gate above).
      ...(isFlutter ? { hostPlatform: flutterHostPlatform } : {}),
      createdAt: new Date().toISOString(),
      // Audit BUG-1 fix: persist the selector so the next warmup can
      // detect "user wants a different device" and invalidate the
      // cache instead of silently reusing the wrong device. Only
      // stored when a non-default selector was actually used.
      ...(deviceSelector ? { deviceSelector } : {}),
    };

    // Write the per-session binding BEFORE the warmup key so any concurrent
    // claimWarmedSession that sees the warmup key always finds the binding too.
    if (dedicatedRunnerUrl) {
      await storeSessionRunnerBinding(
        session.sessionId,
        { runnerUrl: dedicatedRunnerUrl, runnerApiKey: dedicatedRunnerApiKey },
        WARMUP_TTL,
      );
    } else if (useCompanionRunner) {
      await storeSessionRunnerBinding(
        session.sessionId,
        { kind: 'companion', userId },
        WARMUP_TTL,
      );
    } else if (isDistinctHostRunner) {
      // The session lives on the iOS-host runner — without a binding, later
      // session-scoped calls (getMobileRunnerClientForSession) would fall
      // back to the shared env runner and hit the WRONG host.
      await storeSessionRunnerBinding(
        session.sessionId,
        { runnerUrl: hostRunnerUrl, runnerApiKey: null },
        WARMUP_TTL,
      );
    }

    await redisConnection.set(
      `${WARMUP_PREFIX}${projectId}:${userId}`,
      JSON.stringify(warmupData),
      'EX',
      WARMUP_TTL,
    );

    // Release the warmup lock now that the session is stored. Compare-and-del
    // by token: only delete the lock if it's STILL ours — a concurrent warmup
    // that re-acquired the key after our TTL lapsed must not have its lock
    // wiped by us (the mirror of the stomp bug fixed in the concurrent branch).
    await releaseWarmupLock(lockKey, lockToken);

    logger.info('[MOBILE_SESSION] Emulator warmed up', {
      projectId,
      userId,
      sessionId: session.sessionId,
      platform,
    });

    // Install the project's mobile app and run launch_app BEFORE returning, so the
    // preview stream shows the app already open when the frontend connects.
    // A native-editor warmup can remain usable after an install failure, so its
    // prep is non-fatal. Flutter is different: attachFlutter immediately launches
    // the package to find its VM service. Continuing after a failed install turns
    // the real storage/install error into a misleading "No activities found" or
    // "Flutter VM Service not detected" error.
    // For Flutter we install but DON'T launch here — `attachFlutter` below clears
    // logcat and launches so the one-time VM Service log line is inside the
    // detection window.
    let preppedPackage: string | undefined;
    try {
      preppedPackage = await time('prep_app_fresh', () => MobileAppPrepService.prepApp({
        client,
        sessionId: session.sessionId,
        projectId,
        userId,
        appPackage,
        platform,
        hostPlatform: flutterHostPlatform,
        variantLabel,
        skipLaunch: isFlutter ? true : !prelaunch,
        onProgress: (stage, progress) => emitWarmupProgress(userId, stage, progress),
      }));
    } catch (err) {
      const prepError = err instanceof Error ? err.message : String(err);
      logger.warn('[MOBILE_SESSION] App install/launch during warmup failed', {
        sessionId: session.sessionId,
        projectId,
        platform,
        fatal: isFlutter,
        error: prepError,
      });
      if (isFlutter) {
        // The warmup entry was written before prep so concurrent callers could
        // find the freshly-created session. It is invalid when its required APK
        // could not be installed; remove it and tear down the session rather
        // than handing a future retry a broken emulator.
        await redisConnection.del(`${WARMUP_PREFIX}${projectId}:${userId}`).catch(() => {});
        await client.destroySession(session.sessionId, { userId }).catch((destroyErr) => {
          logger.warn('[MOBILE_SESSION] Failed to destroy session after Flutter app-prep failure', {
            sessionId: session.sessionId,
            projectId,
            error: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
          });
        });
        res.status(422).json({
          success: false,
          code: 'FLUTTER_APP_INSTALL_FAILED',
          error: `Unable to install the Flutter app before starting the session: ${prepError}`,
        });
        return;
      }
    }

    // Flutter: upgrade the native session into a Flutter session (launch →
    // VM Service detect → connect). FATAL — a Flutter test can't run without
    // the driver connection, and the runner destroys the native session on
    // failure, so drop the Redis pointer and surface the runner's status
    // (422 FLUTTER_NOT_DETECTED when the build isn't debug/profile).
    if (isFlutter) {
      const flutterPackage = appPackage || preppedPackage;
      if (!flutterPackage) {
        logger.warn('[MOBILE_SESSION] warmup rejected: no APK to launch for Flutter session', {
          userId,
          projectId,
          platform,
          reason: 'flutter_no_app_package',
          status: 400,
        });
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
      runnerSocketUrl: effectiveRunnerSocketUrl,
      runnerBindingKind: useCompanionRunner ? 'companion' : undefined,
      tookMs: Date.now() - warmupStart,
      timings,
    });

    try { refreshIdle(userId, getIO()); } catch { /* non-fatal */ }
    res.status(201).json({
      success: true,
      sessionId: session.sessionId,
      runnerSocketUrl: effectiveRunnerSocketUrl,
      runnerApiKey: getEffectiveRunnerApiKey(warmupData),
      runnerBindingKind: useCompanionRunner ? 'companion' : 'direct',
      platform,
      reused: false,
      createdAt: warmupData.createdAt,
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

    // Release our lock on failure so a retry/reopen isn't blocked for the full
    // 60s TTL. Compare-and-del — never wipe a concurrent warmup's lock.
    await releaseWarmupLock(lockKey, lockToken);

    sendMobileRunnerError(res, error, 'Failed to warm up emulator session');
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
    // Destroy on runner — use the session's bound runner (dedicated or shared).
    const client = await getMobileRunnerClientForSession(sessionId);
    try {
      await client.destroySession(sessionId, { userId });
    } catch (err) {
      // Session may already be expired/destroyed on runner — non-fatal
      logger.warn('[MOBILE_SESSION] Runner destroy returned error (may be expired)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Clear per-session runner binding (best-effort).
    clearSessionRunnerBinding(sessionId).catch(() => {});

    // Drop this session's authoring-credit dedup entries, mirroring what the
    // web preview does on teardown (preview-session.service.ts). Without it the
    // in-memory set only ever grows for mobile — session ids are unique, so the
    // stale keys can never match again, they just accumulate for the lifetime
    // of the API process.
    const { AuthoringCreditsService } = await import('@/services/core/authoring-credits.service');
    AuthoringCreditsService.clearSession(sessionId);

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

    sendMobileRunnerError(res, error, 'Failed to destroy session');
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
    const client = await getMobileRunnerClientForSession(sessionId);
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
    sendMobileRunnerError(res, error, 'Tap failed', { userId: req.user?.id, sessionId, surfacedBy: 'tap' });
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
    const client = await getMobileRunnerClientForSession(sessionId);
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
    sendMobileRunnerError(res, error, 'Swipe failed', { userId: req.user?.id, sessionId, surfacedBy: 'swipe' });
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
    const client = await getMobileRunnerClientForSession(sessionId);
    await client.executeBatchCommands(sessionId, [
      { type: 'go_home', params: {}, _skipWait: true },
    ], { interactive: true, userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Go home failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendMobileRunnerError(res, error, 'Go home failed', { userId: req.user?.id, sessionId, surfacedBy: 'home' });
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
    const client = await getMobileRunnerClientForSession(sessionId);
    await client.executeBatchCommands(sessionId, [
      { type: 'go_back', params: {}, _skipWait: true },
    ], { interactive: true, userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Go back failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendMobileRunnerError(res, error, 'Go back failed', { userId: req.user?.id, sessionId, surfacedBy: 'back' });
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
    const client = await getMobileRunnerClientForSession(sessionId);
    await client.executeBatchCommands(sessionId, [
      { type: 'type_text', params: { text }, _skipWait: true },
    ], { interactive: true, userId: req.user.id });
    res.json({ success: true });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Type text failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    sendMobileRunnerError(res, error, 'Type text failed', { userId: req.user?.id, sessionId, surfacedBy: 'type' });
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
    const client = await getMobileRunnerClientForSession(sessionId);
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
    sendMobileRunnerError(res, error, 'Key press failed', { userId: req.user?.id, sessionId, surfacedBy: 'key' });
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
    const client = await getMobileRunnerClientForSession(sessionId);
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
    sendMobileRunnerError(res, error, 'Command failed', { userId: req.user?.id, sessionId, surfacedBy: 'command' });
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

  // Hoisted so the catch block can emit a lint result/error trace event with the
  // same correlation id — a timed-out / thrown lint must leave a row, not a hole
  // (the missing "Order" results in the 2026-06-15 Flutter trace were this gap).
  const requestId = randomUUID();
  const trace = EditorTraceService.getOrCreate(`mobile-${sessionId}`, req.user.id);
  let lintStart = 0;
  let lintDescription = '';
  let lintActionType = 'tap';

  try {
    const client = await getMobileRunnerClientForSession(sessionId);

    // Liveness guard. Unlike warmup/apply/run (which call sessionExists), lint
    // used to forward straight to the runner with whatever sessionId the editor
    // still held — so a session the runner had reclaimed (idle TTL ~25min, pool
    // reset, runner redeploy) produced a bare runner 404 that the catch below
    // flattened into a useless "Lint failed". Detect the dead session up front
    // and return a TYPED 410 the editor recognizes (code SESSION_EXPIRED), so it
    // can surface "session expired — reopen" instead of a generic error. Cheap
    // (~one GET /api/sessions, 5s cap) and only on the lint path.
    const alive = await client.sessionExists(sessionId);
    if (!alive) {
      // Diagnostic: pull the runner's destroy tombstone so the log names the
      // REAL cause (idle_ttl / evicted / device_disconnected / multiuser_evict /
      // pool_recover / shutdown / …) instead of guessing. Best-effort; null when
      // the tombstone aged out or the runner restarted (a restart itself being
      // the implicit cause). Tracks the recurring "session gone ~15-23s after
      // warmup, first lint" incident (2026-06-29) — once a reason shows up we
      // know which teardown path to fix.
      const reason = await client.getSessionDestroyReason(sessionId);
      logger.info('[MOBILE_SESSION] Lint on a session the runner no longer has', {
        sessionId,
        reason: reason ?? 'unknown',
      });
      res.status(410).json({
        success: false,
        code: 'SESSION_EXPIRED',
        error: 'Session expired',
        ...(reason ? { reason } : {}),
        message: 'The device session is no longer available (it was reclaimed after inactivity or a restart). Reopen the test case to continue.',
      });
      void traceMobileSessionExpiry(sessionId, req.user.id, 'lint', 'liveness_precheck', reason);
      return;
    }

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

    // Step kind → runner actionType. The map is resolution POLICY, so it lives
    // in the service layer (see lint-action-type.ts for why it matters).
    const actionType = toRunnerActionType(stepType);

    // Trace logging for mobile editor
    lintDescription = description;
    lintActionType = actionType;
    trace.writeMobileLintRequest({ requestId, description, actionType, sessionId });
    lintStart = Date.now();

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
    // "Use screenshot to find element" — forces vision-only resolution. The
    // editor sends it on the draft's options; without forwarding it here the
    // toggle is inert on mobile Find (the runner would text-resolve anyway).
    const useScreenshotOnly = stepDraft?.options?.useScreenshotOnly === true;

    const lintResult = await client.lintElement(sessionId, description, actionType, bindingHints, {
      userId: req.user.id,
      useScreenshotOnly,
    });

    // Log the result for debugging element resolution issues
    trace.writeMobileLintResult({
      requestId,
      description,
      actionType,
      sessionId,
      latencyMs: Date.now() - lintStart,
      framework: lintResult.framework,
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
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[MOBILE_SESSION] Lint failed', { sessionId, error: message });
    // Leave a trace row for a failed lint so a slow/errored search isn't an
    // invisible hole in the JSONL (the missing "Order" results). Paired to the
    // request by requestId. Guard on lintStart > 0: it's set immediately after
    // writeMobileLintRequest, so a throw BEFORE the request (client init / module
    // import) writes no result — avoids an orphan result with no paired request.
    if (lintStart > 0) {
      trace.writeMobileLintResult({
        requestId,
        description: lintDescription,
        actionType: lintActionType,
        sessionId,
        latencyMs: Date.now() - lintStart,
        result: { status: 'error', message },
      });
    }
    // Forward the REAL cause (shared helper) instead of a blanket "Lint failed":
    // carries the cause in `error`, passes the runner's typed code/status, and
    // maps a session that died mid-lint (TOCTOU past the up-front guard) to a
    // typed 410 SESSION_EXPIRED.
    sendMobileRunnerError(res, error, 'Lint failed', { userId: req.user?.id, sessionId, surfacedBy: 'lint' });
    if (isSessionGoneError(error)) {
      const e = error as { reason?: string; code?: string };
      void traceMobileSessionExpiry(sessionId, req.user.id, 'lint', e.reason ?? e.code);
    }
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

  // Set the run's user triggers ON THE SESSION so the runner's trigger engine +
  // permission watcher honour them during this step. The editor "Run" applies
  // steps one at a time, so triggers can't ride the batch run-steps body — they
  // ride the session, set before each apply (like permissionPolicy). Best-effort:
  // a trigger-setup hiccup must never fail the step.
  const { triggers: applyTriggers } = req.body as { triggers?: unknown };
  if (Array.isArray(applyTriggers)) {
    try {
      const { sanitizeTriggers } = await import('@/services/mobile/trigger-validation.util');
      const triggersClient = await getMobileRunnerClientForSession(sessionId);
      await triggersClient.setTriggers(sessionId, sanitizeTriggers(applyTriggers), { userId: req.user!.id });
    } catch (err) {
      logger.warn('[applySession] failed to set triggers (non-fatal)', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Hoisted out of the try so the catch can report the REAL elapsed time. How
  // long a failed apply ran is the primary diagnostic for a stall (a 7-minute
  // latency says "connection died", a 30s one says "runner timeout"), so a
  // placeholder 0 here would throw away the most useful number in the trace.
  const applyStart = Date.now();
  // Guards against writing two `mobile_apply_result` events for one step: the
  // success path writes as soon as the verdict is known, so a throw in the
  // post-verdict work below must not make the catch write again.
  let resultTraced = false;

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
      // Marked in-flight for the duration of the runner call so a WebSocket
      // ping-timeout cleanup can't destroy this session mid-step. The run is
      // driven over REST but the session's lifetime is governed by the WS, and
      // the two fail independently — see session-inflight.registry.ts.
      output = await trackSessionInFlight(sessionId, () =>
        MobileStepApplyService.apply({
          sessionId,
          stepDraft,
          userId: req.user!.id,
          signal: abortController.signal,
        }),
      );
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
    // The result event is now on the wire. Everything below (credit charge,
    // compiled-plan persist, res.json) is post-verdict, so if any of it throws,
    // the catch must NOT write a SECOND result event for this step — that would
    // double-count `failedSteps` in trace_summary.
    resultTraced = true;

    // Charge credits for an AI-assisted mobile apply — same rate and dedup as
    // the web preview path (preview.handler.ts). Only fires when the runner
    // needed the LLM (resolvedVia 'llm'/'vision'/'thinking'); deterministic
    // tree matches are free. Fire-and-forget: billing must never delay or fail
    // the apply, which is on the interactive editor hot path.
    if (output.stepResult?.success) {
      void import('@/services/core/authoring-credits.service')
        .then(({ AuthoringCreditsService }) =>
          AuthoringCreditsService.chargeForMobileApply({
            userId: req.user!.id,
            previewSessionId: sessionId,
            stepId: stepDraft.id,
            resolvedVia: output.stepResult?.resolvedVia,
          }),
        )
        .catch((err) => {
          logger.warn('[applySession] authoring credit charge failed (non-fatal)', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

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
    // Record the failure in the trace BEFORE any early return. Without this the
    // request/result events are unbalanced: `writeMobileApplyRequest` ran at the
    // top, `writeMobileApplyResult` only runs on the success path, so an apply
    // that threw left a request with no result. `trace_summary` then reported
    // `errors: 0, failedSteps: 0` for a run the UI had shown as failed —
    // observed 2026-07-31, where the only way to diagnose a 7-minute stall was
    // a screenshot, because the trace claimed the run was clean.
    // Best-effort: tracing must never mask the original error.
    if (!resultTraced) {
      try {
        const trace = EditorTraceService.getOrCreate(`mobile-${sessionId}`, req.user!.id);
        trace.writeMobileApplyResult({
          stepId: stepDraft.id || `apply_${Date.now()}`,
          sessionId,
          latencyMs: Date.now() - applyStart,
          result: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (traceError) {
        logger.warn('[MOBILE_SESSION] Failed to write apply failure to trace (non-fatal)', {
          sessionId,
          error: traceError instanceof Error ? traceError.message : String(traceError),
        });
      }
    }

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
    sendMobileRunnerError(res, error, 'Apply failed', { userId: req.user?.id, sessionId, surfacedBy: 'apply' });
    if (isSessionGoneError(error)) {
      const e = error as { reason?: string; code?: string };
      void traceMobileSessionExpiry(sessionId, req.user!.id, 'apply', e.reason ?? e.code);
    }
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

    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;

    // Load app so we know which storagePath to pend if we fail early.
    // Reads the platform-sharded slot when available so an Android+iOS
    // dual-platform project pends the correct binary instead of always
    // the legacy singular one (which is whatever was uploaded last).
    // getProject doubles as the IDOR guard: it returns null when `userId`
    // has no access to `projectId` (the upload route is requireAuth only,
    // NOT project-scoped). Bail out before booting/installing — without this
    // a user could boot a session against another tenant's project, and with
    // dedicated-emulator routing reach another workspace's pinned device.
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      logger.warn('[MOBILE_AUTO_BOOT] No project access — skipping auto-boot', { projectId, userId });
      return;
    }
    const projectAppForPend = getProjectMobileApp(project?.settings, platform);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyApp = (project?.settings as any)?.mobileApp;
    const appStoragePath = projectAppForPend?.storagePath ?? legacyApp?.storagePath;

    // Flutter host lane. A Flutter app boots on its resolved host (project
    // default: android|ios), NOT the raw 'flutter' platform — the runner can't
    // create a 'flutter' session directly (the VM Service probe runs before the
    // app is installed → always fails). Mirror warmup: detect flutter (declared,
    // or an android-typed upload the parser flagged as flutter) and resolve the
    // host + default variant so the SAME artifact lane the editor installs is
    // prepped here. Without the host, a Flutter project defaulted to iOS would
    // silently boot android and prep the android slot after every upload.
    const autoBootFramework = platform === 'android'
      ? await MobileAppStorageService.getDetectedFramework(projectId).catch(() => undefined)
      : undefined;
    const autoBootIsFlutter = platform === 'flutter' || autoBootFramework === 'flutter';
    const autoBootHostPlatform: 'android' | 'ios' = autoBootIsFlutter
      ? getFlutterDefaultHost(project.settings)
      : 'android';
    const autoBootPrepPlatform: MobilePlatform = autoBootIsFlutter ? 'flutter' : platform;
    const autoBootVariantLabel = getDefaultVariantLabel(project.settings, autoBootPrepPlatform);
    const sessionCreatePlatform: MobilePlatform = autoBootIsFlutter ? autoBootHostPlatform : platform;

    // Resolve dedicated device early so we can use the right runner client for
    // both the sessionExists check and session creation below. Resolve against
    // the HOST (iOS is shared-only → returns null, so an iOS-host Flutter run
    // never pins an android dedicated device).
    const autoBootWorkspaceId: string | undefined = project.workspace_id ?? undefined;
    const autoBootDedicated = await resolveDedicatedDevice(autoBootWorkspaceId, sessionCreatePlatform);
    const autoBootRunnerUrl = autoBootDedicated?.runnerUrl ?? null;
    const autoBootRunnerApiKey = autoBootDedicated?.runnerApiKey ?? null;
    // Route Flutter-on-iOS to MOBILE_RUNNER_IOS_URL when configured; locally
    // inert (the var is unset → same shared runner). Dedicated takes precedence.
    const autoBootHostRunnerUrl = resolveRunnerUrlForHost(
      autoBootIsFlutter ? autoBootHostPlatform : undefined,
    );
    const autoBootIsDistinctHostRunner = autoBootHostRunnerUrl !== env.MOBILE_RUNNER_URL;
    const client = autoBootRunnerUrl
      ? new MobileRunnerClient({ baseUrl: autoBootRunnerUrl, apiKey: autoBootRunnerApiKey ?? '' })
      : autoBootIsDistinctHostRunner
      ? new MobileRunnerClient({ baseUrl: autoBootHostRunnerUrl })
      : getMobileRunnerClient();

    // Check for existing session
    let sessionId: string | null = null;
    const existingRaw = await redisConnection.get(redisKey);
    if (existingRaw) {
      const existing: WarmupData = JSON.parse(existingRaw);
      if (existing.sessionId && existing.sessionId !== '_booting') {
        // Use the runner the existing session was BORN on, not the current dedicated
        // config. If the config changed (e.g. workspace gained a dedicated runner after
        // session creation), querying the new dedicated runner for a shared-pool session
        // would always return false and force an unnecessary cold-boot.
        const existingClient: IMobileRunnerClient = existing.runnerBindingKind === 'companion' && existing.companionUserId
          ? new CompanionRunnerClient(existing.companionUserId)
          : existing.isDedicated && existing.runnerUrl
          ? new MobileRunnerClient({ baseUrl: existing.runnerUrl, apiKey: existing.runnerApiKey ?? '' })
          // An iOS-host Flutter session lives on the iOS runner (its runnerUrl
          // was stored at birth). Probe THAT runner, not the shared android one
          // — otherwise sessionExists always returns false and we needlessly
          // cold-boot. Dark locally (MOBILE_RUNNER_IOS_URL unset → runnerUrl is
          // the shared runner anyway).
          : existing.hostPlatform === 'ios' && existing.runnerUrl
          ? new MobileRunnerClient({ baseUrl: existing.runnerUrl, apiKey: existing.runnerApiKey ?? '' })
          : getMobileRunnerClient();
        const alive = await existingClient.sessionExists(existing.sessionId);
        if (alive) {
          sessionId = existing.sessionId;
          // Refresh the binding TTL so subsequent calls (install, launch, tap) resolve
          // the right runner even when the original binding has expired.
          if (existing.runnerBindingKind === 'companion' && existing.companionUserId) {
            storeSessionRunnerBinding(
              existing.sessionId,
              { kind: 'companion', userId: existing.companionUserId },
              WARMUP_TTL,
            ).catch(() => {});
          } else if (existing.isDedicated) {
            storeSessionRunnerBinding(
              existing.sessionId,
              { runnerUrl: existing.runnerUrl, runnerApiKey: existing.runnerApiKey ?? null },
              WARMUP_TTL,
            ).catch(() => {});
          }
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
      const autoBootEffectiveRunnerUrl = autoBootRunnerUrl ?? autoBootHostRunnerUrl;
      const autoBootEffectiveSocketUrl = autoBootRunnerUrl
        ? runnerUrlToSocketUrl(autoBootRunnerUrl)
        : autoBootIsDistinctHostRunner
        ? runnerUrlToSocketUrl(autoBootHostRunnerUrl)
        : currentRunnerSocketUrl();
      const bootingData: WarmupData = {
        sessionId: '_booting',
        isDedicated: !!autoBootRunnerUrl,
        runnerUrl: autoBootEffectiveRunnerUrl,
        runnerSocketUrl: autoBootEffectiveSocketUrl,
        runnerApiKey: autoBootRunnerApiKey ?? undefined,
        platform,
        // Record the Flutter host so a later warmup reuse-gate can tell this
        // session apart from an android-host one (mirrors the warmup branch).
        ...(autoBootIsFlutter ? { hostPlatform: autoBootHostPlatform } : {}),
        createdAt: new Date().toISOString(),
      };
      await redisConnection.set(redisKey, JSON.stringify(bootingData), 'EX', WARMUP_TTL);

      const autoBootOwnerId = autoBootDedicated
        ? autoBootWorkspaceId
        : (env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined);
      const session = await client.createSession(sessionCreatePlatform, {
        ownerId: autoBootOwnerId,
        userId,
        ...(autoBootDedicated ? { deviceSelector: { serial: autoBootDedicated.serial }, dedicated: true } : {}),
      });
      sessionId = session.sessionId;

      // Update Redis with the real session ID
      bootingData.sessionId = sessionId;
      await redisConnection.set(redisKey, JSON.stringify(bootingData), 'EX', WARMUP_TTL);

      // Store per-session runner binding for dedicated OR distinct-host (iOS)
      // sessions — without it, later session-scoped calls fall back to the
      // shared env runner and hit the WRONG host.
      if (autoBootRunnerUrl) {
        await storeSessionRunnerBinding(
          sessionId,
          { runnerUrl: autoBootRunnerUrl, runnerApiKey: autoBootRunnerApiKey },
          WARMUP_TTL,
        );
      } else if (autoBootIsDistinctHostRunner) {
        await storeSessionRunnerBinding(
          sessionId,
          { runnerUrl: autoBootHostRunnerUrl, runnerApiKey: null },
          WARMUP_TTL,
        );
      }

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
      platform: autoBootPrepPlatform,
      hostPlatform: autoBootHostPlatform,
      variantLabel: autoBootVariantLabel,
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
  /**
   * When supplied, the warmed record must match this platform (and, for
   * Flutter, the host lane) or the claim is REFUSED — and, crucially, the
   * Redis record is left in place. Pre-fix the caller compared platforms
   * AFTER the delete, so every mismatched flutter regression run silently
   * ate the editor's warmup and cold-started anyway. Flutter matching:
   * `platform === 'flutter'` plus `hostPlatform` (absent = 'android',
   * mirroring the editor reuse gate).
   */
  match?: { platform: MobilePlatform; hostPlatform?: 'android' | 'ios' },
): Promise<WarmupData | null> {
  const key = `${WARMUP_PREFIX}${projectId}:${userId}`;

  try {
    const raw = await redisConnection.get(key);
    if (!raw) return null;

    const data = JSON.parse(raw) as WarmupData;

    // Platform/host gate BEFORE the delete — a mismatched record belongs to
    // the editor (or another platform's warmup) and must survive this claim.
    if (match) {
      const platformMatches = data.platform === match.platform;
      const hostMatches =
        match.platform !== 'flutter' ||
        (data.hostPlatform ?? 'android') === (match.hostPlatform ?? 'android');
      if (!platformMatches || !hostMatches) {
        logger.warn('[MOBILE_SESSION] Warmed session left unclaimed — platform/host mismatch', {
          projectId,
          userId,
          warmedPlatform: data.platform,
          warmedHostPlatform: data.hostPlatform ?? null,
          requestedPlatform: match.platform,
          requestedHostPlatform: match.hostPlatform ?? null,
        });
        return null;
      }
    }

    // Atomically delete so no other job can claim
    await redisConnection.del(key);

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
    // Use the session's bound runner (dedicated or shared) so URL/auth match.
    let alive = false;
    try {
      const client = await getMobileRunnerClientForSession(data.sessionId);
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

    // V-cross-app: link_test_case steps are resolved by RegressionRunService
    // before dispatch (see link-resolution.service.ts) — this session-scoped
    // run path has no equivalent resolution wired up. Reject explicitly
    // rather than forwarding an unresolved step straight to the runner.
    if (steps.some((s: any) => s?.type === 'link_test_case')) {
      res.status(400).json({
        success: false,
        error: 'This test case links to another test case — trigger a regression run to test it (linked steps are not supported when running on an existing session).',
      });
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

    const client = await getMobileRunnerClientForSession(sessionId);
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

      // Author switched this step off in the editor — never dispatch it. Only
      // an explicit `false` disables, so steps saved before the flag existed
      // keep running. Checked before `hardFailed` so a disabled step reports
      // its own reason rather than inheriting the previous failure's.
      if (step.options?.enabled === false) {
        stepResults.push({ stepId: step.id, success: true, error: undefined, durationMs: 0 });
        skippedSteps++;
        sendEvent({ type: 'step_result', stepId: step.id, stepIndex: i, status: 'skipped', durationMs: 0, disabled: true });
        continue;
      }

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
          const useScreenshotOnly = (step as any).options?.useScreenshotOnly === true;
          // Forward the step's screenshot-only flag — this lint IS the
          // resolution for an uncompiled step on this run path, so dropping it
          // here silently text-resolves a step the user marked vision-only.
          const lintResult = await client.lintElement(sessionId, description, lintActionType, undefined, {
            userId,
            useScreenshotOnly,
          });

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

            // The lint above resolved vision-led, but the coordinates it
            // produced are demoted below TRUST_COORDS_THRESHOLD (0.9), so the
            // runner RE-RESOLVES before tapping — and without this flag that
            // re-resolve drops back to the text pipeline and re-picks the very
            // element the toggle exists to avoid. CLAUDE.md Hard invariant #7
            // requires it on the dispatched command; MobileStepApplyService
            // does this already, and this loop is a second copy of the same
            // lint-then-tap logic that was missing it.
            //
            // Live evidence (JanaPost TC-13, unlabeled settings gear): Find
            // highlighted the gear at vision confidence exactly 0.9, then a
            // full Run tapped the `EN` language button 182 px away — and
            // reported PASS, because tapping EN succeeded.
            const visionFlag: Record<string, unknown> = useScreenshotOnly
              ? { _useScreenshotOnly: true }
              : {};

            const commands: Array<{ type: string; params: Record<string, unknown> }> = [];

            if (rawType === 'type' || rawType === 'fill') {
              commands.push({ type: 'tap', params: { ...coordParams }, ...visionFlag });
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
                  ...visionFlag,
                });
                if (step.options?.pressEnter) {
                  commands.push({ type: 'press_key', params: { keycode: 'KEYCODE_ENTER' } });
                }
              }
            } else {
              commands.push({ type: RAW_CMD_MAP[rawType] || 'tap', params: { ...coordParams }, ...visionFlag });
            }

            // Same resolve budget as MobileStepApplyService's dispatch, and for
            // the same reason: these commands carry `intent` + a demoted
            // `coordsConfidence`, so the runner re-resolves and then runs its
            // post-action stability wait. On the 30s default the client abandons
            // a request the runner has already completed, and the `catch` below
            // re-runs the step against the screen the first tap navigated to.
            await client.executeBatchCommands(sessionId, commands, {
              userId,
              timeoutMs: RESOLVE_DISPATCH_TIMEOUT_MS,
            });
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
    sendMobileRunnerError(res, error, 'Failed to run test case', { userId: req.user?.id, sessionId, surfacedBy: 'run' });
  }
}

/**
 * GET /api/v1/mobile/exploration/readiness
 *
 * Backend-brokered readiness probe for mobile exploration. Replaces the
 * browser's direct runner call: the runner API key stays server-side
 * (injected by MobileRunnerClient), so the frontend launcher can show
 * the "Runner / LLM keys / emulator slot" panel without ever holding
 * the key. Returns the runner's readiness shape as-is.
 */
export async function explorationReadiness(req: Request, res: Response): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  try {
    const client = getMobileRunnerClient();
    const readiness = await client.getExplorationReadiness({ userId: req.user.id });
    res.json({ success: true, readiness });
  } catch (error) {
    logger.warn('[MOBILE_SESSION] Exploration readiness probe failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Route through the shared runner-error mapper instead of a blanket 502:
    // it forwards the runner's own status (503 at-capacity, 4xx config, 410
    // session-gone) so the launcher can tell "runner unreachable" from "runner
    // busy". A truly unreachable runner still surfaces as its connection error.
    sendMobileRunnerError(res, error, 'Runner readiness check failed', {
      userId: req.user.id,
      surfacedBy: 'exploration_readiness',
    });
  }
}

/**
 * POST /api/v1/mobile/projects/:projectId/exploration/start
 *
 * Backend-brokered mobile exploration kickoff (Stage 3, Slice 4). The
 * frontend has already warmed a session (warmupSession) and holds its
 * sessionId; it sends that here instead of calling the runner directly,
 * so the runner API key stays server-side. We mint an explorationId,
 * enqueue the brokered job (which starts the runner run + relays its
 * events), and return immediately — progress arrives over the backend
 * Socket.IO as web-style exploration:* events keyed by explorationId.
 *
 * Body: { platform, appId, runnerSessionId, runnerSocketUrl?, goal?, budget? }
 */
export async function startMobileExploration(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const {
    platform: rawPlatform,
    appId,
    runnerSessionId,
    goal,
    briefing: rawBriefing,
    budget,
    chatSessionId,
  } = req.body as {
    platform?: string;
    appId?: string;
    runnerSessionId?: string;
    goal?: string;
    briefing?: unknown;
    budget?: Record<string, number>;
    chatSessionId?: string;
  };

  // Normalize the briefing to the safe shape: string fields + string arrays,
  // capped, and CREDENTIAL-FREE (any credential-ish keys are dropped — creds
  // ride the runner's answer/redaction seam, never this blob).
  const briefing = normalizeMobileBriefing(rawBriefing);

  const VALID: Record<string, 'android' | 'ios' | 'flutter'> = {
    android: 'android', ios: 'ios', flutter: 'flutter',
  };
  const platform = VALID[rawPlatform ?? ''] ?? 'android';

  if (!projectId || !appId || !runnerSessionId) {
    res.status(400).json({
      success: false,
      error: 'projectId, appId and runnerSessionId are required',
    });
    return;
  }

  // IDOR guard: projectId comes from req.params, so a caller could pass any
  // project's id. The discovered cases + app-skeleton merge in the worker
  // write to THIS projectId (mobile-exploration-run.job.ts), so without this
  // check an authenticated paid user could pollute another tenant's project
  // with their own crawl output. Mirrors the guard in warmupSession above.
  const accessibleProject = await ProjectService.getProject(projectId, userId);
  if (!accessibleProject) {
    logger.warn('[MOBILE_SESSION] exploration start rejected: project not found or no access', {
      userId,
      projectId,
      platform: rawPlatform,
      reason: 'project_not_found_or_forbidden',
      status: 404,
    });
    res.status(404).json({ success: false, error: 'Project not found' });
    return;
  }

  // Server-config ONLY — never accept a client-supplied runner URL (it
  // would let a caller redirect the server-held key to an arbitrary host).
  const runnerSocketUrl = currentRunnerSocketUrl();
  if (!runnerSocketUrl) {
    res.status(503).json({ success: false, error: 'Mobile runner is not configured' });
    return;
  }

  // randomUUID, not Date.now() — two concurrent requests in the same ms
  // would otherwise mint the same id, and since it's the BullMQ jobId the
  // second enqueue would silently dedupe to the first (run never starts).
  const explorationId = `mexpl-${randomUUID()}`;

  try {
    await QueueManager.addMobileExplorationJob({
      explorationId,
      runnerSessionId,
      runnerSocketUrl,
      appId,
      platform,
      projectId,
      userId,
      chatSessionId: chatSessionId || undefined,
      budget,
      goal: goal?.trim() || undefined,
      briefing,
    });

    logger.info('[MOBILE_SESSION] Mobile exploration queued', {
      explorationId, projectId, platform, appId, userId,
    });

    res.json({ success: true, explorationId, mode: 'exploration', platform });
  } catch (error) {
    logger.error('[MOBILE_SESSION] Failed to queue mobile exploration', {
      explorationId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to start mobile exploration',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
