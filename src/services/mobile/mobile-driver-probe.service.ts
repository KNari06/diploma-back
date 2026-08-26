/**
 * Mobile Driver-Extension Probe Service
 *
 * Orchestrates the user-triggered "Detect enableFlutterDriverExtension"
 * action exposed in Settings → Mobile App. The actual emulator boot,
 * install, and VM Service log scan live in the runner; this service
 * exists per the layering rule (routes → services → db/) so the
 * controller never reaches into the runner client or storage directly.
 *
 *   1. Refuse if no app is uploaded for the project or the detected
 *      framework is not Flutter.
 *   2. Download the stored APK and push the bytes to the runner the same
 *      way a normal test run does (`uploadApp` → on-disk `apkPath`). The
 *      runner never reaches storage itself.
 *   3. Call the runner's `/api/probe/driver-extension` endpoint with the
 *      `apkPath`.
 *   4. Persist the verdict + timestamp on the probed build's lane so the
 *      UI can render the result across reloads without re-probing.
 */

import { ProjectService } from '@/services/core/project.service';
import { WorkspaceAccessService, PERMISSIONS } from '@/services/core/workspace-access.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import {
  buildDriverVerdictPatch,
  getDefaultVariantLabel,
  getProjectMobileApp,
  variantStoragePlatform,
} from '@/services/mobile/project-mobile-app.helper';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { CI_PUBLISH_LOCK } from '@/config/features/ci-publish-limits';
import { withRedisMutex } from '@/utils/core/redis-mutex';
import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

/**
 * Per-project in-flight lock TTL. The probe boots a real emulator and can
 * run ~2–6 min on a cold device; the TTL must outlive the slowest probe so
 * a concurrent click is rejected for the whole duration, but still expire
 * if the process dies mid-probe (no permanent lock). Released explicitly in
 * `finally` on the normal path.
 */
const PROBE_LOCK_TTL_SEC = 420;

/**
 * Crash ceiling for the verdict write — one read + one settings update, so a
 * couple of seconds in practice. Deliberately far below `CI_PUBLISH_LOCK.ttlSec`
 * (600s, sized for a download+parse): holding a publish lock for ten minutes on
 * behalf of two queries would stall a customer's pipeline.
 */
const VERDICT_WRITE_LOCK_TTL_SEC = 30;

export type DriverExtensionVerdict = 'detected' | 'not_detected' | 'error';

export interface DriverExtensionProbeResponse {
  verdict: DriverExtensionVerdict;
  detail: string;
  vmServiceUrl?: string;
  probedAt: string;
}

/**
 * Which build to probe. Both fields are optional: absent `platform` means
 * Android (the only probeable one), absent `variantLabel` means the lane the
 * project's default-variant pointer names — i.e. the build a run would install.
 */
export interface DriverExtensionProbeTarget {
  platform?: MobilePlatform;
  variantLabel?: string;
}

export class MobileDriverProbeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'MobileDriverProbeError';
  }
}

