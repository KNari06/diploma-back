import { env } from '@/config/environment/env';
import { companionRegistry } from './companion-registry';
import type { IMobileRunnerClient } from '../mobile-runner-client';
import {
  MobileRunnerError,
  type MobileArtifactBundle,
  type MobileDeviceInventory,
  type MobileExplorationReadiness,
  type MobileExplorationSnapshot,
  type MobileExplorationStartResponse,
  type MobileForegroundResponse,
  type MobileHealthResponse,
  type MobileIntentStep,
  type MobileLogLevel,
  type MobileLogsResponse,
  type MobilePlatform,
  type MobileRunStepsRequest,
  type MobileRunStepsResponse,
  type MobileSessionConfig,
  type MobileSessionResponse,
  type MobileStepHistoryResponse,
  type MobileTestMetadata,
  type MobileUiState,
  type Trigger,
} from '../mobile-runner.types';
import { mintRunnerUserToken } from '../user-token';

const DEFAULT_TIMEOUT_MS = 30_000;
const INTERACTIVE_TIMEOUT_MS = 8_000;
const RUN_STEPS_TIMEOUT_MS = 300_000;

interface ProxyOptions {
  body?: unknown;
  bodyEncoding?: 'json' | 'base64-file';
  signal?: AbortSignal;
  timeoutMs?: number;
  userId?: string;
}

/**
 * MobileRunnerClient-compatible adapter that routes runner REST calls through
 * the user's outbound companion socket instead of dialing a runner URL.
 */
export class CompanionRunnerClient implements IMobileRunnerClient {
  private geminiApiKey = env.GEMINI_API_KEY || '';

  constructor(private readonly companionUserId: string) {}

  setGeminiApiKey(key: string): void {
    this.geminiApiKey = key;
  }

