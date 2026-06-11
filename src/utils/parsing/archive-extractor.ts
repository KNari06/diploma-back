/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHIVE EXTRACTOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unpacks a .zip / .tar.gz archive (in memory, from a Buffer) and concatenates
 * the relevant Python source files into a single annotated blob that the
 * existing Python adapter can parse as one "script".
 *
 * Never writes to disk. Reads from buffers only. Guards against zip-slip and
 * zip-bombs via path filtering and entry/byte caps.
 */

import zlib from 'zlib';
import AdmZip from 'adm-zip';
import * as tarStream from 'tar-stream';
import { logger } from '../core/logger';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Default cap on the combined blob — aligned with chat's MAX_EXTRACTED_TEXT_LENGTH. */
export const DEFAULT_ARCHIVE_COMBINED_CAP = 50_000;

/** Per-file byte cap — a single huge .py is almost never a hand-written client. */
const MAX_FILE_BYTES = 200_000;
/** Zip-bomb guards. */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB

/** Directory fragments that are never source-of-interest. */
const SKIP_DIR_FRAGMENTS = [
  'node_modules/',
  '.git/',
  '__pycache__/',
  'venv/',
  '.venv/',
  'site-packages/',
  'dist/',
  'build/',
  '.egg-info/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export interface ArchiveExtractionResult {
  combined: string;
  fileCount: number;
  includedFiles: string[];
  truncated: boolean;
  skipped: string[];
}

interface RawEntry {
  path: string;
  content: string;
}

/**
 * Is this upload an archive we can unpack? Checks extension and common mimetypes.
 */
export function isArchive(fileName?: string, mimeType?: string): boolean {
  const name = (fileName || '').toLowerCase();
  if (name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.tar')) {
    return true;
  }
  const mt = (mimeType || '').toLowerCase();
  return [
    'application/zip',
    'application/x-zip-compressed',
    'application/gzip',
    'application/x-gzip',
    'application/x-tar',
  ].includes(mt);
}

/**
 * Extract relevant Python source from an archive buffer into one annotated blob.
 * @throws if the archive can't be read or contains no .py files.
 */
