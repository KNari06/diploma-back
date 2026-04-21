import { promises as fs } from 'fs';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { logger } from '../core/logger';

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
  // Validate file path
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = await fs.readFile(filePath, 'utf-8');
  return {
    content: content || '',
    metadata: {
      fileType: 'text',
      wordCount: content ? content.split(/\s+/).filter(word => word.length > 0).length : 0,
    },
  };
}

/**
 * Parse PDF file
 */
async function parsePdfFile(filePath: string): Promise<ParsedFile> {
  // Validate file path
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  let dataBuffer: Buffer;
  try {
    dataBuffer = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`Failed to read PDF file: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const parser = new PDFParse({ data: new Uint8Array(dataBuffer) });

    // pdf-parse v2: getText() loads the doc internally and returns TextResult
    const result = await parser.getText();

    // TextResult has .text (concatenated string) and .total (page count)
    const text = result.text || '';
    const numPages = result.total || undefined;

    return {
      content: text,
      metadata: {
        fileType: 'pdf',
        pageCount: numPages,
        wordCount: text ? text.split(/\s+/).filter(word => word.length > 0).length : 0,
      },
    };
  } catch (error) {
    throw new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Parse DOCX file
 */
async function parseDocxFile(filePath: string): Promise<ParsedFile> {
  // Validate file path
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  let dataBuffer: Buffer;
  try {
    dataBuffer = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`Failed to read DOCX file: ${error instanceof Error ? error.message : String(error)}`);
  }

  let result: { value: string; messages?: any[] };
  try {
    result = await mammoth.extractRawText({ buffer: dataBuffer });
  } catch (error) {
    throw new Error(`Failed to parse DOCX: ${error instanceof Error ? error.message : String(error)}`);
  }

  const content = result && result.value ? String(result.value) : '';

  return {
    content,
    metadata: {
      fileType: 'docx',
      wordCount: content ? content.split(/\s+/).filter(word => word.length > 0).length : 0,
    },
  };
}

/**
 * Parse JSON file (convert to readable text)
 */
async function parseJsonFile(filePath: string): Promise<ParsedFile> {
  // Validate file path
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }

  let jsonData: any;
  try {
    jsonData = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON format: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Convert JSON to formatted text
  let formattedText: string;
  try {
    formattedText = JSON.stringify(jsonData, null, 2);
  } catch (error) {
    // Fallback to original content if stringify fails
    formattedText = content;
  }

  return {
    content: formattedText || '',
    metadata: {
      fileType: 'json',
      wordCount: formattedText ? formattedText.split(/\s+/).filter(word => word.length > 0).length : 0,
    },
  };
}

/**
 * Parse markdown file
 */
async function parseMarkdownFile(filePath: string): Promise<ParsedFile> {
  // Validate file path
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = await fs.readFile(filePath, 'utf-8');
  return {
    content: content || '',
    metadata: {
      fileType: 'markdown',
      wordCount: content ? content.split(/\s+/).filter(word => word.length > 0).length : 0,
    },
  };
}

/**
 * Main file parser - detects type and parses accordingly
 */
export async function parseFile(filePath: string, originalName: string): Promise<ParsedFile> {
  // Validate inputs
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid filePath');
  }

  if (!originalName || typeof originalName !== 'string') {
    throw new Error('Invalid originalName');
  }

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
      case 'yaml':
      case 'yml':
        // No OpenAPI adapter claimed it — treat as plain text.
        return await parseTextFile(filePath);
      default:
        // Fallback to text parsing
        logger.warn('Unknown file type, treating as text', { extension });
        return await parseTextFile(filePath);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('File parsing failed', { error: errorMessage, filePath, originalName });
    throw new Error(`Failed to parse file "${originalName}": ${errorMessage}`);
  }
}

/**
 * Validate file type
 */
export function isValidFileType(fileName: string): boolean {
  // yaml/yml added for OpenAPI specs; format-adapter layer routes them.
  const validExtensions = ['txt', 'pdf', 'docx', 'json', 'md', 'markdown', 'yaml', 'yml'];
  const extension = fileName.split('.').pop()?.toLowerCase();
  return extension ? validExtensions.includes(extension) : false;
}

/**
 * Get file size in MB
 */
export async function getFileSizeMB(filePath: string): Promise<number> {
  // Validate input
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
  }

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }

  try {
    const stats = await fs.stat(filePath);
    const sizeMB = stats.size / (1024 * 1024);
    return Math.max(0, sizeMB); // Ensure non-negative
  } catch (error) {
    throw new Error(`Failed to get file size: ${error instanceof Error ? error.message : String(error)}`);
  }
}