  async checkHealth(): Promise<MobileHealthResponse> {
    return this.request<MobileHealthResponse>('GET', '/health', { timeoutMs: 5_000 });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      return health.status === 'ok';
    } catch {
      return false;
    }
  }

  async createSession(
    platform: MobilePlatform,
    config?: MobileSessionConfig & { ownerId?: string; userId?: string },
  ): Promise<MobileSessionResponse> {
    const { userId, ...rest } = config ?? {};
    return this.request<MobileSessionResponse>('POST', '/api/sessions', {
      body: { platform, ...rest },
      timeoutMs: 180_000,
      userId,
    });
  }

  async destroySession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    await this.request('DELETE', `/api/sessions/${sessionId}`, { userId: opts?.userId });
  }

  async endDedicatedSession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    await this.request('POST', `/api/sessions/${sessionId}/end-dedicated`, {
      timeoutMs: 15_000,
      userId: opts?.userId,
    });
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const result = await this.request<{ sessions: { id: string }[] }>('GET', '/api/sessions', { timeoutMs: 5_000 });
      return Array.isArray(result?.sessions) && result.sessions.some((s) => s.id === sessionId);
    } catch {
      return false;
    }
  }

  async getSessionDestroyReason(sessionId: string): Promise<string | null> {
    try {
      const res = await this.request<{ reason?: string | null }>(
        'GET',
        `/api/sessions/${sessionId}/destroy-reason`,
        { timeoutMs: 5_000 },
      );
      return res?.reason ?? null;
    } catch {
      return null;
    }
  }

  // Keepalive — bump the companion runner's lastActivityAt so an actively-edited
  // companion session isn't idle-evicted during think-time. Best-effort.
  async touchSession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    try {
      await this.request('POST', `/api/sessions/${sessionId}/touch`, {
        timeoutMs: 5_000,
        userId: opts?.userId,
      });
    } catch {
      /* best-effort — never break the keepalive path */
    }
  }

  async setPermissionPolicy(
    sessionId: string,
    policy: 'auto_allow' | 'auto_deny' | 'manual',
    opts?: { userId?: string },
  ): Promise<void> {
    await this.request('PATCH', `/api/sessions/${sessionId}/permission-policy`, {
      body: { policy },
      timeoutMs: 5_000,
      userId: opts?.userId,
    });
  }

  async setTriggers(sessionId: string, triggers: Trigger[], opts?: { userId?: string }): Promise<void> {
    await this.request('PATCH', `/api/sessions/${sessionId}/triggers`, {
      body: { triggers },
      timeoutMs: 5_000,
      userId: opts?.userId,
    });
  }

  async startExploration(
    sessionId: string,
    body: { appId: string; goal?: string; budget?: Record<string, number> },
    opts?: { userId?: string },
  ): Promise<MobileExplorationStartResponse> {
    return this.request<MobileExplorationStartResponse>('POST', `/api/explorer/sessions/${sessionId}/start`, {
      body,
      timeoutMs: 30_000,
      userId: opts?.userId,
    });
  }

  async getExplorationStatus(runId: string, opts?: { userId?: string }): Promise<MobileExplorationSnapshot> {
    return this.request<MobileExplorationSnapshot>('GET', `/api/explorer/runs/${runId}`, {
      timeoutMs: 10_000,
      userId: opts?.userId,
    });
  }

  async getExplorationResult(runId: string, opts?: { userId?: string }): Promise<MobileExplorationSnapshot> {
    return this.request<MobileExplorationSnapshot>('GET', `/api/explorer/runs/${runId}/result`, {
      timeoutMs: 15_000,
      userId: opts?.userId,
    });
  }

  async submitExplorationAnswer(
    runId: string,
    answer: { questionId: string; value?: string; credentialValue?: string; skipped?: boolean },
    opts?: { userId?: string },
  ): Promise<unknown> {
    return this.request('POST', `/api/explorer/runs/${runId}/answer`, {
      body: answer,
      timeoutMs: 10_000,
      userId: opts?.userId,
    });
  }

  async cancelExploration(runId: string, opts?: { userId?: string }): Promise<unknown> {
    return this.request('POST', `/api/explorer/runs/${runId}/cancel`, {
      timeoutMs: 10_000,
      userId: opts?.userId,
    });
  }

  async getExplorationDefaults(opts?: { userId?: string }): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/api/explorer/defaults', {
      timeoutMs: 5_000,
      userId: opts?.userId,
    });
  }

  async getExplorationReadiness(opts?: { userId?: string }): Promise<MobileExplorationReadiness> {
    return this.request<MobileExplorationReadiness>('GET', '/api/explorer/readiness', {
      timeoutMs: 5_000,
      userId: opts?.userId,
    });
  }

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
    return this.request('POST', `/api/sessions/${sessionId}/capture-app-data`, {
      body: { packageName },
      timeoutMs: 30_000,
      userId: opts?.userId,
    });
  }

  async restoreAppData(
    sessionId: string,
    packageName: string,
    dataTarballBase64: string,
    opts?: { signal?: AbortSignal; userId?: string },
  ): Promise<{
    restoredVia: 'run-as' | 'su';
    restoreMs: number;
    launched: boolean;
  }> {
    this.throwIfAborted(opts?.signal);
    return this.request('POST', `/api/sessions/${sessionId}/restore-app-data`, {
      body: { packageName, dataTarballBase64 },
      signal: opts?.signal,
      timeoutMs: 30_000,
      userId: opts?.userId,
    });
  }

  async claimSession(platform: MobilePlatform, opts?: { ownerId?: string; userId?: string }): Promise<MobileSessionResponse> {
    return this.request<MobileSessionResponse>('POST', '/api/sessions/claim', {
      body: { platform, ...(opts?.ownerId ? { ownerId: opts.ownerId } : {}) },
      timeoutMs: 20_000,
      userId: opts?.userId,
    });
  }

  async releaseSession(sessionId: string, opts?: { userId?: string }): Promise<void> {
    await this.request('POST', '/api/sessions/release', {
      body: { sessionId },
      timeoutMs: 15_000,
      userId: opts?.userId,
    });
  }

  async getCapacity(): Promise<{
    pool: {
      android: { total: number; idle: number; busy: number } | null;
      ios: { total: number; idle: number; busy: number } | null;
    } | null;
    adhoc: { maxSessions: number; activeSessions: number; available: number };
    mode: 'pool' | 'classic';
  }> {
    return this.request('GET', '/api/sessions/capacity', { timeoutMs: 5_000 });
  }

  /**
   * Companion drives the user's OWN phone, and the install fast path this
   * feeds is a cell optimisation: it exists to avoid re-uploading a large APK
   * to a shared emulator we manage. Reporting "no devices" makes the caller
   * fall through to its normal install, which is the behaviour companion had
   * before this method existed.
   *
   * Answering empty rather than throwing is deliberate — the caller treats an
   * empty answer as "cannot confirm → reinstall", which is the safe direction.
   * A throw would have to be caught at every call site to reach the same
   * place.
   */
  async getDeviceBuilds(): Promise<MobileDeviceInventory> {
    return { collectedAt: new Date().toISOString(), devices: [] };
  }

  async executeBatchCommands(
    sessionId: string,
    commands: unknown[],
    opts?: { interactive?: boolean; timeoutMs?: number; signal?: AbortSignal; userId?: string },
  ): Promise<{ results: unknown[] }> {
    this.throwIfAborted(opts?.signal);
    return this.request<{ results: unknown[] }>('POST', `/api/commands/${sessionId}/batch`, {
      body: { commands },
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? (opts?.interactive ? INTERACTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
      userId: opts?.userId,
    });
  }

  async runSteps(
    sessionId: string,
    intentSteps: MobileIntentStep[],
    opts?: {
      screenshotEachStep?: boolean;
      stopOnFailure?: boolean;
      metadata?: MobileTestMetadata;
      triggers?: Trigger[];
      signal?: AbortSignal;
      userId?: string;
    },
  ): Promise<MobileRunStepsResponse> {
    this.throwIfAborted(opts?.signal);
    const body: MobileRunStepsRequest = {
      steps: intentSteps,
      screenshotEachStep: opts?.screenshotEachStep ?? true,
      stopOnFailure: opts?.stopOnFailure,
      metadata: opts?.metadata,
      ...(opts?.triggers && opts.triggers.length > 0 ? { triggers: opts.triggers } : {}),
    };
    return this.request<MobileRunStepsResponse>('POST', `/api/runs/${sessionId}/run-steps`, {
      body,
      signal: opts?.signal,
      timeoutMs: RUN_STEPS_TIMEOUT_MS,
      userId: opts?.userId,
    });
  }

  async probeFlutterDriverExtension(
    input: { packageName: string; apkPath: string },
    opts?: { userId?: string },
  ): Promise<{ detected: boolean; vmServiceUrl?: string; detail: string }> {
    return this.request('POST', '/api/probe/driver-extension', {
      body: input,
      timeoutMs: 240_000,
      userId: opts?.userId,
    });
  }

  async attachFlutter(
    sessionId: string,
    input: { packageName: string },
    opts?: { userId?: string },
  ): Promise<{ sessionId: string; platform: string }> {
    return this.request('POST', `/api/sessions/${sessionId}/attach-flutter`, {
      body: input,
      timeoutMs: env.MOBILE_ATTACH_FLUTTER_TIMEOUT_MS,
      userId: opts?.userId,
    });
  }

  async uploadApp(
    fileBuffer: Buffer,
    originalName: string,
    opts?: { userId?: string },
  ): Promise<{ path: string; filename: string; originalName: string; size: number }> {
    // Companion protocol: the backend cannot send multipart through the JSON
    // Socket.IO RPC. The companion must decode this marker and post multipart
    // field "file" to its local runner's /api/upload/apk endpoint.
    return this.request('POST', '/api/upload/apk', {
      body: {
        fieldName: 'file',
        fileBase64: fileBuffer.toString('base64'),
        originalName,
      },
      bodyEncoding: 'base64-file',
      timeoutMs: 120_000,
      userId: opts?.userId,
    });
  }

  async lintElement(
    sessionId: string,
    intent: string,
    actionType: string = 'tap',
    bindingHints?: Record<string, unknown>,
    /**
     * Mirrors MobileRunnerClient.lintElement — `useScreenshotOnly` forces
     * vision-only resolution. Kept structurally identical because
     * `IMobileRunnerClient` is a `Pick<MobileRunnerClient, …>` and
     * session-runner-routing returns this class as that type.
     *
     * NOTE (companion): a companion bundles its own runner, so an older
     * companion silently ignores this field and text-resolves instead — the
     * failure mode being fixed, just invisible. `forcedVision` is echoed back
     * on the result so callers can tell whether it was honoured.
     */
    opts?: { userId?: string; useScreenshotOnly?: boolean },
  ): Promise<{
    status: 'resolved' | 'not_found' | 'low_confidence' | 'error';
    boundingBox?: { x: number; y: number; width: number; height: number };
    screenSize?: { width: number; height: number };
    confidence?: number;
    resolvedVia?: string;
    visionMode?: boolean;
    elementText?: string;
    elementType?: string;
    screenshot?: string;
    message?: string;
    compiledPlan?: import('../mobile-runner.types').MobileCompiledPlan;
    visibleNodeCount?: number;
    topNodes?: Array<{
      type?: string;
      label?: string;
      bounds?: { left: number; top: number; right: number; bottom: number };
      resourceId?: string;
      creationLocation?: string;
    }>;
    intentWords?: string[];
    framework?: 'android' | 'ios' | 'flutter';
    forcedVision?: boolean;
  }> {
    return this.request('POST', `/api/commands/${sessionId}/lint`, {
      body: {
        intent,
        actionType,
        ...(bindingHints && Object.keys(bindingHints).length > 0 ? { bindingHints } : {}),
        ...(opts?.useScreenshotOnly ? { useScreenshotOnly: true } : {}),
      },
      timeoutMs: 18_000,
      userId: opts?.userId,
    });
  }

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
    this.throwIfAborted(opts?.signal);
    const params = new URLSearchParams();
    if (opts?.includeTree === false) params.set('includeTree', 'false');
    if (opts?.includeScreenshot === false) params.set('includeScreenshot', 'false');
    const qs = params.toString();
    return this.request<MobileUiState>('GET', `/api/sessions/${sessionId}/ui-state${qs ? `?${qs}` : ''}`, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? 8_000,
      userId: opts?.userId,
    });
  }

  async fetchForeground(
    sessionId: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal; userId?: string },
  ): Promise<MobileForegroundResponse> {
    this.throwIfAborted(opts?.signal);
    return this.request<MobileForegroundResponse>('GET', `/api/sessions/${sessionId}/foreground`, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? 3_000,
      userId: opts?.userId,
    });
  }

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
    this.throwIfAborted(opts?.signal);
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.includeRawInputs === true) params.set('includeRawInputs', 'true');
    const qs = params.toString();
    return this.request<MobileStepHistoryResponse>('GET', `/api/sessions/${sessionId}/step-history${qs ? `?${qs}` : ''}`, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? 3_000,
      userId: opts?.userId,
    });
  }

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
    this.throwIfAborted(opts?.signal);
    const params = new URLSearchParams();
    if (opts?.level !== undefined) params.set('level', opts.level);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.since !== undefined) params.set('since', opts.since);
    const qs = params.toString();
    return this.request<MobileLogsResponse>('GET', `/api/sessions/${sessionId}/logs${qs ? `?${qs}` : ''}`, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? 6_000,
      userId: opts?.userId,
    });
  }

  async getArtifacts(sessionId: string, opts?: { userId?: string }): Promise<MobileArtifactBundle> {
    return this.request<MobileArtifactBundle>('GET', `/api/runs/${sessionId}/artifacts`, {
      userId: opts?.userId,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    opts?: ProxyOptions,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.geminiApiKey) {
      headers['X-Gemini-Api-Key'] = this.geminiApiKey;
    }
    if (opts?.userId && env.RUNNER_USER_TOKEN_SECRET) {
      headers['X-User-Token'] = mintRunnerUserToken(opts.userId, env.RUNNER_USER_TOKEN_SECRET);
    }

    const response = await companionRegistry.proxyRequest(
      this.companionUserId,
      method,
      path,
      opts?.body,
      headers,
      {
        bodyEncoding: opts?.bodyEncoding,
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    );

    if (!response.ok) {
      const parsed = (response.body && typeof response.body === 'object')
        ? response.body as { code?: string; error?: string; reason?: string }
        : {};
      throw new MobileRunnerError(
        parsed.error
          ? `${parsed.error} (runner code: ${parsed.code ?? 'none'})`
          : `Runner returned ${response.status}`,
        response.status,
        parsed.code ?? (response.status >= 500 ? 'SERVER_ERROR' : 'CLIENT_ERROR'),
        parsed.reason,
      );
    }

    return response.body as T;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw new MobileRunnerError('Request aborted by caller', 499, 'ABORTED');
  }
}
