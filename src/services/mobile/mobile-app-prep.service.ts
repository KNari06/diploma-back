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
import { getProjectMobileApp, buildMobileAppSettingsPatch, DEFAULT_VARIANT_LABEL } from '@/services/mobile/project-mobile-app.helper';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';

/**
 * Stage labels recognised by the editor's loading-bar component. The worker
 * doesn't render these but the type lets editor callers stay type-safe.
 *
 * These are the MOBILE warmup stages — they mirror the real prep steps the
 * editor's loading bar shows (APK/IPA install → cold launch). The emulator
 * boot stage (`boot_emulator`) is emitted by the warmup controller before
 * prepApp runs; `waiting_first_frame` is driven by the frontend off the
 * live video stream. The legacy web stage names (`launching_browser`, …)
 * are intentionally NOT part of this union anymore — mobile prep no longer
 * borrows them.
 */
export type AppPrepStage = 'installing_app' | 'launching_app' | 'ready';

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
  /**
   * Platform the caller is preparing the session for. Drives the
   * platform-sharded read of `project.settings.mobileApps[platform]`.
   *
   * When undefined, the helper falls back to the legacy singular slot
   * (`project.settings.mobileApp`) for back-compat with any caller that
   * hasn't been migrated yet — this matches the pre-multi-platform
   * behaviour, so existing Android workflows aren't disturbed.
   *
   * Editor callers know the platform from the active flow. Worker
   * callers know it from the regression run config. Both should pass
   * it explicitly going forward.
   */
  platform?: MobilePlatform;
  /**
   * Named build-variant lane to install (e.g. 'Staging'). When set and no
   * explicit `appStoragePathOverride` was supplied, prep resolves that lane's
   * build via `MobileAppStorageService.resolveAppForRun` and installs IT
   * instead of the project default — the same resolver the regression
   * dispatcher uses, so an editor preview installs the build the flow is
   * pinned to. Absent → the project default lane (pre-variant behaviour).
   * A variant with no build falls back to the default lane (logged).
   */
  variantLabel?: string;
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
  /**
   * Cheap on-device package existence check (~50ms `pm path` via the runner's
   * `check_package` command). Returns false on ANY error so callers treat
   * "couldn't confirm" as "not installed" and fall through to a full install —
   * safer than trusting a cache an emulator wipe may have silently invalidated.
   */
  private static async isPackageOnDevice(
    client: MobileRunnerClient,
    sessionId: string,
    userId: string,
    packageName: string,
  ): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await client.executeBatchCommands(sessionId, [
        { type: 'check_package', params: { packageName } },
      ], { timeoutMs: 10_000, userId }) as any;
      return !!res?.results?.[0]?.data?.installed;
    } catch (err) {
      logger.debug('[MOBILE_APP_PREP] check_package failed (treating as not-installed)', {
        sessionId,
        packageName,
        error: (err as Error).message,
      });
      return false;
    }
  }

  static async prepApp(args: PrepAppArgs): Promise<string | undefined> {
    const {
      client,
      sessionId,
      projectId,
      userId,
      appPackage: appPackageOverrideArg,
      appStoragePathOverride: appStoragePathOverrideArg,
      appOriginalNameOverride: appOriginalNameOverrideArg,
      skipLaunch,
      onProgress,
      platform,
      variantLabel,
    } = args;
    // Mutable so a resolved variant build (below) can fill these in as the
    // install source when the caller didn't pass explicit overrides.
    let appPackageOverride = appPackageOverrideArg;
    let appStoragePathOverride = appStoragePathOverrideArg;
    let appOriginalNameOverride = appOriginalNameOverrideArg;

    // A Flutter(-on-Android) build is delivered AS an Android APK: upload
    // stores it under the `android` slot (mobile-app.service finalize) and the
    // session is created as android (`sessionCreatePlatform`). Resolve AND
    // persist the app metadata against that same slot. Without this, a flutter
    // prep looks up a `flutter` slot that upload never writes → finds nothing →
    // `effectiveStoragePath` stays undefined → install is skipped entirely, so
    // the app is never reinstalled after the emulator is wiped.
    const appSlotPlatform: MobilePlatform | undefined =
      platform === 'flutter' ? 'android' : platform;

    // True once a named variant resolves to a concrete build. Two builds of
    // the same app share a packageName, so the package-presence dedup (Branch
    // 2 below) can't tell 421 from 426 — when a specific build is demanded we
    // must NOT trust package-only presence and have to reinstall the exact APK
    // unless Branch 1 (Redis storagePath match) already confirmed it.
    let exactBuildRequested = false;

    // Effective lane to install, by precedence: explicit pin → the project's
    // default-variant POINTER (the same lane a regression run installs via
    // getProjectDefaultVariant). A 'default'/absent pointer means the base slot,
    // handled by the default-lane read below. This makes editor warmup and
    // regression runs install the SAME build for an "inherit" flow — without
    // this, inherit warmups installed the base slot while regression installed
    // the pointer. The caller-supplied storagePath override (regression worker)
    // short-circuits all of this. Resolver gets the original `platform` so it
    // applies its own flutter→android lane mapping.
    if (platform && !appStoragePathOverride) {
      let effectiveVariant: string | undefined = variantLabel;
      let variantSource = 'explicit';
      if (!effectiveVariant) {
        effectiveVariant = await MobileAppStorageService.getProjectDefaultVariant(projectId, platform);
        variantSource = 'project-default-pointer';
      }
      if (effectiveVariant && effectiveVariant !== DEFAULT_VARIANT_LABEL) {
        const variantBuild = await MobileAppStorageService.resolveAppForRun({
          projectId,
          platform,
          variantLabel: effectiveVariant,
        });
        if (variantBuild?.storagePath) {
          appStoragePathOverride = variantBuild.storagePath;
          appOriginalNameOverride = appOriginalNameOverride ?? variantBuild.originalName;
          appPackageOverride = appPackageOverride ?? variantBuild.packageName;
          exactBuildRequested = true;
          logger.info('[MOBILE_APP_PREP] variant build resolved for install', {
            projectId,
            platform,
            variantLabel: effectiveVariant,
            variantSource,
            buildId: variantBuild.id,
            originalName: variantBuild.originalName,
            packageName: variantBuild.packageName,
            versionCode: variantBuild.versionCode,
            storagePath: variantBuild.storagePath,
          });
        } else {
          logger.warn('[MOBILE_APP_PREP] variant lane has no build, using default lane', {
            projectId,
            platform,
            variantLabel: effectiveVariant,
            variantSource,
          });
        }
      } else if (variantLabel) {
        // Base/default lane, EXPLICITLY pinned (variantLabel === 'default', e.g.
        // the user picked the base build to get off a named variant). Read the
        // LITERAL base SLOT (settings.mobileApps[platform] / legacy), NOT:
        //   - the project read below: getProjectMobileApp WITHOUT a variant
        //     resolves the default-variant POINTER (a named lane here), and
        //   - NOT resolveAppForRun('default'): for flutter its default lane has
        //     no rows, so it falls through to "latest android build" — which is
        //     the newest variant upload, i.e. exactly the build we're escaping.
        // The slot is the original main upload and is left untouched by named-
        // variant uploads, so it's the real base build. Pass the original
        // `platform` so getProjectMobileApp applies its own flutter→android
        // fallback. Force the full install for the same reasons as a variant.
        const proj = await ProjectService.getProject(projectId, userId);
        const baseBuild = getProjectMobileApp(proj?.settings, platform, DEFAULT_VARIANT_LABEL);
        if (baseBuild?.storagePath) {
          appStoragePathOverride = baseBuild.storagePath;
          appOriginalNameOverride = appOriginalNameOverride ?? baseBuild.originalName;
          appPackageOverride = appPackageOverride ?? baseBuild.packageName;
          // Only force the install once we have the REAL base build. If the base
          // slot is empty (project uploaded only named variants), do NOT set
          // exactBuildRequested — otherwise the effectiveStoragePath fallback
          // (the default-variant POINTER build) would be force-installed, i.e.
          // the very build the user pinned 'default' to escape.
          exactBuildRequested = true;
          logger.info('[MOBILE_APP_PREP] base build resolved for explicit default pin', {
            projectId,
            platform,
            originalName: baseBuild.originalName,
            packageName: baseBuild.packageName,
            versionCode: baseBuild.versionCode,
            storagePath: baseBuild.storagePath,
          });
        } else {
          logger.warn('[MOBILE_APP_PREP] explicit default pin but no base build resolved', {
            projectId,
            platform,
          });
        }
      } else {
        logger.debug('[MOBILE_APP_PREP] inherit → base default lane', { projectId, platform });
      }
    }

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

    // Nudge the UI past "boot emulator" as soon as install logic starts.
    emit('installing_app', 35);

    // Load the project's app config. Worker callers usually supply their
    // own storagePath/originalName/packageName via overrides — we still
    // read the project so we can persist a detected packageName back to
    // settings (cache warm for future warmups), and so the editor path is
    // unchanged from the pre-extraction behavior.
    //
    // Multi-platform read: when `platform` is provided, fetch from the
    // sharded `mobileApps[platform]` slot — this is what lets a project
    // with both .apk and .ipa uploaded boot the iOS session against the
    // .ipa instead of accidentally trying to `xcrun simctl install` the
    // .apk that happened to be the most recent upload. When `platform`
    // is undefined we read the legacy singular slot for back-compat with
    // any caller that hasn't been wired through yet.
    const project = await time('project_load', () => ProjectService.getProject(projectId, userId));
    const sharded = appSlotPlatform
      ? getProjectMobileApp(project?.settings, appSlotPlatform)
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacy = (project?.settings as any)?.mobileApp;
    // When the caller specified a platform, the sharded slot is the ONLY
    // valid source. Falling through to `legacy` when sharded is empty
    // would resurrect the cross-platform bug: a project with only an
    // .apk uploaded would have its iOS warmups install the .apk on the
    // simulator, which crashes downstream (`xcrun simctl install` →
    // "Mach error -308" or the new install_app guard in step-dispatcher).
    // For unspecified-platform callers (legacy code paths) we keep the
    // historical behaviour of consulting `mobileApp` directly.
    const projectMobileApp = sharded ?? (appSlotPlatform ? undefined : legacy) ?? {};
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

    // The warm emulator may hold a DIFFERENT build of the SAME package — e.g.
    // the user switched the flow's pinned build (426 → base 421). Redis tracks
    // the installed build's storagePath (per project+user, so it persists even
    // when the runner hands back a different pooled session). When it differs
    // from the build we're about to install, the package-only device dedup
    // (Branch 2) would wrongly keep the stale build — so force a full install.
    // This covers every switch direction (named↔named, named↔base, base↔named),
    // not just the named-variant resolve that sets `exactBuildRequested`.
    const buildMismatch = !!(warmup?.appStoragePath && warmup.appStoragePath !== effectiveStoragePath);
    if (buildMismatch) {
      logger.info('[MOBILE_APP_PREP] installed build differs from target — forcing full install', {
        sessionId,
        projectId,
        installed: warmup?.appStoragePath,
        target: effectiveStoragePath,
      });
    }

    // ── Branch 1: Cached fast-path (Redis hit + same APK) ──────────────
    if (
      !hasPendingInstall
      && !cachedMismatch
      && warmup?.appStoragePath === effectiveStoragePath
      && warmup?.installedPackage
    ) {
      const cachedPackage = appPackageOverride || warmup.installedPackage;
      // The Redis cache can lie after an emulator wipe / factory-reset: it
      // still records the app as installed when the device no longer has it.
      // Confirm on-device (~50ms) before trusting it — otherwise we skip the
      // reinstall and the caller's launch/attach fails on a missing package
      // (the exact symptom when a user cleans their emulator). If it's gone,
      // drop the stale cache and fall through to Branch 2/3 to reinstall.
      const onDevice = await time('branch1_verify', () =>
        this.isPackageOnDevice(client, sessionId, userId, cachedPackage));
      if (onDevice) {
        logger.debug('[MOBILE_APP_PREP] Same APK installed (Redis) and present on device, hard-reset + relaunch', {
          sessionId,
          projectId,
          package: cachedPackage,
          skipLaunch: skipLaunch === true,
        });
        emit('launching_app', 80);
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
          ], { timeoutMs: 60_000, userId }));
        }
        branchTaken = 'cached_fast_path';
        logger.info('[MOBILE_APP_PREP] timing', {
          sessionId, projectId, branch: branchTaken,
          totalMs: Date.now() - prepStart, timings,
        });
        return cachedPackage;
      }
      logger.info('[MOBILE_APP_PREP] Redis cache hit but package missing on device (emulator wiped?) — forcing reinstall', {
        sessionId,
        projectId,
        package: cachedPackage,
      });
      // Drop the stale cache so a retry doesn't re-take this branch.
      await redisConnection.del(redisKey).catch((err) => {
        logger.debug('[MOBILE_APP_PREP] Failed to clear stale warmup key (non-fatal)', {
          error: (err as Error).message,
        });
      });
    }
    if (cachedMismatch) {
      logger.info('[MOBILE_APP_PREP] Cached package differs from override — forcing full install', {
        sessionId,
        projectId,
        cached: warmup?.installedPackage,
        override: appPackageOverride,
      });
    }

    // A demanded exact build (named variant) that Branch 1 didn't confirm:
    // the device may hold a DIFFERENT build of the same package, which the
    // package-only check below cannot detect. Force the full install.
    if (exactBuildRequested) {
      logger.info('[MOBILE_APP_PREP] exact build requested but not confirmed on device — forcing full install (skipping package dedup)', {
        sessionId,
        projectId,
        variantLabel,
        storagePath: effectiveStoragePath,
      });
    }

    // ── Branch 2: Device-check fast-path (Redis expired but APK on device) ──
    // Avoids expensive re-download + re-install when the app is still on
    // the emulator. Skipped when a pending-install flag is set (we don't
    // trust device state in that case) or when an exact build was demanded
    // (package presence ≠ correct build present — see exactBuildRequested).
    const knownPackage = appPackageOverride || projectAny.packageName;
    if (knownPackage && !hasPendingInstall && !exactBuildRequested && !buildMismatch) {
      const isInstalled = await time('branch2_check_package', () =>
        this.isPackageOnDevice(client, sessionId, userId, knownPackage));
      if (isInstalled) {
        logger.info('[MOBILE_APP_PREP] Package still on device (Redis expired), hard-reset + relaunch without reinstall', {
          sessionId,
          projectId,
          package: knownPackage,
          skipLaunch: skipLaunch === true,
        });
        emit('launching_app', 80);
        if (!skipLaunch) {
          // Same hard-reset as the Redis fast path above — keeps the prep
          // contract consistent: every successful prep leaves the app in
          // a freshly-data-wiped state regardless of which install
          // branch fired. Same 60s budget as branch 1.
          await time('branch2_close_launch', () => client.executeBatchCommands(sessionId, [
            { type: 'close_app', params: { packageName: knownPackage, hard: true } },
            { type: 'launch_app', params: { packageName: knownPackage } },
          ], { timeoutMs: 60_000, userId }));
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
        await persistPackageName(projectId, userId, projectMobileApp, knownPackage, appSlotPlatform, project?.settings);

        branchTaken = 'device_check_fast_path';
        logger.info('[MOBILE_APP_PREP] timing', {
          sessionId, projectId, branch: branchTaken,
          totalMs: Date.now() - prepStart, timings,
        });
        return knownPackage;
      }
    }

    // ── Branch 3: Full install (download → upload → install → launch) ──
    logger.info('[MOBILE_APP_PREP] Installing app on session', {
      sessionId,
      projectId,
      originalName: effectiveOriginalName,
      oldPackage: warmup?.installedPackage || '(none)',
    });
    emit('installing_app', 55);

    const fileBuffer = await time('storage_download', () => MobileAppStorageService.downloadApp(effectiveStoragePath));
    const uploaded = await time('runner_upload', () => client.uploadApp(fileBuffer, effectiveOriginalName ?? 'app.apk', { userId }));

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
    ], { timeoutMs: 180_000, userId })) as any;

    // Runner wraps every command result as { success, data, durationMs, ... }.
    // The install handler returns { installed, packageName } inside `data`.
    const detected = installResult?.results?.[0]?.data?.packageName as string | undefined;
    const packageName = explicitPackage || detected;

    // Always issue an explicit launch_app — never rely on install's
    // auto-launch. Gives us one deterministic code path regardless of
    // whether we knew the package name up front. Skipped when caller
    // passes `skipLaunch: true` (autoBootAndInstall pattern).
    if (packageName && !skipLaunch) {
      emit('launching_app', 80);
      // launch_app timeout: 90s. Fresh-install + permission pre-grant + RN/
      // Flutter first-run init can briefly exceed 60s; 90s covers the long
      // tail while still failing-fast half as long as the legacy 180s when
      // the launch is truly stuck.
      await time('runner_launch', () => client.executeBatchCommands(sessionId, [
        { type: 'launch_app', params: { packageName } },
      ], { timeoutMs: 90_000, userId }));
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

    // Persist packageName to project settings so future preps can use
    // the check_package fast path even after Redis TTL expires. With
    // platform passed through, the write goes to mobileApps[platform]
    // (and mirrors to legacy) instead of clobbering the legacy slot.
    if (packageName) {
      await persistPackageName(projectId, userId, projectMobileApp, packageName, appSlotPlatform, project?.settings);
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
 * Write the detected package name back to project settings so subsequent
 * preps (after Redis TTL expiry) can hit the `check_package` fast path
 * instead of re-downloading the binary. No-op when the value is already
 * up to date. Failures are logged but swallowed — this is a cache warm,
 * not a correctness-critical write.
 *
 * Dual-platform note: the write goes through `buildMobileAppSettingsPatch`
 * when the caller knows the platform, so the per-platform shard is
 * updated AND the legacy mirror is kept in sync. The previous
 * implementation wrote ONLY to `settings.mobileApp` (legacy singular),
 * which clobbered the latest-upload semantics — an iOS prep would
 * overwrite the legacy slot with iOS metadata even when the user's most
 * recent action was an Android upload. Callers that don't know the
 * platform (legacy paths) fall back to legacy-only writes.
 */
async function persistPackageName(
  projectId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentMobileApp: any,
  packageName: string,
  platform: MobilePlatform | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentSettings: any,
): Promise<void> {
  if (!packageName || currentMobileApp?.packageName === packageName) return;
  try {
    const updated = { ...currentMobileApp, packageName };
    const settingsPatch = platform
      ? buildMobileAppSettingsPatch(currentSettings, platform, updated)
      : { mobileApp: updated as unknown as Record<string, unknown> };
    await ProjectService.updateProject(projectId, userId, {
      settings: settingsPatch,
    });
    logger.info('[MOBILE_APP_PREP] Persisted packageName to project settings', {
      projectId,
      packageName,
      platform: platform ?? '(unspecified)',
    });
  } catch (err) {
    logger.warn('[MOBILE_APP_PREP] Failed to persist packageName (non-fatal)', {
      projectId,
      packageName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
