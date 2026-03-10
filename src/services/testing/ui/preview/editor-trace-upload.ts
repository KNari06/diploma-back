/**
 * Editor Trace Upload
 * Uploads editor and preview-run JSONL trace files to Supabase Storage.
 * Best-effort: failures are logged but never thrown.
 * Reuses existing uploadLiteTraceLogToStorage() and insertTraceFileRecord().
 */

import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import * as fs from 'fs/promises';
import * as path from 'path';

interface UploadEditorTraceParams {
  filePath: string;
  userId: string;
  previewSessionId: string;
  traceType: 'editor' | 'preview_run';
  intentTestCaseId?: string;
}

const TAG = '[EDITOR_TRACE_UPLOAD]';

/**
 * Upload a JSONL trace file to Supabase Storage and record in trace_files.
 * Fully fire-and-forget safe — never throws.
 */
export async function uploadEditorTrace(params: UploadEditorTraceParams): Promise<void> {
  const { filePath, userId, previewSessionId, traceType, intentTestCaseId } = params;

  try {
    if (!isValidUUID(userId)) {
      logger.warn(`${TAG} Skipping upload — userId is not a valid UUID`, {
        userId: userId?.substring(0, 8),
        previewSessionId,
        traceType,
      });
      return;
    }

    // Check file exists and is non-empty
    let fileSize: number;
    try {
      const stats = await fs.stat(filePath);
      fileSize = stats.size;
    } catch {
      logger.debug(`${TAG} Trace file not found, skipping`, { filePath, previewSessionId, traceType });
      return;
    }

    if (fileSize === 0) {
      logger.debug(`${TAG} Trace file empty, skipping`, { filePath, previewSessionId, traceType });
      return;
    }

    const {
      uploadLiteTraceLogToStorage,
      insertTraceFileRecord,
      deleteLiteTraceLogFromStorage,
    } = await import('@/services/storage/test-artifacts-storage.service');

    const fileName = path.basename(filePath);

    logger.info(`${TAG} Uploading trace`, {
      previewSessionId,
      traceType,
      fileName,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });

    const uploadResult = await uploadLiteTraceLogToStorage(filePath, userId, fileName);

    // testId must be UUID or null — previewSessionId is not a UUID
    const testId = intentTestCaseId && isValidUUID(intentTestCaseId) ? intentTestCaseId : null;

    try {
      await insertTraceFileRecord({
        userId,
        testId,
        fileName,
        storagePath: uploadResult.storagePath,
        fileSize: uploadResult.fileSize,
        browser: traceType === 'editor' ? 'editor-trace' : 'preview-run-trace',
      });
    } catch (insertError) {
      logger.error(`${TAG} Failed to insert trace_files record, rolling back storage`, {
        previewSessionId,
        traceType,
        error: insertError instanceof Error ? insertError.message : String(insertError),
      });
      await deleteLiteTraceLogFromStorage(uploadResult.storagePath).catch(() => {});
      return;
    }

    logger.info(`${TAG} Trace uploaded successfully`, {
      previewSessionId,
      traceType,
      storagePath: uploadResult.storagePath,
    });

    // Clean up local file (best-effort)
    try {
      await fs.unlink(filePath);
    } catch {
      // Non-fatal — local file stays on disk
    }
  } catch (error) {
    logger.error(`${TAG} Upload failed (best-effort, non-fatal)`, {
      previewSessionId,
      traceType,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
