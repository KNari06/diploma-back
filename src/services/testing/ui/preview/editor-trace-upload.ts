/**
 * Editor Trace Upload
 * Uploads editor and preview-run JSONL trace files to Supabase Storage.
 * Best-effort: failures are logged but never thrown.
 * Reuses existing uploadLiteTraceLogToStorage() and insertTraceFileRecord().
 */

import { isDevelopment } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { TraceType } from '@/services/storage/test-artifacts-storage.service';
import { aggregateJsonl, type TraceSummary } from './trace-analysis.util';

interface UploadEditorTraceParams {
  filePath: string;
  userId: string;
  previewSessionId: string;
  traceType: 'editor' | 'preview_run' | 'draft_run';
  intentTestCaseId?: string;
}

/**
 * Map the caller-facing traceType (kept snake_case for frontend compatibility)
 * to the storage-layer TraceType (dash-free enum used for path prefixing).
 */
const TRACE_TYPE_FOR_STORAGE: Record<UploadEditorTraceParams['traceType'], TraceType> = {
  editor: 'editor',
  preview_run: 'preview',
  draft_run: 'draft',
};

const TAG = '[EDITOR_TRACE_UPLOAD]';

/**
 * Upload a JSONL trace file to Supabase Storage and record in trace_files.
 * Fully fire-and-forget safe — never throws.
 */
export async function uploadEditorTrace(params: UploadEditorTraceParams): Promise<void> {
  const { filePath, userId, previewSessionId, traceType, intentTestCaseId } = params;

  try {
    // In development, keep trace logs locally for debugging — skip Supabase upload
    if (isDevelopment) {
      logger.debug(`${TAG} Skipping upload in development mode, keeping local file`, {
        filePath,
        previewSessionId,
        traceType,
      });
      return;
    }

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

    const originalFileName = path.basename(filePath);

    logger.info(`${TAG} Uploading trace`, {
      previewSessionId,
      traceType,
      fileName: originalFileName,
      fileSize: `${Math.round(fileSize / 1024)}KB`,
    });

    // parsed_data layer — what dashboards / SQL queries see in Supabase.
    //
    // Strategy: if the writer wrote a `trace_summary` event at close, use
    // that directly (no double-work, no risk of drift). Otherwise recompute
    // by re-aggregating the JSONL — same algorithm, defined once in
    // ./trace-analysis.util.ts. See that file for the field-by-field map.
    //
    // Why two paths:
    //   1. trace_summary at close = the canonical record. Lives inside
    //      the JSONL itself so `jq` can read it locally without DB.
    //   2. Upload-time recompute = belt-and-suspenders. If writer was
    //      killed mid-flush (SIGKILL, OOM, container restart) the
    //      trace_summary event may be missing — recompute keeps
    //      parsed_data populated rather than null.
    let parsedData: TraceSummary | null = null;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');

      // First try the cheap path: scan from the bottom for the
      // canonical trace_summary event. Writers emit it as the LAST
      // line on graceful close, so we usually hit it within a few
      // lines from the end.
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt?.eventType === 'trace_summary' && evt.payload) {
            parsedData = evt.payload as TraceSummary;
            break;
          }
        } catch { /* malformed tail — fall back to recompute */ }
        // Stop scanning the tail once we hit any non-summary event —
        // trace_summary is supposed to be last, no point walking the
        // full file from the back.
        break;
      }

      // Fallback recompute when the close-time event wasn't written.
      if (!parsedData) {
        parsedData = aggregateJsonl(raw);
      }
    } catch {
      // Non-fatal — summary will be null
    }

    const storageTraceType = TRACE_TYPE_FOR_STORAGE[traceType];
    const uploadResult = await uploadLiteTraceLogToStorage(
      filePath,
      userId,
      originalFileName,
      storageTraceType,
    );

    // trace_files.test_id has a FK on tests(id); intent_test_cases rows live
    // in a different table, so we never put an intentTestCaseId there.
    // Preview/editor traces are not produced by the legacy `tests` runner,
    // so testId is always null for this code path. The intent test case link
    // (if any) goes into the separate intent_test_case_id column instead.
    const resolvedIntentTestCaseId =
      intentTestCaseId && isValidUUID(intentTestCaseId) ? intentTestCaseId : null;

    try {
      await insertTraceFileRecord({
        userId,
        testId: null,
        intentTestCaseId: resolvedIntentTestCaseId,
        fileName: uploadResult.fileName,
        storagePath: uploadResult.storagePath,
        fileSize: uploadResult.fileSize,
        browser: traceType === 'editor' ? 'editor-trace' : 'preview-run-trace',
        // TraceSummary is a flat numeric struct — the explicit cast keeps
        // it queryable as a plain JSONB record on the Supabase side.
        parsedData: parsedData as unknown as Record<string, unknown> | null,
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

/**
 * Close an open editor trace and upload it in one step. Single source for the
 * "write a terminal lifecycle event → close → upload" sequence the mobile
 * session-end paths need (idle timer, disconnect grace, runner-reclaimed 410).
 * Best-effort — never throws. Returns true when a trace was found and the
 * upload was attempted, false when there was nothing open under this id.
 */
export async function closeAndUploadEditorTrace(
  previewSessionId: string,
  traceType: UploadEditorTraceParams['traceType'] = 'editor',
): Promise<boolean> {
  try {
    const { EditorTraceService } = await import('./editor-trace.service');
    const meta = await EditorTraceService.close(previewSessionId);
    if (!meta) return false;
    await uploadEditorTrace({
      filePath: meta.filePath,
      userId: meta.userId,
      previewSessionId,
      traceType,
    });
    return true;
  } catch (err) {
    logger.warn(`${TAG} closeAndUploadEditorTrace failed (non-fatal)`, {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
