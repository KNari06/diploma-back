import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';

// Validate API key on module load
if (!env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is not configured');
}

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 30000, // 30 seconds
});

// Using text-embedding-3-small (1536 dimensions, fast, HNSW-compatible)
// Note: text-embedding-3-large (3072 dims) exceeds HNSW limit (2000 dims)
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
// OpenAI limit: 8191 tokens
// Safe char limit considering different languages:
// - English: ~4 chars/token → 15K chars = ~3,750 tokens ✅
// - Russian: ~2.5 chars/token → 15K chars = ~6,000 tokens ✅
// - Chinese: ~1.5 chars/token → 15K chars = ~10,000 tokens ⚠️ (rare, but safe margin)
const MAX_TEXT_LENGTH = 15000; // Safe limit for all languages (was 20K, too risky for Chinese/Japanese)
const MAX_BATCH_SIZE = 100; // Limit batch size for safety

/**
 * Generate embedding vector for text using OpenAI
 * @param text - Text to embed
 * @returns Vector embedding (1536 dimensions)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // Validate input
  if (!text || typeof text !== 'string') {
    logger.error('[EMBEDDING] Invalid text input', { type: typeof text });
    throw new Error('Text must be a non-empty string');
  }

  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    logger.error('[EMBEDDING] Empty text provided');
    throw new Error('Text is empty');
  }

  // Check text length
  if (trimmedText.length > MAX_TEXT_LENGTH) {
    logger.warn('[EMBEDDING] Text too long, truncating', {
      originalLength: trimmedText.length,
      maxLength: MAX_TEXT_LENGTH,
    });
  }

  try {
    // OpenAI recommends replacing newlines with spaces for better embeddings
    let cleanedText = trimmedText
      .substring(0, MAX_TEXT_LENGTH)
      .replace(/\n/g, ' ')
      .trim();

    // ✅ FIX: Check if text became empty after cleaning
    if (cleanedText.length === 0) {
      throw new Error('Text became empty after cleaning (only whitespace/newlines)');
    }

    // ✅ FIX: Additional length check after cleaning (replace may change length)
    if (cleanedText.length > MAX_TEXT_LENGTH) {
      cleanedText = cleanedText.substring(0, MAX_TEXT_LENGTH);
    }

    logger.info('[EMBEDDING] Generating embedding', {
      textLength: cleanedText.length,
      originalLength: trimmedText.length,
      model: EMBEDDING_MODEL,
    });

    // ✅ FIX: Retry logic for temporary API errors (rate limits, network issues)
    const MAX_RETRIES = 3;
    let lastError: any;
    let response;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: cleanedText,
          dimensions: EMBEDDING_DIMENSIONS,
        }, {
          timeout: 60000, // ✅ FIX: Increased timeout for embedding requests (60s)
        });
        break; // Success - exit retry loop
      } catch (apiError: any) {
        lastError = apiError;

        // Check if it's a retryable error
        const isRetryable =
          apiError?.status === 429 || // Rate limit
          apiError?.status === 503 || // Service unavailable
          apiError?.status === 502 || // Bad gateway
          apiError?.code === 'ECONNRESET' || // Network reset
          apiError?.code === 'ETIMEDOUT'; // Timeout

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = 1000 * attempt; // Exponential backoff: 1s, 2s, 3s
          logger.warn('[EMBEDDING] Retryable error, retrying', {
            attempt,
            maxRetries: MAX_RETRIES,
            delay,
            errorStatus: apiError?.status,
            errorCode: apiError?.code,
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Not retryable or max retries reached - throw
        throw apiError;
      }
    }

    if (!response) {
      throw lastError || new Error('Failed to generate embedding after retries');
    }

    // ✅ FIX: Validate response structure
    if (!response || !response.data || !Array.isArray(response.data) || response.data.length === 0) {
      throw new Error('OpenAI API returned empty or invalid response');
    }

    if (!response.data[0] || !response.data[0].embedding) {
      throw new Error('OpenAI API returned invalid response structure (missing embedding)');
    }

    const embedding = response.data[0].embedding;

    // ✅ FIX: Validate embedding structure and dimensions
    if (!embedding || !Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`Invalid embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${embedding?.length}`);
    }

    // ✅ FIX: Validate all values are valid numbers
    const invalidValues = embedding.filter(val => typeof val !== 'number' || isNaN(val) || !isFinite(val));
    if (invalidValues.length > 0) {
      throw new Error(`Embedding contains ${invalidValues.length} invalid numbers (NaN or non-finite)`);
    }

    logger.info('[EMBEDDING] Embedding generated successfully', {
      textLength: cleanedText.length,
      dimensions: embedding.length,
    });

    return embedding;
  } catch (error) {
    // ✅ FIX: Preserve original error with stack trace
    const errorDetails = {
      error,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      textLength: trimmedText?.length,
    };

    logger.error('[EMBEDDING] Generation failed', errorDetails);

    // ✅ FIX: Re-throw original error to preserve stack trace
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to generate embedding: ${String(error)}`);
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * @param texts - Array of texts to embed
 * @returns Array of vector embeddings
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  // Validate input
  if (!texts || !Array.isArray(texts)) {
    logger.error('[EMBEDDING] Invalid texts input', { type: typeof texts });
    throw new Error('Texts must be an array');
  }

  if (texts.length === 0) {
    logger.warn('[EMBEDDING] Empty texts array provided');
    return [];
  }

  // Check batch size
  if (texts.length > MAX_BATCH_SIZE) {
    logger.warn('[EMBEDDING] Batch size exceeds limit', {
      provided: texts.length,
      max: MAX_BATCH_SIZE,
    });
    throw new Error(`Batch size exceeds limit of ${MAX_BATCH_SIZE}`);
  }

  try {
    // Clean and validate texts
    const cleanedTexts = texts.map((text, index) => {
      if (!text || typeof text !== 'string') {
        logger.warn('[EMBEDDING] Invalid text in batch', { index, type: typeof text });
        return ''; // Empty string as fallback
      }

      return text
        .trim()
        .substring(0, MAX_TEXT_LENGTH)
        .replace(/\n/g, ' ')
        .trim();
    }).filter(text => text.length > 0); // Remove empty strings

    if (cleanedTexts.length === 0) {
      logger.error('[EMBEDDING] No valid texts after cleaning');
      throw new Error('No valid texts to embed');
    }

    logger.info('[EMBEDDING] Generating batch embeddings', {
      count: cleanedTexts.length,
      model: EMBEDDING_MODEL,
    });

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: cleanedTexts,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const embeddings = response.data.map((item) => item.embedding);

    // Validate embeddings
    if (embeddings.length !== cleanedTexts.length) {
      throw new Error(`Expected ${cleanedTexts.length} embeddings, got ${embeddings.length}`);
    }

    // Validate each embedding dimension
    for (let i = 0; i < embeddings.length; i++) {
      if (!embeddings[i] || embeddings[i].length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Invalid embedding at index ${i}: expected ${EMBEDDING_DIMENSIONS} dimensions, got ${embeddings[i]?.length}`);
      }
    }

    logger.info('[EMBEDDING] Batch embeddings generated successfully', {
      count: embeddings.length,
      dimensions: embeddings[0]?.length,
    });

    return embeddings;
  } catch (error) {
    logger.error('[EMBEDDING] Batch generation failed', {
      error,
      count: texts?.length,
    });
    throw new Error(`Failed to generate batch embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Calculate cosine similarity between two embeddings
 * @param embedding1 - First embedding
 * @param embedding2 - Second embedding
 * @returns Similarity score (0-1, or -1 to 1 technically, but OpenAI embeddings are normalized)
 */
