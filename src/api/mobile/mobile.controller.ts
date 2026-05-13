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
// UPLOAD APP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/projects/:projectId/app
 *
 * Upload APK/IPA for a project. Replaces previous upload if exists.
 * Body: multipart/form-data
 *   - `file` (required)          — APK / IPA / AAB.
 *   - `platform` (optional)      — 'android' | 'ios' | 'flutter', default 'android'.
 *   - `packageName` (optional)   — Android package id.
 *   - `branch` (optional)        — Phase 5: git branch this build was produced from.
 *   - `commitSha` (optional)     — Phase 5: exact commit. Pins the build for a run.
 *   - `buildNumber` (optional)   — Phase 5: CI build id / job number.
 *   - `ciRunId` (optional)       — Phase 5: CI run reference for audit.
 *
 * When any git metadata is provided, a row is ALSO inserted into
 * `mobile_app_builds` for branch / commit lookup. The legacy
 * `projects.settings.mobileApp` slot is always updated so existing
 * single-build consumers keep working unchanged.
 */
export async function uploadMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const raw = req.body.platform as string | undefined;
  const VALID: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  const platform: MobilePlatform = raw && VALID[raw] ? VALID[raw] : 'android';
  // packageName is REQUIRED — the runner needs it to install + launch the app.
  // The UI form validates this too, but we enforce server-side as well so
  // CI uploads / direct API calls can't bypass it (previously could land
  // with packageName: undefined and block the editor at warm-up time).
  const packageNameRaw = req.body.packageName as string | undefined;
  const packageName = typeof packageNameRaw === 'string' ? packageNameRaw.trim() : '';

  // Phase 5: optional git metadata — trimmed, empty strings treated as absent.
  // Shared normaliser keeps this parsing consistent with the CI path.
  const branch = trimMobileBuildField(req.body.branch);
  const commitSha = trimMobileBuildField(req.body.commitSha);
  const buildNumber = trimMobileBuildField(req.body.buildNumber);
  const ciRunId = trimMobileBuildField(req.body.ciRunId);
  const hasBuildMeta = !!(branch || commitSha || buildNumber || ciRunId);

  if (!req.file) {
    res.status(400).json({ success: false, error: 'No file uploaded. Use form field "file".' });
    return;
  }

  if (!packageName) {
    res.status(400).json({
      success: false,
      error: 'packageName is required (non-empty string). Android: package id (com.example.app); iOS: bundle ID.',
    });
    return;
  }

  // Verify project access
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  logger.info('[MOBILE_API] Uploading app', {
    projectId,
    platform,
    packageName,
    originalName: req.file.originalname,
    size: req.file.size,
    userId,
    branch,
    commitSha,
    hasBuildMeta,
  });

  // Delete previous app from storage if exists.
  // NOTE: this only deletes the OLD legacy settings blob. Versioned
  // `mobile_app_builds` rows are immutable history and keep their own
  // storage paths — each new upload lands in a fresh timestamped path.
  const existingApp = project.settings?.mobileApp as MobileAppMetadata | undefined;
  if (existingApp?.storagePath) {
    logger.info('[MOBILE_API] Deleting previous app', {
      projectId,
      oldStoragePath: existingApp.storagePath,
    });
    await MobileAppStorageService.deleteApp(existingApp.storagePath);
  }

  // Upload new app to Supabase Storage
  const metadata = await MobileAppStorageService.uploadApp(req.file, {
    workspaceId: project.workspace_id,
    projectId,
    platform,
    packageName,
  });

  // Save metadata to project settings (legacy slot — always).
  // Preserves pre-Phase-5 behaviour for code that still reads
  // `project.settings.mobileApp` (the resolver's last-resort fallback).
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: metadata as unknown as Record<string, unknown>,
    },
  });

  // Phase 5: record a versioned build row when any git metadata is present.
  // Best-effort — a failure here MUST NOT fail the upload (APK is already
  // in storage and the legacy slot is set).
  if (hasBuildMeta) {
    await MobileAppStorageService.recordBuild(
      metadata,
      { branch, commitSha, buildNumber, ciRunId, source: 'manual' },
      { projectId, workspaceId: project.workspace_id, uploadedBy: userId },
    );
  }

  logger.info('[MOBILE_API] App uploaded successfully', {
    projectId,
    platform,
    storagePath: metadata.storagePath,
    versioned: hasBuildMeta,
  });

  res.status(201).json({
    success: true,
    mobileApp: metadata,
  });

  // Auto-boot emulator + install APK in background (fire-and-forget).
  // By the time the user opens the editor, the emulator is already running.
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

export type MobilePermissionPolicy = 'auto_allow' | 'auto_deny' | 'manual';

const VALID_POLICIES: readonly MobilePermissionPolicy[] = ['auto_allow', 'auto_deny', 'manual'];

function isValidPolicy(value: unknown): value is MobilePermissionPolicy {
  return typeof value === 'string' && (VALID_POLICIES as readonly string[]).includes(value);
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
      error: `policy must be one of: ${VALID_POLICIES.join(', ')}`,
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
