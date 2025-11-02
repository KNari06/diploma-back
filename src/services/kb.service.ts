import { supabase } from '@/db/supabase';
import { logger } from '@/utils/logger';
import { generateEmbedding, generateEmbeddings } from './embedding.service';
import { chunkText, chunkMarkdown } from '@/utils/chunking';
import { parseFile, isValidFileType, getFileSizeMB } from '@/utils/fileParser';
import { promises as fs } from 'fs';

const MAX_FILE_SIZE_MB = 10; // Maximum file size

export interface KBChunk {
  id: string;
  content: string;
  source_file?: string;
  file_name?: string;
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
 * Search KB using RAG (global first, then project)
 */
export async function searchKB(
  query: string,
  projectId?: string,
  options: {
    matchThreshold?: number;
    matchCount?: number;
  } = {}
): Promise<KBSearchResult> {
  try {
    const matchThreshold = options.matchThreshold || 0.7;
    const matchCount = options.matchCount || 5;

    // Generate query embedding
    const queryEmbedding = await generateEmbedding(query);

    // Search global KB first
    const { data: globalResults, error: globalError } = await supabase.rpc('search_global_kb', {
      query_embedding: JSON.stringify(queryEmbedding),
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (globalError) {
      logger.error('Global KB search failed', { globalError });
    }

    const globalChunks: KBChunk[] = globalResults || [];

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
