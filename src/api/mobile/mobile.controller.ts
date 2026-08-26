/**
 * Mobile API Controller — thin HTTP layer.
 *
 * Handlers ONLY:
 *   1. Parse + validate the request (via `mobile-request.helpers.ts`).
 *   2. Delegate to `mobile-app.service.ts`.
 *   3. Translate the result into an HTTP response (via `mobile-error-mapper.ts`).
 *   4. Kick off fire-and-forget side-effects (auto-boot, prune) that
 *      must NOT block the response.
 *
 * Business logic — version-identity waterfall, storage-path validation,
 * per-platform shard merging, build recording — lives in
 * `src/services/mobile/mobile-app.service.ts` and is unit-tested without
 * Express coupling.
 */

import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

import * as MobileAppService from '@/services/mobile/mobile-app.service';
import * as MobileAppVariantService from '@/services/mobile/mobile-app-variant.service';
import { MobileAppStorageService, trimMobileBuildField } from '@/services/storage/mobile-app-storage.service';
import { VALID_PERMISSION_POLICIES } from '@/services/mobile/permission-policy.service';
import {
  MobileDriverProbeService,
  MobileDriverProbeError,
} from '@/services/mobile/mobile-driver-probe.service';

import {
  parseContentLength,
  parseVersionCode,
  pickPlatform,
  pickPlatformOrUndefined,
  requireUserId,
  trimmedString,
} from './mobile-request.helpers';
import { sendMobileAppError } from './mobile-error-mapper';
import { autoBootAndInstall } from './session.controller';

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD APP — signed-URL flow
// ═══════════════════════════════════════════════════════════════════════════
//
// The backend never touches the APK/IPA buffer:
//   1. POST .../app/upload-url  → tiny JSON, returns a Supabase signed URL.
//   2. PUT  <signed URL>        → client streams directly to Supabase Storage.
//   3. POST .../app/finalize    → validates the object exists and persists
//                                 metadata.
// This bypasses Cloud Run's 32 MiB request-body cap.

/** POST /api/v1/mobile/projects/:projectId/app/upload-url */
export async function createMobileAppUploadUrl(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { projectId } = req.params;
  const filename = trimmedString(req.body?.filename);
  if (!filename) {
    res.status(400).json({ success: false, error: 'filename is required (non-empty string)' });
    return;
  }

  const result = await MobileAppService.createMobileAppUploadUrl({
    projectId,
    userId,
    filename,
    platform: pickPlatform(req.body?.platform),
    declaredSize: parseContentLength(req.body?.contentLength),
    variantLabel: trimmedString(req.body?.variant),
  });

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({
    success: true,
    uploadUrl: result.uploadUrl,
    token: result.token,
    storagePath: result.storagePath,
    // Provider-specific PUT headers. The web client currently derives these by
    // sniffing the URL hostname; it can switch to this and stop guessing.
    requiredHeaders: result.requiredHeaders,
  });
}

/**
 * POST /api/v1/mobile/projects/:projectId/app/finalize
 *
 * The version-identity waterfall (client → parsed → timestamp fallback)
 * + build recording + per-platform shard merge live in the service.
 * This handler only parses the body and dispatches fire-and-forget
 * side-effects after responding.
 */
