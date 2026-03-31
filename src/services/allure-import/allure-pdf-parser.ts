/**
 * Allure TestOps PDF Parser (LLM-based)
 *
 * Extracts text from Allure TestOps PDF exports using pdf-parse v2,
 * then sends the text to an LLM in chunks to produce ParsedTestCaseFromLLM objects.
 *
 * PDF structure (per test case, spanning 1+ pages):
 *   #NNNN TestName [Status]
 *   Custom fields: Story, Feature, Epic, Suite
 *   Issues: JIRA URLs
 *   Members: Owner, Lead, Auditor
 *   Description: markdown text
 *   Precondition: prerequisite text
 *   Steps: numbered with optional attachments
 */

import { promises as fs } from 'fs';
import { PDFParse } from 'pdf-parse';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import type { ParsedTestCaseFromLLM } from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max characters per LLM call (~3000 tokens input). */
const CHUNK_MAX_CHARS = 12_000;

/** Delay between LLM calls (ms). */
const INTER_CHUNK_DELAY_MS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// LLM prompt
// ─────────────────────────────────────────────────────────────────────────────

const PDF_PARSE_SYSTEM_PROMPT = `You extract structured test cases from text that was extracted from an Allure TestOps PDF export.

## Expected PDF structure per test case
Each test case in the PDF follows this pattern:
\`\`\`
TestCase Details
#NNNN TestName [Status]
Custom fields:
- Story: <value>
- Feature: <value>
Issues:
JIRA-KEY-1 JIRA-KEY-2
Members:
owner@example.com
Description:
<markdown text>
Precondition:
<prerequisite text>
Steps:
1. Step title
1.1. Attachment: description (image/png)
2. Another step
2.1. Attachment: description (image/png)
\`\`\`

Some test cases may span multiple pages. The page header/footer ("N of M Test Cases") should be ignored.

## Field mapping rules

### Hierarchy
- Epic → moduleName (highest priority)
- Story → moduleName (if no Epic). If both Epic and Story, add Story as tag "story:<value>"
- Suite → moduleName (fallback)
- Feature → flowName

### Steps
Convert each numbered step (1., 2., etc.) into a test step:
- Infer action type from step text (navigate/click/type/select/assert/wait/hover/scroll/press/check/uncheck/upload/dblclick)
- If ambiguous → "click"
- Attachment descriptions provide context for the step — incorporate into step description
- Keep descriptions concise (max 120 chars), in the SAME LANGUAGE as the source

### Status
- Active → "active", Draft → "draft", Deprecated → "deprecated"

### Priority
Default "medium". No severity info typically available in PDF exports.

### Links
Extract any Jira issue keys (e.g. MFT-1003, MGOSAPP-4268) and convert to full URLs if a base URL pattern is visible. Otherwise store as-is.

### Tags
- Members/Owner → "owner:<email>"

## Output format
{
  "testCases": [
    {
      "name": "Test case title",
      "description": "Markdown description",
      "preconditions": ["Precondition 1"],
      "steps": [
        { "type": "click", "description": "Step description" }
      ],
      "moduleName": "From Epic/Story/Suite",
      "flowName": "From Feature",
      "tags": ["owner:email@example.com"],
      "priority": "medium",
      "links": ["https://jira.example.com/browse/KEY-123"],
      "status": "active",
      "owner": "email@example.com"
    }
  ]
}

## Rules
1. Each distinct test case becomes one entry — do NOT merge different test cases
2. Preserve the original language (do NOT translate)
3. Skip header/footer lines like "1 of 8 Test Cases", "TestCases report", "Created by..."
4. If the text chunk has no test cases, return {"testCases": []}
5. Return ONLY the JSON, no markdown fences`;

// ─────────────────────────────────────────────────────────────────────────────
// Text extraction
// ─────────────────────────────────────────────────────────────────────────────

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunking by test case boundaries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split extracted PDF text into chunks, trying to split at test case boundaries.
 *
 * Allure TestOps PDF test cases start with a pattern like:
 *   "#1685 Доверительная приемка [Active]"
 * or:
 *   "TestCase Details"
 *
 * We split at these boundaries, then merge small chunks up to CHUNK_MAX_CHARS.
 */
function chunkPdfText(fullText: string): string[] {
  if (fullText.length <= CHUNK_MAX_CHARS) return [fullText];

  // Split at test case boundary patterns.
  // Allure TestOps IDs are 3+ digits (e.g. #1685), so we require \d{3,}
  // to avoid false splits on step numbers like "#1 " or "#2 ".
  const boundaryPattern = /(?=^#\d{3,}\s|\bTestCase Details\b)/gm;
  const sections = fullText.split(boundaryPattern).filter((s) => s.trim());

  if (sections.length <= 1) {
    // No clear boundaries found — split by character limit with overlap
    return splitBySize(fullText, CHUNK_MAX_CHARS, 500);
  }

  // Merge small adjacent sections up to CHUNK_MAX_CHARS
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    if (current.length + section.length > CHUNK_MAX_CHARS && current) {
      chunks.push(current);
      current = section;
    } else {
      current += (current ? '\n' : '') + section;
    }
  }
  if (current.trim()) chunks.push(current);

  return chunks;
}

