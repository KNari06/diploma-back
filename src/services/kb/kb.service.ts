import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { chunkMarkdown, chunkText } from '@/utils/text-processing/chunking';
import { getFileSizeMB, isValidFileType, parseFile } from '@/utils/parsing/fileParser';
import { logger } from '@/utils/core/logger';
import { promises as fs } from 'fs';
import { generateEmbedding, generateEmbeddings } from '@/services/ai/core/embedding.service';
import { ingestFile, type ProjectKBFormat } from './format-adapters';
import { searchLocalGlobalKBHybrid } from './localKB.service';
import { logRetrievalEvent } from './retrieval-telemetry.service';
import { applyRerank, rerank } from './reranker.service';
import { env } from '@/config/environment/env';

const MAX_FILE_SIZE_MB = 10; // Maximum file size

export interface KBChunk {
  id: string;
  content: string;
  source_file?: string;
  file_name?: string;
  language?: string; // 'en', 'ru', 'neutral'
  tags?: string[];
  /**
   * Parent section slug. Chunks sharing a parent_id belong to the same
   * logical section. Optional — legacy chunks may not have it.
   */
  parent_id?: string;
  /**
   * Full text of the parent section. When set, callers should use this
   * instead of `content` when building the LLM prompt — the small content
   * field is what matched, the parent is what gives GPT enough context.
   */
  parent_text?: string;
  /**
   * Project-KB citation fields (undefined for global KB). Surface these to
   * users so they can trust (or question) why an answer was given.
   */
  file_version?: number;
  file_format?: ProjectKBFormat;
  uploaded_at?: string;
  metadata: any;
  similarity?: number;
  created_at: string;
}

/**
 * Structured citation for a retrieved chunk. Suitable for chat UI
 * ("based on api-spec.yaml v3 uploaded Apr 12").
 */
export interface KBCitation {
  fileName: string;
  fileVersion?: number;
  fileFormat?: ProjectKBFormat;
  uploadedAt?: string;
  sourceFile?: string;
  sectionTitle?: string;
  scope: 'global' | 'project';
}

/**
 * Build citations from retrieved chunks. Dedupes by (scope, fileName, version).
 */
export function buildCitations(chunks: KBChunk[]): KBCitation[] {
  const seen = new Map<string, KBCitation>();
  for (const chunk of chunks) {
    const isProject = !!chunk.file_name;
    const fileName = chunk.file_name || chunk.source_file || '';
    if (!fileName) continue;

    const key = `${isProject ? 'p' : 'g'}::${fileName}::${chunk.file_version ?? ''}`;
    if (seen.has(key)) continue;

    seen.set(key, {
      fileName,
      fileVersion: chunk.file_version,
      fileFormat: chunk.file_format,
      uploadedAt: chunk.uploaded_at,
      sourceFile: chunk.source_file,
      sectionTitle:
        (chunk.metadata && typeof chunk.metadata === 'object'
          ? String(
              (chunk.metadata.sectionTitle ??
                chunk.metadata.section_title ??
                '')
            ) || undefined
          : undefined),
      scope: isProject ? 'project' : 'global',
    });
  }
  return Array.from(seen.values());
}

/**
 * Given a matched chunk, return the best text to send to the LLM.
 * - If the chunk has parent_text bigger than its content → use parent_text.
 * - Otherwise → use content (the chunk IS the whole section, or legacy).
 *
 * Dedup is the caller's job: if two retrieved chunks share a parent_id, the
 * caller should keep only one to avoid sending the same section twice.
 */
export function expandChunkForLLM(chunk: KBChunk): string {
  if (chunk.parent_text && chunk.parent_text.length > chunk.content.length) {
    return chunk.parent_text;
  }
  return chunk.content;
}

export interface KBSearchResult {
  chunks: KBChunk[];
  sources: {
    global: string[];
    project: string[];
  };
  /**
   * Structured citations for UI surfacing. One entry per unique
   * (scope, file, version) retrieved. Order matches retrieval rank.
   */
  citations: KBCitation[];
}

