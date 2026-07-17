/**
 * Allure Parser
 *
 * Reads a raw ZIP Buffer and produces AllureParsedData:
 *  - Unzips all entries using adm-zip (already in project dependencies)
 *  - Runs the classifier on every file
 *  - Parses *-result.json and *-container.json files
 *  - Deduplicates parameterised tests by testCaseId
 *  - Builds container → result UUID linkage map
 *  - Parses environment.properties and executor.json
 *  - Returns DocumentationFile[] for the KB processor
 */

import AdmZip from 'adm-zip';
import path from 'path';
import { logger } from '@/utils/core/logger';
import { classifyAllureFiles, type ClassifierInput } from './allure-classifier';
import { adaptReportTestCases, isReportTestCasePath } from './allure-report-adapter';
import type {
  AllureParsedData,
  AllureTestResult,
  AllureContainer,
  AllureClassificationSummary,
  AllureImportMetadata,
  DocumentationFile,
} from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum ZIP entry size we will load into memory for parsing (50 MB per file). */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

/** Maximum text size for documentation files sent to KB. */
const MAX_DOC_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Cap on TOTAL uncompressed bytes for one ZIP. Multer caps the *compressed*
 * upload at 100 MB, but a malicious ZIP can have a 1:10000+ ratio (zip-bomb
 * pattern: 100 MB compressed → 1 TB uncompressed of repeated zeros). Without
 * this guard the worker happily decompresses entry-by-entry and OOMs.
 *
 * 500 MB of uncompressed data is a generous cap for a real Allure report
 * (typical reports are 5–50 MB once unpacked); anything over that is either
 * a bomb or content we couldn't usefully process anyway.
 */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a Java .properties file into a key-value map.
 * Lines starting with '#' or '!' are comments.
 */
function parseProperties(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const eqIndex = trimmed.indexOf('=');
    const colonIndex = trimmed.indexOf(':');
    let sepIndex = -1;
    if (eqIndex !== -1 && (colonIndex === -1 || eqIndex <= colonIndex)) {
      sepIndex = eqIndex;
    } else if (colonIndex !== -1) {
      sepIndex = colonIndex;
    }
    if (sepIndex === -1) {
      result[trimmed] = '';
    } else {
      const key = trimmed.slice(0, sepIndex).trim();
      const value = trimmed.slice(sepIndex + 1).trim();
      if (key) result[key] = value;
    }
  }
  return result;
}

/**
 * Safely parse a JSON string.  Returns null on any error.
 */
function safeParseJSON<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Decode a ZIP entry buffer to UTF-8 string.
 * Returns null if the entry is larger than MAX_ENTRY_BYTES or looks binary.
 */
