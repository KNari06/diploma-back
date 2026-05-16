/**
 * Mobile API Controller
 *
 * Handles mobile app management: upload APK/IPA, get app info, delete app.
 * APK/IPA is stored at project-level in Supabase Storage + project.settings.mobileApp.
 */

import { ProjectService } from '@/services/core/project.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import {
  MobileAppStorageService,
  MobileAppMetadata,
  trimMobileBuildField,
} from '@/services/storage/mobile-app-storage.service';
import { autoBootAndInstall } from './session.controller';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD APP — signed-URL flow
// ═══════════════════════════════════════════════════════════════════════════
//
// The backend never touches the APK/IPA buffer: it issues a one-time
// Supabase signed URL, the client PUTs the binary directly to Storage,
// then calls /finalize to persist metadata. This bypasses Cloud Run's
// hard 32 MiB request-body limit which previously made any APK >30 MB
// fail with 413 from Google Frontend.
//
//   1. POST .../app/upload-url   → tiny JSON, returns a Supabase signed URL
//   2. PUT  <signed URL>         → client streams the APK/IPA directly to
//                                  Supabase Storage, no backend in the path
//   3. POST .../app/finalize     → tiny JSON, validates the object exists
//                                  and writes project.settings.mobileApp

const MAX_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500MB — mirrors multer
const ALLOWED_UPLOAD_EXTENSIONS = ['.apk', '.ipa', '.aab'];

function pickPlatform(raw: unknown): MobilePlatform {
  const VALID: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  if (typeof raw === 'string' && VALID[raw]) return VALID[raw];
  return 'android';
}

/**
 * POST /api/v1/mobile/projects/:projectId/app/upload-url
 *
 * Body: { filename, platform?, contentLength? }
 *   - filename       (required) — must end with .apk / .ipa / .aab.
 *   - platform       (optional) — 'android' | 'ios' | 'flutter'.
 *   - contentLength  (optional) — declared file size in bytes; rejected
 *                                 client-side if >500 MB so we don't issue
 *                                 a signed URL for an upload that will fail.
 *
 * Returns: { uploadUrl, token, storagePath, expiresIn }
 *
 * The client then issues `PUT uploadUrl` with the file body. The signed URL
 * is one-time-use and expires in ~2h on Supabase's side (server-set, not
 * configurable from the SDK).
 */
export async function createMobileAppUploadUrl(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
  const platform = pickPlatform(req.body?.platform);
  const contentLengthRaw = req.body?.contentLength;
  const contentLength = typeof contentLengthRaw === 'number'
    ? contentLengthRaw
    : (typeof contentLengthRaw === 'string' && /^\d+$/.test(contentLengthRaw)
      ? Number(contentLengthRaw)
      : null);

  if (!filename) {
    res.status(400).json({ success: false, error: 'filename is required (non-empty string)' });
    return;
  }
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
    res.status(400).json({
      success: false,
      error: `Invalid file type: ${ext || '(none)'}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
    });
    return;
  }
  if (contentLength !== null && contentLength > MAX_UPLOAD_SIZE_BYTES) {
    res.status(413).json({
      success: false,
      error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB, declared ${(contentLength / 1024 / 1024).toFixed(1)}MB`,
    });
    return;
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const signed = await MobileAppStorageService.createSignedUploadUrl({
    workspaceId: project.workspace_id,
    projectId,
    platform,
    originalName: filename,
  });

  logger.info('[MOBILE_API] Issued signed upload URL', {
    projectId,
    platform,
    storagePath: signed.storagePath,
    declaredSize: contentLength,
    userId,
  });

  res.json({
    success: true,
    uploadUrl: signed.uploadUrl,
    token: signed.token,
    storagePath: signed.storagePath,
  });
}

/**
 * POST /api/v1/mobile/projects/:projectId/app/finalize
 *
 * Body: { storagePath, packageName, platform?, originalName?, branch?,
 *         commitSha?, buildNumber?, ciRunId? }
 *
 * Called after the client has finished `PUT`ing the file to Supabase. The
 * handler verifies the object exists, then runs the same post-upload work
 * the legacy multipart route does: delete previous APK, write
 * `projects.settings.mobileApp`, optionally insert a versioned build row,
 * kick off `autoBootAndInstall`.
 *
 * Mirrors the shape of `projects.settings.mobileApp` written by the old
 * multipart upload path so downstream consumers (resolver, runner) stay
 * identical.
 */
