/**
 * Test File Storage Service (V6)
 *
 * Handles uploading test files to Supabase Storage for use with
 * the upload step type (sourceType: "storage" / file picker flow).
 */

import { supabaseAdmin } from '@/db/supabase';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import path from 'path';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Service for managing test file uploads to Supabase Storage
 */
export class TestFileStorageService {
  /**
   * Upload a test file to Supabase Storage
   * @param userId - User ID (for folder structure)
   * @param file - Multer file object from request
   * @returns Public URL, filename, and storage path
   */
  static async uploadFile(
    userId: string,
    file: Express.Multer.File
  ): Promise<{ publicUrl: string; fileName: string; storagePath: string }> {
    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB, received ${(file.size / 1024 / 1024).toFixed(2)}MB`
      );
    }

    // Generate unique filename
    const timestamp = Date.now();
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${baseName}_${timestamp}${ext}`;
    const storagePath = `test-uploads/${userId}/${fileName}`;

    logger.info('[TEST_FILE_STORAGE] Uploading file', {
      userId,
      fileName,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });

    // Upload to Supabase Storage
    const { error } = await supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
        cacheControl: '86400', // 24 hours
      });

    if (error) {
      logger.error('[TEST_FILE_STORAGE] Upload failed', { error, userId });
      throw new Error(`Failed to upload file: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .getPublicUrl(storagePath);

    logger.info('[TEST_FILE_STORAGE] Upload successful', {
      userId,
      storagePath,
      publicUrl: urlData.publicUrl,
    });

    return {
      publicUrl: urlData.publicUrl,
      fileName,
      storagePath,
    };
  }

  /**
   * Delete a test file from Supabase Storage
   * @param storagePath - Storage path to delete
   */
  static async deleteFile(storagePath: string): Promise<void> {
    if (!storagePath) return;

    try {
      const { error } = await supabaseAdmin.storage
        .from(env.SUPABASE_BUCKET_NAME)
        .remove([storagePath]);

      if (error) {
        logger.error('[TEST_FILE_STORAGE] Delete failed', { error, storagePath });
        throw new Error(`Failed to delete file: ${error.message}`);
      }

      logger.info('[TEST_FILE_STORAGE] Delete successful', { storagePath });
    } catch (error) {
      logger.error('[TEST_FILE_STORAGE] Delete error', { error, storagePath });
      throw error;
    }
  }
}
