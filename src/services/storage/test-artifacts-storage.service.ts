import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
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
    const { error } = await supabaseAdmin.storage
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

    // Validate ZIP magic bytes (PK\x03\x04)
    if (fileBuffer[0] !== 0x50 || fileBuffer[1] !== 0x4B) {
      logger.error('[STORAGE] Trace file is not a valid ZIP archive', {
        testId,
        localPath,
        fileSize,
        firstBytes: fileBuffer.slice(0, 16).toString('hex'),
      });
      throw new Error(`Trace file is not a valid ZIP: starts with ${fileBuffer.slice(0, 4).toString('hex')} instead of 504B`);
    }

    logger.debug('[STORAGE] Trace file read successfully', {
      testId,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });
    const fileName = `trace-${testId}-${Date.now()}.zip`;
    const storagePath = `${userId}/traces/${fileName}`;

    // Upload to Supabase Storage
    const { error } = await supabaseAdmin.storage
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

    // Detect image type from data URI prefix before stripping
    const isJpeg = screenshotBase64.startsWith('data:image/jpeg') || screenshotBase64.startsWith('/9j/');
    const ext = isJpeg ? 'jpg' : 'png';
    const contentType = isJpeg ? 'image/jpeg' : 'image/png';

    // Convert base64 to buffer (handle both PNG and JPEG data URI prefixes)
    const base64Data = screenshotBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const fileName = `screenshot-${testId}-${index}-${Date.now()}.${ext}`;
    const storagePath = `${userId}/screenshots/${fileName}`;

    // Upload to Supabase Storage
    const { error } = await supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType,
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
 * Upload screenshot from Buffer directly to Supabase Storage
 * More efficient than base64 conversion (used by Lite mode)
 */
