/**
 * Allure File Classifier
 *
 * Two-phase classification for files inside an Allure ZIP:
 *
 * Phase 1 — Deterministic (free, instant):
 *   Uses filename patterns, paths, and basic JSON structure checks
 *   to handle all clearly identifiable file types without any AI calls.
 *
 * Phase 2 — AI Classification (GPT-4.1 Mini):
 *   Only triggered for files that are genuinely ambiguous after phase 1.
 *   Files are batched (≤15 per prompt) to minimise API calls.
 *   GPT returns category, kb_worthy flag, and a short summary per file.
 */

import path from 'path';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import type { AllureFileCategory, ClassifiedFile } from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum characters of file content sent to AI for classification. */
const AI_PREVIEW_CHARS = 2000;

/** Maximum files sent in one AI batch prompt (keeps prompt under 30K tokens). */
const AI_BATCH_SIZE = 15;

/**
 * Image extensions — always skipped (screenshots not imported).
 * Allure supports: image/png, image/jpeg, image/gif, image/bmp, image/svg+xml, image/tiff.
 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.tiff', '.tif']);

/**
 * Video extensions — always skipped.
 * Common formats attached by Allure adapters.
 */
const VIDEO_EXTS = new Set(['.webm', '.mp4', '.ogg', '.avi', '.mov']);

/**
 * Text-based extensions that may contain valuable documentation.
 * Allure attaches these as step/test-level artifacts.
 * Includes formats documented in Allure: text/csv, text/tab-separated-values,
 * application/json, application/xml, application/yaml, text/plain, text/html.
 */
const TEXT_EXTS = new Set([
  '.txt', '.log', '.html', '.json', '.xml', '.csv', '.tsv',
  '.har', '.yaml', '.yml', '.md', '.markdown',
]);

/**
 * Filenames / path segments that always belong to the generated report UI.
 * These should never be imported.
 */
const SKIP_EXACT_NAMES = new Set([
  'index.html', 'app.js', 'styles.css', 'favicon.ico',
  'app.css', 'vendor.js',
]);

const SKIP_PATH_PREFIXES = [
  'plugins/', 'export/', 'history/', 'static/',
  'data/test-cases/', // generated per-test detail pages
];

const SKIP_PATH_SEGMENTS = ['plugins', 'export'];

/** Metadata filenames that carry environment/CI info. */
const METADATA_EXACT = new Set([
  'categories.json',
  'environment.properties',
  'environment.xml',
  'executor.json',
]);

/** Path patterns that indicate structure / summary data. */
const STRUCTURE_PATH_PATTERNS = [
  'data/suites',
  'data/behaviors',
  'data/packages',
  'data/timeline',
  'data/categories',
  'data/graph',
  'widgets/summary',
  'widgets/environment',
  'widgets/categories',
  'widgets/severity',
  'widgets/status-chart',
  'widgets/trend',
  'widgets/duration',
  'widgets/suites',
];

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Deterministic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to classify a file using only its path, extension, and
 * a lightweight JSON structure check (for result/container files).
 *
 * Returns `null` when the file is genuinely ambiguous and needs AI.
 */
