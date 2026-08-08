import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { claimWarmedSession } from '@/api/mobile/session.controller';
import { MobileRunnerClient } from './mobile-runner-client';
import { MobileRunnerError, type MobilePlatform } from './mobile-runner.types';
import { resolveDedicatedDevice } from './dedicated-device.service';
import { storeSessionRunnerBinding, getSessionRunnerBinding } from './session-runner-routing';
import { DedicatedDeviceFeature } from '@/config/features/dedicated-device';
import { env } from '@/config/environment/env';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MOBILE SESSION ACQUISITION SERVICE
 *
 * Extracted from MobileTestRunJobHandler (Phase 2-B refactor).
 * Owns the three-tier session acquisition ladder:
 *   1. Pool claim (runner pre-booted sessions, ~0-15s)
 *   2. Warmed session (editor eager-start, ~0-5s)
 *   3. Cold start (new emulator/simulator, ~60s)
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * Dedicated-create retry budget. Three attempts over ~30s: long enough to
 * outlast the tail of a sibling run's teardown, short enough that a genuinely
 * occupied device still reports back inside the job's patience.
 */
const DEDICATED_BUSY_RETRIES = 2;
const DEDICATED_BUSY_BACKOFF_MS = [10_000, 20_000];

export class MobileSessionAcquisitionService {
  /**
   * Create the dedicated session, retrying only on the runner's DEVICE_BUSY.
   *
   * Every other failure (DEVICE_NOT_FOUND, DEVICE_INIT_FAILED, transport) is
   * rethrown untouched — those are not transient and re-firing them only
   * delays the user-visible error, the same reasoning the client's own retry
   * loop applies to typed device errors.
   */
  private static async createDedicatedWithRetry(
    client: MobileRunnerClient,
    platform: MobilePlatform,
    config: Parameters<MobileRunnerClient['createSession']>[1],
    onRetry: (attempt: number, waitMs: number) => void,
  ): Promise<{ sessionId: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.createSession(platform, config);
      } catch (err) {
        const isBusy = err instanceof MobileRunnerError && err.code === 'DEVICE_BUSY';
        if (!isBusy || attempt >= DEDICATED_BUSY_RETRIES) throw err;
        const waitMs = DEDICATED_BUSY_BACKOFF_MS[attempt] ?? 20_000;
        onRetry(attempt + 1, waitMs);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  /**
   * Attempt to acquire a mobile runner session via pool → warmup → cold-start.
   *
   * Emits WebSocket progress events so the frontend doesn't display a long
   * silent pause during cold-start. Callers MUST persist the returned
   * `sessionClaimMs` and `coldStartUsed` values into their telemetry state.
   *
   * @param params.client         - Runner HTTP client for this job
   * @param params.testId         - `tests.id` for WS + logging
   * @param params.platform       - Target platform ('android' | 'ios' | 'flutter')
   * @param params.browser        - Browser label for WS payloads
   * @param params.userId         - Owner for multi-user isolation
   * @param params.projectId      - Project used for warmup-session lookup
   * @param params.chatSessionId  - Editor chat session, used in WS payloads
   */
  static async acquireSession(params: {
    client: MobileRunnerClient;
    testId: string;
    platform: MobilePlatform;
    browser: string;
    userId: string;
    workspaceId: string | undefined;
    projectId: string | undefined;
    chatSessionId: string | undefined;
    /**
     * Set for a Flutter job: `platform` above is then the HOST to acquire
     * ('android' | 'ios'), while the editor's warmed session is recorded as
     * platform 'flutter' + a hostPlatform. Drives host-aware warmup matching.
     */
    isFlutter?: boolean;
  }): Promise<{
    sessionId: string;
    sessionSource: 'pool' | 'warmup' | 'cold' | 'dedicated';
    sessionClaimMs: number;
    coldStartUsed: boolean;
  }> {
    const { client, testId, platform, browser, userId, workspaceId, projectId, chatSessionId, isFlutter } = params;

    // Announce session start to the frontend
    try {
      webSocketService.emitTestProgress(testId, {
        testId,
        browser,
        progress: 10,
        phase: 'initializing',
        currentStep: `Starting ${platform} session...`,
        status: 'running',
        timestamp: new Date().toISOString(),
        userId,
        sessionId: chatSessionId,
      });
    } catch { /* non-fatal */ }

    // Phase 6: Session acquisition can take up to ~60s on a cold start.
    // Progressively tell the frontend which fallback we're on so "Starting
    // mobile session…" doesn't feel like a freeze. Progress stays in the
    // 10-15% band — we're still in the initializing phase, not executing.
    const emitSessionPhase = (step: string, pct: number) => {
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: pct,
          phase: 'initializing',
          currentStep: step,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }
    };

    // Phase 2 telemetry: timer wraps the entire pool->warmup->cold
    // ladder so cold-start dominated runs surface in `session_claim_ms`.
    // Date.now() is good enough at millisecond granularity for human-
    // observable infrastructure wait times.
    const sessionClaimT0 = Date.now();
    let sessionId: string | null = null;
    let sessionSource: 'pool' | 'warmup' | 'cold' | 'dedicated' = 'cold';

    // Tier 0: Dedicated emulator (runs BEFORE pool/warmup/cold). When the
    // workspace has an active dedicated device, pin the run to it and SKIP the
    // shared ladder entirely — running first is what preempts a stale shared
    // warmed session being claimed for a dedicated workspace. Resolver is a
    // no-op (null) unless the feature flag is on AND a row exists, so this
    // block is inert in the default deploy.
    const dedicated = await resolveDedicatedDevice(workspaceId, platform);
    if (dedicated) {
      emitSessionPhase(`Starting your dedicated ${platform} emulator…`, 12);
      // ownerId=workspaceId gives per-workspace Android multi-user isolation
      // on the runner IF it has multi-user enabled; harmless no-op otherwise.
      // Isolation primarily comes from the dedicated container itself, not the
      // Android user. NO shared-pool fallback on failure — a dedicated workspace
      // must never silently land on a shared device (that breaks isolation).
      //
      // DEVICE_BUSY is the ONE runner code worth retrying here. The runner's
      // per-serial guard rejects a second session on the workspace's container
      // *expecting the caller to come back* — but the generic retry loop in
      // MobileRunnerClient only retries bare 5xx (a coded 409 is excluded), so
      // nothing ever did. A dedicated workspace can genuinely have two runs
      // overlap: MOBILE_WORKER_CONCURRENCY defaults to 2, so a plan with two
      // mobile tests dispatches both at once and the loser used to fail in
      // seconds. Bounded — this covers a real overlap, NOT a stuck session
      // (the runner reclaims those itself now).
      const session = await MobileSessionAcquisitionService.createDedicatedWithRetry(
        client,
        platform,
        { deviceSelector: { serial: dedicated.serial }, ownerId: workspaceId, userId, dedicated: true },
        (attempt, waitMs) => {
          emitSessionPhase(
            `Your dedicated ${platform} device is busy — retrying in ${Math.round(waitMs / 1000)}s…`,
            12,
          );
          logger.info('[MOBILE-TEST] Dedicated device busy — retrying', {
            testId, workspaceId, serial: dedicated.serial, attempt, waitMs,
          });
        },
      );
      logger.info('[MOBILE-TEST] Dedicated session created', {
        testId,
        sessionId: session.sessionId,
        platform,
        workspaceId,
      });
      // Store binding so getMobileRunnerClientForSession resolves the right runner
      // for session-scoped calls (runSteps, destroySession, etc.) during the job.
      // TTL matches the editor warmup TTL (15 min) — regression jobs are bounded.
      await storeSessionRunnerBinding(
        session.sessionId,
        { runnerUrl: dedicated.runnerUrl, runnerApiKey: dedicated.runnerApiKey },
        900,
      );
      return {
        sessionId: session.sessionId,
        sessionSource: 'dedicated',
        sessionClaimMs: Math.max(0, Date.now() - sessionClaimT0),
        coldStartUsed: false,
      };
    }

    // Observability (Phase 7, log-only): the dedicated feature is ON and we
    // have a workspace, yet no dedicated device resolved — this run is about to
    // fall through to the SHARED pool. For a workspace that's supposed to be
    // dedicated this is silent routing breakage (missing/inactive row, platform
    // mismatch, or an ios-v1 run). Surface a warn ops can alert on; there's no
    // session_source column to make this visible in telemetry. iOS is excluded
    // from the warn — it's an expected fall-through (no dedicated iOS in v1),
    // not a misconfiguration.
    if (DedicatedDeviceFeature.isEnabled() && workspaceId && platform !== 'ios') {
      logger.warn('[MOBILE-TEST] Dedicated feature on but no device resolved — falling back to shared pool', {
        testId,
        workspaceId,
        platform,
      });
    }

    try {
      // Try 1: Pool claim (runner pre-booted sessions, fastest path ~0-15s).
      // Pass `ownerId: userId` so the runner switches to this user's
      // dedicated Android multi-user — apps from other owners are hidden.
      // Gated by MOBILE_MULTI_USER_ISOLATION (default OFF for shared
      // workspace; skipping `ownerId` shaves 5-15s and avoids
      // "Maximum user limit is reached" on long-running redroid hosts).
      const effectiveOwnerId = env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined;
      try {
        const claimed = await client.claimSession(platform, { ownerId: effectiveOwnerId, userId });
        sessionId = claimed.sessionId;
        sessionSource = 'pool';
        logger.info('[MOBILE-TEST] Pool session claimed', {
          testId, sessionId, platform,
          ownerId: effectiveOwnerId ?? null,
          multiUserIsolation: env.MOBILE_MULTI_USER_ISOLATION,
        });
      } catch (poolErr) {
        // Pool exhausted, disabled, or runner unreachable — try next
        logger.debug('[MOBILE-TEST] Pool claim failed, trying warmup', {
          testId,
          error: poolErr instanceof Error ? poolErr.message : String(poolErr),
        });
      }

      // Try 2: Warmed session (editor eager start). The match criteria are
      // enforced INSIDE claimWarmedSession, BEFORE its Redis delete — a
      // mismatched record (other platform, or a Flutter warmup on the other
      // host) is left in place for the editor instead of being eaten.
      // For a Flutter job the warmed record is platform 'flutter' with a
      // hostPlatform, while our `platform` is the host to acquire.
      if (!sessionId && projectId) {
        emitSessionPhase(`Checking warmed ${platform} session…`, 11);
        const warmed = await claimWarmedSession(
          projectId,
          userId,
          isFlutter
            ? { platform: 'flutter', hostPlatform: platform === 'ios' ? 'ios' : 'android' }
            : { platform },
        );
        if (warmed) {
          sessionId = warmed.sessionId;
          sessionSource = 'warmup';
          logger.info('[MOBILE-TEST] Warmed session claimed', { testId, sessionId, platform });
          // Refresh the per-session runner binding so a companion / dedicated-URL
          // warmup can't lose its routing if the original 15-min TTL lapses before
          // the job's session-scoped calls (runSteps, destroySession) —
          // getMobileRunnerClientForSession would otherwise silently fall back to
          // the shared env runner and hit the WRONG runner. The dedicated tier-0
          // branch already re-stores its binding; mirror that here. Shared-pool
          // warmups carry NO binding and are left untouched (default runner is
          // correct for them). Best-effort: a Redis hiccup must not fail the run.
          try {
            const warmupBinding = await getSessionRunnerBinding(sessionId);
            if (warmupBinding) {
              await storeSessionRunnerBinding(sessionId, warmupBinding, 900);
            }
          } catch (bindErr) {
            logger.warn('[MOBILE-TEST] Warmup binding refresh failed (non-fatal)', {
              testId,
              sessionId,
              error: bindErr instanceof Error ? bindErr.message : String(bindErr),
            });
          }
        }
        // Platform/host mismatch is logged (and the record preserved) inside
        // claimWarmedSession — no discard branch needed here anymore.
      }

      // Try 3: Cold start (fallback — creates new emulator/simulator ~60s)
      if (!sessionId) {
        // Explicit heads-up: cold starts can take up to a minute, so users
        // see "Booting emulator…" instead of a long silent pause after 10%.
        emitSessionPhase(`Booting ${platform} emulator (cold start, up to 60s)…`, 12);
        const effectiveOwnerId = env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined;
        const session = await client.createSession(platform, {
          ownerId: effectiveOwnerId,
          userId,
          // iOS: pin to a simulator. The runner's default-source policy can
          // flip to 'local-physical' when an iPhone is hotplugged via USB —
          // a background regression must never silently claim a physical
          // device (mirrors the editor's guard in session.controller.ts).
          ...(platform === 'ios' ? { deviceSelector: { source: 'local-emulator' as const } } : {}),
        });
        sessionId = session.sessionId;
        sessionSource = 'cold';
        logger.info('[MOBILE-TEST] Session created (cold start)', {
          testId,
          sessionId,
          platform,
          ownerId: effectiveOwnerId ?? null,
        });
      }
    } finally {
      // Phase 2: record claim wallclock regardless of outcome. A
      // cold-start that succeeded after pool failure has the full
      // ladder time, which is the honest number to expose. We also
      // record coldStartUsed here so the value is set even if a
      // subsequent prepApp throw skips later instrumentation.
      // (These are returned to the caller to persist into tlm.)
    }

    // sessionId is always set here — one of the three paths always succeeds
    // or throws (pool + warmup silent-fail, cold-start throws on runner error).
    return {
      sessionId: sessionId as string,
      sessionSource,
      sessionClaimMs: Math.max(0, Date.now() - sessionClaimT0),
      coldStartUsed: sessionSource === 'cold',
    };
  }
}
