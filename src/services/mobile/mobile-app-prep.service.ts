/**
 * Mobile App Preparation Service
 *
 * Single primitive for preparing a mobile session's app state before
 * either the AI editor's preview shows or the regression worker's runSteps
 * batch fires. Both flows want the same guarantees:
 *
 *   1. The right APK is installed on the emulator.
 *   2. The app's data is wiped (`pm clear` equivalent) so no prior session's
 *      logged-in state, onboarding-modal-dismissed flags, or random-screen
 *      state leaks into the run.
 *   3. The app is launched cold so the very first frame the caller sees /
 *      the runner reads via uiautomator is the first-run UI.
 *
 * Pre-extraction this logic was inlined in
 * `src/api/mobile/session.controller.ts:installAppOnSession` (editor path)
 * and re-implemented separately in `src/jobs/mobile-test-run.job.ts:383-458`
 * (regression worker path). The worker's path was a strict subset:
 * `install_app(reinstall:true) + launch_app(clearData:true)` with no Redis
 * caching, no fast-paths, and no explicit `close_app(hard:true)` step. The
 * editor's three-branch fast-path (cached / device-checked / full install)
 * was inaccessible from the worker, so every regression test paid the full
 * APK download + upload + install cost (30-60s on a 90MB APK) even when an
 * editor session on the same emulator had just installed the same APK
 * 30 seconds earlier.
 *
 * Extraction unifies the two paths on a single primitive:
 *   - Same Redis warmup cache (key: `${WARMUP_PREFIX}${projectId}:${userId}`)
 *   - Same three branches (cached fast-path → device check → full install)
 *   - Same hard-reset semantics (`close_app(hard:true) + launch_app`)
 *   - Same per-branch timeouts and pending-install retry semantics
 *
 * Inheritance is automatic: any future improvement to one caller's app prep
 * (better timeout handling, new launcher activities, permission re-grants,
 * different emulator boot flows) lands here once and benefits both.
 *
 * The progress emitter is now an optional callback so each caller can wire
 * its own UI signal (editor: `preview:session:progress` WS event for the
 * loading bar; worker: `test:progress` for the regression run card). When
 * not provided, progress callbacks are silently dropped.
 */

