import { logger } from '@/utils/logger';
import { cosineSimilarity } from '@/utils/vector';
import fs from 'fs/promises';
import path from 'path';

export interface LocalKBChunk {
  id: string;
  content: string;
  embedding: number[];
  source_file: string;
  tags?: string[];
  metadata?: any;
  similarity?: number;
}

export interface LocalKBData {
  version: string;
  model: string;
  generated_at: string;
  chunks: LocalKBChunk[];
}

let globalKBCache: LocalKBChunk[] | null = null;
let isInitialized = false;

/**
 * Load global KB from local JSON file
 */
export async function loadGlobalKB(): Promise<LocalKBChunk[]> {
  if (globalKBCache && isInitialized) {
    return globalKBCache;
  }

  try {
    const kbPath = path.join(process.cwd(), 'data/global-kb/embeddings.json');

    // Check if file exists
    try {
      await fs.access(kbPath);
    } catch {
      logger.warn('Global KB embeddings.json not found, using empty KB');
      globalKBCache = [];
      isInitialized = true;
      return [];
    }

    const data = await fs.readFile(kbPath, 'utf-8');
    const kb: LocalKBData = JSON.parse(data);

    globalKBCache = kb.chunks;
    isInitialized = true;

    logger.info('Global KB loaded from local storage', {
      chunks: kb.chunks.length,
      version: kb.version,
      model: kb.model,
    });

    return globalKBCache;
  } catch (error) {
    logger.error('Failed to load global KB', { error });
    globalKBCache = [];
    isInitialized = true;
    return [];
  }
}

/**
 * Search local global KB using vector similarity
 */
export async function searchLocalGlobalKB(
  queryEmbedding: number[],
  options: {
    threshold?: number;
    limit?: number;
  } = {}
): Promise<LocalKBChunk[]> {
  const threshold = options.threshold || 0.7;
  const limit = options.limit || 5;

  // Load KB (uses cache if already loaded)
  const chunks = await loadGlobalKB();

  if (chunks.length === 0) {
    return [];
  }

  // Calculate similarity for each chunk
  const results = chunks.map((chunk) => ({
    ...chunk,
    similarity: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  // Filter by threshold and sort by similarity
  const filtered = results
    .filter((r) => r.similarity > threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  logger.debug('Local KB search completed', {
    totalChunks: chunks.length,
    matchedChunks: filtered.length,
    topSimilarity: filtered[0]?.similarity || 0,
  });

  return filtered;
}

/**
 * Reload global KB (for updates)
 */
export async function reloadGlobalKB(): Promise<void> {
  globalKBCache = null;
  isInitialized = false;
  await loadGlobalKB();
  logger.info('Global KB reloaded');
}

/**
 * Get global KB statistics
 */
export async function getLocalKBStats(): Promise<{
  totalChunks: number;
  totalFiles: number;
  model: string;
  version: string;
  lastGenerated: string;
}> {
  const chunks = await loadGlobalKB();

  if (chunks.length === 0) {
    return {
      totalChunks: 0,
      totalFiles: 0,
      model: 'unknown',
      version: 'unknown',
      lastGenerated: 'never',
    };
  }

  const kbPath = path.join(process.cwd(), 'data/global-kb/embeddings.json');
  const data = await fs.readFile(kbPath, 'utf-8');
  const kb: LocalKBData = JSON.parse(data);

  const uniqueFiles = new Set(chunks.map((c) => c.source_file));

  return {
    totalChunks: chunks.length,
    totalFiles: uniqueFiles.size,
    model: kb.model,
    version: kb.version,
    lastGenerated: kb.generated_at,
  };
}

/**
 * Pre-load global KB into memory on startup
 */
export async function initializeGlobalKB(): Promise<void> {
  logger.info('Initializing global KB...');
  await loadGlobalKB();
  logger.info('Global KB initialized successfully');
}

/**
 * Rebuild global KB from source files (without server restart)
 */
export async function rebuildGlobalKB(): Promise<{
  success: boolean;
  chunks: number;
  files: number;
}> {
  try {
    // Import build function
    const { buildGlobalKB } = await import('@/scripts/build-global-kb');

    logger.info('Rebuilding global KB from sources...');

    // Run build
    await buildGlobalKB();

    // Reload into memory
    await reloadGlobalKB();

    const stats = await getLocalKBStats();

    logger.info('Global KB rebuilt successfully', {
      chunks: stats.totalChunks,
      files: stats.totalFiles,
    });

    return {
      success: true,
      chunks: stats.totalChunks,
      files: stats.totalFiles,
    };
  } catch (error) {
    logger.error('Failed to rebuild global KB', { error });
    throw error;
  }
}