export const MobileDriverProbeService = {
  /**
   * Run the probe against the project's currently uploaded app. Throws
   * `MobileDriverProbeError` with an explicit HTTP status when the pre-
   * conditions aren't met (no app / not Flutter / project not found /
   * no write access / probe already running). Runner-side failures never
   * throw — they map to `verdict: 'error'`.
   *
   * TIMING / CLIENT TIMEOUT: APK delivery (`uploadApp`) + the runner probe
   * are sequential and can exceed a typical 300s sync request cap (Node
   * `server.requestTimeout`, Cloud Run) on a cold emulator. The verdict is
   * ALWAYS persisted to the probed build's lane (see `persistVerdict`),
   * so even if the client socket resets the result is recoverable via
   * `GET /app` — the frontend hook re-reads it on completion/error. The
   * per-project lock below also prevents a timed-out-but-still-running probe
   * from being re-triggered into a pile-up.
   */
  async probe(
    projectId: string,
    userId: string,
    target: DriverExtensionProbeTarget = {},
  ): Promise<DriverExtensionProbeResponse> {
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      throw new MobileDriverProbeError(404, 'Project not found or access denied');
    }

    // Write-access gate. `getProject` only requires read membership, so
    // without this a `view`-role user could boot an emulator. Booting
    // hardware is a write-class side-effect — require PROJECT_WRITE.
    const canWrite = await WorkspaceAccessService.hasPermission(
      userId,
      project.workspace_id,
      PERMISSIONS.PROJECT_WRITE,
    );
    if (!canWrite) {
      throw new MobileDriverProbeError(403, 'Write access is required to run the driver-extension probe');
    }

    // The probe is Android-only by construction: the runner boots an emulator,
    // installs over ADB and scans logcat for the Dart VM Service line. A Flutter
    // iOS build has no path through that, so refuse it here rather than let it
    // fail deep in the runner as a generic 'error' verdict.
    const requested = target.platform ?? 'android';
    if (variantStoragePlatform(requested) !== 'android') {
      throw new MobileDriverProbeError(
        400,
        'The driver-extension probe runs on an Android emulator — iOS builds cannot be probed.',
      );
    }
    const platform: MobilePlatform = 'android';
    // Resolve the lane ONCE and reuse it for both the read and the verdict
    // write. Letting `getProjectMobileApp` fall back to the pointer internally
    // while persisting under 'default' would stamp a named lane's verdict onto
    // the default lane whenever the pointer isn't the default lane.
    const variantLabel = target.variantLabel?.trim()
      ? target.variantLabel.trim()
      : getDefaultVariantLabel(project.settings, platform);

    // Same resolver a RUN uses, so "verify" and "run" can never disagree about
    // which binary they mean.
    const mobileApp = getProjectMobileApp(project.settings, platform, variantLabel);
    if (!mobileApp || !mobileApp.storagePath) {
      throw new MobileDriverProbeError(400, 'No mobile app uploaded for this build');
    }
    if (!mobileApp.packageName) {
      throw new MobileDriverProbeError(400, 'Stored app metadata has no packageName');
    }

    // Static framework detection runs on every parsed upload. We only
    // refuse here when we *know* the upload isn't Flutter; missing
    // `detectedFramework` (legacy uploads pre-detector) is allowed
    // through so the user can still verify older builds manually.
    if (mobileApp.detectedFramework && mobileApp.detectedFramework !== 'flutter') {
      throw new MobileDriverProbeError(
        400,
        `App is not a Flutter build (detected: ${mobileApp.detectedFramework}). `
        + 'enableFlutterDriverExtension() probe is only meaningful for Flutter apps.',
      );
    }

    const probedStoragePath = mobileApp.storagePath;
    const runner = getMobileRunnerClient();

    // Concurrency guard: the probe boots a real emulator, so unguarded
    // spam-clicks (or a timed-out-but-still-running probe being re-fired)
    // would saturate the runner pool. `SET NX` gives a per-project in-flight
    // lock across API instances; reject the duplicate with 409. Released in
    // `finally`; TTL is a backstop for a crashed process.
    const lockKey = `mobile:probe:lock:${projectId}`;
    const lockAcquired = await redisConnection.set(lockKey, '1', 'EX', PROBE_LOCK_TTL_SEC, 'NX');
    if (!lockAcquired) {
      throw new MobileDriverProbeError(409, 'A driver-extension probe is already running for this project');
    }

    try {
      // Deliver the APK to the runner the same way a normal run does: read
      // the bytes from storage here (the backend has storage access) and
      // push them to the runner's /upload/apk endpoint, which streams them
      // to disk. The runner never fetches storage itself — keeps its
      // network surface identical to the test path and avoids buffering a
      // large download inside the runner process.
      let apkPath: string;
      try {
        const buffer = await MobileAppStorageService.downloadApp(probedStoragePath);
        const originalName = mobileApp.originalName
          || (probedStoragePath.includes('/')
            ? probedStoragePath.slice(probedStoragePath.lastIndexOf('/') + 1)
            : probedStoragePath)
          || 'app.apk';
        const uploaded = await runner.uploadApp(buffer, originalName, { userId });
        apkPath = uploaded.path;
      } catch (err) {
        // Download or runner-upload failed — surface as a structured
        // 'error' verdict, same as a runner-unreachable failure below.
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn('[DRIVER_PROBE] apk delivery failed', { projectId, detail });
        const errorVerdict: DriverExtensionProbeResponse = {
          verdict: 'error',
          detail: `failed to deliver app to runner: ${detail}`,
          probedAt: new Date().toISOString(),
        };
        await persistVerdict(projectId, userId, platform, variantLabel, probedStoragePath, errorVerdict);
        return errorVerdict;
      }

      let runnerResult: { detected: boolean; vmServiceUrl?: string; detail: string };
      try {
        runnerResult = await runner.probeFlutterDriverExtension(
          { packageName: mobileApp.packageName, apkPath },
          { userId },
        );
      } catch (err) {
        // Runner round-trip failed (network, 5xx, timeout). Surface this
        // as `verdict: 'error'` instead of bubbling — the UI prefers a
        // structured verdict to a thrown error so the button can show a
        // grey "unreachable" badge rather than a red toast.
        const detail = err instanceof Error ? err.message : String(err);
        logger.warn('[DRIVER_PROBE] runner unreachable', { projectId, detail });
        const errorVerdict: DriverExtensionProbeResponse = {
          verdict: 'error',
          detail: `runner unreachable: ${detail}`,
          probedAt: new Date().toISOString(),
        };
        await persistVerdict(projectId, userId, platform, variantLabel, probedStoragePath, errorVerdict);
        return errorVerdict;
      }

      const verdict: DriverExtensionVerdict = runnerResult.detected ? 'detected' : 'not_detected';
      const response: DriverExtensionProbeResponse = {
        verdict,
        detail: runnerResult.detail,
        vmServiceUrl: runnerResult.vmServiceUrl,
        probedAt: new Date().toISOString(),
      };

      await persistVerdict(projectId, userId, platform, variantLabel, probedStoragePath, response);

      logger.info('[DRIVER_PROBE] complete', {
        projectId,
        packageName: mobileApp.packageName,
        verdict,
      });
      return response;
    } finally {
      await redisConnection.del(lockKey).catch(() => {});
    }
  },
};

