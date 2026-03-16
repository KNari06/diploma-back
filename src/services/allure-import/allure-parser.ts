/**
 * Allure Parser
 *
 * Reads a raw ZIP Buffer and produces AllureParsedData:
 *  - Unzips all entries using adm-zip (already in project dependencies)
 *  - Runs the classifier on every file
 *  - Parses *-result.json and *-container.json files
 *  - Deduplicates parameterised tests by testCaseId
 *  - Builds container → result UUID linkage map
 *  - Collects attachment buffers for screenshots
 *  - Parses environment.properties and executor.json
 *  - Returns DocumentationFile[] for the KB processor
 */

import AdmZip from 'adm-zip';
import path from 'path';
import { logger } from '@/utils/core/logger';
import { classifyAllureFiles } from './allure-classifier';
import type { ClassifierInput } from './allure-classifier';
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

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryPath = entry.entryName.replace(/\\/g, '/');
    const filename = path.basename(entryPath);

    // Read raw buffer (lazily — adm-zip decompresses on demand)
    let buf: Buffer;
    try {
      buf = entry.getData();
    } catch {
      logger.warn('[AllureParser] Failed to read ZIP entry', { entryPath });
      continue;
    }

    entryBufferMap.set(entryPath, buf);

    // Attempt to decode as text for the classifier
    const textContent = decodeTextEntry(buf) ?? undefined;

    classifierInputs.push({ path: entryPath, filename, textContent });
  }

  // ── 3. Classify all files ─────────────────────────────────────────────────
  const classified = await classifyAllureFiles(classifierInputs);

  // ── 4. Process by category ────────────────────────────────────────────────
  const rawResults: AllureTestResult[] = [];
  const rawContainers: AllureContainer[] = [];
  const attachmentBuffers = new Map<string, Buffer>();
  const documentation: DocumentationFile[] = [];
  const screenshots: string[] = [];
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
        if (!parsed || !parsed.uuid || !parsed.name) {
          logger.warn('[AllureParser] Skipping malformed result file', { path: file.path });
          filesSkipped++;
          break;
        }
        // Ensure required arrays are present
        rawResults.push({
          ...parsed,
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

      // ── Screenshots ───────────────────────────────────────────────────
      case 'screenshot': {
        attachmentBuffers.set(file.filename, buf);
        screenshots.push(file.filename);
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
    attachments: attachmentBuffers.size,
    screenshots: screenshots.length,
    documentation: documentation.length,
    videosSkipped,
    filesSkipped,
  });

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
    screenshots,
    documentation,
    videosSkipped,
    filesSkipped,
  };

  return {
    results,
    containers: rawContainers,
    containerByResultUuid,
    attachmentBuffers,
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
