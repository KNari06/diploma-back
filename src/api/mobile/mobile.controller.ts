/**
 * Mobile API Controller
 *
 * Handles mobile app management: upload APK/IPA, get app info, delete app.
 * APK/IPA is stored at project-level in Supabase Storage + project.settings.mobileApp.
 */

import { ProjectService } from '@/services/core/project.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { MobileAppStorageService, MobileAppMetadata } from '@/services/storage/mobile-app-storage.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD APP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/projects/:projectId/app
 *
 * Upload APK/IPA for a project. Replaces previous upload if exists.
 * Body: multipart/form-data with field "file" + optional "packageName", "platform"
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
  const packageName = req.body.packageName as string | undefined;

  if (!req.file) {
    res.status(400).json({ success: false, error: 'No file uploaded. Use form field "file".' });
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
  });

  // Delete previous app from storage if exists
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

  // Save metadata to project settings
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: metadata as unknown as Record<string, unknown>,
    },
  });

  logger.info('[MOBILE_API] App uploaded successfully', {
    projectId,
    platform,
    storagePath: metadata.storagePath,
  });

  res.status(201).json({
    success: true,
    mobileApp: metadata,
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
