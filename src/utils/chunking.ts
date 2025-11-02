import { encoding_for_model } from 'tiktoken';
import { logger } from './logger';

const CHUNK_SIZE = 800; // tokens per chunk (balanced for quality)
const CHUNK_OVERLAP = 100; // overlap between chunks for context preservation

/**
 * Get tiktoken encoder with fallback
 */
function getEncoder() {
  try {
    return encoding_for_model('gpt-4');
  } catch (error) {
    logger.warn('Failed to get gpt-4 encoder, falling back to gpt-3.5-turbo', { error });
    try {
      return encoding_for_model('gpt-3.5-turbo');
    } catch (fallbackError) {
      logger.error('Failed to get any encoder', { fallbackError });
      throw new Error('Tiktoken encoder unavailable');
    }
  }
}

/**
 * Normalize text before chunking
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\s+$/gm, '') // Remove trailing spaces
    .trim();
}

/**
 * Count tokens in text using tiktoken
 */
export function countTokens(text: string): number {
  try {
    const encoder = getEncoder();
    const tokens = encoder.encode(text);
    encoder.free();
    return tokens.length;
  } catch (error) {
    logger.error('Token counting failed', { error });
    // Fallback: rough estimate (1 token ≈ 4 characters)
    return Math.ceil(text.length / 4);
  }
}

/**
 * Split text into chunks with metadata
 */
export interface TextChunk {
  content: string;
  chunkIndex: number;
  totalChunks: number;
  tokenCount: number;
  metadata: {
    sectionTitle?: string;
    startChar: number;
    endChar: number;
  };
}

/**
 * Smart text chunking with overlap
 * @param text - Text to chunk
 * @param options - Chunking options
 */
export function chunkText(
  text: string,
  options: {
    fileName?: string;
    sectionTitle?: string;
    chunkSize?: number;
    overlap?: number;
  } = {}
): TextChunk[] {
  const chunkSize = options.chunkSize || CHUNK_SIZE;
  const overlap = options.overlap || CHUNK_OVERLAP;

  try {
    // Normalize text before processing
    const normalizedText = normalizeText(text);

    const encoder = getEncoder();
    const tokens = encoder.encode(normalizedText);

    const chunks: TextChunk[] = [];
    let startIdx = 0;

    while (startIdx < tokens.length) {
      const endIdx = Math.min(startIdx + chunkSize, tokens.length);
      const chunkTokens = tokens.slice(startIdx, endIdx);

      // tiktoken's decode returns string (not Uint8Array)
      const chunkText = String(encoder.decode(chunkTokens));

      chunks.push({
        content: chunkText.trim(),
        chunkIndex: chunks.length,
        totalChunks: 0, // Will be set after all chunks are created
        tokenCount: chunkTokens.length,
        metadata: {
          sectionTitle: options.sectionTitle,
          startChar: startIdx,
          endChar: endIdx,
        },
      });

      // Move forward with overlap
      startIdx += chunkSize - overlap;
    }

    // Update total chunks
    chunks.forEach((chunk) => {
      chunk.totalChunks = chunks.length;
    });

    encoder.free();

    logger.info('Text chunked successfully', {
      fileName: options.fileName,
      totalChunks: chunks.length,
      avgTokens: Math.round(chunks.reduce((sum, c) => sum + c.tokenCount, 0) / chunks.length),
    });

    return chunks;
  } catch (error) {
    logger.error('Chunking failed', { error });
    throw new Error('Failed to chunk text');
  }
}

/**
 * Extract structure from markdown content
 */
export function extractMarkdownStructure(content: string): { title: string; sections: { heading: string; content: string }[] } {
  // Normalize content first
  const normalizedContent = normalizeText(content);
  const lines = normalizedContent.split('\n');
  let title = '';
  const sections: { heading: string; content: string }[] = [];
  let currentSection: { heading: string; content: string } | null = null;

  for (const line of lines) {
    // Extract title (# Heading)
    if (!title && line.startsWith('# ')) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    // Extract sections (## or ### Heading)
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        heading: headingMatch[2].trim(),
        content: '',
      };
      continue;
    }

    // Accumulate content
    if (currentSection) {
      currentSection.content += line + '\n';
    }
  }

  // Add last section
  if (currentSection) {
    sections.push(currentSection);
  }

  return { title, sections };
}

/**
 * Chunk markdown with structure preservation
 */
export function chunkMarkdown(content: string, fileName: string): TextChunk[] {
  // Normalize content first (especially important for .docx/.pdf conversions)
  const normalizedContent = normalizeText(content);
  const { title, sections } = extractMarkdownStructure(normalizedContent);

  if (sections.length === 0) {
    // No structure found, fallback to simple chunking
    return chunkText(normalizedContent, { fileName, sectionTitle: title });
  }

  const allChunks: TextChunk[] = [];

  for (const section of sections) {
    const sectionText = `${section.heading}\n\n${section.content}`.trim();

    // If section is small, keep it as one chunk
    if (countTokens(sectionText) <= CHUNK_SIZE) {
      allChunks.push({
        content: sectionText,
        chunkIndex: allChunks.length,
        totalChunks: 0, // Will be updated later
        tokenCount: countTokens(sectionText),
        metadata: {
          sectionTitle: section.heading,
          startChar: 0,
          endChar: sectionText.length,
        },
      });
    } else {
      // Section is large, split it
      const sectionChunks = chunkText(sectionText, {
        fileName,
        sectionTitle: section.heading,
      });

      allChunks.push(...sectionChunks);
    }
  }

  // Update total chunks and reindex
  allChunks.forEach((chunk, idx) => {
    chunk.chunkIndex = idx;
    chunk.totalChunks = allChunks.length;
  });

  logger.info('Markdown chunked with structure', {
    fileName,
    title,
    sections: sections.length,
    totalChunks: allChunks.length,
  });

  return allChunks;
}
