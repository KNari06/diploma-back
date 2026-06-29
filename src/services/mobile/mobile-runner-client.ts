/**
 * Mobile Runner HTTP Client
 * Communicates with qait-mobile-runner microservice (port 4100).
 *
 * Handles: session lifecycle, step execution, artifact retrieval.
 * Uses native fetch with retry + timeout.
 */

import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import type {
  MobilePlatform,
  MobileSessionResponse,
  MobileSessionConfig,
  MobileRunStepsRequest,
  MobileRunStepsResponse,
  MobileArtifactBundle,
  MobileHealthResponse,
  MobileIntentStep,
  MobileTestMetadata,
  Trigger,
  MobileUiState,
  MobileForegroundResponse,
  MobileStepHistoryResponse,
  MobileLogsResponse,
  MobileLogLevel,
  MobileExplorationStartResponse,
  MobileExplorationReadiness,
  MobileExplorationSnapshot,
} from './mobile-runner.types';
import { MobileRunnerError } from './mobile-runner.types';
import { mintRunnerUserToken } from './user-token';
import { validateRunnerUrl, parseAllowedHosts } from './validate-runner-url';

/**
 * Phase B-SEC helper. Returns the hostname allowlist used by the
 * SSRF guard, with the env-configured `MOBILE_RUNNER_URL` hostname
 * auto-included. Pure: re-reads env each call so test overrides work
 * without restart.
 */