/**
 * Upload and process file for global KB (admin only)
 *
 * @deprecated Global KB is now stored locally in data/global-kb/
 * Use markdown files in data/global-kb/sources/ and run npm run build-kb instead
 *
 * This function is kept for backwards compatibility but not recommended
 */
export async function uploadGlobalKB(
  filePath: string,
  originalName: string,
  tags: string[],
  uploadedBy: string
): Promise<{ success: boolean; chunkCount: number }> {
  try {
    // Validate file
    if (!isValidFileType(originalName)) {
      throw new Error('Invalid file type. Supported: txt, pdf, docx, json, md');
    }

    const fileSizeMB = await getFileSizeMB(filePath);
    if (fileSizeMB > MAX_FILE_SIZE_MB) {
      throw new Error(`File too large. Maximum size: ${MAX_FILE_SIZE_MB}MB`);
    }

    // Parse file
    const parsed = await parseFile(filePath, originalName);
    logger.info('File parsed', { fileName: originalName, wordCount: parsed.metadata.wordCount });

    // Chunk content
    const chunks =
      parsed.metadata.fileType === 'markdown'
        ? chunkMarkdown(parsed.content, originalName)
        : chunkText(parsed.content, { fileName: originalName });

    if (chunks.length === 0) {
      throw new Error('No content to process');
    }

    // Generate embeddings in batch
    const embeddings = await generateEmbeddings(chunks.map((c) => c.content));

    // Validate embeddings count matches chunks count
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embeddings count mismatch: expected ${chunks.length}, got ${embeddings.length}`
      );
    }

    // Validate each embedding has correct dimensions (1536 for text-embedding-3-small)
    const invalidEmbeddings = embeddings.filter(
      (emb) => !emb || !Array.isArray(emb) || emb.length !== 1536
    );
    if (invalidEmbeddings.length > 0) {
      throw new Error(
        `Invalid embeddings found: ${invalidEmbeddings.length} embeddings have incorrect dimensions`
      );
    }

    // Insert into DB
    const records = chunks.map((chunk, idx) => {
      // Validate embedding exists
      if (!embeddings[idx] || !Array.isArray(embeddings[idx])) {
        throw new Error(`Missing or invalid embedding at index ${idx}`);
      }

      return {
        content: chunk.content,
        embedding: JSON.stringify(embeddings[idx]), // Supabase expects JSON string for vector
        source_file: originalName,
        tags: Array.isArray(tags) ? tags : [],
        metadata: {
          ...chunk.metadata,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          tokenCount: chunk.tokenCount,
          fileType: parsed.metadata.fileType,
          pageCount: parsed.metadata.pageCount,
        },
        uploaded_by: uploadedBy,
      };
    });

    const { error } = await supabaseAdmin.from('global_kb_chunks').insert(records);

    if (error) {
      logger.error('[KB_SERVICE] Failed to insert global KB chunks', {
        error: error.message,
        code: error.code,
        recordCount: records.length,
      });
      throw new Error('Database insertion failed');
    }

    // Clean up temp file (if it exists)
    try {
      await fs.unlink(filePath);
    } catch (unlinkError) {
      logger.warn('[KB_SERVICE] Failed to delete temp file', {
        filePath,
        error: unlinkError instanceof Error ? unlinkError.message : String(unlinkError),
      });
      // Don't throw - file cleanup is not critical
    }

    logger.info('[KB_SERVICE] Global KB uploaded successfully', {
      fileName: originalName,
      chunkCount: chunks.length,
    });

    return { success: true, chunkCount: chunks.length };
  } catch (error) {
    logger.error('[KB_SERVICE] Global KB upload failed', {
      error: error instanceof Error ? error.message : String(error),
      fileName: originalName,
    });
    throw error;
  }
}

/**
 * Upload and process file for project KB.
 *
 * Behaviour:
 *   - Detects the file's format (OpenAPI, Postman, generic) and chunks it
 *     accordingly via the format-adapter layer.
 *   - Computes the NEXT version for (project_id, file_name) by reading the
 *     current max, then inserts new-version chunks with is_current=true.
 *   - Atomically flips prior versions to is_current=false via RPC, so the
 *     retrieval path (is_current=true filter) never sees a split-brain.
 *   - Old versions stay in the table for audit / rollback; they just stop
 *     being retrieved.
 */
export async function uploadProjectKB(
  filePath: string,
  originalName: string,
  projectId: string,
  uploadedBy: string
): Promise<{
  success: boolean;
  chunkCount: number;
  format: ProjectKBFormat;
  summary: string;
  fileVersion: number;
  previousVersionsRetired: number;
}> {
  // Validate inputs
  if (!filePath || typeof filePath !== 'string') throw new Error('Invalid filePath');
  if (!originalName || typeof originalName !== 'string') throw new Error('Invalid originalName');
  if (!projectId || typeof projectId !== 'string') throw new Error('Invalid projectId');
  if (!uploadedBy || typeof uploadedBy !== 'string') throw new Error('Invalid uploadedBy');

  // Always clean up the temp file — success OR failure. Controllers stage
  // uploads under /tmp and rely on us (not them) to delete on completion.
  try {
    // Ingest: format detection + structured chunking (or generic fallback)
    const ingest = await ingestFile(filePath, originalName, MAX_FILE_SIZE_MB);

    logger.info('[KB_SERVICE] Project file ingested', {
      fileName: originalName,
      projectId,
      format: ingest.format,
      summary: ingest.summary,
      chunkCount: ingest.chunks.length,
    });

    // Compute NEXT version for this (project_id, file_name)
    const { data: prior, error: priorError } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('file_version')
      .eq('project_id', projectId)
      .eq('file_name', originalName)
      .order('file_version', { ascending: false })
      .limit(1);

    if (priorError) {
      logger.error('[KB_SERVICE] Failed to read prior versions', {
        error: priorError.message,
        code: priorError.code,
        projectId,
        fileName: originalName,
      });
      throw new Error('Version lookup failed');
    }

    const previousVersion = Array.isArray(prior) && prior.length > 0 && typeof prior[0]?.file_version === 'number'
      ? prior[0].file_version
      : 0;
    const newVersion = previousVersion + 1;

    // Generate embeddings in batches — OpenAI caps at 100 inputs per call.
    const texts = ingest.chunks.map((c) => c.content);
    const embeddings: number[][] = [];
    const BATCH = 100;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const batchEmbeds = await generateEmbeddings(batch);
      embeddings.push(...batchEmbeds);
      // Small gap between batches to respect rate limits on large files
      if (i + BATCH < texts.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (embeddings.length !== ingest.chunks.length) {
      throw new Error(`Embeddings count mismatch: ${ingest.chunks.length} chunks, ${embeddings.length} embeddings`);
    }

    const invalidEmbeddings = embeddings.filter(
      (emb) => !emb || !Array.isArray(emb) || emb.length !== 1536
    );
    if (invalidEmbeddings.length > 0) {
      throw new Error(`Invalid embeddings: ${invalidEmbeddings.length} have incorrect dimensions`);
    }

    // Build insert records
    const uploadedAt = new Date().toISOString();
    const records = ingest.chunks.map((chunk, idx) => {
      if (!embeddings[idx]) {
        throw new Error(`Missing embedding at index ${idx}`);
      }
      return {
        project_id: projectId,
        file_name: originalName,
        content: chunk.content,
        embedding: JSON.stringify(embeddings[idx]),
        metadata: {
          ...(chunk.metadata ?? {}),
        },
        uploaded_by: uploadedBy,
        uploaded_at: uploadedAt,
        file_version: newVersion,
        is_current: true,
        format: ingest.format,
      };
    });

    // Insert new-version chunks. If this fails, nothing has changed yet.
    // Unique partial index (project_id, file_name, file_version) WHERE is_current
    // guards against concurrent uploads — the loser hits 23505 (unique_violation)
    // and we translate that into a user-visible "retry" error instead of a
    // confusing 500.
    const { error: insertError } = await supabaseAdmin
      .from('project_kb_chunks')
      .insert(records);

    if (insertError) {
      const isConcurrent = insertError.code === '23505';
      logger.error('[KB_SERVICE] Failed to insert project KB chunks', {
        error: insertError.message,
        code: insertError.code,
        projectId,
        fileName: originalName,
        recordCount: records.length,
        concurrentUpload: isConcurrent,
      });
      if (isConcurrent) {
        throw new Error(
          'Another upload for this file is in progress — please retry in a moment'
        );
      }
      throw new Error('Database insertion failed');
    }

    // Atomically retire older versions. If this fails after a successful
    // insert we have a soft problem (two 'current' versions), so attempt
    // a cleanup before surfacing.
    let previousVersionsRetired = 0;
    if (previousVersion > 0) {
      const { data: flipData, error: flipError } = await supabaseAdmin.rpc(
        'project_kb_flip_previous_versions',
        {
          p_project_id: projectId,
          p_file_name: originalName,
          p_new_version: newVersion,
        }
      );

      if (flipError) {
        logger.error('[KB_SERVICE] Failed to retire previous versions — rolling back new version', {
          error: flipError.message,
          code: flipError.code,
          projectId,
          fileName: originalName,
          newVersion,
        });
        // Best-effort rollback: remove the just-inserted new-version chunks.
        await supabaseAdmin
          .from('project_kb_chunks')
          .delete()
          .eq('project_id', projectId)
          .eq('file_name', originalName)
          .eq('file_version', newVersion);
        throw new Error('Version flip failed — upload rolled back');
      }

      previousVersionsRetired = typeof flipData === 'number' ? flipData : 0;
    }

    logger.info('[KB_SERVICE] Project KB uploaded', {
      fileName: originalName,
      projectId,
      format: ingest.format,
      chunkCount: ingest.chunks.length,
      fileVersion: newVersion,
      previousVersionsRetired,
    });

    return {
      success: true,
      chunkCount: ingest.chunks.length,
      format: ingest.format,
      summary: ingest.summary,
      fileVersion: newVersion,
      previousVersionsRetired,
    };
  } catch (error) {
    logger.error('[KB_SERVICE] Project KB upload failed', {
      error: error instanceof Error ? error.message : String(error),
      fileName: originalName,
      projectId,
    });
    throw error;
  } finally {
    // Clean up temp file on EVERY exit path (success, expected error,
    // unexpected throw). The controller staged it under /tmp and will not
    // clean up itself.
    try {
      await fs.unlink(filePath);
    } catch (unlinkError) {
      // Missing file is fine (already deleted earlier); other errors are
      // not critical enough to mask the original upload result.
      const msg = unlinkError instanceof Error ? unlinkError.message : String(unlinkError);
      if (!msg.includes('ENOENT')) {
        logger.warn('[KB_SERVICE] Failed to delete temp file', {
          filePath,
          error: msg,
        });
      }
    }
  }
}

/**
 * Detect language from user message using AI
 * Falls back to simple heuristic if AI fails
 * @param message - User message to detect language for
 * @returns Detected language: 'en', 'ru', or 'neutral'
 */
export async function detectLanguage(message: string): Promise<'en' | 'ru' | 'neutral'> {
  // Validate input
  if (!message || typeof message !== 'string') {
    return 'neutral';
  }

  // Quick fallback for very short messages
  if (message.trim().length < 3) {
    return 'neutral';
  }

  try {
    // Use AI for accurate language detection
    const result = await detectLanguageWithAI(message);
    return result;
  } catch (error) {
    logger.warn('[KB_SERVICE] AI language detection failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
      message: message.substring(0, 50),
    });

    // Fallback to simple heuristic
    return detectLanguageFallback(message);
  }
}

/**
 * AI-powered language detection
 * @param message - Message to detect language for
 * @returns Detected language
 */
async function detectLanguageWithAI(message: string): Promise<'en' | 'ru' | 'neutral'> {
  // Validate input
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return 'neutral';
  }

  // Truncate message if too long (max 1000 chars for AI call)
  const truncatedMessage = message.length > 1000 ? message.substring(0, 1000) : message;

  const prompt = `Detect the language of this message. Return ONLY the language code.

MESSAGE: "${truncatedMessage}"

RULES:
- If Russian text (Cyrillic) → return "ru"
- If English text (Latin) → return "en"
- If mixed languages → return primary language
- If unclear/symbols/numbers only → return "neutral"

RETURN ONLY: ru, en, or neutral`;

  try {
    const response = await getChatCompletionWithMessages(
      [
        {
          role: 'system',
          content: 'You are a language detection expert. Return only the language code: ru, en, or neutral.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      {
        model: AI_TASK_MODELS.knowledgeBase,
        temperature: 0.1, // Very low for consistent results
        max_tokens: 10, // Just need 1-2 tokens
      }
    );

    if (!response || !response.content) {
      throw new Error('Empty response from AI');
    }

    const detected = response.content.trim().toLowerCase();

    // Validate response
    if (detected === 'ru' || detected === 'en' || detected === 'neutral') {
      return detected;
    }

    // If AI returned something unexpected, use fallback
    logger.warn('[KB_SERVICE] AI returned unexpected language', {
      detected,
      message: message.substring(0, 50),
    });
    return detectLanguageFallback(message);
  } catch (error) {
    logger.warn('[KB_SERVICE] AI language detection error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // Re-throw to trigger fallback in caller
  }
}

/**
 * Simple fallback language detection using regex heuristics
 * @param message - Message to detect language for
 * @returns Detected language
 */
function detectLanguageFallback(message: string): 'en' | 'ru' | 'neutral' {
  // Validate input
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return 'neutral';
  }

  // Simple heuristic: if message contains Cyrillic characters → ru
  const hasCyrillic = /[а-яА-ЯёЁ]/.test(message);
  const hasLatin = /[a-zA-Z]/.test(message);

  if (hasCyrillic && !hasLatin) return 'ru';
  if (hasLatin && !hasCyrillic) return 'en';
  if (hasCyrillic && hasLatin) return 'ru'; // Mixed → prefer Russian

  return 'neutral'; // Numbers, symbols, etc.
}

/**
 * Search KB using RAG (local global KB first, then project KB from Supabase)
 * @param query - Search query
 * @param projectId - Optional project ID for project-specific KB
 * @param options - Search options (threshold, count, language filter)
 * @returns Search results with chunks and sources
 */
export async function searchKB(
  query: string,
  projectId?: string,
  options: {
    matchThreshold?: number;
    matchCount?: number;
    language?: 'en' | 'ru' | 'neutral'; // Filter by language
    /** Telemetry fields — optional, used to attribute retrievals to user/session/message. */
    telemetry?: {
      userId?: string | null;
      sessionId?: string | null;
      callSite?: import('./retrieval-telemetry.service').RetrievalCallSite;
    };
  } = {}
): Promise<KBSearchResult> {
  // Validate inputs
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    logger.warn('[KB_SERVICE] Invalid query in searchKB', { query: typeof query });
    return {
      chunks: [],
      citations: [],
      sources: {
        global: [],
        project: [],
      },
    };
  }

  if (projectId && typeof projectId !== 'string') {
    logger.warn('[KB_SERVICE] Invalid projectId in searchKB', { projectId: typeof projectId });
    projectId = undefined; // Continue without project KB
  }

  const startedAt = Date.now();

  try {
    // Validate and clamp options
    const matchThreshold = Math.max(0, Math.min(1, options.matchThreshold || 0.7));
    const matchCount = Math.max(1, Math.min(100, Math.floor(options.matchCount || 5)));
    const language = options.language && ['en', 'ru', 'neutral'].includes(options.language)
      ? options.language
      : undefined;

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // Validate embedding
    if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length !== 1536) {
      throw new Error('Invalid query embedding generated');
    }

    // Hybrid search: vector (semantic) + BM25 (exact keyword) fused via RRF.
    // Threshold is 0 because RRF produces scores in a different range than
    // cosine — we rely on poolSize + matchCount as the effective cutoff.
    // The `matchThreshold` option is kept for callers that want the old
    // pure-vector behaviour with cosine threshold semantics.
    //
    // When reranker is on, pull a LARGER pool (candidatePoolSize) so the
    // cross-encoder has enough variation to meaningfully reorder. Without
    // this, reranking only 5 items ≈ shuffling deck chairs.
    const rerankerOn = env.KB_RERANKER !== 'off';
    const candidatePoolSize = rerankerOn ? Math.max(matchCount, 20) : matchCount;
    const localGlobalResults = await searchLocalGlobalKBHybrid(query, queryEmbedding, {
      threshold: 0,
      limit: candidatePoolSize,
      language,
      poolSize: rerankerOn ? 30 : 20,
    });

    const globalChunks: KBChunk[] = localGlobalResults.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      source_file: chunk.source_file,
      language: chunk.language,
      tags: chunk.tags,
      parent_id: chunk.parent_id,
      parent_text: chunk.parent_text,
      metadata: chunk.metadata,
      similarity: chunk.similarity,
      created_at: new Date().toISOString(), // Local KB doesn't have created_at
    }));

    // Search project KB if projectId provided
    let projectChunks: KBChunk[] = [];
    if (projectId) {
      try {
        const { data: projectResults, error: projectError } = await supabaseAdmin.rpc('search_project_kb', {
          p_project_id: projectId,
          query_embedding: JSON.stringify(queryEmbedding),
          match_threshold: matchThreshold,
          match_count: matchCount,
        });

        if (projectError) {
          logger.error('[KB_SERVICE] Project KB search failed', {
            error: projectError.message,
            code: projectError.code,
            projectId,
          });
          // Continue with global results only
        } else if (projectResults && Array.isArray(projectResults)) {
          // Map RPC rows into KBChunk — RPC now returns file_version/format/uploaded_at
          projectChunks = projectResults.map((row: Record<string, unknown>) => ({
            id: typeof row.id === 'string' ? row.id : '',
            content: typeof row.content === 'string' ? row.content : '',
            file_name: typeof row.file_name === 'string' ? row.file_name : undefined,
            file_version: typeof row.file_version === 'number' ? row.file_version : undefined,
            file_format: typeof row.format === 'string'
              ? (row.format as ProjectKBFormat)
              : undefined,
            uploaded_at: typeof row.uploaded_at === 'string' ? row.uploaded_at : undefined,
            metadata: row.metadata ?? {},
            similarity: typeof row.similarity === 'number' ? row.similarity : undefined,
            created_at: typeof row.uploaded_at === 'string'
              ? row.uploaded_at
              : new Date().toISOString(),
          }));
        }
      } catch (rpcError) {
        logger.error('[KB_SERVICE] Project KB RPC error', {
          error: rpcError instanceof Error ? rpcError.message : String(rpcError),
          projectId,
        });
        // Continue with global results only
      }
    }

    // Combine results
    const allChunks = [...projectChunks, ...globalChunks];

    // Sort by similarity (descending)
    allChunks.sort((a, b) => {
      const simA = Number.isFinite(a.similarity) ? (a.similarity || 0) : 0;
      const simB = Number.isFinite(b.similarity) ? (b.similarity || 0) : 0;
      return simB - simA;
    });

    // Deduplicate: prefer parent-section dedup (so two chunks from the same
    // section collapse into one) and fall back to first-100-chars hash for
    // legacy chunks without parent_id. Already sorted by similarity, so the
    // first insert wins.
    //
    // When reranker is on, we dedup into a larger pool (candidatePoolSize)
    // and let the reranker pick the final top-matchCount. When off, we cap
    // at matchCount directly.
    const seenParents = new Set<string>();
    const seenContents = new Set<string>();
    const dedupPoolCap = rerankerOn ? candidatePoolSize : matchCount;
    const dedupPool: KBChunk[] = [];

    for (const chunk of allChunks) {
      if (!chunk || !chunk.content) continue;

      const parentKey = chunk.parent_id && chunk.source_file
        ? `${chunk.source_file}#${chunk.parent_id}`
        : null;

      if (parentKey) {
        if (seenParents.has(parentKey)) continue;
        seenParents.add(parentKey);
      } else {
        const contentHash = chunk.content.substring(0, 100);
        if (seenContents.has(contentHash)) continue;
        seenContents.add(contentHash);
      }

      dedupPool.push(chunk);

      if (dedupPool.length >= dedupPoolCap) {
        break;
      }
    }

    // Rerank step: ask cross-encoder to re-order dedupPool by true relevance.
    // `rerank()` is safe-by-default — returns null on any failure, and we
    // fall through to the original order. Never throws.
    let uniqueChunks: KBChunk[] = dedupPool;
    if (rerankerOn && dedupPool.length >= 6) {
      const rerankStart = Date.now();
      const hits = await rerank({
        query,
        docs: dedupPool
          .filter((c) => typeof c.id === 'string' && c.id.length > 0)
          .map((c) => ({ id: c.id, content: c.content })),
      });
      if (hits) {
        uniqueChunks = applyRerank(dedupPool, hits);
        logger.debug('[KB_SERVICE] Reranker applied', {
          query: query.substring(0, 50),
          poolSize: dedupPool.length,
          elapsedMs: Date.now() - rerankStart,
        });
      }
    }

    // Final slice to matchCount
    uniqueChunks = uniqueChunks.slice(0, matchCount);

    // Extract sources (filter out null/undefined)
    const globalSources = [
      ...new Set(globalChunks.map((c) => c.source_file).filter((s): s is string => !!s)),
    ];
    const projectSources = [
      ...new Set(projectChunks.map((c) => c.file_name).filter((s): s is string => !!s)),
    ];

    logger.debug('[KB_SERVICE] KB search completed', {
      query: query.substring(0, 50),
      globalResults: globalChunks.length,
      projectResults: projectChunks.length,
      totalReturned: uniqueChunks.length,
    });

    // Telemetry (fire-and-forget — never blocks response).
    // Call site defaults to 'other' when caller didn't supply one.
    logRetrievalEvent({
      userId: options.telemetry?.userId ?? null,
      sessionId: options.telemetry?.sessionId ?? null,
      projectId: projectId ?? null,
      query,
      callSite: options.telemetry?.callSite ?? 'other',
      chunkIds: uniqueChunks.map((c) => c.id).filter((id): id is string => typeof id === 'string'),
      sourceFiles: uniqueChunks
        .map((c) => c.source_file || c.file_name || '')
        .filter((s) => s.length > 0),
      globalCount: globalChunks.length,
      projectCount: projectChunks.length,
      latencyMs: Date.now() - startedAt,
    });

    return {
      chunks: uniqueChunks,
      citations: buildCitations(uniqueChunks),
      sources: {
        global: globalSources,
        project: projectSources,
      },
    };
  } catch (error) {
    logger.error('[KB_SERVICE] KB search failed', {
      error: error instanceof Error ? error.message : String(error),
      query: query.substring(0, 50),
    });
    throw new Error('Knowledge base search failed');
  }
}

