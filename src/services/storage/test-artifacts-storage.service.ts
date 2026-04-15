import { env } from '@/config/environment/env';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import fs from 'fs/promises';
import * as path from 'path';

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
 * Upload a replay-mode JSONL trace log to the unified `lite-trace-logs`
 * bucket and register it in `trace_files` so it shows up in the admin UI.
 *
 * Replay traces carry element resolution details (compiled / LLM / self-heal),
 * readiness checks, retry attempts, and step failures — everything needed to
 * diagnose a failed regression run.
 *
 * Behavior:
 * - Anonymous runs (non-UUID userId) fall back to the `anonymous` segment and
 *   SKIP the DB insert (mirrors the Lite engine path).
 * - If the DB insert fails on an authenticated run, the storage object is
 *   deleted to avoid orphaned blobs.
 * - Local file is best-effort unlinked after a successful upload.
 *
 * @param localPath - Path to local JSONL file (from ReplayTraceWriter)
 * @param testId - UUID of the `tests` row this replay belongs to (used as FK)
 * @param userId - User UUID; falls back to anonymous path if not a UUID
 * @returns Object with storagePath, normalized fileName, fileSize, and optional
 *          `traceFileId` (present only when a trace_files row was inserted).
 */
export async function uploadReplayTraceToStorage(
  localPath: string,
  testId: string,
  userId: string,
): Promise<{
  storagePath: string;
  fileName: string;
  fileSize: number;
  traceFileId?: string;
}> {
  const isUserUuid = isValidUUID(userId);
  const isTestUuid = isValidUUID(testId);

  // Branch 1: anonymous / non-UUID user — upload to the shared anon folder,
  // skip DB bookkeeping (no user to attribute the row to).
  if (!isUserUuid) {
    const { storagePath, fileName: normalizedFileName, fileSize } =
      await uploadLiteTraceLogToStorageAnonymous(localPath, path.basename(localPath), 'replay');
    return { storagePath, fileName: normalizedFileName, fileSize };
  }

  // Branch 2: authenticated user — upload + DB insert with rollback.
  const uploadResult = await uploadLiteTraceLogToStorage(
    localPath,
    userId,
    path.basename(localPath),
    'replay',
  );

  try {
    const { id } = await insertTraceFileRecord({
      userId,
      // `testId` FK to `tests(id)`; only attach if it's a real UUID. For
      // synthetic ids we leave it null so the insert doesn't 23503 on FK.
      testId: isTestUuid ? testId : null,
      fileName: uploadResult.fileName,
      storagePath: uploadResult.storagePath,
      fileSize: uploadResult.fileSize,
      browser: 'replay-trace',
      status: 'uploaded',
    });

    return {
      storagePath: uploadResult.storagePath,
      fileName: uploadResult.fileName,
      fileSize: uploadResult.fileSize,
      traceFileId: id,
    };
  } catch (insertError) {
    logger.error('[STORAGE] Failed to register replay trace in DB, rolling back storage', {
      error: insertError instanceof Error ? insertError.message : String(insertError),
      storagePath: uploadResult.storagePath,
    });
    await deleteLiteTraceLogFromStorage(uploadResult.storagePath).catch(() => {});
    throw insertError;
  }
}

/**
 * Trace type discriminator — drives the file name prefix inside the user's
 * daily trace folder. Keep the value short, lowercase, alphanumeric with `-`.
 */
export type TraceType =
  | 'lite'
  | 'editor'
  | 'preview'
  | 'draft'
  | 'api-agent'
  | 'exploration'
  | 'replay';

