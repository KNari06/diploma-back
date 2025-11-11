import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// Using text-embedding-3-small (1536 dimensions, fast, HNSW-compatible)
// Note: text-embedding-3-large (3072 dims) exceeds HNSW limit (2000 dims)
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate embedding vector for text using OpenAI
 * @param text - Text to embed
 * @returns Vector embedding (1536 dimensions)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('Text is empty');
    }

    // OpenAI recommends replacing newlines with spaces for better embeddings
    const cleanedText = text.replace(/\n/g, ' ').trim();

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: cleanedText,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const embedding = response.data[0].embedding;

    logger.info('Embedding generated', {
      textLength: text.length,
      dimensions: embedding.length,
    });

    return embedding;
  } catch (error) {
    logger.error('Embedding generation failed', { error, textLength: text?.length });
    throw new Error('Failed to generate embedding');
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * @param texts - Array of texts to embed
 * @returns Array of vector embeddings
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    if (!texts || texts.length === 0) {
      throw new Error('No texts provided');
    }

    // Clean texts
    const cleanedTexts = texts.map((text) => text.replace(/\n/g, ' ').trim());

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: cleanedTexts,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    const embeddings = response.data.map((item) => item.embedding);

    logger.info('Batch embeddings generated', {
      count: texts.length,
      dimensions: embeddings[0]?.length,
    });

    return embeddings;
  } catch (error) {
    logger.error('Batch embedding generation failed', { error, count: texts?.length });
    throw new Error('Failed to generate batch embeddings');
  }
}

/**
 * Calculate cosine similarity between two embeddings
 * @param embedding1 - First embedding
 * @param embedding2 - Second embedding
 * @returns Similarity score (0-1)
 */
export function cosineSimilarity(embedding1: number[], embedding2: number[]): number {
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same dimensions');
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
}