export function cosineSimilarity(embedding1: number[], embedding2: number[]): number {
  // Validate inputs
  if (!embedding1 || !Array.isArray(embedding1) || !embedding2 || !Array.isArray(embedding2)) {
    logger.error('[EMBEDDING] Invalid embeddings for similarity calculation', {
      hasEmbedding1: !!embedding1,
      hasEmbedding2: !!embedding2,
      isArray1: Array.isArray(embedding1),
      isArray2: Array.isArray(embedding2),
    });
    throw new Error('Both embeddings must be valid arrays');
  }

  if (embedding1.length !== embedding2.length) {
    logger.error('[EMBEDDING] Embedding dimension mismatch', {
      length1: embedding1.length,
      length2: embedding2.length,
    });
    throw new Error(`Embeddings must have the same dimensions: ${embedding1.length} vs ${embedding2.length}`);
  }

  if (embedding1.length === 0) {
    logger.error('[EMBEDDING] Empty embeddings provided');
    throw new Error('Embeddings cannot be empty');
  }

  try {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      // Validate numbers
      if (typeof embedding1[i] !== 'number' || typeof embedding2[i] !== 'number') {
        throw new Error(`Invalid number at index ${i}: ${embedding1[i]}, ${embedding2[i]}`);
      }

      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);

    // Handle edge case: zero vectors
    if (denominator === 0) {
      logger.warn('[EMBEDDING] Zero vector detected in similarity calculation');
      return 0;
    }

    const similarity = dotProduct / denominator;

    // Clamp to [-1, 1] due to floating point errors
    return Math.max(-1, Math.min(1, similarity));
  } catch (error) {
    logger.error('[EMBEDDING] Cosine similarity calculation failed', {
      error,
      length: embedding1.length,
    });
    throw new Error(`Failed to calculate cosine similarity: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