export async function finalizeMobileAppUpload(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const storagePath = typeof req.body?.storagePath === 'string' ? req.body.storagePath.trim() : '';
  const packageName = typeof req.body?.packageName === 'string' ? req.body.packageName.trim() : '';
  const platform = pickPlatform(req.body?.platform);
  const originalName = typeof req.body?.originalName === 'string' && req.body.originalName.trim()
    ? req.body.originalName.trim()
    : (storagePath.includes('/') ? storagePath.slice(storagePath.lastIndexOf('/') + 1) : storagePath);

  const branch = trimMobileBuildField(req.body?.branch);
  const commitSha = trimMobileBuildField(req.body?.commitSha);
  const buildNumber = trimMobileBuildField(req.body?.buildNumber);
  const ciRunId = trimMobileBuildField(req.body?.ciRunId);
  const hasBuildMeta = !!(branch || commitSha || buildNumber || ciRunId);

  if (!storagePath) {
    res.status(400).json({ success: false, error: 'storagePath is required (non-empty string)' });
    return;
  }
  if (!packageName) {
    res.status(400).json({
      success: false,
      error: 'packageName is required (non-empty string). Android: package id (com.example.app); iOS: bundle ID.',
    });
    return;
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  // Defence in depth: refuse paths that don't belong to this project's tree.
  // The signed-url issuer always builds paths under
  // `mobile-apps/{workspaceId}/{projectId}/{platform}/…`, so a request that
  // doesn't match means the client tampered with the storagePath.
  const expectedPrefix = `mobile-apps/${project.workspace_id}/${projectId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    logger.warn('[MOBILE_API] finalize rejected — path outside project tree', {
      projectId,
      storagePath,
      expectedPrefix,
      userId,
    });
    res.status(400).json({ success: false, error: 'storagePath does not belong to this project' });
    return;
  }

  // Verify the object is actually present and not empty.
  const stat = await MobileAppStorageService.statObject(storagePath);
  if (!stat) {
    res.status(404).json({
      success: false,
      error: 'Object not found at storagePath — was the PUT to the upload URL successful?',
    });
    return;
  }
  if (stat.sizeBytes === 0) {
    res.status(400).json({ success: false, error: 'Uploaded object is empty (0 bytes)' });
    return;
  }
  if (stat.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    // Should never happen — Supabase per-file limit is set at the bucket —
    // but if a bucket-side limit lets a huge file through we still refuse.
    res.status(413).json({
      success: false,
      error: `Uploaded file too large (${(stat.sizeBytes / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024} MB.`,
    });
    return;
  }

  // Delete previous APK from storage (legacy slot only — versioned builds
  // are immutable history).
  const existingApp = project.settings?.mobileApp as MobileAppMetadata | undefined;
  if (existingApp?.storagePath && existingApp.storagePath !== storagePath) {
    logger.info('[MOBILE_API] Deleting previous app (finalize)', {
      projectId,
      oldStoragePath: existingApp.storagePath,
    });
    await MobileAppStorageService.deleteApp(existingApp.storagePath);
  }

  const metadata = MobileAppStorageService.finaliseDirectUpload({
    workspaceId: project.workspace_id,
    projectId,
    platform,
    packageName,
    storagePath,
    originalName,
    fileSize: stat.sizeBytes,
  });

  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: metadata as unknown as Record<string, unknown>,
    },
  });

  if (hasBuildMeta) {
    await MobileAppStorageService.recordBuild(
      metadata,
      { branch, commitSha, buildNumber, ciRunId, source: 'manual' },
      { projectId, workspaceId: project.workspace_id, uploadedBy: userId },
    );
  }

  logger.info('[MOBILE_API] App finalized (signed-URL flow)', {
    projectId,
    platform,
    storagePath: metadata.storagePath,
    fileSize: metadata.fileSize,
    versioned: hasBuildMeta,
  });

  res.status(201).json({
    success: true,
    mobileApp: metadata,
  });

  // Auto-boot emulator + install APK in background — same fire-and-forget
  // contract as the legacy upload route.
  autoBootAndInstall(projectId, userId, platform).catch((err) => {
    logger.warn('[MOBILE_API] Background auto-boot failed (non-fatal)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET APP INFO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/projects/:projectId/app
 *
 * Get current mobile app metadata for a project.
 */
export async function getMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;

  if (!mobileApp) {
    res.json({ success: true, mobileApp: null });
    return;
  }

  res.json({ success: true, mobileApp });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST APP BUILD HISTORY (Phase 5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/projects/:projectId/builds?platform=android&limit=20
 *
 * Return recent versioned builds for the project (table: `mobile_app_builds`).
 * Separate from `GET /app` which still returns only the legacy single-entry
 * metadata. Used by the frontend to show build history (branch, commitSha,
 * uploadedAt, source) and to pick a specific build for a pinned run.
 */
export async function listMobileAppBuilds(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const rawPlatform = (req.query.platform as string) || 'android';
  const VALID: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  const platform: MobilePlatform = VALID[rawPlatform] ?? 'android';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 200);

  // Verify project access — same pattern as getMobileApp.
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const builds = await MobileAppStorageService.listBuilds(projectId, platform, limit);
  res.json({ success: true, builds });
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH APP (packageName only)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PATCH /api/v1/mobile/projects/:projectId/app
 * Body: { packageName: string }
 *
 * Update ONLY the packageName on the already-uploaded `projects.settings.mobileApp`
 * blob. Use case: APK was uploaded before the packageName input was required, so
 * the legacy slot has packageName: undefined. Re-uploading the APK just to set
 * one string is wasteful when the binary itself is fine.
 *
 * Does NOT touch versioned `mobile_app_builds` rows — those are immutable
 * history. The editor's warm-up reads from the legacy slot, so patching it
 * here is enough to unblock the flow.
 */
export async function patchMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const rawPackageName = req.body?.packageName;
  const packageName = typeof rawPackageName === 'string' ? rawPackageName.trim() : '';
  if (!packageName) {
    res.status(400).json({ success: false, error: 'packageName is required (non-empty string)' });
    return;
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const existing = project.settings?.mobileApp as MobileAppMetadata | undefined;
  if (!existing) {
    res.status(404).json({
      success: false,
      error: 'No uploaded app to update — upload an APK/IPA first',
    });
    return;
  }

  const updated: MobileAppMetadata = { ...existing, packageName };

  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: updated as unknown as Record<string, unknown>,
    },
  });

  logger.info('[MOBILE_API] App packageName updated', { projectId, packageName });

  res.json({ success: true, mobileApp: updated });
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE APP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/mobile/projects/:projectId/app
 *
 * Delete mobile app from storage and clear project settings.
 */
export async function deleteMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;

  if (!mobileApp) {
    res.json({ success: true, message: 'No app to delete' });
    return;
  }

  // Delete from storage
  await MobileAppStorageService.deleteApp(mobileApp.storagePath);

  // Clear from project settings
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: null,
    },
  });

  logger.info('[MOBILE_API] App deleted', {
    projectId,
    storagePath: mobileApp.storagePath,
  });

  res.json({ success: true, message: 'App deleted' });
}

// ═══════════════════════════════════════════════════════════════════════════
// PERMISSION POLICY  (project-level default)
// ═══════════════════════════════════════════════════════════════════════════
//
// Type + validator live in `services/mobile/permission-policy.service.ts` —
// this file used to duplicate them, which made it easy for the shared
// service and the HTTP handlers to drift (e.g. add 'prompt' to the union
// in one place but not the other). Single source of truth now.

import {
  VALID_PERMISSION_POLICIES,
  type MobilePermissionPolicy,
} from '@/services/mobile/permission-policy.service';

function isValidPolicy(value: unknown): value is MobilePermissionPolicy {
  return typeof value === 'string'
    && (VALID_PERMISSION_POLICIES as readonly string[]).includes(value);
}

/**
 * GET /api/v1/mobile/projects/:projectId/permission-policy
 *
 * Returns the project-level default permission policy. Individual tests
 * may override it via their own settings; unset tests inherit this value.
 * Defaults to 'auto_allow' when nothing is stored yet.
 */
export async function getProjectPermissionPolicy(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const { projectId } = req.params;
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found' });
    return;
  }
  const stored = project.settings?.mobilePermissionPolicy;
  const policy: MobilePermissionPolicy = isValidPolicy(stored) ? stored : 'auto_allow';
  res.json({ success: true, policy });
}

/**
 * PUT /api/v1/mobile/projects/:projectId/permission-policy
 * Body: { policy: 'auto_allow' | 'auto_deny' | 'manual' }
 *
 * Updates the project-level default. Persisted at
 * `project.settings.mobilePermissionPolicy`.
 */
export async function setProjectPermissionPolicy(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const { projectId } = req.params;
  const { policy } = req.body ?? {};
  if (!isValidPolicy(policy)) {
    res.status(400).json({
      success: false,
      error: `policy must be one of: ${VALID_PERMISSION_POLICIES.join(', ')}`,
    });
    return;
  }
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobilePermissionPolicy: policy,
    },
  });
  logger.info('[MOBILE_API] Permission policy updated', { projectId, policy });
  res.json({ success: true, policy });
}