export async function extractPythonFromArchive(
  buffer: Buffer,
  fileName: string,
  combinedCap: number = DEFAULT_ARCHIVE_COMBINED_CAP,
): Promise<ArchiveExtractionResult> {
  const lower = (fileName || '').toLowerCase();
  const isGzTar = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const isPlainTar = lower.endsWith('.tar');

  const entries = isGzTar
    ? await readTarGz(buffer)
    : isPlainTar
      ? await readTar(buffer)
      : readZip(buffer);

  // Filter to relevant .py files (drop entries whose bytes weren't valid UTF-8 → empty)
  const relevant = entries.filter(
    e => e.content && e.path.toLowerCase().endsWith('.py') && !shouldSkipPath(e.path),
  );

  if (relevant.length === 0) {
    throw new Error(
      'No Python (.py) source files found in the archive. ' +
        'Make sure the archive contains a Python project (requests / httpx / aiohttp / urllib / pytest).',
    );
  }

  // Relevance ordering: core source first, tests last
  relevant.sort((a, b) => relevanceRank(a.path) - relevanceRank(b.path));

  // Concatenate with file headers until the cap is hit
  const includedFiles: string[] = [];
  const skipped: string[] = [];
  let combined = '';
  let truncated = false;

  for (const entry of relevant) {
    const block = `# === file: ${entry.path} ===\n${entry.content}\n\n`;
    if (combined.length + block.length > combinedCap) {
      truncated = true;
      skipped.push(entry.path);
      continue; // keep checking — a later (smaller) file might still fit
    }
    combined += block;
    includedFiles.push(entry.path);
  }

  // If the very first (most relevant) file alone exceeds the cap, include a truncated slice
  if (includedFiles.length === 0 && relevant.length > 0) {
    const first = relevant[0];
    combined = `# === file: ${first.path} (truncated) ===\n${first.content.slice(0, combinedCap)}\n`;
    includedFiles.push(first.path);
    truncated = true;
    skipped.push(...relevant.slice(1).map(e => e.path));
  }

  logger.info('[ARCHIVE_EXTRACTOR] Extracted Python from archive', {
    fileName,
    format: isGzTar ? 'tar.gz' : isPlainTar ? 'tar' : 'zip',
    included: includedFiles.length,
    skipped: skipped.length,
    truncated,
  });

  return {
    combined,
    fileCount: includedFiles.length,
    includedFiles,
    truncated,
    skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// READERS
// ─────────────────────────────────────────────────────────────────────────────

function readZip(buffer: Buffer): RawEntry[] {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`Could not read the .zip archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const out: RawEntry[] = [];
  let kept = 0;
  let totalBytes = 0;

  for (const entry of zip.getEntries()) {
    if (kept >= MAX_ENTRIES) break; // budget counts KEPT .py files, not junk scanned past
    if (entry.isDirectory) continue;

    const path = normalizeEntryPath(entry.entryName);
    if (!path) continue; // zip-slip / absolute — skip
    if (!path.toLowerCase().endsWith('.py')) continue;
    if (shouldSkipPath(path)) continue;

    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) continue;
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Archive is too large to process (exceeds uncompressed size limit).');
    }

    kept++;
    out.push({ path, content: decodeUtf8(data) });
  }

  return out;
}

async function readTarGz(buffer: Buffer): Promise<RawEntry[]> {
  // Stream the gunzip so a compression bomb (tiny .gz → many GB) is aborted at
  // the cap instead of being fully materialized by gunzipSync first.
  const gunzip = zlib.createGunzip();
  let decompressed = 0;
  gunzip.on('data', (c: Buffer) => {
    decompressed += c.length;
    if (decompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      gunzip.destroy(new Error('Archive is too large to process (exceeds uncompressed size limit).'));
    }
  });
  return readTarEntries((extract) => {
    gunzip.on('error', (err) => extract.destroy(err));
    gunzip.pipe(extract);
    gunzip.end(buffer);
  }, 'Could not decompress the .tar.gz archive');
}

async function readTar(buffer: Buffer): Promise<RawEntry[]> {
  return readTarEntries((extract) => extract.end(buffer), 'Could not read the tar archive');
}

/**
 * Shared tar-entry reader. `feed` wires bytes into the extractor (directly for a
 * plain tar, or via a bounded gunzip for .tar.gz). Keeps only relevant .py files,
 * counting KEPT entries (not scanned) so a junk-front-loaded archive can't
 * exhaust the entry budget before reaching real source.
 */
function readTarEntries(
  feed: (extract: ReturnType<typeof tarStream.extract>) => void,
  errPrefix: string,
): Promise<RawEntry[]> {
  return new Promise<RawEntry[]>((resolve, reject) => {
    const out: RawEntry[] = [];
    let kept = 0;
    let totalBytes = 0;
    const extract = tarStream.extract();

    extract.on('entry', (header, stream, next) => {
      const path = header.type === 'file' ? normalizeEntryPath(header.name) : null;
      const keep =
        kept < MAX_ENTRIES && !!path && path.toLowerCase().endsWith('.py') && !shouldSkipPath(path);

      if (!keep) {
        stream.resume();
        return next();
      }
      kept++;

      const chunks: Buffer[] = [];
      let size = 0;
      let oversize = false;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_FILE_BYTES) {
          oversize = true;
          return;
        }
        chunks.push(c);
      });
      stream.on('end', () => {
        if (!oversize) {
          totalBytes += size;
          if (totalBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
            return reject(new Error('Archive is too large to process (exceeds uncompressed size limit).'));
          }
          out.push({ path: path as string, content: decodeUtf8(Buffer.concat(chunks)) });
        }
        next();
      });
      stream.on('error', next);
    });

    extract.on('finish', () => resolve(out));
    extract.on('error', (err) => reject(new Error(`${errPrefix}: ${err.message}`)));

    feed(extract);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize an archive entry path; return null for unsafe paths (zip-slip).
 * Exported for unit testing the path-traversal guard directly (high-level zip
 * libs sanitize on write, so a malicious entry can't be reproduced via addFile).
 */
export function normalizeEntryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) return null; // absolute
  if (p.split('/').some(seg => seg === '..')) return null; // traversal
  return p;
}

/**
 * Decode bytes as strict UTF-8. A `.py`-named binary or non-UTF8 source would
 * otherwise become replacement-char mojibake fed to the LLM; on failure we
 * return '' so the (empty) block contributes nothing rather than garbage.
 */
function decodeUtf8(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return '';
  }
}

function shouldSkipPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SKIP_DIR_FRAGMENTS.some(frag => lower.includes(frag));
}

/**
 * Lower rank = included first / kept under truncation.
 * Core client/config source ranks above generic source; tests rank last.
 */
function relevanceRank(path: string): number {
  const lower = path.toLowerCase();
  const isTest = /(^|\/)tests?\//.test(lower) || /(^|\/)test_[^/]*\.py$/.test(lower) || /_test\.py$/.test(lower);
  if (isTest) return 30;
  if (/(client|config|api|http|base|session|auth|settings|conftest)/.test(lower)) return 10;
  return 20;
}
