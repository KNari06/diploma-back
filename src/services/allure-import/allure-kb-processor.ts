/**
 * Allure KB Processor
 *
 * Processes documentation files extracted from an Allure ZIP and stores them
 * in the project Knowledge Base.  Wraps the existing KB pipeline with three
 * critical safety fixes:
 *
 *  1. Batched embeddings   — generateEmbeddings() crashes for >100 chunks;
 *                            we split into batches of 95 with 3-attempt retry.
 *  2. Batched DB inserts   — PostgREST 10 MB limit; insert in batches of 50.
 *  3. Duplicate detection  — skip files whose file_name is already in the KB.
 *
 * Additionally:
 *  - AI preprocessing (GPT-4.1 Mini) cleans HTML, strips noise, summarises logs
 *    before KB ingestion.
 *  - Categorically similar files are grouped into a single logical KB document
 *    (e.g. all test logs → "Allure Test Logs — YYYY-MM-DD").
 */

import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { chunkText, chunkMarkdown } from '@/utils/text-processing/chunking';
import { generateEmbeddings } from '@/services/ai/core/embedding.service';
import type { DocumentationFile } from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum chunks per embeddings batch (safe limit — API crashes at >100). */
const EMBED_BATCH_SIZE = 95;

/** Maximum records per Supabase insert (keep payload under PostgREST 10 MB). */
const INSERT_BATCH_SIZE = 50;

/** Maximum content length sent to AI for preprocessing (tokens ~ chars/4). */
const AI_PREPROCESS_CHARS = 12_000;

/** Max attempts for each embedding batch. */
const EMBED_RETRY_ATTEMPTS = 3;

/** Delay between sequential AI preprocessing calls (ms) to avoid rate-limit spikes. */
const AI_PREPROCESS_DELAY_MS = 200;

/** Page size for paginating existing KB file names. */
const KB_FILES_PAGE_SIZE = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// AI preprocessing
// ─────────────────────────────────────────────────────────────────────────────

interface PreprocessResult {
  cleanedContent: string;
  documentTitle: string;
  isNoise: boolean;
}

/**
 * Send a documentation file's content to GPT-4.1 Mini for AI preprocessing:
 *  - Strip HTML tags / scripts / CSS
 *  - Remove noise (ANSI codes, PID timestamps, base64 blobs)
 *  - Summarise test logs (keep key events, failures, assertions)
 *  - Extract schema/error details from API responses
 *
 * Returns `isNoise: true` if the model determines the content has no value.
 */
