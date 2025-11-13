import { logger } from '@/utils/logger';
import { cosineSimilarity } from '@/utils/vector';
import fs from 'fs/promises';
import path from 'path';

export interface LocalKBChunk {
  id: string;
  content: string;
  embedding: number[];
  source_file: string;
  language: string; // 'en', 'ru', 'neutral'
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
    // Try multiple possible paths for embeddings.json
    // 1. Relative to process.cwd() (works in dev and when running from project root)
    // 2. Relative to __dirname (works when compiled to dist/)
    // 3. Absolute path from project root
    const possiblePaths = [
      path.join(process.cwd(), 'data/global-kb/embeddings.json'),
      path.join(process.cwd(), '../data/global-kb/embeddings.json'),
      path.join(__dirname, '../../data/global-kb/embeddings.json'),
      path.join(__dirname, '../../../data/global-kb/embeddings.json'),
    ];

    let kbPath: string | null = null;

    // Find the first existing path
    for (const testPath of possiblePaths) {
      try {
        await fs.access(testPath);
        kbPath = testPath;
        logger.debug('Found Global KB embeddings.json', { path: kbPath });
        break;
      } catch {
        // Continue to next path
      }
    }

    if (!kbPath) {
      logger.warn('Global KB embeddings.json not found in any expected location', {
        searchedPaths: possiblePaths,
        cwd: process.cwd(),
        __dirname,
      });
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
    language?: 'en' | 'ru' | 'neutral'; // Filter by language
  } = {}
): Promise<LocalKBChunk[]> {
  const threshold = options.threshold || 0.7;
  const limit = options.limit || 5;
  const language = options.language;

  // Load KB (uses cache if already loaded)
  const chunks = await loadGlobalKB();

  if (chunks.length === 0) {
    return [];
  }

  // Filter by language if specified
  let filteredChunks = chunks;
  if (language) {
    filteredChunks = chunks.filter(
      (chunk) => chunk.language === language || chunk.language === 'neutral'
    );

    logger.debug('Filtered KB by language', {
      language,
      totalChunks: chunks.length,
      filteredChunks: filteredChunks.length,
    });
  }

  if (filteredChunks.length === 0) {
    logger.warn('No chunks found for language', { language });
    return [];
  }

  // Calculate similarity for each chunk
  const results = filteredChunks.map((chunk) => ({
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
    languageFilteredChunks: filteredChunks.length,
    matchedChunks: filtered.length,
    topSimilarity: filtered[0]?.similarity || 0,
    language: language || 'all',
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

  // Use the same path resolution logic as loadGlobalKB
  const possiblePaths = [
    path.join(process.cwd(), 'data/global-kb/embeddings.json'),
    path.join(process.cwd(), '../data/global-kb/embeddings.json'),
    path.join(__dirname, '../../data/global-kb/embeddings.json'),
    path.join(__dirname, '../../../data/global-kb/embeddings.json'),
  ];

  let kbPath: string | null = null;

  for (const testPath of possiblePaths) {
    try {
      await fs.access(testPath);
      kbPath = testPath;
      break;
    } catch {
      // Continue to next path
    }
  }

  if (!kbPath) {
    return {
      totalChunks: 0,
      totalFiles: 0,
      model: 'unknown',
      version: 'unknown',
      lastGenerated: 'never',
    };
  }

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
