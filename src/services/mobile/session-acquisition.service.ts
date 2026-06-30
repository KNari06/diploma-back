import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { claimWarmedSession } from '@/api/mobile/session.controller';
import { MobileRunnerClient } from './mobile-runner-client';
import type { MobilePlatform } from './mobile-runner.types';
import { resolveDedicatedDevice } from './dedicated-device.service';
import { storeSessionRunnerBinding } from './session-runner-routing';
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
export class MobileSessionAcquisitionService {
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
  }): Promise<{
    sessionId: string;
    sessionSource: 'pool' | 'warmup' | 'cold' | 'dedicated';
    sessionClaimMs: number;
    coldStartUsed: boolean;
  }> {
    const { client, testId, platform, browser, userId, workspaceId, projectId, chatSessionId } = params;

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
      const session = await client.createSession(platform, {
        deviceSelector: { serial: dedicated.serial },
        ownerId: workspaceId,
        userId,
        dedicated: true,
      });
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

      // Try 2: Warmed session (editor eager start)
      if (!sessionId && projectId) {
        emitSessionPhase(`Checking warmed ${platform} session…`, 11);
        const warmed = await claimWarmedSession(projectId, userId);
        if (warmed && warmed.platform === platform) {
          sessionId = warmed.sessionId;
          sessionSource = 'warmup';
          logger.info('[MOBILE-TEST] Warmed session claimed', { testId, sessionId, platform });
        } else if (warmed && warmed.platform !== platform) {
          // Pre-fix this branch was silent — a warmup existed but for a
          // different platform (e.g. user warmed mobile_android in the
          // editor, then ran a mobile_ios regression). The cold-start
          // tax then applies anyway. Warn so operators can spot wasted
          // warmups and tune the editor's eager-start heuristics.
          logger.warn('[MOBILE-TEST] Warmed session discarded — platform mismatch', {
            testId,
            warmedSessionId: warmed.sessionId,
            warmedPlatform: warmed.platform,
            requestedPlatform: platform,
          });
        }
      }

      // Try 3: Cold start (fallback — creates new emulator/simulator ~60s)
      if (!sessionId) {
        // Explicit heads-up: cold starts can take up to a minute, so users
        // see "Booting emulator…" instead of a long silent pause after 10%.
        emitSessionPhase(`Booting ${platform} emulator (cold start, up to 60s)…`, 12);
        const effectiveOwnerId = env.MOBILE_MULTI_USER_ISOLATION ? userId : undefined;
        const session = await client.createSession(platform, { ownerId: effectiveOwnerId, userId });
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
