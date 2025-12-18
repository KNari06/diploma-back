import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';
import fs from 'fs/promises';

/**
 * Upload video file to Supabase Storage
 */
export async function uploadVideoToStorage(
  localPath: string,
  testId: string,
  userId: string
): Promise<string> {
  try {
    // ✅ FIX: Check if file exists before reading
    try {
      await fs.access(localPath);
    } catch (accessError) {
      logger.error('[STORAGE] Video file does not exist', {
        testId,
        localPath,
        error: accessError instanceof Error ? accessError.message : String(accessError),
      });
      throw new Error(`Video file not found: ${localPath}`);
    }

    logger.info('[STORAGE] Uploading video', {
      testId,
      localPath,
      userId,
    });

    // Read file
    const fileBuffer = await fs.readFile(localPath);
    const fileSize = fileBuffer.length;

    if (fileSize === 0) {
      logger.warn('[STORAGE] Video file is empty', { testId, localPath });
      throw new Error('Video file is empty');
    }

    logger.debug('[STORAGE] Video file read successfully', {
      testId,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });
    const fileName = `video-${testId}-${Date.now()}.webm`;
    const storagePath = `${userId}/videos/${fileName}`;

    // Upload to Supabase Storage
    const { data, error } = await supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(storagePath, fileBuffer, {
        contentType: 'video/webm',
        upsert: false,
        cacheControl: '3600',
      });

    if (error) {
      logger.error('[STORAGE] Failed to upload video', {
        error,
        testId,
        storagePath,
      });
      throw new Error(`Failed to upload video: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .getPublicUrl(storagePath);

    logger.info('[STORAGE] Video uploaded successfully', {
      testId,
      url: urlData.publicUrl,
    });

    // Clean up local file
    try {
      await fs.unlink(localPath);
      logger.debug('[STORAGE] Local video file deleted', { localPath });
    } catch (cleanupError) {
      logger.warn('[STORAGE] Failed to delete local video file', {
        localPath,
        error: cleanupError,
      });
    }

    return urlData.publicUrl;
  } catch (error) {
    logger.error('[STORAGE] Video upload error', {
      error: error instanceof Error ? error.message : String(error),
      testId,
    });
    throw error;
  }
}

/**
 * Upload trace file to Supabase Storage
 */
export async function uploadTraceToStorage(
  localPath: string,
  testId: string,
  userId: string
): Promise<string> {
  try {
    // ✅ FIX: Check if file exists before reading
    try {
      await fs.access(localPath);
    } catch (accessError) {
      logger.error('[STORAGE] Trace file does not exist', {
        testId,
        localPath,
        error: accessError instanceof Error ? accessError.message : String(accessError),
      });
      throw new Error(`Trace file not found: ${localPath}`);
    }

    logger.info('[STORAGE] Uploading trace', {
      testId,
      localPath,
      userId,
    });

    // Read file
    const fileBuffer = await fs.readFile(localPath);
    const fileSize = fileBuffer.length;

    if (fileSize === 0) {
      logger.warn('[STORAGE] Trace file is empty', { testId, localPath });
      throw new Error('Trace file is empty');
    }

    logger.debug('[STORAGE] Trace file read successfully', {
      testId,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });
    const fileName = `trace-${testId}-${Date.now()}.zip`;
    const storagePath = `${userId}/traces/${fileName}`;

    // Upload to Supabase Storage
    const { data, error} = await supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(storagePath, fileBuffer, {
        contentType: 'application/zip',
        upsert: false,
        cacheControl: '3600',
      });

    if (error) {
      logger.error('[STORAGE] Failed to upload trace', {
        error,
        testId,
        storagePath,
      });
      throw new Error(`Failed to upload trace: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .getPublicUrl(storagePath);

    logger.info('[STORAGE] Trace uploaded successfully', {
      testId,
      url: urlData.publicUrl,
    });

    // Clean up local file
    try {
      await fs.unlink(localPath);
      logger.debug('[STORAGE] Local trace file deleted', { localPath });
    } catch (cleanupError) {
      logger.warn('[STORAGE] Failed to delete local trace file', {
        localPath,
        error: cleanupError,
      });
    }

    return urlData.publicUrl;
  } catch (error) {
    logger.error('[STORAGE] Trace upload error', {
      error: error instanceof Error ? error.message : String(error),
      testId,
    });
    throw error;
  }
}

/**
 * Upload screenshot to Supabase Storage
 */
export async function uploadScreenshotToStorage(
  screenshotBase64: string,
  testId: string,
  userId: string,
  index: number = 0
): Promise<string> {
  try {
    logger.info('[STORAGE] Uploading screenshot', {
      testId,
      index,
    });

    // Convert base64 to buffer
    const base64Data = screenshotBase64.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const fileName = `screenshot-${testId}-${index}-${Date.now()}.png`;
    const storagePath = `${userId}/screenshots/${fileName}`;

    // Upload to Supabase Storage
    const { data, error } = await supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType: 'image/png',
        upsert: false,
        cacheControl: '3600',
      });

    if (error) {
      logger.error('[STORAGE] Failed to upload screenshot', {
        error,
        testId,
        storagePath,
      });
      throw new Error(`Failed to upload screenshot: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .getPublicUrl(storagePath);

    logger.info('[STORAGE] Screenshot uploaded successfully', {
      testId,
      index,
      url: urlData.publicUrl,
    });

    return urlData.publicUrl;
  } catch (error) {
    logger.error('[STORAGE] Screenshot upload error', {
      error: error instanceof Error ? error.message : String(error),
      testId,
    });
    throw error;
  }
}

/**
 * Download file from Supabase Storage
 */
export async function downloadFromStorage(storageUrl: string): Promise<Buffer> {
  try {
    const response = await fetch(storageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    logger.error('[STORAGE] Download error', {
      error: error instanceof Error ? error.message : String(error),
      url: storageUrl,
    });
    throw error;
  }
}
