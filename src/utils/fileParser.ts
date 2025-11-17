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

  // pdf-parse expects default export
  const pdf = (pdfParse as any).default || pdfParse;

  let data: any;
  try {
    data = await pdf(dataBuffer);
  } catch (error) {
    throw new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = data && data.text ? String(data.text) : '';
  const numpages = data && typeof data.numpages === 'number' ? data.numpages : undefined;

  return {
    content: text,
    metadata: {
      fileType: 'pdf',
      pageCount: numpages,
      wordCount: text ? text.split(/\s+/).filter(word => word.length > 0).length : 0,
    },
  };
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