import type { MobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { redisConnection } from '@/config/infrastructure/queues';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { ProjectService } from '@/services/core/project.service';
import { logger } from '@/utils/core/logger';
import { WARMUP_PREFIX, WARMUP_TTL, PENDING_INSTALL_PREFIX, type WarmupData } from '@/api/mobile/session.controller';

/**
 * Stage labels recognised by the editor's loading-bar component. The worker
 * doesn't render these but the type lets editor callers stay type-safe.
 */
export type AppPrepStage = 'launching_browser' | 'loading_page' | 'extracting_elements' | 'ready';

export interface PrepAppArgs {
  client: MobileRunnerClient;
  sessionId: string;
  projectId: string;
  userId: string;
  /**
   * Override the package name from `project.settings.mobileApp.packageName`.
   * The regression dispatch resolves the package at dispatch time and
   * passes it via job data, so the worker can supply it directly without
   * a follow-up project read. Editor's first call usually leaves this
   * undefined and lets the helper fall back on the project setting.
   */
  appPackage?: string;
  /**
   * Override the storage path from `project.settings.mobileApp.storagePath`.
   * Used by the regression worker which captures the storage path at
   * dispatch time. If undefined the helper reads it from the project — the
   * editor path that the original function shipped with.
   */
  appStoragePathOverride?: string;
  /**
   * Override the original APK filename from
   * `project.settings.mobileApp.originalName`. Same rationale as
   * `appStoragePathOverride`.
   */
  appOriginalNameOverride?: string;
  /**
   * Skip the final launch — the caller will perform its own
   * `close_app(hard:true) + launch_app` outside this helper. Used by
   * `autoBootAndInstall` so the very first frame the user sees in the
   * preview is the cold-launched, data-wiped app (no leak of the
   * pre-wipe UI). Default false.
   */
  skipLaunch?: boolean;
  /**
   * Optional progress callback. Editor wires it to a WS emit, worker
   * wires it to its `test:progress` event. Stage values mirror the four
   * progress checkpoints the original `installAppOnSession` emitted.
   */
  onProgress?: (stage: AppPrepStage, progress: number) => void;
}

/**
 * Shared app-prep primitive used by:
 *   - editor warmup (session.controller.ts: warmupSession + autoBootAndInstall)
 *   - regression worker (mobile-test-run.job.ts before runSteps)
 *
 * Returns the package name that ended up running, or `undefined` when the
 * project has no mobile-app configured (and no override was supplied).
 */
export class MobileAppPrepService {
  static async prepApp(args: PrepAppArgs): Promise<string | undefined> {
    const {
      client,
      sessionId,
      projectId,
      userId,
      appPackage: appPackageOverride,
      appStoragePathOverride,
      appOriginalNameOverride,
      skipLaunch,
      onProgress,
    } = args;

    const emit = (stage: AppPrepStage, progress: number): void => {
      if (onProgress) onProgress(stage, progress);
    };

    // Per-phase timing accumulator. Emitted on the single end-of-function
    // log line so operators can see "install: 28s, launch: 2s, branch: full"
    // for any prep without grepping multiple lines.
    const prepStart = Date.now();
    const timings: Record<string, number> = {};
    const time = async <T>(label: string, op: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        return await op();
      } finally {
        timings[label] = (timings[label] ?? 0) + (Date.now() - start);
      }
    };
    let branchTaken = 'unknown';

    // Nudge the UI past "preparing env" as soon as install logic starts.
    emit('launching_browser', 25);

    // Load the project's app config. Worker callers usually supply their
    // own storagePath/originalName/packageName via overrides — we still
    // read the project so we can persist a detected packageName back to
    // settings (cache warm for future warmups), and so the editor path is
    // unchanged from the pre-extraction behavior.
    const project = await time('project_load', () => ProjectService.getProject(projectId, userId));
    const projectMobileApp = project?.settings?.mobileApp ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectAny = projectMobileApp as any;

    const effectiveStoragePath: string | undefined =
      appStoragePathOverride ?? projectAny.storagePath;
    const effectiveOriginalName: string | undefined =
      appOriginalNameOverride ?? projectAny.originalName;

    if (!effectiveStoragePath) {
      logger.debug('[MOBILE_APP_PREP] No mobile app configured for project, skipping install', { projectId });
      return undefined;
    }

    // Check Redis for what's currently installed on this emulator.
    // Parallel get — independent keys, no need to serialise.
    const redisKey = `${WARMUP_PREFIX}${projectId}:${userId}`;
    const pendingKey = `${PENDING_INSTALL_PREFIX}${projectId}:${userId}`;
    const [warmupRaw, pendingStoragePath] = await time('redis_gets', () => Promise.all([
      redisConnection.get(redisKey),
      redisConnection.get(pendingKey),
    ]));
    const warmup: WarmupData | null = warmupRaw ? JSON.parse(warmupRaw) : null;

    // Pending-install flag — set by autoBootAndInstall when an upload
    // couldn't reach the emulator. If present AND matches the current APK,
    // the Redis/device dedup fast paths CANNOT be trusted — force a full
    // install.
    const hasPendingInstall = pendingStoragePath === effectiveStoragePath;
    if (hasPendingInstall) {
      logger.info('[MOBILE_APP_PREP] Pending-install flag detected — forcing full install', {
        sessionId,
        projectId,
        storagePath: effectiveStoragePath,
      });
    }

    // Audit fix (Bug #4): bail out of the cached fast path when the caller
    // explicitly supplied a DIFFERENT packageName than what's cached.
    // Previous logic took `appPackageOverride || warmup.installedPackage`
    // as the cached package and tried to launch it — but if
    // override='com.foo' and cached='com.bar', launch_app(com.foo) hits a
    // not-installed package. Falling through forces a full install of the
    // requested package.
    const cachedMismatch = !!(appPackageOverride
      && warmup?.installedPackage
      && appPackageOverride !== warmup.installedPackage);

    // ── Branch 1: Cached fast-path (Redis hit + same APK) ──────────────
    if (
      !hasPendingInstall
      && !cachedMismatch
      && warmup?.appStoragePath === effectiveStoragePath
      && warmup?.installedPackage
    ) {
      const cachedPackage = appPackageOverride || warmup.installedPackage;
      logger.debug('[MOBILE_APP_PREP] Same APK already installed (Redis), hard-reset + relaunch', {
        sessionId,
        projectId,
        package: cachedPackage,
        skipLaunch: skipLaunch === true,
      });
      emit('extracting_elements', 75);
      if (!skipLaunch) {
        // Hard reset on every prep: `pm clear --user N` wipes the app's
        // data dir + revokes runtime perms (auto-re-granted by the runner
        // per session policy), then cold-launch lands on first-run UI.
        // 60s budget: pm clear 5–15s + cold am start with first-launch dex
        // opt 10–20s = ~15-35s typical. Tighter than the legacy 90s so the
        // user sees a clear failure faster when the runner is wedged
        // (circuit breaker now propagates failure within ~30s).
        await time('branch1_close_launch', () => client.executeBatchCommands(sessionId, [
          { type: 'close_app', params: { packageName: cachedPackage, hard: true } },
          { type: 'launch_app', params: { packageName: cachedPackage } },
        ], { timeoutMs: 60_000 }));
      }
      branchTaken = 'cached_fast_path';
      logger.info('[MOBILE_APP_PREP] timing', {
        sessionId, projectId, branch: branchTaken,
        totalMs: Date.now() - prepStart, timings,
      });
      return cachedPackage;
    }
    if (cachedMismatch) {
      logger.info('[MOBILE_APP_PREP] Cached package differs from override — forcing full install', {
        sessionId,
        projectId,
        cached: warmup?.installedPackage,
        override: appPackageOverride,
      });
    }

    // ── Branch 2: Device-check fast-path (Redis expired but APK on device) ──
    // Avoids expensive re-download + re-install when the app is still on
    // the emulator. Skipped when a pending-install flag is set (we don't
    // trust device state in that case).
    const knownPackage = appPackageOverride || projectAny.packageName;
    if (knownPackage && !hasPendingInstall) {
      try {
        const checkResult = await time('branch2_check_package', () => client.executeBatchCommands(sessionId, [
          { type: 'check_package', params: { packageName: knownPackage } },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ], { timeoutMs: 10_000 })) as any;
        const isInstalled = !!checkResult?.results?.[0]?.data?.installed;
        if (isInstalled) {
          logger.info('[MOBILE_APP_PREP] Package still on device (Redis expired), hard-reset + relaunch without reinstall', {
            sessionId,
            projectId,
            package: knownPackage,
            skipLaunch: skipLaunch === true,
          });
          emit('extracting_elements', 75);
          if (!skipLaunch) {
            // Same hard-reset as the Redis fast path above — keeps the prep
            // contract consistent: every successful prep leaves the app in
            // a freshly-data-wiped state regardless of which install
            // branch fired. Same 60s budget as branch 1.
            await time('branch2_close_launch', () => client.executeBatchCommands(sessionId, [
              { type: 'close_app', params: { packageName: knownPackage, hard: true } },
              { type: 'launch_app', params: { packageName: knownPackage } },
            ], { timeoutMs: 60_000 }));
          }

          // Restore Redis cache so the next prep skips this branch too.
          if (warmup) {
            warmup.installedPackage = knownPackage;
            warmup.appStoragePath = effectiveStoragePath;
            await redisConnection.set(redisKey, JSON.stringify(warmup), 'EX', WARMUP_TTL);
          }

          // Persist packageName to project settings so future preps can
          // hit this fast path even after Redis expires (knownPackage may
          // have come from appPackageOverride when packageName was null).
          await persistPackageName(projectId, userId, projectMobileApp, knownPackage);

          branchTaken = 'device_check_fast_path';
          logger.info('[MOBILE_APP_PREP] timing', {
            sessionId, projectId, branch: branchTaken,
            totalMs: Date.now() - prepStart, timings,
          });
          return knownPackage;
        }
      } catch (err) {
        logger.debug('[MOBILE_APP_PREP] Device package check failed, proceeding with install', {
          error: (err as Error).message,
        });
      }
    }

    // ── Branch 3: Full install (download → upload → install → launch) ──
    logger.info('[MOBILE_APP_PREP] Installing app on session', {
      sessionId,
      projectId,
      originalName: effectiveOriginalName,
      oldPackage: warmup?.installedPackage || '(none)',
    });
    emit('loading_page', 45);

    const fileBuffer = await time('storage_download', () => MobileAppStorageService.downloadApp(effectiveStoragePath));
    const uploaded = await time('runner_upload', () => client.uploadApp(fileBuffer, effectiveOriginalName ?? 'app.apk'));

    // Prefer explicit package from caller / project metadata.
    const explicitPackage = appPackageOverride || projectAny.packageName;

    // Always uninstall the old package if we know it from a previous
    // install. Ensures clean state when:
    //   - Package name changed between uploads
    //   - packageName was never provided by the user (frontend doesn't
    //     always send it)
    //   - Same package but different signature (would otherwise fail with
    //     INSTALL_FAILED_UPDATE_INCOMPATIBLE)
    const oldPackage = warmup?.installedPackage;
    const shouldUninstallOld = !!oldPackage;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const installResult = await time('runner_install', () => client.executeBatchCommands(sessionId, [
      {
        type: 'install_app',
        params: {
          apkPath: uploaded.path,
          reinstall: true,
          clearData: true,
          autoLaunch: false,
          ...(explicitPackage ? { packageName: explicitPackage } : {}),
          ...(shouldUninstallOld ? { uninstallOldPackage: oldPackage } : {}),
        },
      },
      // adb install timeout: 180s. Big APKs + permission pre-grant on a cold
      // emulator routinely take 60-120s — 180s leaves ~50% headroom while
      // failing-fast 60s sooner than the legacy 240s when the runner is
      // genuinely wedged. The circuit breaker in AdbClient now propagates
      // hung-emulator failures within ~30s independently of this timeout.
    ], { timeoutMs: 180_000 })) as any;

    // Runner wraps every command result as { success, data, durationMs, ... }.
    // The install handler returns { installed, packageName } inside `data`.
    const detected = installResult?.results?.[0]?.data?.packageName as string | undefined;
    const packageName = explicitPackage || detected;

    // Always issue an explicit launch_app — never rely on install's
    // auto-launch. Gives us one deterministic code path regardless of
    // whether we knew the package name up front. Skipped when caller
    // passes `skipLaunch: true` (autoBootAndInstall pattern).
    if (packageName && !skipLaunch) {
      emit('extracting_elements', 75);
      // launch_app timeout: 90s. Fresh-install + permission pre-grant + RN/
      // Flutter first-run init can briefly exceed 60s; 90s covers the long
      // tail while still failing-fast half as long as the legacy 180s when
      // the launch is truly stuck.
      await time('runner_launch', () => client.executeBatchCommands(sessionId, [
        { type: 'launch_app', params: { packageName } },
      ], { timeoutMs: 90_000 }));
    }

    // Audit fix (Bug #1): install completed but packageName resolution
    // failed. This is rare (usually `pm list packages -3` diff after install
    // picks it up) but happens with side-loaded splits. Without a warning
    // the caller's `if (installedPackage)` guard silently skips the
    // wipe-and-launch step that's the whole point of `skipLaunch:true`
    // flows. Loud-fail so it shows up in logs.
    if (!packageName) {
      logger.warn('[MOBILE_APP_PREP] Install succeeded but packageName resolution failed — caller will skip post-install hooks', {
        sessionId,
        projectId,
        hadExplicitPackage: !!explicitPackage,
        hadDetected: !!detected,
      });
    }

    // Update Redis with the installed package so future preps know what's
    // on the emulator.
    if (warmup && packageName) {
      warmup.installedPackage = packageName;
      warmup.appStoragePath = effectiveStoragePath;
      await redisConnection.set(redisKey, JSON.stringify(warmup), 'EX', WARMUP_TTL);
    }

    // Persist packageName to project.settings.mobileApp so future preps can
    // use the check_package fast path even after Redis TTL expires.
    if (packageName) {
      await persistPackageName(projectId, userId, projectMobileApp, packageName);
    }

    // Pending-install flag (if any) has now been consumed — clear it.
    if (hasPendingInstall) {
      await redisConnection.del(pendingKey);
    }

    logger.info('[MOBILE_APP_PREP] App installed on session', {
      sessionId,
      projectId,
      packageName: packageName || '(auto-launched by runner)',
    });

    branchTaken = 'full_install';
    logger.info('[MOBILE_APP_PREP] timing', {
      sessionId, projectId, branch: branchTaken,
      totalMs: Date.now() - prepStart, timings,
    });

    return packageName;
  }
}

/**
 * Write the detected Android package name back to
 * `project.settings.mobileApp` so subsequent preps (after Redis TTL expiry)
 * can hit the `check_package` fast path instead of re-downloading the APK.
 * No-op when the value is already up to date. Failures are logged but
 * swallowed — this is a cache warm, not a correctness-critical write.
 */
async function persistPackageName(
  projectId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentMobileApp: any,
  packageName: string,
): Promise<void> {
  if (!packageName || currentMobileApp?.packageName === packageName) return;
  try {
    await ProjectService.updateProject(projectId, userId, {
      settings: {
        mobileApp: {
          ...currentMobileApp,
          packageName,
        } as unknown as Record<string, unknown>,
      },
    });
    logger.info('[MOBILE_APP_PREP] Persisted packageName to project settings', {
      projectId,
      packageName,
    });
  } catch (err) {
    logger.warn('[MOBILE_APP_PREP] Failed to persist packageName (non-fatal)', {
      projectId,
      packageName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
