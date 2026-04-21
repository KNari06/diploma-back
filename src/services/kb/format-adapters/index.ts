/**
 * Project KB ingestion router
 *
 * One entry point: `ingestFile(filePath, originalName)`.
 *   1. Read the raw file once.
 *   2. Run structured-format adapters in priority order (most specific first).
 *      The first to `detect()` wins and produces structured chunks.
 *   3. Fall back to the generic chunker (markdown / text) for anything else.
 *
 * Output shape is always the same — IngestResult with `format`, `chunks`,
 * `summary`. The caller doesn't care which adapter produced it.
 */

import { promises as fs } from 'fs';
import { logger } from '@/utils/core/logger';
import { chunkMarkdown, chunkText, type TextChunk } from '@/utils/text-processing/chunking';
import { getFileSizeMB, isValidFileType, parseFile } from '@/utils/parsing/fileParser';
import { openApiAdapter } from './openapi.adapter';
import { postmanAdapter } from './postman.adapter';
import type { AdapterChunk, FormatAdapter, ProjectKBFormat } from './types';

export type { ProjectKBFormat } from './types';

export interface IngestedChunk {
  content: string;
  sectionTitle?: string;
  /**
   * Per-chunk metadata: includes the structured fields the adapter produced
   * (http_method, path, operation_id, …) plus chunkIndex/totalChunks/tokenCount.
   * Stored in project_kb_chunks.metadata.
   */
  metadata: Record<string, unknown>;
}

export interface IngestResult {
  format: ProjectKBFormat;
  summary: string;
  chunks: IngestedChunk[];
  /** Aggregate metadata for logs and UI */
  stats: {
    fileType: string;
    chunkCount: number;
    totalTokens: number;
  };
}

const STRUCTURED_ADAPTERS: FormatAdapter[] = [openApiAdapter, postmanAdapter];

/**
 * Ingest a file from disk into retrieval-ready chunks.
 * Caller is responsible for validating and cleaning up the file.
 * Throws on: missing file, invalid extension, oversized, empty content.
 */
export async function ingestFile(
  filePath: string,
  originalName: string,
  maxFileSizeMB = 10
): Promise<IngestResult> {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid filePath');
  }
  if (!originalName || typeof originalName !== 'string') {
    throw new Error('Invalid originalName');
  }
  if (!isValidFileType(originalName)) {
    throw new Error('Invalid file type. Supported: txt, pdf, docx, json, md, yaml, yml');
  }

  const sizeMB = await getFileSizeMB(filePath);
  if (sizeMB > maxFileSizeMB) {
    throw new Error(`File too large (${sizeMB.toFixed(1)} MB). Max ${maxFileSizeMB} MB.`);
  }

  // Try structured adapters on TEXT-LIKE files only. PDFs / DOCX go straight
  // to the generic parser — OpenAPI inside a PDF is too rare to handle specially.
  const ext = originalName.split('.').pop()?.toLowerCase() || '';
  const isTextLike = ['json', 'yaml', 'yml', 'txt', 'md', 'markdown'].includes(ext);

  if (isTextLike) {
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (raw.trim().length === 0) {
      throw new Error('File is empty');
    }

    for (const adapter of STRUCTURED_ADAPTERS) {
      try {
        if (!adapter.detect(originalName, raw)) continue;
        const result = adapter.extract(originalName, raw);

        // Guard: adapter ran but returned nothing usable — fall through to generic.
        if (!result.chunks || result.chunks.length === 0) {
          logger.warn('[KB_INGEST] Structured adapter matched but produced no chunks, falling back', {
            adapter: adapter.name,
            fileName: originalName,
          });
          break;
        }

        const ingested = toIngestedChunks(result.chunks, adapter.name);

        logger.info('[KB_INGEST] Structured adapter used', {
          fileName: originalName,
          adapter: adapter.name,
          summary: result.summary,
          chunkCount: ingested.length,
        });

        return {
          format: adapter.name,
          summary: result.summary,
          chunks: ingested,
          stats: {
            fileType: adapter.name,
            chunkCount: ingested.length,
            totalTokens: ingested.reduce((s, c) => s + Number(c.metadata.tokenCount ?? 0), 0),
          },
        };
      } catch (err) {
        // Structured parse failed — log and fall through to generic
        logger.warn('[KB_INGEST] Structured adapter failed, falling back to generic', {
          adapter: adapter.name,
          fileName: originalName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Generic fallback: reuse existing parseFile + chunker
  const parsed = await parseFile(filePath, originalName);
  if (!parsed.content || parsed.content.trim().length === 0) {
    throw new Error('File content is empty after parsing');
  }

  const genericChunks: TextChunk[] =
    parsed.metadata.fileType === 'markdown'
      ? chunkMarkdown(parsed.content, originalName)
      : chunkText(parsed.content, { fileName: originalName });

  if (genericChunks.length === 0) {
    throw new Error('No content to process');
  }

  const ingested = genericChunks.map<IngestedChunk>((c) => ({
    content: c.content,
    sectionTitle: c.metadata.sectionTitle,
    metadata: {
      format: 'generic' as ProjectKBFormat,
      chunkIndex: c.chunkIndex,
      totalChunks: c.totalChunks,
      tokenCount: c.tokenCount,
      sectionTitle: c.metadata.sectionTitle,
      parent_id: c.parentId,
      parent_text: c.parentText,
      fileType: parsed.metadata.fileType,
      pageCount: parsed.metadata.pageCount,
    },
  }));

  return {
    format: 'generic',
    summary: `${parsed.metadata.fileType} · ${ingested.length} chunks · ${parsed.metadata.wordCount} words`,
    chunks: ingested,
    stats: {
      fileType: parsed.metadata.fileType,
      chunkCount: ingested.length,
      totalTokens: ingested.reduce((s, c) => s + Number(c.metadata.tokenCount ?? 0), 0),
    },
  };
}

function toIngestedChunks(adapterChunks: AdapterChunk[], format: ProjectKBFormat): IngestedChunk[] {
  const total = adapterChunks.length;
  return adapterChunks.map((c, idx) => {
    const contentLen = typeof c.content === 'string' ? c.content.length : 0;
    return {
      content: c.content,
      sectionTitle: c.sectionTitle,
      metadata: {
        ...(c.metadata ?? {}),
        format,
        chunkIndex: idx,
        totalChunks: total,
        // Crude token estimate — structured adapters rarely need precise counts,
        // and tiktoken per chunk on ~50 endpoints is wasted work.
        tokenCount: Math.ceil(contentLen / 4),
        sectionTitle: c.sectionTitle,
      },
    };
  });
}