function buildEffectiveAllowlist(): Set<string> {
  const fromCsv = parseAllowedHosts(env.MOBILE_RUNNER_ALLOWED_HOSTS);
  try {
    const envHost = new URL(env.MOBILE_RUNNER_URL).hostname.toLowerCase();
    fromCsv.add(envHost);
  } catch {
    // If env.MOBILE_RUNNER_URL is malformed, we'll fail in the validator
    // a moment later with a clearer error — don't suppress it here.
  }
  return fromCsv;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const CLIENT_CONFIG = {
  /** Default timeout for most requests */
  defaultTimeoutMs: 30_000,
  /** Timeout for interactive preview commands (tap, swipe, etc.) — fail fast */
  interactiveTimeoutMs: 8_000,
  /** Extended timeout for step execution (steps can take minutes) */
  runStepsTimeoutMs: 300_000, // 5 minutes
  /** Retry count for 5xx errors */
  maxRetries: 2,
  /** Base delay for exponential backoff (ms) */
  retryBaseDelayMs: 1000,
};

// ============================================================================
// CLIENT
// ============================================================================

export class MobileRunnerClient {
  private baseUrl: string;
  private apiKey: string;
  private geminiApiKey: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string; geminiApiKey?: string }) {
    const candidate = (opts?.baseUrl || env.MOBILE_RUNNER_URL).replace(/\/$/, '');
    // Phase B-SEC: SSRF guard. Reject non-http(s) schemes, malformed
    // URLs, and internal addresses (loopback / RFC1918 / link-local)
    // unless explicitly allowlisted.
    //
    // The operator-configured `env.MOBILE_RUNNER_URL` is the trust
    // anchor — by definition the deploy operator chose that URL, so
    // we auto-grant its hostname even if it's internal (local dev
    // points at `localhost:4100`; staging may sit on `10.0.x.y`).
    // The validator THEN sees an allowlist that includes the env
    // host, which means:
    //   - Today (single-runner deploy): the env URL works, but if a
    //     per-session callsite later passes a DIFFERENT internal
    //     URL, it'll be rejected unless it's also allowlisted.
    //   - Once `MOBILE_RUNNER_ALLOWED_HOSTS` is set, callers can pick
    //     any of those, plus the env default.
    //
    // Crashing at construct time when misconfigured is intentional —
    // better to fail fast on startup than silently route the chat to
    // an unexpected host.
    const effectiveAllowlist = buildEffectiveAllowlist();
    const validation = validateRunnerUrl(candidate, effectiveAllowlist);
    if (!validation.ok) {
      // Phase B7: count SSRF rejections by reason so ops can tell
      // "deploy misconfig" (host_not_allowed once at boot) from
      // "active probing" (repeated invalid_url / internal_address).
      // Lazy-require to dodge circular-import risk during module init.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { incCounter } = require('@/utils/core/mobile-chat-metrics') as typeof import('@/utils/core/mobile-chat-metrics');
      incCounter('mobile_chat.ssrf_rejection', validation.reason);
      throw new Error(
        `MobileRunnerClient: refusing to construct with unsafe URL "${candidate}" — ${validation.reason}: ${validation.detail}. ` +
          `Check MOBILE_RUNNER_URL and MOBILE_RUNNER_ALLOWED_HOSTS env vars.`,
      );
    }
    this.baseUrl = candidate;
    this.apiKey = opts?.apiKey || env.MOBILE_RUNNER_API_KEY;
    this.geminiApiKey = opts?.geminiApiKey || env.GEMINI_API_KEY || '';
  }

  /** Update Gemini API key (passed per-request from user context) */
  setGeminiApiKey(key: string): void {
    this.geminiApiKey = key;
  }

  // ── Health ──────────────────────────────────────────────────────

  async checkHealth(): Promise<MobileHealthResponse> {
    return this.request<MobileHealthResponse>('GET', '/health', {
      timeoutMs: 5000,
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      return health.status === 'ok';
    } catch {
      return false;
    }
  }

  // ── Session lifecycle ───────────────────────────────────────────

  async createSession(
    platform: MobilePlatform,
    config?: MobileSessionConfig & { ownerId?: string; userId?: string },
  ): Promise<MobileSessionResponse> {
    const { userId, ...rest } = config ?? {};
    return this.request<MobileSessionResponse>('POST', '/api/sessions', {
      body: { platform, ...rest },
      // Emulator boot can exceed the previous 60s on cold-starts under load
      // (large APK install + slow disk + permission pre-grant). Bumped to
      // 180s — frontend was hitting the old cap during /warmup and surfacing
      // a generic timeout error to the user.
      timeoutMs: 180_000,
      userId,
    });
  }

  async destroySession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    await this.request('DELETE', `/api/sessions/${sessionId}`, { userId: opts?.userId });
  }

  /**
   * End a DEDICATED session without destroying its device.
   *
   * A dedicated emulator container is pinned to a workspace and must outlive a
   * single run — `destroySession` would tear down the remote container (it
   * calls `emulatorManager.stop(serial)` → `adb emu kill`). This endpoint ends
   * the session and resets app state (force-stop + clear data) but leaves the
   * container alive for the workspace's next run.
   *
   * Runner contract (qait-mobile-runner): `POST /api/sessions/:id/end-dedicated`
   * — the app-reset half of `resetSession` WITHOUT `releaseAndroidDevice`.
   * Until the runner ships it, this 404s and the caller's catch logs it; the
   * container is NOT destroyed either way, which is the safety property that
   * matters.
   */
  async endDedicatedSession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    await this.request('POST', `/api/sessions/${sessionId}/end-dedicated`, {
      timeoutMs: 15_000,
      noRetry: true,
      userId: opts?.userId,
    });
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const sessions = await this.request<{ id: string }[]>('GET', '/api/sessions', {
        timeoutMs: 5000,
      });
      return Array.isArray(sessions) && sessions.some((s) => s.id === sessionId);
    } catch {
      return false;
    }
  }

  /**
   * Bump the session's runner-side `lastActivityAt` so an actively-edited
   * editor session isn't capacity-evicted during pure think-time (editing a
   * step / opening the find UI sends NO device traffic, so the runner's idle
   * clock would otherwise advance and make the session an eviction target).
   *
   * Driven by the `mobile:keepalive` WS event, which already means "user is
   * active in the editor". Best-effort: a 404 (session already gone) or any
   * transport error is swallowed — keepalive must never throw.
   */
  async touchSession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    try {
      await this.request('POST', `/api/sessions/${sessionId}/touch`, {
        timeoutMs: 5000,
        userId: opts?.userId,
      });
    } catch {
      /* best-effort — never break the keepalive path */
    }
  }

  /**
   * Update the runtime-permission policy for a live session.
   *
   * - 'auto_allow' (default): pre-grant on install + ambient watcher auto-Allows
   * - 'auto_deny': watcher auto-Dismisses runtime permission dialogs
   * - 'manual': no automation — explicit permission_dialog steps only
   *
   * Non-fatal: if the runner rejects or is unreachable we just log and move on;
   * the session will fall back to the runner-side default ('auto_allow').
   */
  async setPermissionPolicy(
    sessionId: string,
    policy: 'auto_allow' | 'auto_deny' | 'manual',
    opts?: { userId?: string },
  ): Promise<void> {
    await this.request('PATCH', `/api/sessions/${sessionId}/permission-policy`, {
      body: { policy },
      timeoutMs: 5000,
      userId: opts?.userId,
    });
  }

  /**
   * Set the session's user-defined triggers for an editor run. The editor
   * applies steps one at a time (NOT the batch run-steps body), so triggers
   * must ride on the session — set once before the run, like permissionPolicy.
   * Passing `[]` clears them.
   */
  async setTriggers(
    sessionId: string,
    triggers: Trigger[],
    opts?: { userId?: string },
  ): Promise<void> {
    await this.request('PATCH', `/api/sessions/${sessionId}/triggers`, {
      body: { triggers },
      timeoutMs: 5000,
      userId: opts?.userId,
    });
  }

  // ── Exploration (autonomous app crawl) ──────────────────────────
  //
  // Brokers the runner's /api/explorer/* API so the runner API key stays
  // server-side and never reaches the browser (B2C). Mirrors the web
  // exploration flow: backend starts a run, relays the runner's per-run
  // socket events, and fetches the final result on completion.
  //
  // The runner authenticates these calls via the X-API-Key header that
  // `request()` injects from the server-held MOBILE_RUNNER_API_KEY.

  /**
   * Start an exploration on an already-warmed session.
   * Runner returns 202 with the run id; 409 if the session is already
   * exploring, 404 if the session is gone.
   */
  async startExploration(
    sessionId: string,
    body: { appId: string; goal?: string; budget?: Record<string, number> },
    opts?: { userId?: string },
  ): Promise<MobileExplorationStartResponse> {
    return this.request<MobileExplorationStartResponse>(
      'POST',
      `/api/explorer/sessions/${sessionId}/start`,
      { body, timeoutMs: 30_000, userId: opts?.userId },
    );
  }

  /** UI-contract snapshot of a live or cold run (404 if unknown). */
  async getExplorationStatus(
    runId: string,
    opts?: { userId?: string },
  ): Promise<MobileExplorationSnapshot> {
    return this.request<MobileExplorationSnapshot>(
      'GET',
      `/api/explorer/runs/${runId}`,
      { timeoutMs: 10_000, userId: opts?.userId },
    );
  }

  /** Final result snapshot — 409 until the run is finished. */
  async getExplorationResult(
    runId: string,
    opts?: { userId?: string },
  ): Promise<MobileExplorationSnapshot> {
    return this.request<MobileExplorationSnapshot>(
      'GET',
      `/api/explorer/runs/${runId}/result`,
      { timeoutMs: 15_000, userId: opts?.userId },
    );
  }

  /** Answer an awaiting_user prompt (captcha / 2FA / credential). */
  async submitExplorationAnswer(
    runId: string,
    answer: { questionId: string; value?: string; credentialValue?: string; skipped?: boolean },
    opts?: { userId?: string },
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/api/explorer/runs/${runId}/answer`,
      { body: answer, timeoutMs: 10_000, userId: opts?.userId },
    );
  }

  /** Abort a run. Idempotent on the runner side. */
  async cancelExploration(runId: string, opts?: { userId?: string }): Promise<unknown> {
    return this.request(
      'POST',
      `/api/explorer/runs/${runId}/cancel`,
      { timeoutMs: 10_000, userId: opts?.userId },
    );
  }

  /** Runner-side default budget (UI hint shown before a run starts). */
  async getExplorationDefaults(opts?: { userId?: string }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      '/api/explorer/defaults',
      { timeoutMs: 5_000, userId: opts?.userId },
    );
  }

  /**
   * Readiness probe: LLM keys configured on the runner + emulator pool
   * capacity. Used by the launcher before a run; replaces the browser's
   * direct runner call.
   */
  async getExplorationReadiness(opts?: { userId?: string }): Promise<MobileExplorationReadiness> {
    return this.request<MobileExplorationReadiness>(
      'GET',
      '/api/explorer/readiness',
      { timeoutMs: 5_000, userId: opts?.userId },
    );
  }

  // ── Fast-auth (app-data snapshot) ────────────────────────────────
  //
  // Mobile equivalent of web's storageState injection. Captures /data/data/<pkg>
  // shared_prefs + databases as a base64 tarball; restoreAppData replays it
  // before a test so we skip the login recipe entirely.
  //
  // The runner enforces a 5 MB cap on capture and runs a `pm clear` before
  // restore (replace-not-merge — merging is the source of half the
  // session-restore bugs we'd otherwise debug). See runner module
  // src/device/adb/app-data-snapshot.ts for the privilege chain.
  //
  // Both endpoints can return:
  //   - 413 SNAPSHOT_TOO_LARGE (capture only — over 5 MB)
  //   - 409 SNAPSHOT_PRIVILEGE (neither run-as nor su works on this device)
  //   - 400 PACKAGE_NAME_MISMATCH / PLATFORM_UNSUPPORTED
  //
  // Callers MUST treat any non-2xx as "fall back to recipe replay". Never
  // surface fast-auth errors as test failures — the recipe path always
  // exists as a safety net.

  /**
   * Snapshot the current logged-in state of an Android app's data dir.
   * Called by the editor "Save login" flow after the user successfully
   * logs in via the live preview.
   *
   * Returns a base64 tarball the caller writes to the auth resource's
   * `sensitive.mobileSnapshot` field. We don't decode here — the blob
   * stays opaque to backend code; only the runner ever interprets it.
   *
   * No retries: capture is a one-shot user-initiated action, surfacing
   * a transient runner blip as a clear error is better than masking it.
   */
  async captureAppData(
    sessionId: string,
    packageName: string,
    opts?: { userId?: string },
  ): Promise<{
    dataTarballBase64: string;
    sizeBytes: number;
    androidApiLevel: number;
    capturedVia: 'run-as' | 'su';
  }> {
    return this.request(
      'POST',
      `/api/sessions/${sessionId}/capture-app-data`,
      {
        body: { packageName },
        // Capture tars + base64-encodes inside adb shell — slow but bounded
        // by the 5 MB cap on the runner. 30s buffer absorbs slow disks.
        timeoutMs: 30_000,
        noRetry: true,
        userId: opts?.userId,
      },
    );
  }

  /**
   * Restore a previously-captured app-data snapshot, replacing the app's
   * /data/data state. Runner does `pm clear` first then untars. The
   * caller is expected to launch the app afterwards (e.g. via the test's
   * first IntentStep) — restore does NOT launch.
   *
   * Use this BEFORE `runSteps` when the auth binding has a snapshot. If
   * this throws, the caller should fall back to recipe replay for the
   * current test (and mark the snapshot broken so the next run captures
   * a fresh one).
   */
  async restoreAppData(
    sessionId: string,
    packageName: string,
    dataTarballBase64: string,
    opts?: { signal?: AbortSignal; userId?: string },
  ): Promise<{
    restoredVia: 'run-as' | 'su';
    restoreMs: number;
    /** False means data was restored but launching the app via `monkey -p`
     *  didn't confirm success. Caller should fall back to recipe replay —
     *  the data layout is correct but the activity probably moved. */
    launched: boolean;
  }> {
    return this.request(
      'POST',
      `/api/sessions/${sessionId}/restore-app-data`,
      {
        body: { packageName, dataTarballBase64 },
        // `pm clear` + untar + chown. Same 30s budget as capture.
        timeoutMs: 30_000,
        noRetry: true,
        // Honour caller's cancellation — a regression-run cancel during
        // a multi-MB tarball transfer would otherwise hang up to 30s per
        // pending test before noticing.
        signal: opts?.signal,
        userId: opts?.userId,
      },
    );
  }

  // ── Session Pool operations ──────────────────────────────────────

  /**
   * Claim an idle pooled session from the runner.
   * Returns immediately if a session is available, or waits up to
   * the runner's claimTimeoutMs before returning 503.
   *
   * On 503/404 the caller should fall back to createSession() (cold start).
   */
  async claimSession(
    platform: MobilePlatform,
    opts?: { ownerId?: string; userId?: string },
  ): Promise<MobileSessionResponse> {
    return this.request<MobileSessionResponse>('POST', '/api/sessions/claim', {
      body: { platform, ...(opts?.ownerId ? { ownerId: opts.ownerId } : {}) },
      timeoutMs: 20_000, // Pool may wait up to 15s for idle session
      noRetry: true, // 503 means pool exhausted — don't retry, fall back to cold start
      userId: opts?.userId,
    });
  }

  /**
   * Release a pooled session back to the pool after test completion.
   * The runner resets device state (app data, network, video) before
   * marking the session as idle for the next test.
   */
  async releaseSession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    await this.request('POST', '/api/sessions/release', {
      body: { sessionId },
      timeoutMs: 15_000, // Reset can take up to 10s
      userId: opts?.userId,
    });
  }

  /**
   * Get pool + adhoc capacity information from the runner.
   * Used by the job handler to decide claim vs cold start.
   */
  async getCapacity(): Promise<{
    pool: {
      android: { total: number; idle: number; busy: number } | null;
      ios: { total: number; idle: number; busy: number } | null;
    } | null;
    adhoc: { maxSessions: number; activeSessions: number; available: number };
    mode: 'pool' | 'classic';
  }> {
    return this.request('GET', '/api/sessions/capacity', { timeoutMs: 5000 });
  }

  // ── Low-level command execution ─────────────────────────────────
  /**
   * Execute a batch of low-level MobileCommand objects on a given session.
   * This is a thin wrapper over qait-mobile-runner's
   * POST /api/commands/:sessionId/batch endpoint.
   *
   * NOTE: Commands are intentionally typed as unknown[] here to avoid
   * tightly coupling the backend to the runner's internal command union.
   * Callers must ensure they send shape-compatible objects that satisfy
   * the runner's zod `mobileCommandSchema`.
   */
  async executeBatchCommands(
    sessionId: string,
    commands: unknown[],
    opts?: { interactive?: boolean; timeoutMs?: number; signal?: AbortSignal; userId?: string },
  ): Promise<{ results: unknown[] }> {
    return this.request<{ results: unknown[] }>(
      'POST',
      `/api/commands/${sessionId}/batch`,
      {
        body: { commands },
        timeoutMs: opts?.timeoutMs
          ?? (opts?.interactive ? CLIENT_CONFIG.interactiveTimeoutMs : CLIENT_CONFIG.defaultTimeoutMs),
        // Interactive commands must not retry — a failed tap should not
        // be silently retried (user may have already moved on).
        noRetry: opts?.interactive,
        signal: opts?.signal,
        userId: opts?.userId,
      },
    );
  }

  // ── Step execution ──────────────────────────────────────────────

  async runSteps(
    sessionId: string,
    intentSteps: MobileIntentStep[],
    opts?: {
      screenshotEachStep?: boolean;
      stopOnFailure?: boolean;
      metadata?: MobileTestMetadata;
      /** User-defined event→action rules forwarded verbatim to the runner.
       *  Omitted from the body when absent/empty. */
      triggers?: Trigger[];
      /** Propagated to the outgoing fetch so client-disconnect aborts
       *  reach the runner and free its session mutex. */
      signal?: AbortSignal;
      userId?: string;
    },
  ): Promise<MobileRunStepsResponse> {
    const body: MobileRunStepsRequest = {
      steps: intentSteps,
      screenshotEachStep: opts?.screenshotEachStep ?? true,
      stopOnFailure: opts?.stopOnFailure,
      metadata: opts?.metadata,
      // Only attach when present so a no-trigger run sends a byte-identical
      // body to pre-trigger behaviour (the runner schema treats it optional).
      ...(opts?.triggers && opts.triggers.length > 0 ? { triggers: opts.triggers } : {}),
    };

    return this.request<MobileRunStepsResponse>(
      'POST',
      `/api/runs/${sessionId}/run-steps`,
      {
        body,
        timeoutMs: CLIENT_CONFIG.runStepsTimeoutMs,
        signal: opts?.signal,
        userId: opts?.userId,
      },
    );
  }

  // ── Flutter driver-extension probe ─────────────────────────────

  /**
   * Ask the runner to verify whether the user's Flutter APK actually
   * calls `enableFlutterDriverExtension()`. The APK is delivered the same
   * way as a normal run — the caller first pushes the bytes via
   * `uploadApp()` and passes the resulting on-disk `apkPath` here; the
   * runner boots an emulator, installs + launches the APK, watches logcat
   * for the Dart VM Service URL, and tears down the session.
   *
   * Always resolves to a verdict; the runner never throws an error to
   * the HTTP layer.
   *
   * 240 s timeout: a cold probe pays full session bring-up — emulator
   * connect/boot (can be ~90 s), the APK install, app launch, the 10 s
   * VM-Service log scan, then teardown. Measured cold runs land around
   * 120-130 s, so 240 s leaves headroom for a genuinely cold emulator
   * without hanging the request forever.
   */
  async probeFlutterDriverExtension(
    input: { packageName: string; apkPath: string },
    opts?: { userId?: string },
  ): Promise<{ detected: boolean; vmServiceUrl?: string; detail: string }> {
    return this.request<{ detected: boolean; vmServiceUrl?: string; detail: string }>(
      'POST',
      '/api/probe/driver-extension',
      {
        body: input,
        timeoutMs: 240_000,
        noRetry: true,
        userId: opts?.userId,
      },
    );
  }

  // ── Flutter attach (native session → flutter session) ──────────

  /**
   * Upgrade an already-installed native android session into a Flutter
   * session. The caller must have installed the APK on `sessionId` first
   * (normal `install_app`); the runner then launches the app, detects the
   * Dart VM Service, connects, and keeps the SAME session id.
   *
   * Throws `MobileRunnerError` with status 422 / code `FLUTTER_NOT_DETECTED`
   * when the build isn't debug/profile or doesn't call
   * `enableFlutterDriverExtension()` — that's a rebuild-required failure,
   * not transient, so `noRetry`.
   *
   * 45 s timeout covers `logcat -c` + launch + the 20 s VM-Service scan +
   * FlutterClient connect, with headroom for a slow/cold emulator.
   */
  async attachFlutter(
    sessionId: string,
    input: { packageName: string },
    opts?: { userId?: string },
  ): Promise<{ sessionId: string; platform: string }> {
    return this.request<{ sessionId: string; platform: string }>(
      'POST',
      `/api/sessions/${sessionId}/attach-flutter`,
      {
        body: input,
        timeoutMs: 45_000,
        noRetry: true,
        userId: opts?.userId,
      },
    );
  }

  // ── App upload (multipart → runner) ────────────────────────────

  /**
   * Upload APK/IPA to runner via multipart POST /upload/apk.
   * Runner saves file to disk and returns { path, filename, originalName, size }.
   */
  async uploadApp(
    fileBuffer: Buffer,
    originalName: string,
    opts?: { userId?: string },
  ): Promise<{ path: string; filename: string; originalName: string; size: number }> {
    if (!env.MOBILE_RUNNER_ENABLED) {
      throw new MobileRunnerError('Mobile testing is not enabled', 503, 'DISABLED');
    }

    const url = `${this.baseUrl}/api/upload/apk`;
    const timeoutMs = 120_000; // 2 min for large APKs

    // Build multipart form data
    const boundary = `----FormBoundary${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${originalName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileBuffer, footer]);

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (opts?.userId && env.RUNNER_USER_TOKEN_SECRET) {
      headers['X-User-Token'] = mintRunnerUserToken(opts.userId, env.RUNNER_USER_TOKEN_SECRET);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new MobileRunnerError(
          `Upload failed: ${response.status} ${errorBody}`,
          response.status,
          'UPLOAD_ERROR',
        );
      }

      return (await response.json()) as {
        path: string;
        filename: string;
        originalName: string;
        size: number;
      };
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof MobileRunnerError) throw error;
      throw new MobileRunnerError(
        `Failed to upload app to runner: ${error instanceof Error ? error.message : String(error)}`,
        0,
        'NETWORK_ERROR',
      );
    }
  }

  // ── Element Lint (non-destructive resolve for editor preview) ──

  /**
   * Lint an element on the mobile device — find element by intent without
   * dispatching any action. Returns bounding box for frontend overlay.
   *
   * Calls the runner's dedicated lint endpoint (fast, ~1-2s) instead of
   * the full run-steps pipeline (slow, ~3-5s with command dispatch).
   */
  async lintElement(
    sessionId: string,
    intent: string,
    actionType: string = 'tap',
    /**
     * BindingHints from the draft step in the editor. Forwarded so the
     * runner's lint-evidence + resolver caches key by hints — editing a
     * `label` / `selector` / `role` in the UI busts the cache and gets a
     * fresh resolve, instead of silently returning the pre-edit bbox.
     * Optional: runners older than 2026-04-23 ignore the field.
     */
    bindingHints?: Record<string, unknown>,
    opts?: { userId?: string },
  ): Promise<{
    status: 'resolved' | 'not_found' | 'low_confidence' | 'error';
    boundingBox?: { x: number; y: number; width: number; height: number };
    screenSize?: { width: number; height: number };
    confidence?: number;
    resolvedVia?: string;
    /**
     * True when the bounding box came from the vision model (screenshot pixels)
     * rather than an a11y/inspector tree node — common on Semantics-less Flutter
     * screens. These coords are low-trust: callers should demote coordsConfidence
     * so the runner re-resolves by text/keys instead of tapping the pixel blindly.
     */
    visionMode?: boolean;
    elementText?: string;
    elementType?: string;
    screenshot?: string;
    message?: string;
    /** Compiled locator plan built from the resolved node — persist onto IntentStep. */
    compiledPlan?: import('./mobile-runner.types').MobileCompiledPlan;
    visibleNodeCount?: number;
    /**
     * Structured sample of the first ~10 visible nodes (was `string[]`). Carries
     * type/bounds/resourceId/creationLocation so a Flutter screen with unbuilt
     * Semantics — unlabeled View containers — is legible in the editor trace
     * instead of collapsing to an empty list. Trace-only; not returned to the FE.
     */
    topNodes?: Array<{
      type?: string;
      label?: string;
      bounds?: { left: number; top: number; right: number; bottom: number };
      resourceId?: string;
      creationLocation?: string;
    }>;
    intentWords?: string[];
    /** Platform that produced the result — labels Flutter vs native in the trace. */
    framework?: 'android' | 'ios' | 'flutter';
  }> {
    return this.request('POST', `/api/commands/${sessionId}/lint`, {
      // Only attach bindingHints when we actually have some — keeps the wire
      // payload quiet for steps that carry no hints, and matches how
      // existing fields (screenshot, compiledPlan) avoid empty emissions.
      body: bindingHints && Object.keys(bindingHints).length > 0
        ? { intent, actionType, bindingHints }
        : { intent, actionType },
      // Must exceed the runner's lint phase budget (RUN_LINT_PHASE_BUDGET_MS,
      // default 16s) so the runner's own budget-abort wins and returns a clean
      // phase-named error, instead of this client cutting the connection first.
      // The runner needs headroom on slow emulators for the Flutter VM-Service
      // bounds walk (a keyed node found instantly still needs its on-screen box).
      timeoutMs: 18_000,
      userId: opts?.userId,
    });
  }

  // ── UI State (live read for mobile AI Agent) ───────────────────

  /**
   * Snapshot the current foreground screen of a live session. Returns the
   * a11y tree (pre-formatted + optionally raw), screenshot, app identity,
   * and a stable fingerprint.
   *
   * Thin wrapper over the runner's `GET /api/sessions/:id/ui-state`. Read
   * only — no graph or scratchpad mutation on the runner side.
   *
   * Defaults to `includeTree=false` because the backend's mobile-agent
   * only consumes `formattedTree` (the raw tree would just waste wire
   * bandwidth). Screenshot defaults to ON — the executor LLM is multimodal
   * and reading the image noticeably improves element resolution vs tree
   * alone.
   *
   * Errors surface as MobileRunnerError with the runner's status code:
   *   - 404 → session not found (stale mobileSessionId from the frontend)
   *   - 409 → screen unreadable (splash, semantics disabled, transient)
   *   - 500 → capture threw on the runner
   * Callers should handle 404/409 as user-visible messages; 5xx as
   * "try again".
   */
  async fetchUiState(
    sessionId: string,
    opts?: {
      includeTree?: boolean;
      includeScreenshot?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
      userId?: string;
    },
  ): Promise<MobileUiState> {
    const params = new URLSearchParams();
    if (opts?.includeTree === false) params.set('includeTree', 'false');
    // Screenshot defaults: on (multimodal prompt helps). Only opt out.
    if (opts?.includeScreenshot === false) params.set('includeScreenshot', 'false');
    const qs = params.toString();
    const path = `/api/sessions/${sessionId}/ui-state${qs ? `?${qs}` : ''}`;

    return this.request<MobileUiState>('GET', path, {
      // Capture involves a device a11y dump + screencap — typically 200-800ms,
      // but a busy emulator can spike. Budget 8s, don't retry (a stale read
      // with 2s latency is fine; a double-screenshot on retry wastes the
      // device's time).
      timeoutMs: opts?.timeoutMs ?? 8_000,
      noRetry: true,
      signal: opts?.signal,
      userId: opts?.userId,
    });
  }

  // ── Phase B5 — cheap observation endpoints ─────────────────────

  /**
   * `GET /api/sessions/:id/foreground` — dumpsys-only foreground probe
   * (Android) or WDA activeAppInfo (iOS). ~50-150ms typical, no a11y
   * dump, no screenshot. Use this when the LLM only needs "what app
   * is open right now?" — order-of-magnitude cheaper than
   * `fetchUiState`.
   *
   * Returns the same `MobileActualForeground` shape that's embedded
   * inside `MobileUiState.actualForeground`, plus the runner's
   * mismatch verdict (session.packageName vs the device-fresh
   * answer).
   */
  async fetchForeground(
    sessionId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; userId?: string },
  ): Promise<MobileForegroundResponse> {
    return this.request<MobileForegroundResponse>(
      'GET',
      `/api/sessions/${sessionId}/foreground`,
      {
        // Tight budget: this endpoint is meant to be the fast lane. If
        // it's slow, callers should escalate to fetchUiState. Don't retry
        // — a stale-by-100ms answer beats double the dumpsys load.
        timeoutMs: opts?.timeoutMs ?? 3_000,
        noRetry: true,
        signal: opts?.signal,
        userId: opts?.userId,
      },
    );
  }

  /**
   * `GET /api/sessions/:id/step-history?limit=N&includeRawInputs=...`
   * — recent test-step records from the runner's in-memory
   * `TestRunManager`. Never touches the device, so it returns
   * essentially instantly (~1ms).
   *
   * `type_text.text` values are redacted by default at the runner
   * (replaced with `{ inputLength, inputClass }`). Backend may also
   * apply its own PII layer downstream for defence-in-depth.
   *
   * Pass `includeRawInputs: true` ONLY from explicitly-debug paths
   * (operator tooling) — never from the chat path.
   */
  async fetchStepHistory(
    sessionId: string,
    opts?: {
      limit?: number;
      includeRawInputs?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
      userId?: string;
    },
  ): Promise<MobileStepHistoryResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.includeRawInputs === true) params.set('includeRawInputs', 'true');
    const qs = params.toString();
    const path = `/api/sessions/${sessionId}/step-history${qs ? `?${qs}` : ''}`;
    return this.request<MobileStepHistoryResponse>('GET', path, {
      timeoutMs: opts?.timeoutMs ?? 3_000,
      noRetry: true,
      signal: opts?.signal,
      userId: opts?.userId,
    });
  }

  /**
   * `GET /api/sessions/:id/logs?level=warn&limit=N&since=ISO` — logcat
   * tail (Android) or unified-log tail (iOS sim / physical). Runner
   * caps the payload at ~2KB and trims by `level` server-side, so
   * the response is already compact enough to fit in an LLM prompt.
   *
   * `since` is silently ignored on iOS in v1 (the simctl wrapper uses
   * `--last 1m` rather than absolute timestamps); on Android it's
   * passed through as `logcat -T` with a basic safety check.
   */
  async fetchRecentLogs(
    sessionId: string,
    opts?: {
      level?: MobileLogLevel;
      limit?: number;
      since?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      userId?: string;
    },
  ): Promise<MobileLogsResponse> {
    const params = new URLSearchParams();
    if (opts?.level !== undefined) params.set('level', opts.level);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.since !== undefined) params.set('since', opts.since);
    const qs = params.toString();
    const path = `/api/sessions/${sessionId}/logs${qs ? `?${qs}` : ''}`;
    return this.request<MobileLogsResponse>('GET', path, {
      // adb logcat is bounded by a server-side timeout (10s) AND a
      // payload cap; we wait up to 6s for the round trip.
      timeoutMs: opts?.timeoutMs ?? 6_000,
      noRetry: true,
      signal: opts?.signal,
      userId: opts?.userId,
    });
  }

  // ── Artifacts ───────────────────────────────────────────────────

  async getArtifacts(sessionId: string, opts?: { userId?: string }): Promise<MobileArtifactBundle> {
    return this.request<MobileArtifactBundle>(
      'GET',
      `/api/runs/${sessionId}/artifacts`,
      { userId: opts?.userId },
    );
  }

  // ── Internal HTTP ───────────────────────────────────────────────

  private async request<T = unknown>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      timeoutMs?: number;
      /** Skip retries — throw immediately on any error (e.g. pool claim 503) */
      noRetry?: boolean;
      /**
       * Caller-provided AbortSignal. When it fires (e.g. the originating
       * HTTP client aborted), we abort the in-flight fetch to the runner so
       * the runner's `req.on('close')` handler fires and the session mutex
       * is released at the next step boundary.
       */
      signal?: AbortSignal;
      /**
       * Authenticated user this call is acting on behalf of. When set AND
       * env `RUNNER_USER_TOKEN_SECRET` is non-empty we mint a per-request
       * `X-User-Token` HMAC. Either side missing = no header (runner stays
       * in its current legacy/enforced behaviour). See user-token.ts.
       */
      userId?: string;
    },
  ): Promise<T> {
    if (!env.MOBILE_RUNNER_ENABLED) {
      throw new MobileRunnerError('Mobile testing is not enabled', 503, 'DISABLED');
    }

    const url = `${this.baseUrl}${path}`;
    const timeoutMs = opts?.timeoutMs || CLIENT_CONFIG.defaultTimeoutMs;
    const maxRetries = opts?.noRetry ? 0 : CLIENT_CONFIG.maxRetries;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.geminiApiKey) {
      headers['X-Gemini-Api-Key'] = this.geminiApiKey;
    }
    // Mint per-request user token when we have both a known user AND a
    // configured secret. Empty secret = dev / pre-rollout deploys; runner
    // accepts those without a header in legacy mode. Missing userId =
    // system-level call (health check, capacity probe) — also skip.
    if (opts?.userId && env.RUNNER_USER_TOKEN_SECRET) {
      headers['X-User-Token'] = mintRunnerUserToken(opts.userId, env.RUNNER_USER_TOKEN_SECRET);
    }

    // Retry loop for 5xx errors
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = CLIENT_CONFIG.retryBaseDelayMs * Math.pow(2, attempt - 1);
        logger.debug('[MOBILE_CLIENT] Retrying request', {
          url,
          attempt,
          delay,
        });
        await new Promise((r) => setTimeout(r, delay));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Propagate caller abort (e.g. client disconnect) to the outgoing
      // fetch so the runner sees its HTTP request close and can exit its
      // step loop promptly, freeing the session mutex.
      const onCallerAbort = () => controller.abort();
      if (opts?.signal) {
        if (opts.signal.aborted) controller.abort();
        else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: opts?.body ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onCallerAbort);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');

          // Phase 2.6: structured DeviceError codes from the runner take
          // priority over the generic CLIENT_ERROR/SERVER_ERROR bucket.
          // The runner emits `{ code: <DeviceErrorCode>, error: <message> }`
          // for typed failures (IOS_PHYSICAL_NOT_SUPPORTED, DEVICE_BUSY,
          // DEVICE_NOT_FOUND, …). Surfacing the code lets frontend show
          // an actionable message ("operator hasn't enabled physical
          // iOS") instead of a confusing 501.
          let runnerCode: string | undefined;
          let runnerMessage: string | undefined;
          let runnerReason: string | undefined;
          if (errorBody) {
            try {
              const parsed = JSON.parse(errorBody) as { code?: string; error?: string; reason?: string };
              if (typeof parsed.code === 'string' && parsed.code) {
                runnerCode = parsed.code;
              }
              if (typeof parsed.error === 'string' && parsed.error) {
                runnerMessage = parsed.error;
              }
              // Cause for a reclaimed session (idle_ttl / evicted / …) — used by
              // the editor expiry trace to record WHY the session vanished.
              if (typeof parsed.reason === 'string' && parsed.reason) {
                runnerReason = parsed.reason;
              }
            } catch {
              // Body wasn't JSON — fall back to raw text below.
            }
          }

          // Retry on 5xx — but ONLY when the error isn't a typed device
          // failure. A typed `DEVICE_INIT_FAILED` (503) is informational,
          // not transient; re-firing it just delays the user-visible error.
          // Bare 5xx (no code) stays in the retry path.
          if (response.status >= 500 && attempt < maxRetries && !runnerCode) {
            lastError = new MobileRunnerError(
              `Runner returned ${response.status}: ${errorBody}`,
              response.status,
              'SERVER_ERROR',
            );
            continue;
          }

          throw new MobileRunnerError(
            runnerMessage
              ? `${runnerMessage} (runner code: ${runnerCode ?? 'none'})`
              : `Runner returned ${response.status}: ${errorBody}`,
            response.status,
            // Use the runner's typed code when available, otherwise the
            // bucket. Frontend can branch on this for actionable copy.
            runnerCode ?? (response.status >= 500 ? 'SERVER_ERROR' : 'CLIENT_ERROR'),
            runnerReason,
          );
        }

        // DELETE may return empty body
        if (method === 'DELETE' && response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onCallerAbort);

        if (error instanceof MobileRunnerError) {
          throw error;
        }

        if (error instanceof DOMException && error.name === 'AbortError') {
          // Caller-initiated abort (HTTP client disconnected). Don't retry —
          // propagate so upstream knows the operation was cancelled.
          if (opts?.signal?.aborted) {
            throw new MobileRunnerError(
              `Request aborted by caller: ${method} ${path}`,
              499, // Nginx's "client closed request"
              'ABORTED',
            );
          }
          throw new MobileRunnerError(
            `Request timed out after ${timeoutMs}ms: ${method} ${path}`,
            408,
            'TIMEOUT',
          );
        }

        // Network error — retry
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          logger.warn('[MOBILE_CLIENT] Network error, will retry', {
            url,
            attempt,
            error: lastError.message,
          });
          continue;
        }

        throw new MobileRunnerError(
          `Failed to reach mobile runner: ${lastError.message}`,
          0,
          'NETWORK_ERROR',
        );
      }
    }

    throw lastError || new MobileRunnerError('Unknown error', 500);
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _client: MobileRunnerClient | null = null;

export function getMobileRunnerClient(): MobileRunnerClient {
  if (!_client) {
    _client = new MobileRunnerClient();
  }
  return _client;
}
