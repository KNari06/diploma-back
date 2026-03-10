import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import path from 'path';

const BUCKET_NAME = 'user-avatars';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * Service for managing user avatar uploads to Supabase Storage
 */
export class UserAvatarStorageService {
  /**
   * Upload user avatar to Supabase Storage
   */
  static async uploadAvatar(
    userId: string,
    file: Express.Multer.File
  ): Promise<{ storagePath: string; publicUrl: string; fileName: string }> {
    try {
      this.validateFile(file);

      const timestamp = Date.now();
      const ext = path.extname(file.originalname).toLowerCase();
      const fileName = `avatar_${timestamp}${ext}`;
      const storagePath = `${userId}/${fileName}`;

      logger.info('[USER_AVATAR] Uploading avatar', {
        userId,
        fileName,
        size: file.size,
        mimeType: file.mimetype,
      });

      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
          cacheControl: '3600',
        });

      if (error) {
        logger.error('[USER_AVATAR] Upload failed', { error, userId });
        throw new Error(`Failed to upload avatar: ${error.message}`);
      }

      const { data: urlData } = supabaseAdmin.storage
        .from(BUCKET_NAME)
        .getPublicUrl(storagePath);

      logger.info('[USER_AVATAR] Upload successful', {
        userId,
        storagePath,
        publicUrl: urlData.publicUrl,
      });

      return {
        storagePath,
        publicUrl: urlData.publicUrl,
        fileName,
      };
    } catch (error) {
      logger.error('[USER_AVATAR] Upload error', { error, userId });
      throw error;
    }
  }

  /**
   * Delete user avatar from Supabase Storage
   */
  static async deleteAvatar(storagePath: string): Promise<void> {
    try {
      if (!storagePath) {
        logger.warn('[USER_AVATAR] Delete called with empty path');
        return;
      }

      logger.info('[USER_AVATAR] Deleting avatar', { storagePath });

      const { error } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .remove([storagePath]);

      if (error) {
        logger.error('[USER_AVATAR] Delete failed', { error, storagePath });
        throw new Error(`Failed to delete avatar: ${error.message}`);
      }

      logger.info('[USER_AVATAR] Delete successful', { storagePath });
    } catch (error) {
      logger.error('[USER_AVATAR] Delete error', { error, storagePath });
      throw error;
    }
  }

  /**
   * Delete old avatar before uploading new one
   */
  static async deleteOldAvatar(avatarUrl: string | null): Promise<void> {
    if (!avatarUrl) {
      return;
    }

    try {
      const urlParts = avatarUrl.split(`/${BUCKET_NAME}/`);

      if (urlParts.length < 2) {
        logger.warn('[USER_AVATAR] Invalid avatar URL format', { avatarUrl });
        return;
      }

      const storagePath = urlParts[1];
      await this.deleteAvatar(storagePath);
    } catch (error) {
      logger.error('[USER_AVATAR] Failed to delete old avatar', { error, avatarUrl });
      // Don't throw - proceed with upload even if old avatar deletion fails
    }
  }

  /**
   * Validate uploaded file
   */
  private static validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new Error('No file provided');
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB, received ${(file.size / 1024 / 1024).toFixed(2)}MB`
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new Error(
        `Invalid file type "${file.mimetype}". Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
      );
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Invalid file extension "${ext}". Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`
      );
    }
  }

  /**
   * Get public URL from storage path
   */
  static getPublicUrl(storagePath: string): string {
    const { data } = supabaseAdmin.storage
      .from(BUCKET_NAME)
      .getPublicUrl(storagePath);

    return data.publicUrl;
  }
}