/**
 * Get project KB files
 * @param projectId - Project ID
 * @returns Array of file metadata with chunk counts
 */
export async function getProjectFiles(projectId: string): Promise<Array<{
  fileName: string;
  uploadedBy: string;
  uploadedAt: string;
  chunkCount: number;
  fileType?: string;
  /** Current version number (Phase 4). */
  fileVersion?: number;
  /** Format detected at upload: 'openapi' | 'postman' | 'generic'. */
  format?: ProjectKBFormat;
  /** How many older retired versions of this file exist (history). */
  previousVersions?: number;
}>> {
  // Validate input
  if (!projectId || typeof projectId !== 'string') {
    logger.warn('[KB_SERVICE] Invalid projectId in getProjectFiles', { projectId: typeof projectId });
    return [];
  }

  try {
    // Current-version rows only. The UI should show a single row per file
    // (the live version). History is surfaced via previousVersions count.
    const { data: currentRows, error: currentError } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('file_name, uploaded_by, uploaded_at, created_at, metadata, file_version, format')
      .eq('project_id', projectId)
      .eq('is_current', true)
      .order('uploaded_at', { ascending: false });

    if (currentError) {
      logger.error('[KB_SERVICE] Failed to fetch project files', {
        error: currentError.message,
        code: currentError.code,
        projectId,
      });
      throw currentError;
    }

    if (!currentRows || !Array.isArray(currentRows)) {
      return [];
    }

    // Group current rows by file_name and count chunks
    type FileInfo = {
      fileName: string;
      uploadedBy: string;
      uploadedAt: string;
      chunkCount: number;
      fileType?: string;
      fileVersion?: number;
      format?: ProjectKBFormat;
      previousVersions?: number;
    };
    const fileMap = new Map<string, FileInfo>();

    for (const chunk of currentRows) {
      if (!chunk || !chunk.file_name) continue;

      const existing = fileMap.get(chunk.file_name);
      if (!existing) {
        fileMap.set(chunk.file_name, {
          fileName: chunk.file_name,
          uploadedBy: chunk.uploaded_by || '',
          uploadedAt: chunk.uploaded_at || chunk.created_at || new Date().toISOString(),
          chunkCount: 1,
          fileType: chunk.metadata?.fileType,
          fileVersion: typeof chunk.file_version === 'number' ? chunk.file_version : undefined,
          format: typeof chunk.format === 'string' ? (chunk.format as ProjectKBFormat) : undefined,
          previousVersions: 0,
        });
      } else {
        existing.chunkCount += 1;
      }
    }

    // Count retired versions per file so UI can show "v3 (2 older versions)"
    const { data: historyRows, error: historyError } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('file_name, file_version')
      .eq('project_id', projectId)
      .eq('is_current', false);

    if (!historyError && Array.isArray(historyRows)) {
      const versionsPerFile = new Map<string, Set<number>>();
      for (const row of historyRows) {
        if (!row?.file_name || typeof row.file_version !== 'number') continue;
        if (!versionsPerFile.has(row.file_name)) {
          versionsPerFile.set(row.file_name, new Set());
        }
        versionsPerFile.get(row.file_name)!.add(row.file_version);
      }
      for (const [name, versions] of versionsPerFile) {
        const info = fileMap.get(name);
        if (info) info.previousVersions = versions.size;
      }
    }

    return Array.from(fileMap.values());
  } catch (error) {
    logger.error('[KB_SERVICE] Failed to get project files', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
    });
    throw new Error('Failed to retrieve project files');
  }
}