export async function uploadScreenshotBufferToStorage(
  screenshotBuffer: Buffer,
  testId: string,
  userId: string,
  index: number = 0
): Promise<string> {
  try {
    if (!screenshotBuffer || screenshotBuffer.length === 0) {
      throw new Error('Screenshot buffer is empty');
    }

    logger.info('[STORAGE] Uploading screenshot from buffer', {
      testId,
      index,
      bufferSize: `${Math.round(screenshotBuffer.length / 1024)}KB`,
    });

    const fileName = `screenshot-${testId}-${index}-${Date.now()}.png`;
    const storagePath = `${userId}/screenshots/${fileName}`;

    // Upload to Supabase Storage
    const { error } = await supabaseAdmin.storage
      .from(env.SUPABASE_BUCKET_NAME)
      .upload(storagePath, screenshotBuffer, {
        contentType: 'image/png',
        upsert: false,
        cacheControl: '3600',
      });

    if (error) {
      logger.error('[STORAGE] Failed to upload screenshot buffer', {
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

    logger.info('[STORAGE] Screenshot buffer uploaded successfully', {
      testId,
      index,
      url: urlData.publicUrl,
    });

    return urlData.publicUrl;
  } catch (error) {
    logger.error('[STORAGE] Screenshot buffer upload error', {
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

/**
 * Upload Lite trace log (JSONL) to Supabase Storage
 * @param localPath - Path to local JSONL file
 * @param userId - User ID (must be valid UUID)
 * @param fileName - File name (e.g., lite_trace_<timestamp>_<testId>_<runId>.jsonl)
 * @returns Object with storagePath and fileSize
 */
export async function uploadLiteTraceLogToStorage(
  localPath: string,
  userId: string,
  fileName: string
): Promise<{ storagePath: string; fileSize: number }> {
  try {
    // Check if file exists before reading
    try {
      await fs.access(localPath);
    } catch (accessError) {
      logger.error('[STORAGE] Lite trace log file does not exist', {
        localPath,
        fileName,
        error: accessError instanceof Error ? accessError.message : String(accessError),
      });
      throw new Error(`Lite trace log file not found: ${localPath}`);
    }

    logger.info('[STORAGE] Uploading Lite trace log', {
      localPath,
      fileName,
      userId,
    });

    // Read file
    const fileBuffer = await fs.readFile(localPath);
    const fileSize = fileBuffer.length;

    if (fileSize === 0) {
      logger.warn('[STORAGE] Lite trace log file is empty', { localPath, fileName });
      throw new Error('Lite trace log file is empty');
    }

    logger.debug('[STORAGE] Lite trace log file read successfully', {
      fileName,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });

    const storagePath = `trace-logs/${userId}/${fileName}`;

    // Upload to Supabase Storage (bucket: lite-trace-logs)
    const { error } = await supabaseAdmin.storage
      .from('lite-trace-logs')
      .upload(storagePath, fileBuffer, {
        contentType: 'application/x-ndjson',
        upsert: false,
        cacheControl: '3600',
      });

    if (error) {
      logger.error('[STORAGE] Failed to upload Lite trace log', {
        error,
        storagePath,
        fileName,
      });
      throw new Error(`Failed to upload Lite trace log: ${error.message}`);
    }

    logger.info('[STORAGE] Lite trace log uploaded successfully', {
      fileName,
      storagePath,
      fileSize,
    });

    return { storagePath, fileSize };
  } catch (error) {
    logger.error('[STORAGE] Lite trace log upload error', {
      error: error instanceof Error ? error.message : String(error),
      localPath,
      fileName,
    });
    throw error;
  }
}

/**
 * Upload Lite trace log (JSONL) to Supabase Storage for non-UUID / anonymous runs.
 * This intentionally does NOT create a trace_files record.
 */
export async function uploadLiteTraceLogToStorageAnonymous(
  localPath: string,
  fileName: string
): Promise<{ storagePath: string; fileSize: number }> {
  try {
    // Check if file exists before reading
    try {
      await fs.access(localPath);
    } catch (accessError) {
      logger.error('[STORAGE] Lite trace log file does not exist (anonymous upload)', {
        localPath,
        fileName,
        error: accessError instanceof Error ? accessError.message : String(accessError),
      });
      throw new Error(`Lite trace log file not found: ${localPath}`);
    }

    // Read file
    const fileBuffer = await fs.readFile(localPath);
    const fileSize = fileBuffer.length;

    if (fileSize === 0) {
      logger.warn('[STORAGE] Lite trace log file is empty (anonymous upload)', { localPath, fileName });
      throw new Error('Lite trace log file is empty');
    }

    const storagePath = `trace-logs/anonymous/${fileName}`;

    const { error } = await supabaseAdmin.storage
      .from('lite-trace-logs')
      .upload(storagePath, fileBuffer, {
        contentType: 'application/x-ndjson',
        upsert: false,
        cacheControl: '3600',
      });

    if (error) {
      logger.error('[STORAGE] Failed to upload Lite trace log (anonymous)', {
        error,
        storagePath,
        fileName,
      });
      throw new Error(`Failed to upload Lite trace log: ${error.message}`);
    }

    logger.info('[STORAGE] Lite trace log uploaded successfully (anonymous)', {
      fileName,
      storagePath,
      fileSize,
    });

    return { storagePath, fileSize };
  } catch (error) {
    logger.error('[STORAGE] Lite trace log upload error (anonymous)', {
      error: error instanceof Error ? error.message : String(error),
      localPath,
      fileName,
    });
    throw error;
  }
}

/**
 * Best-effort removal of Lite trace log from Storage (cleanup for partial failures).
 */
export async function deleteLiteTraceLogFromStorage(storagePath: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.storage
      .from('lite-trace-logs')
      .remove([storagePath]);

    if (error) {
      logger.warn('[STORAGE] Failed to delete Lite trace log from storage', {
        error,
        storagePath,
      });
    }
  } catch (err) {
    logger.warn('[STORAGE] Exception while deleting Lite trace log from storage', {
      error: err instanceof Error ? err.message : String(err),
      storagePath,
    });
  }
}

/**
 * Insert trace file record into trace_files table
 * @param params - Trace file metadata
 * @returns Object with trace_files record id
 */
export async function insertTraceFileRecord(params: {
  userId: string;
  testId: string | null;
  fileName: string;
  storagePath: string;
  fileSize: number;
  browser: string;
  status?: string;
}): Promise<{ id: string }> {
  try {
    const { userId, testId, fileName, storagePath, fileSize, browser, status = 'uploaded' } = params;

    logger.info('[STORAGE] Inserting trace file record', {
      testId,
      fileName,
      browser,
      fileSize,
    });

    const { data, error } = await supabaseAdmin
      .from('trace_files')
      .insert({
        user_id: userId,
        test_id: testId,
        file_name: fileName,
        storage_path: storagePath,
        file_size: fileSize,
        browser,
        status,
        public_url: null, // Private bucket, use signed URLs
      })
      .select('id')
      .single();

    if (error || !data) {
      logger.error('[STORAGE] Failed to insert trace file record', {
        error,
        testId,
        fileName,
      });
      throw new Error(`Failed to insert trace file record: ${error?.message || 'Unknown error'}`);
    }

    logger.info('[STORAGE] Trace file record inserted successfully', {
      id: data.id,
      testId,
      fileName,
    });

    return { id: data.id };
  } catch (error) {
    logger.error('[STORAGE] Insert trace file record error', {
      error: error instanceof Error ? error.message : String(error),
      testId: params.testId,
      fileName: params.fileName,
    });
    throw error;
  }
}
