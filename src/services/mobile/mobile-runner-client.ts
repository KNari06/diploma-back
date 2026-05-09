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
  MobileUiState,
} from './mobile-runner.types';
import { MobileRunnerError } from './mobile-runner.types';

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
    this.baseUrl = (opts?.baseUrl || env.MOBILE_RUNNER_URL).replace(/\/$/, '');
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
    config?: MobileSessionConfig & { ownerId?: string },
  ): Promise<MobileSessionResponse> {
    return this.request<MobileSessionResponse>('POST', '/api/sessions', {
      body: { platform, ...config },
      timeoutMs: 60_000, // Emulator boot can take 30-60s
    });
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/sessions/${sessionId}`);
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
  ): Promise<void> {
    await this.request('PATCH', `/api/sessions/${sessionId}/permission-policy`, {
      body: { policy },
      timeoutMs: 5000,
    });
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
    opts?: { ownerId?: string },
  ): Promise<MobileSessionResponse> {
    return this.request<MobileSessionResponse>('POST', '/api/sessions/claim', {
      body: { platform, ...(opts?.ownerId ? { ownerId: opts.ownerId } : {}) },
      timeoutMs: 20_000, // Pool may wait up to 15s for idle session
      noRetry: true, // 503 means pool exhausted — don't retry, fall back to cold start
    });
  }

  /**
   * Release a pooled session back to the pool after test completion.
   * The runner resets device state (app data, network, video) before
   * marking the session as idle for the next test.
   */
  async releaseSession(sessionId: string): Promise<void> {
    await this.request('POST', '/api/sessions/release', {
      body: { sessionId },
      timeoutMs: 15_000, // Reset can take up to 10s
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
    opts?: { interactive?: boolean; timeoutMs?: number; signal?: AbortSignal },
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
      /** Propagated to the outgoing fetch so client-disconnect aborts
       *  reach the runner and free its session mutex. */
      signal?: AbortSignal;
    },
  ): Promise<MobileRunStepsResponse> {
    const body: MobileRunStepsRequest = {
      steps: intentSteps,
      screenshotEachStep: opts?.screenshotEachStep ?? true,
      stopOnFailure: opts?.stopOnFailure,
      metadata: opts?.metadata,
    };

    return this.request<MobileRunStepsResponse>(
      'POST',
      `/api/runs/${sessionId}/run-steps`,
      {
        body,
        timeoutMs: CLIENT_CONFIG.runStepsTimeoutMs,
        signal: opts?.signal,
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
  ): Promise<{
    status: 'resolved' | 'not_found' | 'low_confidence' | 'error';
    boundingBox?: { x: number; y: number; width: number; height: number };
    screenSize?: { width: number; height: number };
    confidence?: number;
    resolvedVia?: string;
    elementText?: string;
    elementType?: string;
    screenshot?: string;
    message?: string;
    /** Compiled locator plan built from the resolved node — persist onto IntentStep. */
    compiledPlan?: import('./mobile-runner.types').MobileCompiledPlan;
  }> {
    return this.request('POST', `/api/commands/${sessionId}/lint`, {
      // Only attach bindingHints when we actually have some — keeps the wire
      // payload quiet for steps that carry no hints, and matches how
      // existing fields (screenshot, compiledPlan) avoid empty emissions.
      body: bindingHints && Object.keys(bindingHints).length > 0
        ? { intent, actionType, bindingHints }
        : { intent, actionType },
      timeoutMs: 15_000, // LLM resolve can take a few seconds
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
    });
  }

  // ── Artifacts ───────────────────────────────────────────────────

  async getArtifacts(sessionId: string): Promise<MobileArtifactBundle> {
    return this.request<MobileArtifactBundle>(
      'GET',
      `/api/runs/${sessionId}/artifacts`,
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
          if (errorBody) {
            try {
              const parsed = JSON.parse(errorBody) as { code?: string; error?: string };
              if (typeof parsed.code === 'string' && parsed.code) {
                runnerCode = parsed.code;
              }
              if (typeof parsed.error === 'string' && parsed.error) {
                runnerMessage = parsed.error;
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
