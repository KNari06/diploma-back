import { supabase } from '@/db/supabase';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { chunkMarkdown, chunkText } from '@/utils/chunking';
import { getFileSizeMB, isValidFileType, parseFile } from '@/utils/fileParser';
import { logger } from '@/utils/logger';
import { promises as fs } from 'fs';
import { generateEmbedding, generateEmbeddings } from '../ai/embedding.service';
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

    // Insert into DB
    const records = chunks.map((chunk, idx) => ({
      content: chunk.content,
      embedding: JSON.stringify(embeddings[idx]), // Supabase expects JSON string for vector
      source_file: originalName,
      tags,
      metadata: {
        ...chunk.metadata,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        tokenCount: chunk.tokenCount,
        fileType: parsed.metadata.fileType,
        pageCount: parsed.metadata.pageCount,
      },
      uploaded_by: uploadedBy,
    }));

    const { error } = await supabase.from('global_kb_chunks').insert(records);

    if (error) {
      logger.error('Failed to insert global KB chunks', { error });
      throw new Error('Database insertion failed');
    }

    // Clean up temp file
    await fs.unlink(filePath);

    logger.info('Global KB uploaded successfully', {
      fileName: originalName,
      chunkCount: chunks.length,
    });

    return { success: true, chunkCount: chunks.length };
  } catch (error) {
    logger.error('Global KB upload failed', { error });
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

    // Insert into DB
    const records = chunks.map((chunk, idx) => ({
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
    }));

    const { error } = await supabase.from('project_kb_chunks').insert(records);

    if (error) {
      logger.error('Failed to insert project KB chunks', { error });
      throw new Error('Database insertion failed');
    }

    // Clean up temp file
    await fs.unlink(filePath);

    logger.info('Project KB uploaded successfully', {
      fileName: originalName,
      projectId,
      chunkCount: chunks.length,
    });

    return { success: true, chunkCount: chunks.length };
  } catch (error) {
    logger.error('Project KB upload failed', { error });
    throw error;
  }
}

/**
 * Detect language from user message using AI
 * Falls back to simple heuristic if AI fails
 */
export async function detectLanguage(message: string): Promise<'en' | 'ru' | 'neutral'> {
  // Quick fallback for very short messages
  if (!message || message.trim().length < 3) {
    return 'neutral';
  }

  try {
    // Use AI for accurate language detection
    const result = await detectLanguageWithAI(message);
    return result;
  } catch (error) {
    logger.warn('[KB_SERVICE] AI language detection failed, using fallback', {
      error: error instanceof Error ? error.message : String(error),
      message: message.substring(0, 50)
    });

    // Fallback to simple heuristic
    return detectLanguageFallback(message);
  }
}

/**
 * AI-powered language detection using GPT-3.5-turbo
 */
async function detectLanguageWithAI(message: string): Promise<'en' | 'ru' | 'neutral'> {
  const prompt = `Detect the language of this message. Return ONLY the language code.

MESSAGE: "${message}"

RULES:
- If Russian text (Cyrillic) → return "ru"
- If English text (Latin) → return "en"
- If mixed languages → return primary language
- If unclear/symbols/numbers only → return "neutral"

RETURN ONLY: ru, en, or neutral`;

  const response = await getChatCompletionWithMessages([
    {
      role: 'system',
      content: 'You are a language detection expert. Return only the language code: ru, en, or neutral.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ], {
    model: 'gpt-3.5-turbo',
    temperature: 0.1, // Very low for consistent results
    max_tokens: 10, // Just need 1-2 tokens
  });

  const detected = response.content.trim().toLowerCase();

  // Validate response
  if (detected === 'ru' || detected === 'en' || detected === 'neutral') {
    return detected;
  }

  // If AI returned something unexpected, use fallback
  logger.warn('[KB_SERVICE] AI returned unexpected language', { detected, message: message.substring(0, 50) });
  return detectLanguageFallback(message);
}

/**
 * Simple fallback language detection
 */
function detectLanguageFallback(message: string): 'en' | 'ru' | 'neutral' {
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
  try {
    const matchThreshold = options.matchThreshold || 0.7;
    const matchCount = options.matchCount || 5;
    const language = options.language; // Optional language filter

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

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
      const { data: projectResults, error: projectError } = await supabase.rpc('search_project_kb', {
        p_project_id: projectId,
        query_embedding: JSON.stringify(queryEmbedding),
        match_threshold: matchThreshold,
        match_count: matchCount,
      });

      if (projectError) {
        logger.error('Project KB search failed', { projectError });
      }

      projectChunks = projectResults || [];
    }

    // Combine results
    const allChunks = [...projectChunks, ...globalChunks];

    // Sort by similarity
    allChunks.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

    // Deduplicate and take top results
    const uniqueChunks = allChunks.slice(0, matchCount);

    // Extract sources
    const globalSources = [...new Set(globalChunks.map((c) => c.source_file).filter(Boolean))] as string[];
    const projectSources = [...new Set(projectChunks.map((c) => c.file_name).filter(Boolean))] as string[];

    logger.info('KB search completed', {
      query: query.substring(0, 50),
      globalResults: globalChunks.length,
      projectResults: projectChunks.length,
      totalReturned: uniqueChunks.length,
    });

    return {
      chunks: uniqueChunks,
      sources: {
        global: globalSources,
        project: projectSources,
      },
    };
  } catch (error) {
    logger.error('KB search failed', { error });
    throw new Error('Knowledge base search failed');
  }
}

/**
 * Get project KB files
 */
export async function getProjectFiles(projectId: string): Promise<any[]> {
  try {
    const { data, error } = await supabase
      .from('project_kb_chunks')
      .select('file_name, uploaded_by, created_at, metadata')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw error;
    }

    // Group by file_name and count chunks
    const fileMap = new Map<string, any>();

    data?.forEach((chunk) => {
      if (!fileMap.has(chunk.file_name)) {
        fileMap.set(chunk.file_name, {
          fileName: chunk.file_name,
          uploadedBy: chunk.uploaded_by,
          uploadedAt: chunk.created_at,
          chunkCount: 1,
          fileType: chunk.metadata?.fileType,
        });
      } else {
        const existing = fileMap.get(chunk.file_name);
        existing.chunkCount += 1;
      }
    });

    return Array.from(fileMap.values());
  } catch (error) {
    logger.error('Failed to get project files', { error, projectId });
    throw new Error('Failed to retrieve project files');
  }
}

/**
 * Delete project file (all chunks)
 */
export async function deleteProjectFile(projectId: string, fileName: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('project_kb_chunks')
      .delete()
      .eq('project_id', projectId)
      .eq('file_name', fileName);

    if (error) {
      throw error;
    }

    logger.info('Project file deleted', { projectId, fileName });
    return true;
  } catch (error) {
    logger.error('Failed to delete project file', { error, projectId, fileName });
    throw new Error('Failed to delete file');
  }
}

/**
 * Get KB statistics
 */
export async function getKBStats(projectId?: string): Promise<any> {
  try {
    const { data, error } = await supabase.rpc('get_kb_stats', {
      p_project_id: projectId || null,
    });

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('Failed to get KB stats', { error });
    throw new Error('Failed to retrieve KB statistics');
  }
}
