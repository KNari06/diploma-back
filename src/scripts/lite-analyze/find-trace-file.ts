/**
 * find-trace-file — locate a LiteTraceWriter JSONL file by testId.
 *
 * The writer stores files as:
 *   {logsDir}/{YYYY-MM-DD}_{HH-MM-SS}_{sanitized_testId}.jsonl
 *
 * Where sanitized_testId replaces non-alphanumeric chars with underscores and
 * caps at 80 chars. See LiteTraceWriter.sanitizeFilePart in
 * src/agent/core/lite/trace/lite-trace-writer.ts.
 *
 * Strategy:
 *   1. Sanitize the user-provided testId the same way the writer does
 *   2. Scan the logs dir for filenames containing that sanitized form
 *   3. Pick the most recently modified match (helps when a test is retried)
 *
 * This is a CLI utility — no runtime imports from the hot path. Safe to
 * use fs.promises directly.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** Default logs directory, mirrors LiteTraceWriter.DEFAULT_LOGS_DIR */
export const DEFAULT_LOGS_DIR = path.join(process.cwd(), 'test_logs');

/**
 * Sanitize a testId into the form used by LiteTraceWriter.sanitizeFilePart.
 * Keep in sync with that method — we use the same char set and length cap.
 */
export function sanitizeTestId(input: string): string {
  const safe = (input || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
  return safe.length > 0 ? safe : 'unknown';
}

/**
 * Find the most recently modified trace file for the given testId.
 *
 * @param testId  raw testId as the user knows it (uuid, name, etc.)
 * @param logsDir optional override (default: test_logs/ in cwd)
 * @returns absolute path to the matching JSONL file, or null if none found
 */
export async function findTraceFile(
  testId: string,
  logsDir: string = DEFAULT_LOGS_DIR,
): Promise<string | null> {
  if (!testId || testId.trim() === '') {
    throw new Error('testId is required');
  }

  let entries: string[];
  try {
    entries = await fs.readdir(logsDir);
  } catch (error) {
    const errCode = (error as NodeJS.ErrnoException).code;
    if (errCode === 'ENOENT') {
      return null; // directory doesn't exist yet → no traces
    }
    throw error;
  }

  const sanitized = sanitizeTestId(testId);
  const matching = entries.filter(
    (name) => name.endsWith('.jsonl') && name.includes(sanitized),
  );

  if (matching.length === 0) {
    return null;
  }

  // Prefer the most recently modified file. Stat every candidate so we
  // don't guess based on filename (which encodes creation time but not
  // last-write time — relevant if a test is re-run under the same id).
  const withStats = await Promise.all(
    matching.map(async (name) => {
      const fullPath = path.join(logsDir, name);
      try {
        const stat = await fs.stat(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs };
      } catch {
        // Racing deletion — skip
        return null;
      }
    }),
  );

  const valid = withStats.filter((x): x is { path: string; mtimeMs: number } => x !== null);
  if (valid.length === 0) return null;

  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return valid[0].path;
}

/**
 * List all trace files in the logs dir, most recent first. Used when the
 * user passes --list or provides no testId.
 */
export async function listTraceFiles(
  logsDir: string = DEFAULT_LOGS_DIR,
  limit: number = 20,
): Promise<Array<{ path: string; mtimeMs: number; sizeBytes: number }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(logsDir);
  } catch (error) {
    const errCode = (error as NodeJS.ErrnoException).code;
    if (errCode === 'ENOENT') return [];
    throw error;
  }

  const jsonlFiles = entries.filter((name) => name.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonlFiles.map(async (name) => {
      const fullPath = path.join(logsDir, name);
      try {
        const stat = await fs.stat(fullPath);
        return { path: fullPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
      } catch {
        return null;
      }
    }),
  );

  const valid = withStats.filter(
    (x): x is { path: string; mtimeMs: number; sizeBytes: number } => x !== null,
  );
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return valid.slice(0, limit);
}
