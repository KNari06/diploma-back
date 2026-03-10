/**
 * Mobile App Storage Service
 *
 * Handles uploading/deleting APK/IPA files to Supabase Storage.
 * APK/IPA is stored at project level — one app per project.
 *
 * Storage path: mobile-apps/{workspaceId}/{projectId}/{platform}/{filename}
 * Metadata stored in: projects.settings.mobileApp (JSONB)
 */

import { supabaseAdmin } from '@/db/supabase';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import path from 'path';

// ── Constants ──────────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_EXTENSIONS = ['.apk', '.ipa', '.aab'];
const BUCKET = env.SUPABASE_BUCKET_NAME; // 'qai-assets'

// ── Types ──────────────────────────────────────────────────────────

export interface MobileAppMetadata {
  platform: 'android' | 'ios';
  packageName?: string;
  storagePath: string;
  publicUrl: string;
  originalName: string;
  fileSize: number;
  uploadedAt: string;
}

// ── Service ────────────────────────────────────────────────────────

export class MobileAppStorageService {
  /**
   * Upload APK/IPA to Supabase Storage.
   * If a previous app exists for this project+platform, deletes it first.
   */
  static async uploadApp(
    file: Express.Multer.File,
    params: {
      workspaceId: string;
      projectId: string;
      platform: 'android' | 'ios';
      packageName?: string;
    },
  ): Promise<MobileAppMetadata> {
    const { workspaceId, projectId, platform, packageName } = params;

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB, received ${(file.size / 1024 / 1024).toFixed(1)}MB`,
      );
    }

    // Validate extension
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }

    // Generate storage path
    const timestamp = Date.now();
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_${timestamp}${ext}`;
    const storagePath = `mobile-apps/${workspaceId}/${projectId}/${platform}/${fileName}`;

    logger.info('[MOBILE_APP_STORAGE] Uploading app', {
      projectId,
      platform,
      originalName: file.originalname,
      size: file.size,
      storagePath,
    });

    // Upload to Supabase Storage
    const contentType = ext === '.apk' ? 'application/vnd.android.package-archive'
      : ext === '.ipa' ? 'application/octet-stream'
        : 'application/octet-stream';

    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType,
        upsert: false,
        cacheControl: '31536000', // 1 year (immutable, new file per upload)
      });

    if (error) {
      logger.error('[MOBILE_APP_STORAGE] Upload failed', {
        error,
        projectId,
        storagePath,
      });
      throw new Error(`Failed to upload app: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    const metadata: MobileAppMetadata = {
      platform,
      packageName,
      storagePath,
      publicUrl: urlData.publicUrl,
      originalName: file.originalname,
      fileSize: file.size,
      uploadedAt: new Date().toISOString(),
    };

    logger.info('[MOBILE_APP_STORAGE] Upload successful', {
      projectId,
      platform,
      storagePath,
      publicUrl: urlData.publicUrl,
    });

    return metadata;
  }

  /**
   * Delete a previously uploaded app from Supabase Storage.
   * Best-effort — logs errors but doesn't throw.
   */
  static async deleteApp(storagePath: string): Promise<void> {
    if (!storagePath) return;

    try {
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .remove([storagePath]);

      if (error) {
        logger.warn('[MOBILE_APP_STORAGE] Delete failed', { error, storagePath });
      } else {
        logger.info('[MOBILE_APP_STORAGE] Deleted app', { storagePath });
      }
    } catch (err) {
      logger.warn('[MOBILE_APP_STORAGE] Delete error', {
        error: err instanceof Error ? err.message : String(err),
        storagePath,
      });
    }
  }

  /**
   * Get a signed URL for downloading the app (for proxying to runner).
   * Signed URLs expire — use for short-lived access during test execution.
   */
  static async getSignedUrl(storagePath: string, expiresInSeconds = 600): Promise<string> {
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data?.signedUrl) {
      throw new Error(`Failed to create signed URL: ${error?.message || 'Unknown error'}`);
    }

    return data.signedUrl;
  }

  /**
   * Download app file as Buffer (for proxying to runner).
   */
  static async downloadApp(storagePath: string): Promise<Buffer> {
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download app: ${error?.message || 'Unknown error'}`);
    }

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