function decodeTextEntry(buf: Buffer): string | null {
  if (buf.length > MAX_ENTRY_BYTES) return null;

  // Quick binary heuristic: check for null bytes in first 512 bytes
  const sample = buf.subarray(0, 512);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return null; // binary file
  }

  return buf.toString('utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse an Allure results ZIP buffer into structured data.
 *
 * @param zipBuffer - Raw Buffer from multer / BullMQ job data.
 * @returns AllureParsedData ready to be consumed by the mapper, KB processor,
 *          and storage service.
 * @throws If the buffer is not a valid ZIP file.
 */
export async function parseAllureZip(zipBuffer: Buffer): Promise<AllureParsedData> {
  logger.info('[AllureParser] Starting ZIP parse', { sizeBytes: zipBuffer.length });

  // ── 1. Unzip ─────────────────────────────────────────────────────────────
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new Error(
      `Failed to open ZIP file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entries = zip.getEntries();
  logger.info('[AllureParser] ZIP entries found', { count: entries.length });

  // ── 2. Build classifier inputs ────────────────────────────────────────────
  const classifierInputs: ClassifierInput[] = [];
  const entryBufferMap = new Map<string, Buffer>(); // normalised path → buffer
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryPath = entry.entryName.replace(/\\/g, '/');
    const filename = path.basename(entryPath);

    // Defensive size check BEFORE decompressing. adm-zip exposes the
    // uncompressed size via `header.size`; if it claims this single entry
    // alone would blow MAX_ENTRY_BYTES we skip without ever touching its
    // bytes. Catches the worst zip-bomb case (one entry expanding to GBs)
    // without paying the decompression cost.
    const declaredSize = entry.header?.size ?? 0;
    if (declaredSize > MAX_ENTRY_BYTES) {
      logger.warn('[AllureParser] Skipping over-sized ZIP entry', {
        entryPath,
        declaredSize,
        cap: MAX_ENTRY_BYTES,
      });
      continue;
    }

    // Hard cap on cumulative uncompressed bytes — see MAX_TOTAL_UNCOMPRESSED_BYTES
    // doc for rationale (zip-bomb DoS guard). Stop the whole parse with a
    // clear error so the caller marks the import failed rather than silently
    // truncating to a partial report.
    if (totalUncompressedBytes + declaredSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `ZIP exceeds maximum uncompressed size of ${Math.round(MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024)} MB ` +
        `(reached at "${entryPath}"). Refusing to process — possible zip bomb.`,
      );
    }

    // Read raw buffer (lazily — adm-zip decompresses on demand)
    let buf: Buffer;
    try {
      buf = entry.getData();
    } catch {
      logger.warn('[AllureParser] Failed to read ZIP entry', { entryPath });
      continue;
    }

    // Real (post-decompress) size — counted toward the cap. We re-check
    // here because `header.size` is just metadata; a malicious archive
    // could lie about it.
    if (buf.length > MAX_ENTRY_BYTES) {
      logger.warn('[AllureParser] Decompressed entry exceeded per-file cap, dropping', {
        entryPath,
        actualSize: buf.length,
      });
      continue;
    }
    totalUncompressedBytes += buf.length;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error(
        `ZIP exceeds maximum uncompressed size of ${Math.round(MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024)} MB ` +
        `(reached after "${entryPath}"). Refusing to process — possible zip bomb.`,
      );
    }

    entryBufferMap.set(entryPath, buf);

    // Attempt to decode as text for the classifier
    const textContent = decodeTextEntry(buf) ?? undefined;

    classifierInputs.push({ path: entryPath, filename, textContent });
  }

  logger.info('[AllureParser] ZIP unpacked', {
    entriesAccepted: entryBufferMap.size,
    totalUncompressedMB: Math.round(totalUncompressedBytes / 1024 / 1024),
  });

  // ── 3. Classify all files ─────────────────────────────────────────────────
  const classified = await classifyAllureFiles(classifierInputs);

  // ── 4. Process by category ────────────────────────────────────────────────
  const rawResults: AllureTestResult[] = [];
  const rawContainers: AllureContainer[] = [];
  const documentation: DocumentationFile[] = [];
  let videosSkipped = 0;
  let filesSkipped = 0;
  const metadataRaw: AllureImportMetadata = {};

  for (const file of classified) {
    const buf = entryBufferMap.get(file.path);
    if (!buf) continue;

    switch (file.category) {
      // ── Test results ───────────────────────────────────────────────────
      case 'test_result': {
        const text = buf.toString('utf-8');
        const parsed = safeParseJSON<AllureTestResult>(text);
        if (!parsed || !parsed.uuid) {
          logger.warn('[AllureParser] Skipping malformed result file', { path: file.path });
          filesSkipped++;
          break;
        }

        // Resolve name: name → fullName → filename-derived fallback
        const resolvedName = parsed.name
          || parsed.fullName?.split('.').pop()
          || file.filename.replace(/-result\.json$/i, '');

        if (!resolvedName) {
          logger.warn('[AllureParser] Skipping result with no name', { path: file.path });
          filesSkipped++;
          break;
        }

        // Ensure required arrays are present
        rawResults.push({
          ...parsed,
          name: resolvedName,
          labels: parsed.labels ?? [],
          links: parsed.links ?? [],
          parameters: parsed.parameters ?? [],
          steps: parsed.steps ?? [],
          attachments: parsed.attachments ?? [],
        });
        break;
      }

      // ── Containers (fixtures) ─────────────────────────────────────────
      case 'container': {
        const text = buf.toString('utf-8');
        const parsed = safeParseJSON<AllureContainer>(text);
        if (!parsed || !parsed.uuid) {
          logger.warn('[AllureParser] Skipping malformed container file', { path: file.path });
          filesSkipped++;
          break;
        }
        rawContainers.push({
          ...parsed,
          children: parsed.children ?? [],
          befores: parsed.befores ?? [],
          afters: parsed.afters ?? [],
        });
        break;
      }

      // ── Documentation ─────────────────────────────────────────────────
      case 'documentation': {
        if (buf.length > MAX_DOC_TEXT_BYTES) {
          logger.warn('[AllureParser] Documentation file too large, truncating', {
            filename: file.filename,
            sizeBytes: buf.length,
          });
        }
        const rawContent = buf
          .subarray(0, MAX_DOC_TEXT_BYTES)
          .toString('utf-8');

        documentation.push({
          filename: file.filename,
          rawContent,
          // aiCategory carries the granular label from the AI classifier
          // (test_log, api_response, page_snapshot, config, documentation)
          aiCategory: file.aiCategory,
        });
        break;
      }

      // ── Metadata ──────────────────────────────────────────────────────
      case 'metadata': {
        const lowerName = file.filename.toLowerCase();
        const text = buf.toString('utf-8');

        if (lowerName === 'environment.properties' || lowerName === 'environment.xml') {
          try {
            metadataRaw.environment = parseProperties(text);
          } catch (e) {
            logger.warn('[AllureParser] Failed to parse environment.properties', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        } else if (lowerName === 'executor.json') {
          const parsed = safeParseJSON<AllureImportMetadata['executor']>(text);
          if (parsed) metadataRaw.executor = parsed;
        } else if (lowerName === 'categories.json') {
          const parsed = safeParseJSON<AllureImportMetadata['categories']>(text);
          if (Array.isArray(parsed)) metadataRaw.categories = parsed;
        }
        break;
      }

      // ── Video — always skip ───────────────────────────────────────────
      case 'video': {
        videosSkipped++;
        break;
      }

      // ── Skip everything else ──────────────────────────────────────────
      case 'structure':
      case 'skip':
      default: {
        filesSkipped++;
        break;
      }
    }
  }

  logger.info('[AllureParser] Raw extraction complete', {
    results: rawResults.length,
    containers: rawContainers.length,
    documentation: documentation.length,
    videosSkipped,
    filesSkipped,
  });

  // ── 4b. Generated-report fallback ─────────────────────────────────────────
  // The RAW `allure-results/` directory has `*-result.json` files, handled
  // above. But many users upload the GENERATED report (`allure generate`
  // output / the CI-published site) instead, which stores each test under
  // `data/test-cases/<uid>.json` in a different schema. Those files were
  // hard-skipped by the classifier. When we found NO raw results, adapt the
  // report test cases so the import isn't a silent no-op. Guarded on
  // `rawResults.length === 0` so a genuine results ZIP (which never contains
  // `data/test-cases/`) is completely unaffected.
  if (rawResults.length === 0) {
    const reportEntries: Array<{ path: string; json: unknown }> = [];
    for (const [entryPath, buf] of entryBufferMap) {
      if (!isReportTestCasePath(entryPath)) continue;
      const parsed = safeParseJSON(buf.toString('utf-8'));
      if (parsed) reportEntries.push({ path: entryPath, json: parsed });
    }

    if (reportEntries.length > 0) {
      logger.info('[AllureParser] No raw results — falling back to generated-report adapter', {
        reportTestCaseFiles: reportEntries.length,
      });
      const adapted = adaptReportTestCases(reportEntries);
      rawResults.push(...adapted.results);
      rawContainers.push(...adapted.containers);
      // These files were counted as skipped during classification; correct the
      // tally so the stats reflect what actually became test cases.
      filesSkipped = Math.max(0, filesSkipped - reportEntries.length);
    }
  }

  // ── 5. Deduplicate parameterised tests by testCaseId ──────────────────────
  const results = deduplicateResults(rawResults);

  logger.info('[AllureParser] After deduplication', {
    before: rawResults.length,
    after: results.length,
  });

  // ── 6. Build container → result UUID map ──────────────────────────────────
  const containerByResultUuid = buildContainerMap(rawContainers);

  // ── 7. Compose final output ───────────────────────────────────────────────
  const classificationSummary: AllureClassificationSummary = {
    documentation,
    videosSkipped,
    filesSkipped,
  };

  return {
    results,
    containers: rawContainers,
    containerByResultUuid,
    metadata: metadataRaw,
    classified: classificationSummary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deduplicate parameterised tests:
 *  - Group by `testCaseId` (stable hash that ignores parameter values).
 *  - For each group, keep the result with the most steps (most informative).
 *  - Merge parameters from all runs into the kept result.
 *  - Results without a testCaseId are kept as-is.
 */
function deduplicateResults(results: AllureTestResult[]): AllureTestResult[] {
  const withId: Map<string, AllureTestResult[]> = new Map();
  const withoutId: AllureTestResult[] = [];

  for (const result of results) {
    if (result.testCaseId) {
      const existing = withId.get(result.testCaseId) ?? [];
      existing.push(result);
      withId.set(result.testCaseId, existing);
    } else {
      withoutId.push(result);
    }
  }

  const deduped: AllureTestResult[] = [];

  for (const group of withId.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    // Keep the one with the most steps
    group.sort((a, b) => countStepsRecursive(b.steps) - countStepsRecursive(a.steps));
    const representative = group[0];

    // Merge unique parameters from all runs
    const allParams = group.flatMap((r) => r.parameters ?? []);
    const seenParams = new Set<string>();
    const mergedParams = allParams.filter((p) => {
      const key = `${p.name}=${p.value}`;
      if (seenParams.has(key)) return false;
      seenParams.add(key);
      return true;
    });

    deduped.push({ ...representative, parameters: mergedParams });
  }

  return [...deduped, ...withoutId];
}

/** Count all leaf steps recursively. */
function countStepsRecursive(steps: AllureTestResult['steps']): number {
  if (!steps?.length) return 0;
  return steps.reduce((sum, s) => sum + 1 + countStepsRecursive(s.steps ?? []), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Container map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a map from result UUID → the container that lists it as a child.
 * This lets us quickly look up preconditions / teardown for any test result.
 */
function buildContainerMap(
  containers: AllureContainer[],
): Map<string, AllureContainer> {
  const map = new Map<string, AllureContainer>();

  for (const container of containers) {
    for (const childUuid of container.children ?? []) {
      if (childUuid) map.set(childUuid, container);
    }
  }

  return map;
}
