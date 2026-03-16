/**
 * Allure Screenshot Storage Service
 *
 * Uploads screenshot buffers extracted from an Allure ZIP to Supabase Storage
 * and returns a map from source filename → public URL.
 *
 * Storage path format:
 *   allure-imports/{projectId}/{importId}/{sanitized_filename}
 *
 * Features:
 *  - Skips files > MAX_SCREENSHOT_BYTES (5 MB) to guard against accidental bloat
 *  - Concurrent uploads via Promise.allSettled (10 at a time)
 *  - Returns partial results — individual failures don't abort the batch
 */

import path from 'path';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { env } from '@/config/environment/env';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BUCKET = env.SUPABASE_BUCKET_NAME;

/** Skip screenshots larger than 5 MB. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** Maximum concurrent uploads to avoid exhausting Supabase connection pool. */
const UPLOAD_CONCURRENCY = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a filename for safe storage path usage.
 * Preserves extension, replaces special chars with underscores.
 */
function sanitizeFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${base}${ext}`;
}

/**
 * Infer content-type from a file extension.
 */
function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.bmp':  'image/bmp',
    '.svg':  'image/svg+xml',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenshotUploadResult {
  /** Number of screenshots successfully uploaded. */
  uploaded: number;
  /** Number of screenshots skipped (too large, upload error). */
  skipped: number;
  /** Maps source filename (from ZIP) → public Supabase Storage URL. */
  urlMap: Map<string, string>;
  /** Non-fatal error messages per failed file. */
  errors: string[];
}

/**
 * Upload screenshots from an Allure ZIP to Supabase Storage.
 *
 * @param screenshotFilenames - Source filenames to upload (from classification)
 * @param attachmentBuffers   - Map from source filename → raw buffer
 * @param projectId           - QAIT project ID (used in storage path)
 * @param importId            - Import run ID (used in storage path for isolation)
 */
export async function uploadAllureScreenshots(
  screenshotFilenames: string[],
  attachmentBuffers: Map<string, Buffer>,
  projectId: string,
  importId: string,
): Promise<ScreenshotUploadResult> {
  const result: ScreenshotUploadResult = {
    uploaded: 0,
    skipped: 0,
    urlMap: new Map(),
    errors: [],
  };

  if (screenshotFilenames.length === 0) {
    logger.info('[AllureStorage] No screenshots to upload');
    return result;
  }

  logger.info('[AllureStorage] Starting screenshot upload', {
    count: screenshotFilenames.length,
    projectId,
    importId,
  });

  // Process in concurrent batches
  for (let i = 0; i < screenshotFilenames.length; i += UPLOAD_CONCURRENCY) {
    const batch = screenshotFilenames.slice(i, i + UPLOAD_CONCURRENCY);

    const batchResults = await Promise.allSettled(
      batch.map(async (sourceFilename) => {
        const buf = attachmentBuffers.get(sourceFilename);

        if (!buf) {
          throw new Error(`Buffer not found for ${sourceFilename}`);
        }

        if (buf.length > MAX_SCREENSHOT_BYTES) {
          throw new Error(
            `Screenshot too large (${(buf.length / 1024 / 1024).toFixed(1)} MB > 5 MB): ${sourceFilename}`,
          );
        }

        const safe = sanitizeFilename(sourceFilename);
        const storagePath = `allure-imports/${projectId}/${importId}/${safe}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(storagePath, buf, {
            contentType: inferContentType(sourceFilename),
            upsert: true,   // Idempotent — safe to re-run the import
            cacheControl: '3600',
          });

        if (uploadError) {
          throw new Error(`Upload failed for ${sourceFilename}: ${uploadError.message}`);
        }

        const { data: urlData } = supabaseAdmin.storage
          .from(BUCKET)
          .getPublicUrl(storagePath);

        return { sourceFilename, publicUrl: urlData.publicUrl };
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === 'fulfilled') {
        const { sourceFilename, publicUrl } = settled.value;
        result.urlMap.set(sourceFilename, publicUrl);
        result.uploaded++;
      } else {
        const errMsg = settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
        result.errors.push(errMsg);
        result.skipped++;
        logger.warn('[AllureStorage] Screenshot upload skipped', { error: errMsg });
      }
    }
  }

  logger.info('[AllureStorage] Screenshot upload complete', {
    uploaded: result.uploaded,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}