/**
 * Build the Supabase Storage path for a trace log.
 *
 * Structure:
 *   trace-logs/<userSegment>/<YYYY-MM-DD>/<traceType>__<HH-MM-SS>__<shortTestId>.jsonl
 *
 * `userSegment` is the user's UUID for authenticated runs or the literal
 * `anonymous` for non-UUID runs. RLS policies on the `lite-trace-logs` bucket
 * rely on the first two path segments (`trace-logs/<userId>`), so we keep
 * those fixed and add date + typed filename INSIDE the user folder.
 *
 * `originalFileName` is expected to follow the LiteTraceWriter convention
 * `YYYY-MM-DD_HH-MM-SS_<testId>.jsonl`. If it doesn't match, we fall back
 * to the current time and a sanitized basename so uploads never fail for
 * cosmetic reasons.
 */
/** Regex matching the well-known testId prefixes set by each writer. */
const TRACE_PREFIX_RE = /^(editor|preview_run|draft_run|api_agent|exploration|lite|replay)_/;

export function buildTraceStoragePath(
  userSegment: string,
  traceType: TraceType,
  originalFileName: string,
): { storagePath: string; normalizedFileName: string } {
  const now = new Date();
  const nowIso = now.toISOString();
  const nowDatePart = nowIso.slice(0, 10); // YYYY-MM-DD
  const nowTimePart = nowIso.slice(11, 19).replace(/:/g, '-'); // HH-MM-SS

  // LiteTraceWriter format: <date>_<time>_<testId>.jsonl
  // Example: 2026-04-15_14-32-07_editor_550e8400-e29b-41d4-a716-446655440000.jsonl
  const parsed = originalFileName.match(
    /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_(.+)\.jsonl$/,
  );

  const datePart = parsed?.[1] ?? nowDatePart;
  const timePart = parsed?.[2] ?? nowTimePart;
  const rawTestId = parsed?.[3] ?? originalFileName.replace(/\.jsonl$/, '');

  // Strip known prefixes repeatedly — covers nested forms like
  // `editor_preview_<uuid>` (editor session ids are themselves `preview_<uuid>`).
  let trimmedTestId = rawTestId;
  while (TRACE_PREFIX_RE.test(trimmedTestId)) {
    trimmedTestId = trimmedTestId.replace(TRACE_PREFIX_RE, '');
  }
  const shortTestId = trimmedTestId.slice(-8) || 'unnamed';

  // 3-hex millisecond suffix disambiguates a retry of the same test within
  // the same second (the parent filename is second-precision). Without it,
  // upsert:false would throw 409 on retry and orphan the storage object.
  const msSuffix = (now.getUTCMilliseconds() & 0xfff).toString(16).padStart(3, '0');

  const normalizedFileName = `${traceType}__${timePart}__${shortTestId}_${msSuffix}.jsonl`;
  const storagePath = `trace-logs/${userSegment}/${datePart}/${normalizedFileName}`;

  return { storagePath, normalizedFileName };
}

/**
 * Upload Lite trace log (JSONL) to Supabase Storage
 * @param localPath - Path to local JSONL file
 * @param userId - User ID (must be valid UUID)
 * @param fileName - Original file name from LiteTraceWriter
 *                   (e.g., YYYY-MM-DD_HH-MM-SS_<testId>.jsonl). The storage
 *                   path is rebuilt from this via buildTraceStoragePath().
 * @param traceType - Trace category (lite/editor/preview/draft/api-agent/exploration).
 *                    Defaults to 'lite' for backwards-compatible callers.
 * @returns Object with storagePath, fileName (normalized) and fileSize
 */