/**
 * Delete project file (all chunks)
 * @param projectId - Project ID
 * @param fileName - Name of file to delete
 * @returns True if deletion successful
 */
export async function deleteProjectFile(projectId: string, fileName: string): Promise<boolean> {
  // Validate inputs
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('Invalid projectId');
  }

  if (!fileName || typeof fileName !== 'string' || fileName.trim().length === 0) {
    throw new Error('Invalid fileName');
  }

  try {
    const { error, count } = await supabaseAdmin
      .from('project_kb_chunks')
      .delete()
      .eq('project_id', projectId)
      .eq('file_name', fileName);

    if (error) {
      logger.error('[KB_SERVICE] Failed to delete project file', {
        error: error.message,
        code: error.code,
        projectId,
        fileName,
      });
      throw error;
    }

    logger.info('[KB_SERVICE] Project file deleted', {
      projectId,
      fileName,
      deletedChunks: count || 0,
    });
    return true;
  } catch (error) {
    logger.error('[KB_SERVICE] Failed to delete project file', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
      fileName,
    });
    throw new Error('Failed to delete file');
  }
}

/**
 * Get KB statistics
 * @param projectId - Optional project ID for project-specific stats
 * @returns KB statistics
 */
export async function getKBStats(projectId?: string): Promise<any> {
  // Validate projectId if provided
  if (projectId !== undefined && (typeof projectId !== 'string' || projectId.trim().length === 0)) {
    projectId = undefined;
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('get_kb_stats', {
      p_project_id: projectId || null,
    });

    if (error) {
      logger.error('[KB_SERVICE] Failed to get KB stats', {
        error: error.message,
        code: error.code,
        projectId,
      });
      throw error;
    }

    return data || {};
  } catch (error) {
    logger.error('[KB_SERVICE] Failed to get KB stats', {
      error: error instanceof Error ? error.message : String(error),
      projectId,
    });
    throw new Error('Failed to retrieve KB statistics');
  }
}