async function preprocessDocContent(
  filename: string,
  rawContent: string,
  aiCategory?: string,
): Promise<PreprocessResult> {
  const preview = rawContent.slice(0, AI_PREPROCESS_CHARS);

  const systemPrompt = `You preprocess files from Allure test reports for a QA Knowledge Base (KB).
The KB is used by QA engineers and AI agents to understand test patterns, debug failures, and learn about the tested application.

## Your task
Clean the file content so it's useful for future retrieval. The cleaned content will be chunked, embedded, and stored for semantic search.

## Cleaning rules by category

### test_log (console output, CI logs, pytest/JUnit output)
- KEEP: assertion failures, error messages, failed test names, exception types, HTTP status codes
- KEEP: timing info for slow tests (>5s)
- REMOVE: repetitive "PASSED" lines (keep count: "47 tests passed")
- REMOVE: ANSI escape codes (\\x1b[...), PID/thread prefixes, timestamps on every line
- REMOVE: duplicate stack frames (keep first occurrence only)
- SUMMARISE: if >20 similar pass entries → "X tests passed in module Y"

### api_response (HTTP response bodies, HAR, OpenAPI)
- KEEP: endpoint URL/path, HTTP method, status code, response schema/structure
- KEEP: error response bodies in full
- KEEP: authentication requirements, rate limit headers
- REMOVE: large binary payloads, base64 images
- For HAR files: extract unique endpoints + status codes, discard duplicate requests

### page_snapshot (HTML captures)
- EXTRACT: visible text content, form labels, button text, error messages, page title
- REMOVE: all <script>, <style>, <svg>, <noscript> blocks
- REMOVE: HTML boilerplate (doctype, meta, link tags)
- KEEP: form structure (input names, types, placeholders) — useful for test creation

### config (environment, properties, YAML)
- KEEP: all key-value pairs as-is (they're already clean)
- REMOVE: comments that are just separators (####, //--)
- FORMAT: as "key: value" list, one per line

### documentation (markdown, README, test plans)
- KEEP: almost everything — this is already high-value content
- REMOVE: table of contents if it's just link anchors
- FIX: broken markdown formatting if obvious

## Output rules
- Output cleaned_content as PLAIN TEXT or MARKDOWN (not HTML)
- Maximum 4000 chars for cleaned_content (truncate with "[...truncated]" if needed)
- document_title: descriptive, specific, max 60 chars.
  Good: "Login API — 401 error responses", "Checkout flow — form validation rules"
  Bad: "Log file", "Response", "Test output"
- Set is_noise=true ONLY if <30 chars of meaningful content remain after cleaning

## Response format
{
  "cleaned_content": "<cleaned text in markdown>",
  "document_title": "<specific descriptive title, max 60 chars>",
  "is_noise": false
}`;

  const userPrompt = `File: ${filename}\nCategory hint: ${aiCategory ?? 'unknown'}\n\nContent:\n${preview}`;

  try {
    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model: AI_TASK_MODELS.allurePreprocess,
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      },
    );

    const raw = response.content?.replace(/```json\s*|```\s*/g, '').trim() ?? '{}';

    let parsed: { cleaned_content?: string; document_title?: string; is_noise?: boolean };
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('[AllureKBProcessor] AI response JSON parse failed (truncated?)', {
        filename,
        contentLength: raw.length,
      });
      // Fallback: use raw content as-is
      return { cleanedContent: rawContent, documentTitle: filename, isNoise: false };
    }

    return {
      cleanedContent: parsed.cleaned_content?.trim() ?? rawContent,
      documentTitle: parsed.document_title?.trim() ?? filename,
      isNoise: parsed.is_noise === true,
    };
  } catch (err) {
    logger.warn('[AllureKBProcessor] AI preprocessing failed, using raw content', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback: use raw content as-is
    return {
      cleanedContent: rawContent,
      documentTitle: filename,
      isNoise: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a set of unique file_name values that already exist in the project KB.
 *
 * Uses a Supabase RPC-style approach to avoid fetching one row per chunk
 * (a single document with 50 chunks would return 50 rows with the same name).
 * We use a simple query with LIMIT/OFFSET but build a Set to deduplicate.
 *
 * For Allure imports, the number of distinct file_name values is small
 * (one per doc group per import run), so we only need the distinct names
 * that match the "Allure" prefix to keep the result set minimal.
 */
async function getExistingKBFileNames(projectId: string): Promise<Set<string>> {
  const names = new Set<string>();

  try {
    // Fetch only file names that start with "Allure" — the only ones this
    // processor creates. This avoids scanning the entire KB.
    const { data, error } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('file_name')
      .eq('project_id', projectId)
      .like('file_name', 'Allure%')
      .limit(KB_FILES_PAGE_SIZE);

    if (error) {
      logger.warn('[AllureKBProcessor] Could not fetch existing KB files', {
        error: error.message,
      });
      return names;
    }

    for (const row of data ?? []) {
      names.add(row.file_name as string);
    }
  } catch (err) {
    logger.warn('[AllureKBProcessor] KB file name fetch error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched embedding helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate embeddings in batches of EMBED_BATCH_SIZE.
 * Each batch is retried up to EMBED_RETRY_ATTEMPTS times on failure.
 * Returns a flat array aligned with the input texts array.
 */
async function generateEmbeddingsSafe(texts: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    let success = false;

    for (let attempt = 1; attempt <= EMBED_RETRY_ATTEMPTS; attempt++) {
      try {
        const embeddings = await generateEmbeddings(batch);
        for (let j = 0; j < batch.length; j++) {
          results[i + j] = embeddings[j] ?? null;
        }
        success = true;
        break;
      } catch (err) {
        const delay = attempt * 1000; // simple linear backoff: 1s, 2s, 3s
        logger.warn('[AllureKBProcessor] Embedding batch failed, retrying', {
          batchStart: i,
          batchSize: batch.length,
          attempt,
          delay,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt < EMBED_RETRY_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    if (!success) {
      logger.error('[AllureKBProcessor] Embedding batch permanently failed, skipping', {
        batchStart: i,
        batchSize: batch.length,
      });
      // Leave results as null for this batch — they'll be filtered out before insert
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batched DB insert helper
// ─────────────────────────────────────────────────────────────────────────────

interface KBChunkRecord {
  content: string;
  embedding: string; // JSON-stringified number[]
  file_name: string;
  project_id: string;
  metadata: Record<string, unknown>;
  uploaded_by: string;
}

/**
 * Insert KB chunk records into Supabase in safe batches of INSERT_BATCH_SIZE.
 * Failures within a batch are logged and skipped (partial success is OK).
 *
 * Returns the total number of successfully inserted records.
 */
async function insertChunksSafe(records: KBChunkRecord[]): Promise<number> {
  let insertedCount = 0;

  for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
    const batch = records.slice(i, i + INSERT_BATCH_SIZE);

    const { error } = await supabaseAdmin
      .from('project_kb_chunks')
      .insert(batch);

    if (error) {
      logger.error('[AllureKBProcessor] DB insert batch failed', {
        batchStart: i,
        batchSize: batch.length,
        error: error.message,
      });
      // Continue with next batch
    } else {
      insertedCount += batch.length;
    }
  }

  return insertedCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping helpers
// ─────────────────────────────────────────────────────────────────────────────

type DocGroup = 'test_log' | 'api_response' | 'page_snapshot' | 'env_config' | 'documentation';

function resolveGroup(filename: string, aiCategory?: string): DocGroup {
  const cat = aiCategory?.toLowerCase() ?? '';
  const lname = filename.toLowerCase();

  if (cat === 'test_log' || /\.log$/.test(lname)) return 'test_log';
  if (cat === 'api_response') return 'api_response';
  if (cat === 'page_snapshot') return 'page_snapshot';
  if (cat === 'config' || lname.endsWith('.properties') || lname.endsWith('.yml') || lname.endsWith('.yaml')) return 'env_config';
  return 'documentation';
}

/**
 * Build a stable, unique-per-import label for a doc group.
 *
 * Previously the label was just `"<Group> — <YYYY-MM-DD>"`, which collided
 * for any user running two imports on the same day: the second import saw
 * the first import's KB document name already present and silently skipped
 * the entire group. Adding a short importId suffix makes each run distinct
 * while keeping the human-readable date for KB browsing.
 */
function groupLabel(group: DocGroup, importDateLabel: string, importId: string): string {
  // 8-char prefix is enough to avoid collisions for the per-day KB list and
  // short enough not to dominate the visible name.
  const idShort = (importId || '').replace(/-/g, '').slice(0, 8) || 'unknown';
  const labels: Record<DocGroup, string> = {
    test_log:      `Allure Test Logs — ${importDateLabel} #${idShort}`,
    api_response:  `Allure API Responses — ${importDateLabel} #${idShort}`,
    page_snapshot: `Allure Page Snapshots — ${importDateLabel} #${idShort}`,
    env_config:    `Allure Environment — ${importDateLabel} #${idShort}`,
    documentation: `Allure Documentation — ${importDateLabel} #${idShort}`,
  };
  return labels[group];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface KBProcessorResult {
  /** Number of KB documents (logical file entries) created. */
  documentsCreated: number;
  /** Number of individual KB chunks inserted. */
  chunksInserted: number;
  /** Files skipped (noise or duplicate). */
  filesSkipped: number;
  /** Non-fatal error messages. */
  errors: string[];
}

/**
 * Process documentation files extracted from an Allure ZIP and ingest them
 * into the project Knowledge Base.
 *
 * @param docs       - Documentation files from AllureParser output
 * @param projectId  - QAIT project to attach documents to
 * @param userId     - User performing the import (stored as uploaded_by)
 * @param importId   - Import run ID (used in file names to keep runs separate)
 */
export async function processAllureDocumentation(
  docs: DocumentationFile[],
  projectId: string,
  userId: string,
  importId: string,
): Promise<KBProcessorResult> {
  const result: KBProcessorResult = {
    documentsCreated: 0,
    chunksInserted: 0,
    filesSkipped: 0,
    errors: [],
  };

  if (docs.length === 0) {
    logger.info('[AllureKBProcessor] No documentation files to process');
    return result;
  }

  logger.info('[AllureKBProcessor] Starting KB processing', {
    docCount: docs.length,
    projectId,
    importId,
  });

  // ── 1. Duplicate detection ────────────────────────────────────────────────
  const existingFiles = await getExistingKBFileNames(projectId);
  const importDateLabel = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── 2. AI preprocessing — runs in series to avoid rate-limit spikes ───────
  type ProcessedDoc = {
    filename: string;
    cleanedContent: string;
    documentTitle: string;
    group: DocGroup;
  };

  const processedDocs: ProcessedDoc[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    try {
      const { cleanedContent, documentTitle, isNoise } =
        await preprocessDocContent(doc.filename, doc.rawContent, doc.aiCategory);

      if (isNoise || !cleanedContent.trim()) {
        logger.debug('[AllureKBProcessor] Skipping noise file', {
          filename: doc.filename,
        });
        result.filesSkipped++;
      } else {
        processedDocs.push({
          filename: doc.filename,
          cleanedContent,
          documentTitle,
          group: resolveGroup(doc.filename, doc.aiCategory),
        });
      }
    } catch (err) {
      const msg = `Failed to preprocess ${doc.filename}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error('[AllureKBProcessor] ' + msg);
      result.errors.push(msg);
      result.filesSkipped++;
    }

    // Small delay between AI calls to avoid rate-limit spikes (skip after last item)
    if (i < docs.length - 1) {
      await new Promise((r) => setTimeout(r, AI_PREPROCESS_DELAY_MS));
    }
  }

  // ── 3. Group files by category ────────────────────────────────────────────
  const groups = new Map<DocGroup, ProcessedDoc[]>();
  for (const doc of processedDocs) {
    const list = groups.get(doc.group) ?? [];
    list.push(doc);
    groups.set(doc.group, list);
  }

  // ── 4. Process each group → chunk → embed → insert ───────────────────────
  for (const [group, groupDocs] of groups) {
    const kbFileName = groupLabel(group, importDateLabel, importId);

    // Skip if this logical document was already imported in a previous run
    if (existingFiles.has(kbFileName)) {
      logger.info('[AllureKBProcessor] Skipping duplicate KB document', {
        kbFileName,
      });
      result.filesSkipped += groupDocs.length;
      continue;
    }

    // Merge all docs in the group into a single text
    const mergedContent = groupDocs
      .map((d) => `## ${d.documentTitle}\n\n${d.cleanedContent}`)
      .join('\n\n---\n\n');

    // Chunk — use markdown chunker for docs that start with '#'
    const isMarkdown = mergedContent.trimStart().startsWith('#');
    const chunks = isMarkdown
      ? chunkMarkdown(mergedContent, kbFileName)
      : chunkText(mergedContent, { fileName: kbFileName });

    if (chunks.length === 0) {
      result.filesSkipped += groupDocs.length;
      continue;
    }

    logger.info('[AllureKBProcessor] Processing group', {
      group,
      kbFileName,
      docsInGroup: groupDocs.length,
      chunks: chunks.length,
    });

    // Generate embeddings (safe batched)
    const texts = chunks.map((c) => c.content);
    const embeddings = await generateEmbeddingsSafe(texts);

    // Build records — skip any chunk where embedding failed
    const records: KBChunkRecord[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = embeddings[i];
      if (!embedding) continue;

      records.push({
        content: chunks[i].content,
        embedding: JSON.stringify(embedding),
        file_name: kbFileName,
        project_id: projectId,
        metadata: {
          sectionTitle: chunks[i].metadata?.sectionTitle,
          chunkIndex: chunks[i].chunkIndex,
          totalChunks: chunks[i].totalChunks,
          tokenCount: chunks[i].tokenCount,
          fileType: group,
          importId,
          sourceFiles: groupDocs.map((d) => d.filename),
        },
        uploaded_by: userId,
      });
    }

    if (records.length === 0) {
      logger.warn('[AllureKBProcessor] No valid records to insert for group', {
        group,
        kbFileName,
      });
      continue;
    }

    // Insert in safe batches
    const inserted = await insertChunksSafe(records);

    if (inserted > 0) {
      result.documentsCreated++;
      result.chunksInserted += inserted;

      logger.info('[AllureKBProcessor] Group ingested into KB', {
        group,
        kbFileName,
        chunks: inserted,
      });
    } else {
      const msg = `KB insert failed for group "${group}" (${kbFileName})`;
      result.errors.push(msg);
    }
  }

  logger.info('[AllureKBProcessor] KB processing complete', {
    documentsCreated: result.documentsCreated,
    chunksInserted: result.chunksInserted,
    filesSkipped: result.filesSkipped,
    errors: result.errors.length,
  });

  return result;
}