function classifyDeterministic(
  filePath: string,
  filename: string,
  textPreview?: string,
): AllureFileCategory | null {
  const ext = path.extname(filename).toLowerCase();
  const lowerPath = filePath.toLowerCase();
  const lowerName = filename.toLowerCase();

  // ── Always skip: generated report UI and history ──────────────────────
  if (SKIP_EXACT_NAMES.has(lowerName)) return 'skip';

  for (const prefix of SKIP_PATH_PREFIXES) {
    if (lowerPath.includes(prefix)) return 'skip';
  }

  for (const seg of SKIP_PATH_SEGMENTS) {
    // Match full path segment (avoids matching "plugins" inside a longer word)
    if (lowerPath.split('/').includes(seg)) return 'skip';
  }

  // ── Always skip: videos ───────────────────────────────────────────────
  if (VIDEO_EXTS.has(ext)) return 'video';

  // ── Metadata files ────────────────────────────────────────────────────
  if (METADATA_EXACT.has(lowerName)) return 'metadata';

  // ── Structure/summary files (generated report data) ───────────────────
  for (const pattern of STRUCTURE_PATH_PATTERNS) {
    if (lowerPath.includes(pattern)) return 'structure';
  }

  // ── Images — always skip (screenshots not imported) ─────────────────
  if (IMAGE_EXTS.has(ext)) return 'skip';

  // ── Test result JSON: filename must end with -result.json ─────────────
  if (lowerName.endsWith('-result.json')) {
    // Quick sanity check: content should start with '{' and contain expected keys
    if (textPreview) {
      const trimmed = textPreview.trim();
      if (trimmed.startsWith('{') && (trimmed.includes('"uuid"') || trimmed.includes('"name"'))) {
        return 'test_result';
      }
      // Filename pattern is strong enough — accept even without content validation
    }
    return 'test_result';
  }

  // ── Container JSON: filename must end with -container.json ────────────
  if (lowerName.endsWith('-container.json')) {
    if (textPreview) {
      const trimmed = textPreview.trim();
      if (trimmed.startsWith('{') && (trimmed.includes('"uuid"') || trimmed.includes('"children"'))) {
        return 'container';
      }
    }
    return 'container';
  }

  // ── Attachment-named files (contain "-attachment." in the filename) ────
  // These are binary or text files explicitly attached to test steps.
  if (lowerName.includes('-attachment.')) {
    if (IMAGE_EXTS.has(ext)) return 'skip';
    if (VIDEO_EXTS.has(ext))      return 'video';
    if (TEXT_EXTS.has(ext))       return null; // send to AI — may be doc or noise
    // Unknown binary extension → skip
    return 'skip';
  }

  // ── Non-attachment JSON that isn't result/container ───────────────────
  // Could be API responses, configs, widget data — send to AI
  if (ext === '.json') return null;

  // ── Plain text extensions with no other indicator ─────────────────────
  if (TEXT_EXTS.has(ext)) return null;

  // ── Anything else (binaries, unknown types) ───────────────────────────
  return 'skip';
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: AI classification
// ─────────────────────────────────────────────────────────────────────────────

interface AIFileClassification {
  filename: string;
  /**
   * Category:
   * - documentation  → goes to KB (markdown docs, API refs, test plans, readmes)
   * - test_log       → goes to KB but needs heavy cleaning (console output, CI logs)
   * - api_response   → goes to KB (HTTP response bodies, OpenAPI dumps)
   * - page_snapshot  → goes to KB (HTML page captures)
   * - config         → goes to KB (environment configs, setup files)
   * - noise          → skip (repetitive stack traces, binary-looking content, empty)
   */
  category: 'documentation' | 'test_log' | 'api_response' | 'page_snapshot' | 'config' | 'noise';
  /** True if the cleaned content is worth saving to the Knowledge Base. */
  kb_worthy: boolean;
  /** One-sentence description of what this file contains. */
  summary: string;
}

interface AIBatchResponse {
  files: AIFileClassification[];
}

/**
 * Send a batch of ambiguous files to GPT-4.1 Mini for classification.
 * Returns a map from filename → classification result.
 */
async function classifyBatchWithAI(
  files: Array<{ filename: string; textPreview: string }>,
): Promise<Map<string, AIFileClassification>> {
  const results = new Map<string, AIFileClassification>();

  if (files.length === 0) return results;

  const fileList = files
    .map((f, i) => {
      const preview = f.textPreview.slice(0, AI_PREVIEW_CHARS);
      return `### File ${i + 1}: ${f.filename}\n\`\`\`\n${preview}\n\`\`\``;
    })
    .join('\n\n');

  const systemPrompt = `You classify files extracted from an Allure test report ZIP archive.
Allure is a popular test reporting framework (Java/Python/JS/C#). Its ZIP contains:
- *-result.json / *-container.json (already handled — you will NOT see these)
- Text attachments (logs, API responses, HTML snapshots, configs, docs)
- Generated report UI files (noise — should be skipped)

You receive files that passed deterministic classification but are AMBIGUOUS.
Your job: decide the category and whether the file is worth saving to our QA Knowledge Base.

## Categories

| Category | What it is | kb_worthy? |
|---|---|---|
| documentation | Human-written docs, test plans, README, markdown, wiki exports, changelogs | Usually YES |
| test_log | Automated test output, console logs, CI runner output, assertion results, pytest/JUnit output | YES if contains failures, key events, or unique info. NO if repetitive pass logs |
| api_response | HTTP response bodies, GraphQL responses, REST payloads, OpenAPI/Swagger specs, HAR files | YES if contains endpoint schemas, error responses. NO if just "200 OK" with empty body |
| page_snapshot | HTML snapshots of web pages captured during tests (contains <html>, <body>, DOM) | YES only if contains meaningful UI content (forms, errors). NO if just boilerplate/nav |
| config | Environment config, .properties, .yml/.yaml setup files, Docker/CI configs | YES if contains test env details. NO if generic/default config |
| noise | Minified JS/CSS, empty/near-empty, binary-looking base64 blobs, repeated stack traces, generated Allure report UI assets | Always NO |

## Rules
1. When in doubt → noise (better to skip than pollute KB with junk)
2. Files <50 chars of meaningful text → noise
3. Minified code (single long line, no whitespace) → noise
4. Allure report UI files (app.js, styles.css, widgets) → noise
5. Stack traces repeated >3 times → noise (keep one occurrence → test_log)

## Response format
Respond with ONLY this JSON object:
{
  "files": [
    {
      "filename": "<exact filename from input>",
      "category": "<documentation|test_log|api_response|page_snapshot|config|noise>",
      "kb_worthy": true/false,
      "summary": "<10 words max>"
    }
  ]
}
Return one entry per input file. The "filename" must match EXACTLY.`;

  const userPrompt = `Classify these ${files.length} files:\n\n${fileList}`;

  try {
    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model: AI_TASK_MODELS.allureClassify,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      },
    );

    const rawContent = response.content?.replace(/```json\s*|```\s*/g, '').trim() ?? '';
    const parsed: AIBatchResponse = JSON.parse(rawContent);

    if (Array.isArray(parsed.files)) {
      for (const item of parsed.files) {
        if (item.filename) {
          results.set(item.filename, item);
        }
      }
    }
  } catch (error) {
    logger.error('[AllureClassifier] AI classification batch failed', {
      filesCount: files.length,
      error: error instanceof Error ? error.message : String(error),
    });
    // On failure, treat all files in this batch as 'skip' (handled by caller)
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for the classifier — one entry per file in the ZIP.
 */
export interface ClassifierInput {
  path: string;
  filename: string;
  /** Text content (decoded as UTF-8). Undefined for binary files. */
  textContent?: string;
}

/**
 * Classify all files from an Allure ZIP.
 *
 * 1. Runs deterministic rules on every file (cheap, instant).
 * 2. Sends ambiguous files to GPT-4.1 Mini in batches of ≤15.
 * 3. Returns a `ClassifiedFile` for every input entry.
 */
export async function classifyAllureFiles(
  inputs: ClassifierInput[],
): Promise<ClassifiedFile[]> {
  const classified: ClassifiedFile[] = [];
  const needsAI: Array<{ input: ClassifierInput; index: number }> = [];

  // ── Phase 1: Deterministic ─────────────────────────────────────────────
  for (const input of inputs) {
    const textPreview = input.textContent?.slice(0, AI_PREVIEW_CHARS);
    const detResult = classifyDeterministic(input.path, input.filename, textPreview);

    if (detResult !== null) {
      classified.push({
        path: input.path,
        filename: input.filename,
        category: detResult,
        textPreview,
      });
    } else {
      // Mark slot as placeholder (will be filled after AI)
      const idx = classified.length;
      classified.push({
        path: input.path,
        filename: input.filename,
        category: 'skip', // temporary — overwritten after AI
        textPreview,
      });
      needsAI.push({ input, index: idx });
    }
  }

  logger.info('[AllureClassifier] Phase 1 complete', {
    total: inputs.length,
    classified: classified.length - needsAI.length,
    needsAI: needsAI.length,
  });

  if (needsAI.length === 0) return classified;

  // ── Phase 2: AI classification in batches ──────────────────────────────
  const batches: Array<typeof needsAI> = [];
  for (let i = 0; i < needsAI.length; i += AI_BATCH_SIZE) {
    batches.push(needsAI.slice(i, i + AI_BATCH_SIZE));
  }

  logger.info('[AllureClassifier] Phase 2: AI classification', {
    needsAI: needsAI.length,
    batches: batches.length,
  });

  for (const batch of batches) {
    const aiInputs = batch.map(({ input }) => ({
      filename: input.filename,
      textPreview: input.textContent?.slice(0, AI_PREVIEW_CHARS) ?? '',
    }));

    const aiResults = await classifyBatchWithAI(aiInputs);

    for (const { input, index } of batch) {
      const aiResult = aiResults.get(input.filename);

      if (!aiResult) {
        // AI didn't return a result for this file — treat as skip
        classified[index] = {
          path: input.path,
          filename: input.filename,
          category: 'skip',
          textPreview: input.textContent?.slice(0, AI_PREVIEW_CHARS),
        };
        continue;
      }

      // Map AI category → AllureFileCategory
      let category: AllureFileCategory;
      if (!aiResult.kb_worthy) {
        category = 'skip';
      } else {
        category = 'documentation';
      }

      // Preserve the granular AI category so the KB processor can group files
      // correctly. Only set for kb_worthy files (noise → already mapped to skip).
      const granularCategory = aiResult.kb_worthy
        ? (aiResult.category as 'documentation' | 'test_log' | 'api_response' | 'page_snapshot' | 'config')
        : undefined;

      classified[index] = {
        path: input.path,
        filename: input.filename,
        category,
        textPreview: input.textContent?.slice(0, AI_PREVIEW_CHARS),
        aiSummary: aiResult.summary,
        aiCategory: granularCategory,
        kbWorthy: aiResult.kb_worthy,
      };
    }
  }

  const summary = classified.reduce<Record<string, number>>((acc, f) => {
    acc[f.category] = (acc[f.category] ?? 0) + 1;
    return acc;
  }, {});

  logger.info('[AllureClassifier] Classification complete', { summary });

  return classified;
}
