import { logger } from '@/utils/core/logger';
import { cosineSimilarity } from '@/utils/text-processing/vector';
import fs from 'fs/promises';
import MiniSearch from 'minisearch';
import path from 'path';

export interface LocalKBChunk {
  id: string;
  content: string;
  embedding: number[];
  source_file: string;
  language: string; // 'en', 'ru', 'kk', 'neutral'
  tags?: string[];
  /**
   * Stable slug of the parent section heading. Chunks in the same section
   * share a parent_id. Undefined for legacy chunks built before parent-doc
   * retrieval landed.
   */
  parent_id?: string;
  /**
   * Full text of the parent section. Used by RAG callers to expand a
   * precise small-chunk match into richer context for the LLM.
   */
  parent_text?: string;
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
 * BM25 keyword index built alongside the vector cache. Used by hybrid
 * search to catch exact-token matches (error codes, API paths, identifiers)
 * that dense embeddings often miss.
 */
let keywordIndex: MiniSearch<LocalKBChunk> | null = null;

function buildKeywordIndex(chunks: LocalKBChunk[]): MiniSearch<LocalKBChunk> | null {
  if (!chunks || chunks.length === 0) return null;

  try {
    const index = new MiniSearch<LocalKBChunk>({
      idField: 'id',
      fields: ['content'], // indexed
      storeFields: ['id'], // returned on hits (we rejoin via the main cache)
      searchOptions: {
        boost: { content: 1 },
        fuzzy: 0.2, // typo tolerance
        prefix: true, // prefix match: "addLocat" finds "addLocatorHandler"
      },
    });
    index.addAll(chunks);
    return index;
  } catch (error) {
    logger.warn('[LOCAL_KB] Failed to build keyword index (hybrid disabled)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Reciprocal Rank Fusion — canonical formula for merging multiple ranked lists
 * into one. Score per item = Σ 1/(k + rank_i), k=60 by convention.
 */
function reciprocalRankFusion(
  lists: Array<Array<{ id: string }>>,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      if (!item?.id) return;
      const prev = scores.get(item.id) ?? 0;
      scores.set(item.id, prev + 1 / (k + rank + 1));
    });
  }
  return scores;
}

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

    // Validate JSON
    let kb: LocalKBData;
    try {
      kb = JSON.parse(data);
    } catch (parseError) {
      logger.error('[LOCAL_KB] Failed to parse embeddings.json', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        path: kbPath,
      });
      globalKBCache = [];
      isInitialized = true;
      return [];
    }

    // Validate KB structure
    if (!kb || typeof kb !== 'object') {
      logger.error('[LOCAL_KB] Invalid KB data structure', { path: kbPath });
      globalKBCache = [];
      isInitialized = true;
      return [];
    }

    if (!kb.chunks || !Array.isArray(kb.chunks)) {
      logger.error('[LOCAL_KB] Invalid chunks array', { path: kbPath });
      globalKBCache = [];
      isInitialized = true;
      return [];
    }

    // Validate chunks have required fields
    const validChunks = kb.chunks.filter(
      (chunk) =>
        chunk &&
        typeof chunk === 'object' &&
        chunk.id &&
        chunk.content &&
        chunk.embedding &&
        Array.isArray(chunk.embedding) &&
        chunk.embedding.length === 1536
    );

    if (validChunks.length < kb.chunks.length) {
      logger.warn('[LOCAL_KB] Filtered out invalid chunks', {
        total: kb.chunks.length,
        valid: validChunks.length,
        invalid: kb.chunks.length - validChunks.length,
      });
    }

    globalKBCache = validChunks;
    keywordIndex = buildKeywordIndex(validChunks);
    isInitialized = true;

    logger.info('[LOCAL_KB] Loaded', {
      chunks: validChunks.length,
      keywordIndexBuilt: keywordIndex !== null,
    });

    return globalKBCache;
  } catch (error) {
    logger.error('Failed to load global KB', { error });
    globalKBCache = [];
    keywordIndex = null;
    isInitialized = true;
    return [];
  }
}

/**
 * Search local global KB using vector similarity
 * @param queryEmbedding - Query embedding vector (1536 dimensions)
 * @param options - Search options (threshold, limit, language filter)
 * @returns Array of matching chunks with similarity scores
 */
