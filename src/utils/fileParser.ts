import { promises as fs } from 'fs';
import mammoth from 'mammoth';
import * as pdfParse from 'pdf-parse';
import { logger } from './logger';

export interface ParsedFile {
  content: string;
  metadata: {
    fileType: string;
    pageCount?: number;
    wordCount: number;
  };
}

/**
 * Parse text file
 */
async function parseTextFile(filePath: string): Promise<ParsedFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  return {
    content,
    metadata: {
      fileType: 'text',
      wordCount: content.split(/\s+/).length,
    },
  };
}

/**
 * Parse PDF file
 */
async function parsePdfFile(filePath: string): Promise<ParsedFile> {
  const dataBuffer = await fs.readFile(filePath);
  // pdf-parse expects default export
  const pdf = (pdfParse as any).default || pdfParse;
  const data = await pdf(dataBuffer);

  return {
    content: data.text,
    metadata: {
      fileType: 'pdf',
      pageCount: data.numpages,
      wordCount: data.text.split(/\s+/).length,
    },
  };
}

/**
 * Parse DOCX file
 */
async function parseDocxFile(filePath: string): Promise<ParsedFile> {
  const dataBuffer = await fs.readFile(filePath);
  const result = await mammoth.extractRawText({ buffer: dataBuffer });

  return {
    content: result.value,
    metadata: {
      fileType: 'docx',
      wordCount: result.value.split(/\s+/).length,
    },
  };
}

/**
 * Parse JSON file (convert to readable text)
 */
async function parseJsonFile(filePath: string): Promise<ParsedFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  const jsonData = JSON.parse(content);

  // Convert JSON to formatted text
  const formattedText = JSON.stringify(jsonData, null, 2);

  return {
    content: formattedText,
    metadata: {
      fileType: 'json',
      wordCount: formattedText.split(/\s+/).length,
    },
  };
}

/**
 * Parse markdown file
 */
async function parseMarkdownFile(filePath: string): Promise<ParsedFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  return {
    content,
    metadata: {
      fileType: 'markdown',
      wordCount: content.split(/\s+/).length,
    },
  };
}

/**
 * Main file parser - detects type and parses accordingly
 */
export async function parseFile(filePath: string, originalName: string): Promise<ParsedFile> {
  try {
    const extension = originalName.split('.').pop()?.toLowerCase();

    logger.info('Parsing file', { filePath, extension });

    switch (extension) {
      case 'txt':
        return await parseTextFile(filePath);
      case 'pdf':
        return await parsePdfFile(filePath);
      case 'docx':
        return await parseDocxFile(filePath);
      case 'json':
        return await parseJsonFile(filePath);
      case 'md':
      case 'markdown':
        return await parseMarkdownFile(filePath);
      default:
        // Fallback to text parsing
        logger.warn('Unknown file type, treating as text', { extension });
        return await parseTextFile(filePath);
    }
  } catch (error) {
    logger.error('File parsing failed', { error, filePath });
    throw new Error(`Failed to parse file: ${originalName}`);
  }
}

/**
 * Validate file type
 */
export function isValidFileType(fileName: string): boolean {
  const validExtensions = ['txt', 'pdf', 'docx', 'json', 'md', 'markdown'];
  const extension = fileName.split('.').pop()?.toLowerCase();
  return extension ? validExtensions.includes(extension) : false;
}

/**
 * Get file size in MB
 */
export async function getFileSizeMB(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size / (1024 * 1024);
}
