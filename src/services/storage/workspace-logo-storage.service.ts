import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import path from 'path';

const BUCKET_NAME = 'workspace-logos';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];

/**
 * Service for managing workspace logo uploads to Supabase Storage
 * Handles upload, deletion, and validation of workspace logo files
 */
export class WorkspaceLogoStorageService {
  /**
   * Upload workspace logo to Supabase Storage
   * @param userId - User ID (for folder structure and RLS)
   * @param workspaceId - Workspace ID (for folder structure)
   * @param file - Multer file object from request
   * @returns Storage path, public URL, and filename
   */
  static async uploadLogo(
    userId: string,
    workspaceId: string,
    file: Express.Multer.File
  ): Promise<{ storagePath: string; publicUrl: string; fileName: string }> {
    try {
      // Validate file before upload
      this.validateFile(file);

      // Generate unique filename with timestamp
      const timestamp = Date.now();
      const ext = path.extname(file.originalname).toLowerCase();
      const fileName = `logo_${timestamp}${ext}`;
      const storagePath = `${userId}/${workspaceId}/${fileName}`;

      logger.info('[WORKSPACE_LOGO] Uploading logo', {
        userId,
        workspaceId,
        fileName,
        size: file.size,
        mimeType: file.mimetype,
      });

      // Upload to Supabase Storage
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false, // Don't overwrite existing files
          cacheControl: '3600', // Cache for 1 hour
        });

      if (error) {
        logger.error('[WORKSPACE_LOGO] Upload failed', { error, userId, workspaceId });
        throw new Error(`Failed to upload logo: ${error.message}`);
      }

      // Get public URL
      const { data: urlData } = supabaseAdmin.storage
        .from(BUCKET_NAME)
        .getPublicUrl(storagePath);

      logger.info('[WORKSPACE_LOGO] Upload successful', {
        userId,
        workspaceId,
        storagePath,
        publicUrl: urlData.publicUrl,
      });

      return {
        storagePath,
        publicUrl: urlData.publicUrl,
        fileName,
      };
    } catch (error) {
      logger.error('[WORKSPACE_LOGO] Upload error', { error, userId, workspaceId });
      throw error;
    }
  }

  /**
   * Delete workspace logo from Supabase Storage
   * @param storagePath - Full storage path to the file (e.g., "userId/workspaceId/logo_123.png")
   */
  static async deleteLogo(storagePath: string): Promise<void> {
    try {
      if (!storagePath) {
        logger.warn('[WORKSPACE_LOGO] Delete called with empty path');
        return;
      }

      logger.info('[WORKSPACE_LOGO] Deleting logo', { storagePath });

      const { error } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .remove([storagePath]);

      if (error) {
        logger.error('[WORKSPACE_LOGO] Delete failed', { error, storagePath });
        throw new Error(`Failed to delete logo: ${error.message}`);
      }

      logger.info('[WORKSPACE_LOGO] Delete successful', { storagePath });
    } catch (error) {
      logger.error('[WORKSPACE_LOGO] Delete error', { error, storagePath });
      throw error;
    }
  }

  /**
   * Delete old logo before uploading new one
   * Extracts storage path from public URL and deletes the file
   * @param logoUrl - Current logo URL from database
   */
  static async deleteOldLogo(logoUrl: string | null): Promise<void> {
    if (!logoUrl) {
      return;
    }

    try {
      // Extract storage path from public URL
      // Format: https://{project}.supabase.co/storage/v1/object/public/workspace-logos/{userId}/{workspaceId}/{fileName}
      const urlParts = logoUrl.split(`/workspace-logos/`);

      if (urlParts.length < 2) {
        logger.warn('[WORKSPACE_LOGO] Invalid logo URL format', { logoUrl });
        return;
      }

      const storagePath = urlParts[1];
      await this.deleteLogo(storagePath);
    } catch (error) {
      logger.error('[WORKSPACE_LOGO] Failed to delete old logo', { error, logoUrl });
      // Don't throw - we want to proceed with upload even if old logo deletion fails
    }
  }

  /**
   * Validate uploaded file
   * Checks file size, MIME type, and file extension
   * @param file - Multer file object
   * @throws Error if validation fails
   */
  private static validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new Error('No file provided');
    }

    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB, received ${(file.size / 1024 / 1024).toFixed(2)}MB`
      );
    }

    // Check MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new Error(
        `Invalid file type "${file.mimetype}". Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
      );
    }

    // Check file extension
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Invalid file extension "${ext}". Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`
      );
    }
  }

  /**
   * Get public URL from storage path
   * @param storagePath - Storage path (e.g., "userId/workspaceId/logo_123.png")
   * @returns Public URL
   */
  static getPublicUrl(storagePath: string): string {
    const { data } = supabaseAdmin.storage
      .from(BUCKET_NAME)
      .getPublicUrl(storagePath);

    return data.publicUrl;
  }
}