export async function searchLocalGlobalKB(
  queryEmbedding: number[],
  options: {
    threshold?: number;
    limit?: number;
    language?: 'en' | 'ru' | 'kk' | 'neutral'; // Filter by language
  } = {}
): Promise<LocalKBChunk[]> {
  // Validate queryEmbedding
  if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length !== 1536) {
    logger.warn('[LOCAL_KB] Invalid queryEmbedding', {
      isValid: !!queryEmbedding,
      isArray: Array.isArray(queryEmbedding),
      length: queryEmbedding?.length,
    });
    return [];
  }

  // Validate queryEmbedding contains only finite numbers
  const hasInvalidValues = queryEmbedding.some((val) => !Number.isFinite(val));
  if (hasInvalidValues) {
    logger.warn('[LOCAL_KB] Query embedding contains invalid values');
    return [];
  }

  // Validate and clamp options
  const threshold = Math.max(0, Math.min(1, options.threshold || 0.7));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 5)));
  // KB content exists only in en/ru today. 'kk' (Kazakh) intentionally falls
  // through to `undefined` → unfiltered search, so Kazakh users still get the
  // closest relevant ru/en chunks instead of an empty result.
  const language = options.language && ['en', 'ru', 'neutral'].includes(options.language)
    ? options.language
    : undefined;

  // Load KB (uses cache if already loaded)
  const chunks = await loadGlobalKB();

  if (!chunks || chunks.length === 0) {
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
  const results = filteredChunks
    .filter((chunk) => {
      // Validate chunk has valid embedding
      if (!chunk || !chunk.embedding || !Array.isArray(chunk.embedding)) {
        return false;
      }
      // Validate embedding dimensions match query
      if (chunk.embedding.length !== queryEmbedding.length) {
        logger.warn('[LOCAL_KB] Chunk embedding dimension mismatch', {
          chunkId: chunk.id,
          expected: queryEmbedding.length,
          actual: chunk.embedding.length,
        });
        return false;
      }
      // Validate embedding contains only finite numbers
      return chunk.embedding.every((val) => Number.isFinite(val));
    })
    .map((chunk) => {
      try {
        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        return {
          ...chunk,
          similarity: Number.isFinite(similarity) ? similarity : 0,
        };
      } catch (error) {
        logger.warn('[LOCAL_KB] Failed to calculate similarity', {
          chunkId: chunk.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ...chunk,
          similarity: 0,
        };
      }
    });

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
 * Hybrid search: merges dense (cosine) and sparse (BM25) retrieval using
 * Reciprocal Rank Fusion. Catches cases where semantic similarity alone
 * misses exact keyword matches (error codes, API paths, identifiers).
 *
 * Falls back to pure vector search if the keyword index is unavailable
 * (e.g. indexing failed) or if `query` is empty.
 *
 * Contract is the same as `searchLocalGlobalKB` — returns a ranked
 * `LocalKBChunk[]` with `similarity` set (fused score in [0, 1]).
 */
export async function searchLocalGlobalKBHybrid(
  query: string,
  queryEmbedding: number[],
  options: {
    threshold?: number;
    limit?: number;
    language?: 'en' | 'ru' | 'kk' | 'neutral';
    /** Pool size pulled from each retriever before RRF merge. Default 20. */
    poolSize?: number;
  } = {}
): Promise<LocalKBChunk[]> {
  // Ensure KB is loaded
  await loadGlobalKB();

  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  const poolSize = Math.max(5, Math.min(options.poolSize ?? 20, 100));

  // If no keyword index or empty query — degrade to pure vector search
  if (!keywordIndex || trimmedQuery.length === 0) {
    return searchLocalGlobalKB(queryEmbedding, {
      threshold: options.threshold,
      limit: options.limit,
      language: options.language,
    });
  }

  // Pull bigger pools from each retriever; final ranking comes from RRF
  const vectorPool = await searchLocalGlobalKB(queryEmbedding, {
    threshold: 0, // collect all, let RRF + final threshold cut
    limit: poolSize,
    language: options.language,
  });

  let keywordPool: Array<{ id: string }> = [];
  try {
    keywordPool = keywordIndex.search(trimmedQuery, { combineWith: 'OR' }).slice(0, poolSize);
  } catch (error) {
    logger.warn('[LOCAL_KB] Keyword search failed (falling back to vector only)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Nothing from either side
  if (vectorPool.length === 0 && keywordPool.length === 0) {
    return [];
  }

  // Fuse ranks
  const fused = reciprocalRankFusion([
    vectorPool.map((c) => ({ id: c.id })),
    keywordPool,
  ]);

  // Join back to full chunk data (vector pool has everything we need)
  const byId = new Map<string, LocalKBChunk>(vectorPool.map((c) => [c.id, c]));
  for (const kw of keywordPool) {
    if (!byId.has(kw.id)) {
      const chunk = (globalKBCache ?? []).find((c) => c.id === kw.id);
      if (chunk) byId.set(chunk.id, chunk);
    }
  }

  // Apply language filter to any BM25-only hits (vectorPool already filtered)
  const language = options.language;
  const filteredByLang = language
    ? Array.from(byId.values()).filter(
        (c) => c.language === language || c.language === 'neutral'
      )
    : Array.from(byId.values());

  // Attach fused score as similarity, sort, apply threshold + limit
  const threshold = Math.max(0, Math.min(options.threshold ?? 0, 1));
  const limit = Math.max(1, Math.min(options.limit ?? 5, 100));

  const ranked = filteredByLang
    .map((chunk) => ({ ...chunk, similarity: fused.get(chunk.id) ?? 0 }))
    .filter((c) => c.similarity > threshold)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, limit);

  logger.debug('[LOCAL_KB] Hybrid search completed', {
    query: trimmedQuery.substring(0, 50),
    vectorPool: vectorPool.length,
    keywordPool: keywordPool.length,
    fusedUnique: byId.size,
    returned: ranked.length,
    topScore: ranked[0]?.similarity ?? 0,
  });

  return ranked;
}

/**
 * Reload global KB (for updates)
 */
export async function reloadGlobalKB(): Promise<void> {
  globalKBCache = null;
  keywordIndex = null;
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
  await loadGlobalKB();
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