export async function uploadLiteTraceLogToStorage(
  localPath: string,
  userId: string,
  fileName: string,
  traceType: TraceType = 'lite',
): Promise<{ storagePath: string; fileName: string; fileSize: number }> {
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

    const { storagePath, normalizedFileName } = buildTraceStoragePath(
      userId,
      traceType,
      fileName,
    );

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
        fileName: normalizedFileName,
        traceType,
      });
      throw new Error(`Failed to upload Lite trace log: ${error.message}`);
    }

    logger.info('[STORAGE] Lite trace log uploaded successfully', {
      fileName: normalizedFileName,
      storagePath,
      fileSize,
      traceType,
    });

    return { storagePath, fileName: normalizedFileName, fileSize };
  } catch (error) {
    logger.error('[STORAGE] Lite trace log upload error', {
      error: error instanceof Error ? error.message : String(error),
      localPath,
      fileName,
      traceType,
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
  fileName: string,
  traceType: TraceType = 'lite',
): Promise<{ storagePath: string; fileName: string; fileSize: number }> {
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

    const { storagePath, normalizedFileName } = buildTraceStoragePath(
      'anonymous',
      traceType,
      fileName,
    );

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
        fileName: normalizedFileName,
        traceType,
      });
      throw new Error(`Failed to upload Lite trace log: ${error.message}`);
    }

    logger.info('[STORAGE] Lite trace log uploaded successfully (anonymous)', {
      fileName: normalizedFileName,
      storagePath,
      fileSize,
      traceType,
    });

    return { storagePath, fileName: normalizedFileName, fileSize };
  } catch (error) {
    logger.error('[STORAGE] Lite trace log upload error (anonymous)', {
      error: error instanceof Error ? error.message : String(error),
      localPath,
      fileName,
      traceType,
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
  intentTestCaseId?: string | null;
  fileName: string;
  storagePath: string;
  fileSize: number;
  browser: string;
  status?: string;
  parsedData?: Record<string, unknown> | null;
}): Promise<{ id: string }> {
  try {
    const {
      userId,
      testId,
      intentTestCaseId = null,
      fileName,
      storagePath,
      fileSize,
      browser,
      status = 'uploaded',
      parsedData = null,
    } = params;

    logger.info('[STORAGE] Inserting trace file record', {
      testId,
      intentTestCaseId,
      fileName,
      browser,
      fileSize,
    });

    const basePayload: Record<string, unknown> = {
      user_id: userId,
      test_id: testId,
      file_name: fileName,
      storage_path: storagePath,
      file_size: fileSize,
      browser,
      status,
      public_url: null, // Private bucket, use signed URLs
      ...(parsedData ? { parsed_data: parsedData, status: 'parsed', parsed_at: new Date().toISOString() } : {}),
    };

    const payloadWithIntent: Record<string, unknown> = {
      ...basePayload,
      intent_test_case_id: intentTestCaseId,
    };

    // First attempt includes the new intent_test_case_id column. If the
    // database hasn't had the `trace-files-intent-test-case.sql` migration
    // applied yet, Postgres replies with code 42703 ("column does not
    // exist") — in that case we fall back to the legacy payload so traces
    // still get recorded while the schema catches up. Any non-null
    // intentTestCaseId is dropped in that fallback and logged as a warning.
    let { data, error } = await supabaseAdmin
      .from('trace_files')
      .insert(payloadWithIntent)
      .select('id')
      .single();

    const missingColumn =
      error &&
      (error.code === '42703' ||
        /column\s+"?intent_test_case_id"?\s+.*does not exist/i.test(error.message || ''));

    if (missingColumn) {
      logger.warn(
        '[STORAGE] trace_files.intent_test_case_id column missing — retrying without it. Apply supabase-migrations/features/trace-files-intent-test-case.sql.',
        {
          intentTestCaseId,
          fileName,
        },
      );
      const retry = await supabaseAdmin
        .from('trace_files')
        .insert(basePayload)
        .select('id')
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error || !data) {
      logger.error('[STORAGE] Failed to insert trace file record', {
        error,
        testId,
        intentTestCaseId,
        fileName,
      });
      throw new Error(`Failed to insert trace file record: ${error?.message || 'Unknown error'}`);
    }

    logger.info('[STORAGE] Trace file record inserted successfully', {
      id: data.id,
      testId,
      intentTestCaseId,
      fileName,
    });

    return { id: data.id };
  } catch (error) {
    logger.error('[STORAGE] Insert trace file record error', {
      error: error instanceof Error ? error.message : String(error),
      testId: params.testId,
      intentTestCaseId: params.intentTestCaseId ?? null,
      fileName: params.fileName,
    });
    throw error;
  }
}
