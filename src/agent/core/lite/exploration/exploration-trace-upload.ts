/**
 * Exploration Trace Upload
 * Uploads the exploration JSONL trace file to Supabase Storage in PRODUCTION,
 * so a run triggered on prod leaves the same trace we get locally — instead of
 * it dying with the ephemeral container filesystem.
 *
 * Mirrors src/services/testing/ui/preview/editor-trace-upload.ts (same bucket
 * helper, same prod gate, same trace_files record + rollback, same cleanup).
 * Best-effort: failures are logged, never thrown, and never block the run.
 */

import { isDevelopment } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import * as fs from 'fs/promises';
import * as path from 'path';
import { aggregateJsonl, type TraceSummary } from '@/services/testing/ui/preview/trace-analysis.util';

const TAG = '[EXPLORATION_TRACE_UPLOAD]';

export interface UploadExplorationTraceParams {
  filePath: string;
  /** Server-derived owner of the run. May be absent/non-UUID for anonymous PLG runs. */
  userId?: string;
  explorationId: string;
}

/**
 * Upload an exploration JSONL trace to Supabase Storage and (for an
 * authenticated user) register it in trace_files. Fully fire-and-forget safe —
 * NEVER throws. In development the local file is kept and upload is skipped
 * (same as editor traces) so local debugging is unchanged.
 */
export async function uploadExplorationTrace(params: UploadExplorationTraceParams): Promise<void> {
  const { filePath, userId, explorationId } = params;

  try {
    // Development → keep the local file for jq/debugging, skip the upload.
    if (isDevelopment) {
      logger.debug(`${TAG} Skipping upload in development mode, keeping local file`, { filePath, explorationId });
      return;
    }

    // Non-empty file check (a never-written trace has nothing to upload).
    let fileSize: number;
    try {
      fileSize = (await fs.stat(filePath)).size;
    } catch {
      logger.debug(`${TAG} Trace file not found, skipping`, { filePath, explorationId });
      return;
    }
    if (fileSize === 0) {
      logger.debug(`${TAG} Trace file empty, skipping`, { filePath, explorationId });
      return;
    }

    const {
      uploadLiteTraceLogToStorage,
      uploadLiteTraceLogToStorageAnonymous,
      insertTraceFileRecord,
      deleteLiteTraceLogFromStorage,
    } = await import('@/services/storage/test-artifacts-storage.service');

    const originalFileName = path.basename(filePath);

    // parsed_data — canonical trace_summary (last line on graceful close) or a
    // recompute if the writer was killed mid-flush. Same strategy as editor.
    let parsedData: TraceSummary | null = null;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt?.eventType === 'trace_summary' && evt.payload) {
            parsedData = evt.payload as TraceSummary;
          }
        } catch { /* malformed tail — recompute below */ }
        break; // trace_summary is the last event; stop at the first non-blank line
      }
      if (!parsedData) parsedData = aggregateJsonl(raw);
    } catch {
      // Non-fatal — parsed_data stays null.
    }

    logger.info(`${TAG} Uploading exploration trace`, {
      explorationId,
      fileName: originalFileName,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });

    // Anonymous PLG run (no valid user UUID): upload to the anonymous prefix,
    // no trace_files DB record (the FK/owner columns want a real user).
    if (!userId || !isValidUUID(userId)) {
      try {
        await uploadLiteTraceLogToStorageAnonymous(filePath, originalFileName, 'exploration');
        await fs.unlink(filePath).catch(() => {});
      } catch (err) {
        logger.warn(`${TAG} Anonymous upload failed (best-effort)`, {
          explorationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Authenticated run: upload + register + rollback-on-insert-failure.
    const uploadResult = await uploadLiteTraceLogToStorage(filePath, userId, originalFileName, 'exploration');
    try {
      await insertTraceFileRecord({
        userId,
        testId: null, // exploration is not a legacy `tests` run
        fileName: uploadResult.fileName,
        storagePath: uploadResult.storagePath,
        fileSize: uploadResult.fileSize,
        browser: 'exploration-trace',
        parsedData: parsedData as unknown as Record<string, unknown> | null,
      });
    } catch (insertError) {
      logger.error(`${TAG} Failed to insert trace_files record, rolling back storage`, {
        explorationId,
        error: insertError instanceof Error ? insertError.message : String(insertError),
      });
      await deleteLiteTraceLogFromStorage(uploadResult.storagePath).catch(() => {});
      return;
    }

    logger.info(`${TAG} Trace uploaded`, { explorationId, storagePath: uploadResult.storagePath });
    await fs.unlink(filePath).catch(() => {}); // best-effort local cleanup
  } catch (error) {
    logger.error(`${TAG} Upload failed (best-effort, non-fatal)`, {
      explorationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
