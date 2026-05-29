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
 *   4. Persist the verdict + timestamp on `projects.settings.mobileApp`
 *      so the UI can render the result across reloads without re-probing.
 */

import { ProjectService } from '@/services/core/project.service';
import { MobileAppStorageService, type MobileAppMetadata } from '@/services/storage/mobile-app-storage.service';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { logger } from '@/utils/core/logger';

export type DriverExtensionVerdict = 'detected' | 'not_detected' | 'error';

export interface DriverExtensionProbeResponse {
  verdict: DriverExtensionVerdict;
  detail: string;
  vmServiceUrl?: string;
  probedAt: string;
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
   * conditions aren't met (no app / not Flutter / project not found).
   * Runner-side failures never throw — they map to `verdict: 'error'`.
   */
  async probe(projectId: string, userId: string): Promise<DriverExtensionProbeResponse> {
    const project = await ProjectService.getProject(projectId, userId);
    if (!project) {
      throw new MobileDriverProbeError(404, 'Project not found or access denied');
    }

    const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;
    if (!mobileApp || !mobileApp.storagePath) {
      throw new MobileDriverProbeError(400, 'No mobile app uploaded for this project');
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
      await persistVerdict(projectId, userId, probedStoragePath, errorVerdict);
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
      await persistVerdict(projectId, userId, probedStoragePath, errorVerdict);
      return errorVerdict;
    }

    const verdict: DriverExtensionVerdict = runnerResult.detected ? 'detected' : 'not_detected';
    const response: DriverExtensionProbeResponse = {
      verdict,
      detail: runnerResult.detail,
      vmServiceUrl: runnerResult.vmServiceUrl,
      probedAt: new Date().toISOString(),
    };

    await persistVerdict(projectId, userId, probedStoragePath, response);

    logger.info('[DRIVER_PROBE] complete', {
      projectId,
      packageName: mobileApp.packageName,
      verdict,
    });
    return response;
  },
};

/**
 * Stamp the probe result onto the legacy JSONB slot. We write into the
 * same path `finalizeMobileAppUpload` uses (`settings.mobileApp`) so
 * `GET /app` keeps returning it without any extra plumbing.
 *
 * Re-reads the project immediately before writing and merges the verdict
 * onto the CURRENT `mobileApp` — not the snapshot taken when the probe
 * started (up to ~240 s earlier). If a re-upload swapped the build mid-
 * probe (`storagePath` changed), the verdict no longer applies, so we
 * skip the write rather than clobber the new build with stale metadata.
 *
 * Best-effort — a write failure must not turn the probe into a 5xx
 * (the user already got the verdict). Logged at warn, never re-thrown.
 */
async function persistVerdict(
  projectId: string,
  userId: string,
  probedStoragePath: string,
  result: DriverExtensionProbeResponse,
): Promise<void> {
  try {
    const project = await ProjectService.getProject(projectId, userId);
    const currentApp = project?.settings?.mobileApp as MobileAppMetadata | undefined;
    if (!currentApp || currentApp.storagePath !== probedStoragePath) {
      logger.info('[DRIVER_PROBE] build changed during probe — skipping stale verdict write', {
        projectId,
        probedStoragePath,
        currentStoragePath: currentApp?.storagePath ?? null,
      });
      return;
    }
    const updated: MobileAppMetadata = {
      ...currentApp,
      driverExtensionDetected: result.verdict,
      driverExtensionDetail: result.detail,
      driverExtensionDetectedAt: result.probedAt,
    };
    await ProjectService.updateProject(projectId, userId, {
      settings: {
        mobileApp: updated as unknown as Record<string, unknown>,
      },
    });
  } catch (err) {
    logger.warn('[DRIVER_PROBE] failed to persist verdict (non-fatal)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
