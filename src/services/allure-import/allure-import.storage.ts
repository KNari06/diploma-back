/**
 * Allure Import — Supabase Storage helpers.
 *
 * The uploaded Allure file (zip/csv/pdf) is stashed in Supabase Storage so
 * the API pod (writer) and the BullMQ worker pod (reader) can both reach it
 * without sharing a local filesystem.
 *
 * Bucket: `allure_reports` (private). Created manually via the Supabase
 * Dashboard; RLS policies live in supabase-migrations/.
 *
 * Object key layout: `allure/{userId}/{importId}.{ext}`
 *   - matches the `split_part(name, '/', 2) = auth.uid()::text` RLS pattern
 *     used elsewhere in the project (see lite-trace-logs).
 */

import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import type { AllureImportJobData, AllureSourceFormat } from './allure-import.types';

export const ALLURE_IMPORTS_BUCKET = 'allure_reports';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extensionForFormat(format: AllureSourceFormat): 'zip' | 'csv' | 'pdf' {
  if (format === 'csv') return 'csv';
  if (format === 'pdf') return 'pdf';
  return 'zip';
}

export function contentTypeForFormat(format: AllureSourceFormat): string {
  if (format === 'csv') return 'text/csv';
  if (format === 'pdf') return 'application/pdf';
  return 'application/zip';
}

/**
 * Build the storage object key for an Allure upload.
 *
 * Path layout `allure/{userId}/{importId}.{ext}` matches the RLS policies and
 * the `split_part(name, '/', 2) = auth.uid()::text` predicate. Both inputs are
 * validated as UUIDs to keep the path stable and reject any attempt to slip
 * `/`, `..` or whitespace into the key.
 */
export function buildStorageKey(
  userId: string,
  importId: string,
  format: AllureSourceFormat,
): string {
  if (!UUID_RE.test(userId)) {
    throw new Error('Invalid userId for storage key (expected UUID)');
  }
  if (!UUID_RE.test(importId)) {
    throw new Error('Invalid importId for storage key (expected UUID)');
  }
  return `allure/${userId}/${importId}.${extensionForFormat(format)}`;
}

/**
 * Resolve the storage key for a job, rejecting legacy jobs that only carry a
 * local `filePath`/`zipFilePath` from before the storage migration. Those jobs
 * pointed at the API pod's `/tmp` and can never be read by the worker, so we
 * fail them fast with a clear message instead of trying to fetch a path-shaped
 * key from the bucket.
 */
export function resolveStorageKey(jobData: AllureImportJobData): string {
  if (jobData.storageKey) return jobData.storageKey;
  throw new Error(
    'Legacy Allure import job has no storageKey (uploaded before the Supabase Storage migration). Please re-upload the file.',
  );
}

/**
 * Download an Allure import object from storage and return its bytes as a Buffer.
 * Throws on any storage error — callers handle the failure (mark job failed,
 * emit ws event, etc.) the same way they used to handle ENOENT.
 */
export async function downloadAllureObject(storageKey: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage
    .from(ALLURE_IMPORTS_BUCKET)
    .download(storageKey);

  if (error || !data) {
    throw new Error(
      `Failed to download Allure object: ${error?.message || 'unknown error'} (key=${storageKey})`,
    );
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Best-effort cleanup: remove the object after the worker is done with it.
 * Failures are logged but never thrown — they don't affect import success.
 */
export async function removeAllureObject(storageKey: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.storage
      .from(ALLURE_IMPORTS_BUCKET)
      .remove([storageKey]);

    if (error) {
      logger.warn('[AllureImport] Failed to remove storage object (non-fatal)', {
        storageKey,
        error: error.message,
      });
      return;
    }

    logger.debug('[AllureImport] Removed storage object', { storageKey });
  } catch (e) {
    logger.warn('[AllureImport] Storage remove threw (non-fatal)', {
      storageKey,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