/**
 * Stamp the probe result onto the PROBED LANE's latest build — the default
 * lane also updates the legacy/shard mirror, a named lane only its registry
 * entry (`buildDriverVerdictPatch` owns those rules).
 *
 * Re-reads the project immediately before writing and merges onto the CURRENT
 * lane contents — not the snapshot taken when the probe started (up to ~240 s
 * earlier). If a re-upload swapped that lane's build mid-probe, the patch
 * builder returns null and we skip the write rather than label a new binary
 * with an old build's verdict.
 *
 * Best-effort — a write failure must not turn the probe into a 5xx
 * (the user already got the verdict). Logged at warn, never re-thrown.
 */
async function persistVerdict(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
  variantLabel: string,
  probedStoragePath: string,
  result: DriverExtensionProbeResponse,
): Promise<void> {
  try {
    // Same per-project lock a CI publish takes. This patch rebuilds the whole
    // `mobileAppVariants` map from a snapshot, and `updateProject` merges
    // settings SHALLOWLY — so a finalize landing between our read and our write
    // loses its lane entry, and that lane then resolves to the wrong binary
    // with nothing in the logs (see api/mobile/CLAUDE.md, invariant 6). Our
    // window is milliseconds rather than finalize's 13-26s, which makes this
    // unlikely, not safe.
    //
    // A busy lock means a publish is mid-flight: skip the verdict write rather
    // than queue behind a 26s parse. The probe already returned the verdict to
    // the caller, and a publish in flight is about to replace this build anyway.
    const outcome = await withRedisMutex(
      {
        key: `${CI_PUBLISH_LOCK.prefix}${projectId}`,
        ttlSec: VERDICT_WRITE_LOCK_TTL_SEC,
        logTag: 'DRIVER_PROBE',
      },
      () => writeVerdict(projectId, userId, platform, variantLabel, probedStoragePath, result),
    );
    if (!outcome.acquired) {
      logger.info('[DRIVER_PROBE] settings busy — skipping verdict write', {
        projectId,
        variantLabel,
        retryAfterSec: outcome.retryAfterSec,
      });
    }
  } catch (err) {
    logger.warn('[DRIVER_PROBE] failed to persist verdict (non-fatal)', {
      projectId,
      variantLabel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The read-modify-write itself. Runs under the per-project settings lock. */
async function writeVerdict(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
  variantLabel: string,
  probedStoragePath: string,
  result: DriverExtensionProbeResponse,
): Promise<void> {
  const project = await ProjectService.getProject(projectId, userId);
  const patch = buildDriverVerdictPatch(
    project?.settings,
    platform,
    variantLabel,
    probedStoragePath,
    {
      driverExtensionDetected: result.verdict,
      driverExtensionDetail: result.detail,
      driverExtensionDetectedAt: result.probedAt,
    },
  );
  if (!patch) {
    logger.info('[DRIVER_PROBE] build changed during probe — skipping stale verdict write', {
      projectId,
      platform,
      variantLabel,
      probedStoragePath,
    });
    return;
  }
  await ProjectService.updateProject(projectId, userId, { settings: patch });
}
