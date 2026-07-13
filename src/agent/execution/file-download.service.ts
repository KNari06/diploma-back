/**
 * File Download Service (V6)
 *
 * Downloads files from public URLs to a temp directory for use with
 * Playwright's setInputFiles(). Used by the upload step type.
 */

import axios from 'axios';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '@/utils/core/logger';

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const DOWNLOAD_TIMEOUT_MS = 60_000; // 60 seconds

export interface DownloadResult {
  localPath: string;
  filename: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * Download a file from a public URL to a temp directory.
 * Returns the local file path for use with Playwright setInputFiles().
 */
export async function downloadFileForUpload(
  fileUrl: string,
  options?: {
    filename?: string;
    maxSizeBytes?: number;
    timeoutMs?: number;
  }
): Promise<DownloadResult> {
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;

  logger.info('[FILE_DOWNLOAD] Starting download', {
    url: fileUrl.substring(0, 200),
    maxSizeMB: Math.round(maxSize / 1024 / 1024),
  });

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fileUrl);
  } catch {
    throw new Error(`Invalid file URL: ${fileUrl}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol}. Only http/https allowed.`);
  }

  // Download with size limit enforcement
  const response = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxContentLength: maxSize,
    maxBodyLength: maxSize,
    headers: {
      'User-Agent': 'QAI-TestRunner/1.0',
    },
  });

  const buffer = Buffer.from(response.data);
  if (buffer.length > maxSize) {
    throw new Error(
      `File too large: ${Math.round(buffer.length / 1024 / 1024)}MB exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit`
    );
  }

  // Determine filename.
  // SECURITY: both sources are untrusted — options.filename comes from
  // client/LLM-authored step content (IntentStep.options.upload.filename) or a
  // client-echoed WS payload (preview:recording:upload:resolve), and the URL
  // path is attacker-influenced too. A `../`-laden name would escape the
  // mkdtemp dir and let the fetched buffer be written to an arbitrary path.
  // Sanitise the FINAL name to a bare basename (no separators) before it ever
  // touches a filesystem path — same guard as the chat-upload temp path.
  const contentType = response.headers['content-type'];
  const urlFilename = path.basename(parsedUrl.pathname) || 'upload-file';
  const rawFilename = options?.filename || urlFilename;
  const filename = path.basename(rawFilename).replace(/[/\\]/g, '').slice(0, 128) || 'upload-file';

  // Create temp directory and write file
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qai-upload-'));
  const localPath = path.join(tempDir, filename);
  await fs.writeFile(localPath, buffer);

  logger.info('[FILE_DOWNLOAD] Download complete', {
    localPath,
    filename,
    sizeBytes: buffer.length,
    contentType,
  });

  return {
    localPath,
    filename,
    sizeBytes: buffer.length,
    contentType,
  };
}

/**
 * Clean up a temp file created by downloadFileForUpload.
 * Silently ignores errors (best-effort cleanup).
 */
export async function cleanupUploadTempFile(localPath: string): Promise<void> {
  try {
    const dir = path.dirname(localPath);
    await fs.rm(dir, { recursive: true, force: true });
    logger.debug('[FILE_DOWNLOAD] Temp file cleaned up', { localPath });
  } catch (error) {
    logger.debug('[FILE_DOWNLOAD] Temp file cleanup failed (non-critical)', {
      localPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
