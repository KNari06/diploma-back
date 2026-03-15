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

/** Screenshot image extensions. */
const SCREENSHOT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg']);

/** Video extensions — always skipped. */
const VIDEO_EXTS = new Set(['.webm', '.mp4', '.ogg', '.avi', '.mov']);

/** Text-based extensions that may contain valuable documentation. */
const TEXT_EXTS = new Set([
  '.txt', '.log', '.html', '.json', '.xml', '.csv',
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

  // ── Screenshots / images ─────────────────────────────────────────────
  if (SCREENSHOT_EXTS.has(ext)) return 'screenshot';

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
    if (SCREENSHOT_EXTS.has(ext)) return 'screenshot';
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

  const systemPrompt = `You are a file content classifier for a QA test management platform.
You will receive a list of files extracted from an Allure test report archive.
For each file, determine its content type and whether it should be saved to a Knowledge Base.

Respond with a JSON object in this exact format:
{
  "files": [
    {
      "filename": "<exact filename>",
      "category": "<one of: documentation | test_log | api_response | page_snapshot | config | noise>",
      "kb_worthy": <true|false>,
      "summary": "<one sentence description>"
    }
  ]
}

Category definitions:
- documentation: human-written docs, test plans, README files, wiki exports, markdown
- test_log: automated test output, console logs, CI runner output, assertion traces
- api_response: HTTP response bodies, GraphQL responses, REST payloads, OpenAPI specs
- page_snapshot: HTML snapshots of web pages captured during test execution
- config: environment config, setup scripts, properties files, build configs
- noise: repetitive/redundant content, near-empty files, binary-looking text, minified JS/CSS

kb_worthy = true means the content adds real value to a QA knowledge base (not noise/duplicates).`;

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
