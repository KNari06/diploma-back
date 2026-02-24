import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { supabaseAdmin } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { chunkMarkdown, chunkText } from '@/utils/text-processing/chunking';
import { getFileSizeMB, isValidFileType, parseFile } from '@/utils/parsing/fileParser';
import { logger } from '@/utils/core/logger';
import { promises as fs } from 'fs';
import { generateEmbedding, generateEmbeddings } from '@/services/ai/core/embedding.service';
import { searchLocalGlobalKB } from './localKB.service';

const MAX_FILE_SIZE_MB = 10; // Maximum file size

export interface KBChunk {
  id: string;
  content: string;
  source_file?: string;
  file_name?: string;
  language?: string; // 'en', 'ru', 'neutral'
  tags?: string[];
  metadata: any;
  similarity?: number;
  created_at: string;
}

export interface KBSearchResult {
  chunks: KBChunk[];
  sources: {
    global: string[];
    project: string[];
  };
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
 * Upload and process file for project KB
 */
export async function uploadProjectKB(
  filePath: string,
  originalName: string,
  projectId: string,
  uploadedBy: string
): Promise<{ success: boolean; chunkCount: number }> {
  // Validate inputs
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid filePath');
  }

  if (!originalName || typeof originalName !== 'string') {
    throw new Error('Invalid originalName');
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('Invalid projectId');
  }

  if (!uploadedBy || typeof uploadedBy !== 'string') {
    throw new Error('Invalid uploadedBy');
  }

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
    logger.info('[KB_SERVICE] File parsed', {
      fileName: originalName,
      wordCount: parsed.metadata.wordCount,
    });

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

    // Validate each embedding has correct dimensions
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
        embedding: JSON.stringify(embeddings[idx]),
        file_name: originalName,
        project_id: projectId,
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

    const { error } = await supabaseAdmin.from('project_kb_chunks').insert(records);

    if (error) {
      logger.error('[KB_SERVICE] Failed to insert project KB chunks', {
        error: error.message,
        code: error.code,
        projectId,
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

    logger.info('[KB_SERVICE] Project KB uploaded successfully', {
      fileName: originalName,
      projectId,
      chunkCount: chunks.length,
    });

    return { success: true, chunkCount: chunks.length };
  } catch (error) {
    logger.error('[KB_SERVICE] Project KB upload failed', {
      error: error instanceof Error ? error.message : String(error),
      fileName: originalName,
      projectId,
    });
    throw error;
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
 * AI-powered language detection using GPT-3.5-turbo
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
  } = {}
): Promise<KBSearchResult> {
  // Validate inputs
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    logger.warn('[KB_SERVICE] Invalid query in searchKB', { query: typeof query });
    return {
      chunks: [],
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

    // Search LOCAL global KB (faster, no DB query!)
    const localGlobalResults = await searchLocalGlobalKB(queryEmbedding, {
      threshold: matchThreshold,
      limit: matchCount,
      language, // Pass language filter
    });

    const globalChunks: KBChunk[] = localGlobalResults.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      source_file: chunk.source_file,
      language: chunk.language,
      tags: chunk.tags,
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
          projectChunks = projectResults;
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

    // Deduplicate by content (keep highest similarity) and take top results
    const seenContents = new Set<string>();
    const uniqueChunks: KBChunk[] = [];

    for (const chunk of allChunks) {
      if (!chunk || !chunk.content) continue;

      const contentHash = chunk.content.substring(0, 100); // Use first 100 chars as hash
      if (!seenContents.has(contentHash)) {
        seenContents.add(contentHash);
        uniqueChunks.push(chunk);

        if (uniqueChunks.length >= matchCount) {
          break;
        }
      }
    }

    // Extract sources (filter out null/undefined)
    const globalSources = [
      ...new Set(globalChunks.map((c) => c.source_file).filter((s): s is string => !!s)),
    ];
    const projectSources = [
      ...new Set(projectChunks.map((c) => c.file_name).filter((s): s is string => !!s)),
    ];

    logger.info('[KB_SERVICE] KB search completed', {
      query: query.substring(0, 50),
      globalResults: globalChunks.length,
      projectResults: projectChunks.length,
      totalReturned: uniqueChunks.length,
      language: language || 'all',
    });

    return {
      chunks: uniqueChunks,
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
}>> {
  // Validate input
  if (!projectId || typeof projectId !== 'string') {
    logger.warn('[KB_SERVICE] Invalid projectId in getProjectFiles', { projectId: typeof projectId });
    return [];
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('project_kb_chunks')
      .select('file_name, uploaded_by, created_at, metadata')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[KB_SERVICE] Failed to fetch project files', {
        error: error.message,
        code: error.code,
        projectId,
      });
      throw error;
    }

    if (!data || !Array.isArray(data)) {
      return [];
    }

    // Group by file_name and count chunks
    const fileMap = new Map<string, {
      fileName: string;
      uploadedBy: string;
      uploadedAt: string;
      chunkCount: number;
      fileType?: string;
    }>();

    data.forEach((chunk) => {
      if (!chunk || !chunk.file_name) return;

      if (!fileMap.has(chunk.file_name)) {
        fileMap.set(chunk.file_name, {
          fileName: chunk.file_name,
          uploadedBy: chunk.uploaded_by || '',
          uploadedAt: chunk.created_at || new Date().toISOString(),
          chunkCount: 1,
          fileType: chunk.metadata?.fileType,
        });
      } else {
        const existing = fileMap.get(chunk.file_name);
        if (existing) {
          existing.chunkCount += 1;
        }
      }
    });

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
