import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { IMobileRunnerClient } from './mobile-runner-client';
import { MobileRunnerError } from './mobile-runner.types';
import type { FastAuthRestore } from '@/services/test-resource/resource-step-compiler.service';
import { categorizeFastAuthError } from './fast-auth-error-classifier';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FAST-AUTH ORCHESTRATOR SERVICE
 *
 * Extracted from MobileTestRunJobHandler (Phase 2-C refactor).
 * Owns Phase 3c: restoring app-data snapshots to skip login recipes,
 * and the `markSnapshotBroken` helper that invalidates stale snapshots.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class FastAuthOrchestratorService {
  /**
   * Restore one or more auth-resource snapshots onto the acquired mobile
   * session (Phase 3c). Must run AFTER app prep (prepApp wipes data) and
   * BEFORE runSteps (steps assume the app is on-screen and logged in).
   *
   * Returns a result object rather than throwing a cancellation error so
   * the caller can use its own error type without a circular import.
   *
   * @param params.client          - Runner HTTP client for this job
   * @param params.sessionId       - Acquired session to restore into
   * @param params.fastAuthRestores - List of snapshot restores from resource compiler
   * @param params.testId          - `tests.id` for WS + logging
   * @param params.browser         - Browser label for WS payloads
   * @param params.userId          - For snapshot invalidation + WS payloads
   * @param params.chatSessionId   - Editor chat session, used in WS payloads
   * @param params.checkCancelled  - Async callback returning true when the test was cancelled
   */
  static async restoreSnapshots(params: {
    client: IMobileRunnerClient;
    sessionId: string;
    fastAuthRestores: FastAuthRestore[];
    testId: string;
    browser: string;
    userId: string;
    chatSessionId: string | undefined;
    checkCancelled: () => Promise<boolean>;
  }): Promise<{
    cancelled: boolean;
    fastAuthUsed: boolean;
    fastAuthRestoreMs: number;
    fastAuthFallbackReason: string | null;
  }> {
    const { client, sessionId, fastAuthRestores, testId, browser, userId, chatSessionId, checkCancelled } = params;

    if (fastAuthRestores.length === 0) {
      return { cancelled: false, fastAuthUsed: false, fastAuthRestoreMs: 0, fastAuthFallbackReason: null };
    }

    // Early cancellation check — restore can take up to 30s per binding
    // on a multi-MB tarball, so we don't want to start if the user has
    // already given up.
    if (await checkCancelled()) {
      return { cancelled: true, fastAuthUsed: false, fastAuthRestoreMs: 0, fastAuthFallbackReason: null };
    }

    // Local abort controller scoped to Phase 3c only. Phase 4 has its
    // own (`runStepsAbort`) — keeping them separate avoids leaking the
    // cancel-poller's lifecycle into the restore loop, and means a
    // restore cancellation doesn't also force-abort the runSteps fetch
    // that hasn't started yet.
    const restoreAbort = new AbortController();
    const restoreCancelPoller = setInterval(async () => {
      try {
        if (await checkCancelled()) restoreAbort.abort();
      } catch { /* polling errors are non-fatal */ }
    }, 2_000);
    restoreCancelPoller.unref?.();

    // Emit a progress marker so the UI doesn't show a silent ~200ms
    // gap between "Launching app…" (17%) and "Executing steps…" (20%).
    // On a 200-test regression this is 200 events the user would
    // otherwise wonder about. Non-fatal: WS failures never block restore.
    try {
      webSocketService.emitTestProgress(testId, {
        testId,
        browser,
        progress: 18,
        phase: 'initializing',
        currentStep: 'Restoring saved session (fast-auth)…',
        status: 'running',
        timestamp: new Date().toISOString(),
        userId,
        sessionId: chatSessionId,
      });
    } catch { /* non-fatal */ }

    const fastAuthT0 = Date.now();
    let anySuccess = false;
    let lastFailureReason: string | null = null;

    for (const restore of fastAuthRestores) {
      try {
        const result = await client.restoreAppData(
          sessionId,
          restore.packageName,
          restore.dataTarballBase64,
          { signal: restoreAbort.signal, userId },
        );
        if (!result.launched) {
          // Data was laid down but launch didn't confirm. Treat as
          // partial-failure — the activity entry might have moved
          // between snapshot and current build. Don't trust the
          // snapshot any more; fall back so the next test recompiles.
          lastFailureReason = `restore wrote data but app launch did not confirm (${result.restoredVia})`;
          await FastAuthOrchestratorService.markSnapshotBroken(
            restore.resourceId,
            userId,
            lastFailureReason,
          );
          logger.warn(
            '[FAST_AUTH] Restore wrote data but launch unconfirmed — marking broken',
            {
              testId,
              resourceId: restore.resourceId,
              resourceName: restore.resourceName,
              packageName: restore.packageName,
            },
          );
          continue;
        }
        anySuccess = true;
        logger.info('[FAST_AUTH] Snapshot restored, app launched', {
          testId,
          resourceId: restore.resourceId,
          resourceName: restore.resourceName,
          packageName: restore.packageName,
          restoredVia: result.restoredVia,
          restoreMs: result.restoreMs,
          sizeBytes: restore.sizeBytes,
        });
      } catch (err) {
        // Runner returned non-2xx OR network blip. Decide whether to
        // INVALIDATE the snapshot or just record the failure:
        //
        //   413 SNAPSHOT_TOO_LARGE  → snapshot itself is the problem; strip it.
        //   409 SNAPSHOT_PRIVILEGE  → device-specific; strip it. Other
        //                             devices in the pool might work, but
        //                             on a single-emulator deployment the
        //                             next test would hit the same wall.
        //                             Telemetry will tell us if we
        //                             should soften this to "device
        //                             marker" instead of full strip.
        //   400 PACKAGE_NAME_MISMATCH → snapshot is fine, just wrong target.
        //                              DO NOT strip — user's config bug,
        //                              not snapshot rot.
        //   400 PLATFORM_UNSUPPORTED  → same as above — config bug.
        //   500+ / network / timeout → transient. DO NOT strip — a
        //                              flaky runner would erase all
        //                              snapshots within minutes.
        //
        // The error's `code` field (set by MobileRunnerError) is the
        // authoritative signal; status alone isn't (the runner could
        // ship a 400 for a non-config issue in future).
        const code = err instanceof MobileRunnerError ? err.code : undefined;
        const statusCode = err instanceof MobileRunnerError ? err.statusCode : undefined;
        const reason = err instanceof Error ? err.message : String(err);
        lastFailureReason = reason.slice(0, 200);

        const category = categorizeFastAuthError(code, statusCode);
        const shouldInvalidate = category === 'invalidate_snapshot';
        const isConfigBug = category === 'config_bug';
        const isTransient = category === 'transient';

        if (shouldInvalidate) {
          await FastAuthOrchestratorService.markSnapshotBroken(
            restore.resourceId,
            userId,
            lastFailureReason,
          );
          logger.warn(
            '[FAST_AUTH] Restore failed — snapshot stripped, next test falls back to recipe',
            {
              testId,
              resourceId: restore.resourceId,
              packageName: restore.packageName,
              code,
              error: reason,
            },
          );
        } else if (isConfigBug) {
          logger.warn(
            '[FAST_AUTH] Restore rejected by runner config check — snapshot left intact',
            {
              testId,
              resourceId: restore.resourceId,
              packageName: restore.packageName,
              code,
            },
          );
        } else if (isTransient) {
          logger.warn(
            '[FAST_AUTH] Restore failed (transient) — snapshot left intact, will retry next run',
            {
              testId,
              resourceId: restore.resourceId,
              packageName: restore.packageName,
              statusCode,
              error: reason,
            },
          );
        } else {
          // Unknown shape — be conservative, log and leave the snapshot.
          // Better to retry a snapshot we don't understand than to
          // strip one that might be fine.
          logger.warn(
            '[FAST_AUTH] Restore failed with unrecognised error — snapshot left intact',
            {
              testId,
              resourceId: restore.resourceId,
              packageName: restore.packageName,
              code,
              statusCode,
              error: reason,
            },
          );
        }
      }
    }

    clearInterval(restoreCancelPoller);

    // If the abort came from our cancel poller mid-restore, signal
    // cancellation to the caller (who will throw its own typed error).
    if (restoreAbort.signal.aborted) {
      return { cancelled: true, fastAuthUsed: false, fastAuthRestoreMs: Math.max(0, Date.now() - fastAuthT0), fastAuthFallbackReason: null };
    }

    return {
      cancelled: false,
      fastAuthUsed: anySuccess,
      fastAuthRestoreMs: Math.max(0, Date.now() - fastAuthT0),
      fastAuthFallbackReason: anySuccess ? null : (lastFailureReason ?? 'restore failed for all bindings'),
    };
  }

  /**
   * Fast-auth: strip a now-suspect mobileSnapshot from its auth resource
   * so the NEXT test in this regression compiles to recipe replay instead
   * of trying the same broken snapshot again. Best-effort, never throws —
   * a failed strip just means one more test pays the restore-retry cost.
   */
  static async markSnapshotBroken(
    resourceId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    try {
      const { clearMobileSnapshot } = await import(
        '@/services/test-resource/test-resource.service'
      );
      // markBrokenIfNoRecipe: runtime invalidation = "snapshot is gone AND
      // there's nothing to fall back to". If the resource has a recipe we
      // leave it active (recipe path still works). If not, mark broken so
      // the Logins UI surfaces a re-record CTA — without this the user
      // would silently see "active" resources whose every test fails.
      await clearMobileSnapshot(resourceId, userId, reason, {
        markBrokenIfNoRecipe: true,
      });
    } catch (err) {
      logger.warn('[MOBILE-TEST] markSnapshotBroken threw', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