export async function finalizeMobileAppUpload(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { projectId } = req.params;
  const storagePath = trimmedString(req.body?.storagePath);
  if (!storagePath) {
    res.status(400).json({ success: false, error: 'storagePath is required (non-empty string)' });
    return;
  }

  const platform = pickPlatform(req.body?.platform);
  const originalName = trimmedString(req.body?.originalName)
    ?? (storagePath.includes('/') ? storagePath.slice(storagePath.lastIndexOf('/') + 1) : storagePath);

  const result = await MobileAppService.finalizeMobileAppUpload({
    projectId,
    userId,
    storagePath,
    platform,
    originalName,
    clientPackageName: trimmedString(req.body?.packageName),
    clientVersionName: trimmedString(req.body?.versionName),
    clientVersionCode: parseVersionCode(req.body?.versionCode),
    branch: trimMobileBuildField(req.body?.branch),
    commitSha: trimMobileBuildField(req.body?.commitSha),
    buildNumber: trimMobileBuildField(req.body?.buildNumber),
    ciRunId: trimMobileBuildField(req.body?.ciRunId),
    variantLabel: trimmedString(req.body?.variant),
  });

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.status(201).json({
    success: true,
    mobileApp: result.mobileApp,
    build: result.build,
    variant: result.variantLabel,
  });

  // Fire-and-forget side-effects — must not block the response. Prune the
  // SAME variant lane the build landed in (lanes prune independently).
  MobileAppStorageService.pruneOldBuilds(projectId, result.platform, result.variantLabel).catch((err) => {
    logger.warn('[MOBILE_API] pruneOldBuilds failed (non-fatal)', {
      projectId,
      platform: result.platform,
      variant: result.variantLabel,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  autoBootAndInstall(projectId, userId, result.platform).catch((err) => {
    logger.warn('[MOBILE_API] Background auto-boot failed (non-fatal)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET APP INFO
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/v1/mobile/projects/:projectId/app[?platform=ios] */
export async function getMobileApp(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const result = await MobileAppService.getMobileApp(
    req.params.projectId,
    userId,
    pickPlatformOrUndefined(req.query.platform),
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({
    success: true,
    mobileApp: result.mobileApp,
    ...(result.mobileApps ? { mobileApps: result.mobileApps } : {}),
    ...(result.variants ? { variants: result.variants } : {}),
    ...(result.defaultVariant ? { defaultVariant: result.defaultVariant } : {}),
    maxVariants: result.maxVariants,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PROBE FLUTTER DRIVER EXTENSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/projects/:projectId/app/probe-driver-extension
 *
 * User-triggered probe: ask the runner to verify whether the stored
 * Flutter APK actually wires up `enableFlutterDriverExtension()`.
 * Thin controller — all logic in `MobileDriverProbeService`.
 */
export async function probeDriverExtension(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { projectId } = req.params;
  try {
    const result = await MobileDriverProbeService.probe(projectId, userId, {
      platform: pickPlatformOrUndefined((req.query.platform as string) || req.body?.platform),
      variantLabel: trimmedString(req.body?.variant),
    });
    res.json({ success: true, result });
  } catch (err) {
    if (err instanceof MobileDriverProbeError) {
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }
    logger.error('[MOBILE_API] driver-extension probe failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Driver-extension probe failed' });
  }
}

/** GET /api/v1/mobile/projects/:projectId/builds?platform=android&limit=20 */
export async function listMobileAppBuilds(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 200);
  const result = await MobileAppService.listMobileAppBuilds(
    req.params.projectId,
    userId,
    pickPlatform(req.query.platform),
    limit,
    trimmedString(req.query.variant),
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, builds: result.builds });
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH APP (packageName only)
// ═══════════════════════════════════════════════════════════════════════════

/** PATCH /api/v1/mobile/projects/:projectId/app  Body: { packageName, platform? } */
export async function patchMobileApp(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const packageName = trimmedString(req.body?.packageName);
  if (!packageName) {
    res.status(400).json({ success: false, error: 'packageName is required (non-empty string)' });
    return;
  }

  const result = await MobileAppService.patchMobileAppPackageName(
    req.params.projectId,
    userId,
    packageName,
    pickPlatformOrUndefined((req.query.platform as string) || req.body?.platform),
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, mobileApp: result.mobileApp });
}

// ═══════════════════════════════════════════════════════════════════════════
// VARIANT MANAGEMENT (named lanes)
// ═══════════════════════════════════════════════════════════════════════════

/** DELETE /api/v1/mobile/projects/:projectId/app/variants/:label?platform=android */
export async function deleteMobileAppVariant(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const result = await MobileAppVariantService.deleteMobileAppVariant(
    req.params.projectId,
    userId,
    pickPlatform(req.query.platform),
    req.params.label,
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, deletedBuilds: result.deletedBuilds });
}

/** PATCH /api/v1/mobile/projects/:projectId/app/variants/:label  Body: { name, platform? } */
export async function renameMobileAppVariant(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const name = trimmedString(req.body?.name);
  if (!name) {
    res.status(400).json({ success: false, error: 'name is required (non-empty string)' });
    return;
  }

  const result = await MobileAppVariantService.renameMobileAppVariant(
    req.params.projectId,
    userId,
    pickPlatform((req.query.platform as string) || req.body?.platform),
    req.params.label,
    name,
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, variant: result.label, renamedBuilds: result.renamedBuilds });
}

/** PUT /api/v1/mobile/projects/:projectId/app/variants/:label/default  Body/query: { platform } */
export async function setDefaultMobileAppVariant(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const result = await MobileAppVariantService.setDefaultMobileVariant(
    req.params.projectId,
    userId,
    pickPlatform((req.query.platform as string) || req.body?.platform),
    req.params.label,
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, defaultVariant: result.defaultVariant });
}

/**
 * PUT /api/v1/mobile/projects/:projectId/app/flutter-host  Body: { host: 'android'|'ios' }
 *
 * Persists the editor's Flutter host toggle as the PROJECT default
 * (`settings.flutterDefaultHost`) so non-editor runs (regression /
 * scheduled / CI) target the same host. Per-test-case `host_platform`
 * overrides still win at dispatch time.
 */
export async function setFlutterDefaultHost(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const result = await MobileAppService.setFlutterDefaultHost(
    req.params.projectId,
    userId,
    req.body?.host,
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, flutterDefaultHost: result.flutterDefaultHost });
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE APP
// ═══════════════════════════════════════════════════════════════════════════

/** DELETE /api/v1/mobile/projects/:projectId/app[?platform=ios] */
export async function deleteMobileApp(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const result = await MobileAppService.deleteMobileApp(
    req.params.projectId,
    userId,
    pickPlatformOrUndefined(req.query.platform),
  );

  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }

  res.json({ success: true, message: result.message });
}

// ═══════════════════════════════════════════════════════════════════════════
// PERMISSION POLICY  (project-level default)
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/v1/mobile/projects/:projectId/permission-policy */
export async function getProjectPermissionPolicy(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const result = await MobileAppService.getProjectPermissionPolicy(req.params.projectId, userId);
  if ('kind' in result) {
    // Original wording for this endpoint was the shorter "Project not found"
    // (without "or access denied"). Preserve it — clients may match the string.
    if (result.kind === 'project_not_found') {
      res.status(404).json({ success: false, error: 'Project not found' });
      return;
    }
    sendMobileAppError(res, result);
    return;
  }
  res.json({ success: true, policy: result.policy });
}

/** PUT /api/v1/mobile/projects/:projectId/permission-policy  Body: { policy } */
export async function setProjectPermissionPolicy(req: Request, res: Response): Promise<void> {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const { policy } = req.body ?? {};
  if (!MobileAppService.isValidPermissionPolicy(policy)) {
    res.status(400).json({
      success: false,
      error: `policy must be one of: ${VALID_PERMISSION_POLICIES.join(', ')}`,
    });
    return;
  }

  const result = await MobileAppService.setProjectPermissionPolicy(req.params.projectId, userId, policy);
  if ('kind' in result) {
    sendMobileAppError(res, result);
    return;
  }
  res.json({ success: true, policy: result.policy });
}