/** Fallback: split text into fixed-size chunks with overlap. */
function splitBySize(text: string, maxSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxSize));
    start += maxSize - overlap;
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM chunk processing
// ─────────────────────────────────────────────────────────────────────────────

async function parseChunkWithLLM(
  chunkText: string,
  chunkNum: number,
  totalChunks: number,
): Promise<ParsedTestCaseFromLLM[]> {
  const userPrompt = `Extract test cases from this PDF text (chunk ${chunkNum}/${totalChunks}):\n\n${chunkText}`;

  try {
    const response = await getChatCompletionWithMessages(
      [
        { role: 'system', content: PDF_PARSE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      {
        model: AI_TASK_MODELS.allureCsvPdfParse,
        temperature: 0,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
      },
    );

    const rawContent = response.content?.replace(/```json\s*|```\s*/g, '').trim() ?? '{}';

    let parsed: { testCases?: ParsedTestCaseFromLLM[] };
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      logger.warn('[AllurePdfParser] LLM response JSON parse failed', {
        chunk: chunkNum,
        contentLength: rawContent.length,
      });
      return [];
    }

    if (!Array.isArray(parsed.testCases)) return [];

    return parsed.testCases.filter((tc) => {
      if (!tc || typeof tc !== 'object') return false;
      if (!tc.name || typeof tc.name !== 'string') return false;
      tc.steps = Array.isArray(tc.steps) ? tc.steps : [];
      tc.preconditions = Array.isArray(tc.preconditions) ? tc.preconditions : [];
      tc.tags = Array.isArray(tc.tags) ? tc.tags : [];
      tc.links = Array.isArray(tc.links) ? tc.links : [];
      tc.priority = tc.priority ?? 'medium';
      tc.description = tc.description ?? '';
      tc.status = tc.status ?? 'active';
      return true;
    });
  } catch (err) {
    logger.error('[AllurePdfParser] LLM chunk parse failed', {
      chunk: chunkNum,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface PdfParseResult {
  testCases: ParsedTestCaseFromLLM[];
  errors: string[];
}

/**
 * Parse an Allure TestOps PDF export into structured test cases using LLM.
 *
 * @param pdfFilePath - Path to the PDF file on disk
 * @param onProgress  - Optional callback for progress updates
 */
export async function parseAllurePdf(
  pdfFilePath: string,
  onProgress?: (current: number, total: number) => void,
): Promise<PdfParseResult> {
  const result: PdfParseResult = { testCases: [], errors: [] };

  // 1. Extract text from PDF
  let fullText: string;
  try {
    fullText = await extractPdfText(pdfFilePath);
  } catch (err) {
    const msg = `PDF text extraction failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error('[AllurePdfParser] ' + msg);
    result.errors.push(msg);
    return result;
  }

  if (!fullText.trim()) {
    logger.info('[AllurePdfParser] No text extracted from PDF (possibly scanned)');
    result.errors.push('No text could be extracted from the PDF. Scanned/image-only PDFs are not supported.');
    return result;
  }

  logger.info('[AllurePdfParser] PDF text extracted', {
    textLength: fullText.length,
  });

  // 2. Chunk by test case boundaries
  const chunks = chunkPdfText(fullText);

  logger.info('[AllurePdfParser] Starting LLM parsing', {
    chunks: chunks.length,
  });

  // 3. Process each chunk through LLM
  const seenNames = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    const chunkNum = i + 1;
    onProgress?.(chunkNum, chunks.length);

    try {
      const testCases = await parseChunkWithLLM(chunks[i], chunkNum, chunks.length);

      // Deduplicate across chunks (overlap might produce duplicates)
      for (const tc of testCases) {
        const key = tc.name.toLowerCase();
        if (!seenNames.has(key)) {
          seenNames.add(key);
          result.testCases.push(tc);
        }
      }

      logger.debug('[AllurePdfParser] Chunk parsed', {
        chunk: chunkNum,
        totalChunks: chunks.length,
        testCasesInChunk: testCases.length,
      });
    } catch (err) {
      const msg = `PDF chunk ${chunkNum}/${chunks.length} failed: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      logger.error('[AllurePdfParser] ' + msg);
    }

    // Rate-limit protection
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }
  }

  logger.info('[AllurePdfParser] PDF parse complete', {
    testCases: result.testCases.length,
    errors: result.errors.length,
  });

  return result;
}
