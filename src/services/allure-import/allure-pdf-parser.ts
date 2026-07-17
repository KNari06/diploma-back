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

import { PDFParse } from 'pdf-parse';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { MAX_STEP_DESC_CHARS } from './allure-mapper';
import { allSectionLabelForms } from './allure-labels';
import type { ParsedTestCaseFromLLM } from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max characters per LLM call (~3000 tokens input). */
const CHUNK_MAX_CHARS = 12_000;

/** Delay between LLM calls (ms). */
const INTER_CHUNK_DELAY_MS = 200;

/**
 * Trailing characters carried from the end of one chunk into the start of the
 * next when we split at a test-case boundary. A test case whose text straddles
 * a chunk cut would otherwise be parsed from only its tail (losing its `#NNNN`
 * header → wrong/empty fields). With the overlap the whole test case appears
 * intact in at least one chunk; the cross-chunk dedup-by-name in
 * `parseAllurePdf` drops the partial copy. ~1 KB is enough for the header +
 * custom-fields block of a single Allure test case without bloating tokens.
 */
const CHUNK_OVERLAP_CHARS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// LLM prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The section labels ("Steps", "Expected result", "Precondition") in a TestOps
 * PDF are LOCALIZED to the report's UI language — only the JSON export keeps
 * English keys. Rather than match a fixed word-list (which fails on any
 * language not in the list), the model identifies each delimiter SEMANTICALLY:
 * by its meaning and position. The concrete forms below are ILLUSTRATIVE
 * EXAMPLES only — the rule is "recognise the concept in ANY language", not
 * "match one of these strings". The examples come from the shared registry so
 * they stay in sync, but they are not the classifier.
 */
function buildLocalizedLabelNote(): string {
  const { steps, expected, precondition } = allSectionLabelForms();
  const sample = (forms: readonly string[]) => forms.slice(0, 8).join('", "');
  return `## Section labels appear in the report's LANGUAGE — identify them by MEANING, not by a fixed word
The test text may be in ANY human language. Do NOT rely on the English words. Instead recognise each section by what it MEANS and WHERE it sits, whatever language it is written in:
- The STEPS section: the heading that introduces the list of actions the tester performs. (examples in some languages: "${sample(steps)}", …)
- The EXPECTED RESULT delimiter: a short label line that introduces the verification(s) for the step ABOVE it — the lines after it describe what should be true, not a new action. (examples: "${sample(expected)}", …)
- The PRECONDITION label: introduces setup/prerequisite state before the steps. (examples: "${sample(precondition)}", …)
These example strings are NOT exhaustive and NOT required. If you see a line in Arabic, Hindi, Vietnamese, or any language not listed that clearly plays one of these roles, treat it as that delimiter. A short standalone line whose following lines describe expected state IS the expected-result delimiter even if you don't recognise the exact word.`;
}

const PDF_PARSE_SYSTEM_PROMPT = `You extract structured test cases from text that was extracted from an Allure TestOps PDF export. The text has been pre-cleaned (page headers/footers and stray numbering removed).

## Layout you will actually see
Each test case looks like this — note the STEPS ARE NOT NUMBERED (the PDF's step numbers were lost in extraction). Each step is a plain line under "Steps:". "Expected result" is a delimiter line; the line(s) after it belong to the step ABOVE it.
\`\`\`
#NNNN TestName [Status]
Custom fields:
Story: <value>
Feature: <value>
Suite: <value>
Members:
owner@example.com
Description:
<text, may span several lines>
Precondition:
<one or more prerequisite lines>
Steps:
First step text
Second step text
Expected result
what should be true after the SECOND step
another expectation for the SECOND step
Third step text
Expected result
what should be true after the THIRD step
Attachments:
Attachment: image.png (image/png)
\`\`\`

## How to segment steps (CRITICAL — this is where extraction fails)
Under "Steps:", lines are a mix of STEP actions and their EXPECTED RESULTS, with no numbering to separate them. Segment like this:
- The FIRST line after "Steps:" is step 1.
- A line is a NEW STEP when it describes an action the user performs (open, tap, enter, select, upload, compare, repeat, check…). Start a new step entry for it.
- The literal line "Expected result" (or "Expected result:", "Expected Result:", "Күтілетін нәтиже", "Ожидаемый результат") is a DELIMITER, never a step. Every line AFTER it, up to the next step / "Attachments:" / next "#NNNN" header, is an expected result of the step immediately ABOVE — put those in that step's "expected" array.
- Conditional / branching expectations (e.g. "If status is VERIFIED: … If status is REJECTED: …", or per-country "For KZ users: … For KG/TJ/UZ: …") are ALL expected results of the SAME step. Keep each conditional line as its own entry in that step's "expected" array. Do NOT turn a condition into a separate step, and do NOT drop the branches.
- A line that is just a sub-heading introducing a list ("The following sections are visible:", "Келесі бөлімдер көрінеді:") followed by items IS itself a step or an expected line depending on context — if it appears after "Expected result", it and its items are expected results; otherwise treat the heading+items as one step.

## Absolute conservation rule
NEVER collapse a multi-step test into one step. If "Steps:" contains two or more distinct actions, you MUST emit two or more step entries. Emitting a single step with a long "expected" array for a test that clearly has multiple actions is WRONG — that is the exact failure to avoid. When unsure whether a line is a new step or an expected result, and it reads as an action → make it a step.

## Field mapping
### Hierarchy
- Epic → moduleName (highest priority); Story → moduleName if no Epic (and if both, add tag "story:<value>"); Suite → moduleName as last fallback.
- Feature → flowName

### Steps
- For each step, infer the action type from its text (navigate/click/type/select/assert/wait/hover/scroll/press/check/uncheck/upload/dblclick/drag_and_drop). If ambiguous → "click".
- "Attachment: …" lines are screenshots, not steps — ignore them (do NOT make a step or expected out of them).
- Keep each step "description" concise (max ${MAX_STEP_DESC_CHARS} chars), in the SAME LANGUAGE as the source. Do NOT translate.

### Status / Priority
- Active → "active", Draft → "draft", Deprecated → "deprecated". Priority default "medium".

### Links / Tags
- Extract Jira keys (e.g. MFT-1003) as links (full URL if a base is visible, else as-is). Members/Owner → tag "owner:<email>".

### Title
- Use the title WITHOUT any leading "#N " sub-number (e.g. "#1 Education page" → "Education page"). The "#NNNN" TestOps id is not part of the name either.

## Output format (JSON only, no fences)
{
  "testCases": [
    {
      "name": "Test case title",
      "description": "Description text",
      "preconditions": ["Precondition 1"],
      "steps": [
        { "type": "navigate", "description": "Open the Settings page" },
        { "type": "assert", "description": "Verify all sections are visible", "expected": ["Change account visible", "Change password visible", "Logout visible"] }
      ],
      "moduleName": "From Epic/Story/Suite",
      "flowName": "From Feature",
      "tags": ["owner:email@example.com"],
      "priority": "medium",
      "links": ["MFT-1003"],
      "status": "draft",
      "owner": "email@example.com"
    }
  ]
}

## Worked example (matches the real export shape)
Input Steps block:
\`\`\`
Steps:
Profile бетінде Settings батырмасын басу
Expected result
Settings беті ашылады
Келесі бөлімдер толық көрінеді:
Change account
Logout
Delete account
\`\`\`
Correct output steps (TWO steps, not one):
[
  { "type": "click", "description": "Profile бетінде Settings батырмасын басу", "expected": ["Settings беті ашылады"] },
  { "type": "assert", "description": "Келесі бөлімдер толық көрінеді", "expected": ["Change account", "Logout", "Delete account"] }
]

## Rules
1. Each distinct "#NNNN … [Status]" is ONE test case entry — never merge two different test cases, never split one into two.
2. Preserve EVERY step. A multi-action test MUST yield multiple steps (see conservation rule above).
3. Preserve the original language — do NOT translate.
4. If the chunk has no test cases, return {"testCases": []}.
5. Return ONLY the JSON object, no markdown fences.`;

// ─────────────────────────────────────────────────────────────────────────────
// Text extraction
// ─────────────────────────────────────────────────────────────────────────────

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Text cleaning (pre-LLM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `pdf-parse` extraction of an Allure TestOps PDF is structurally mangled in
 * ways that make step segmentation unreliable and cause multi-step tests to
 * collapse (often to just their first step). This pass removes the noise BEFORE
 * the LLM sees the text. It does NOT try to re-segment steps — that stays the
 * LLM's job — it only deletes lines that carry no test content and that
 * actively fragment steps.
 *
 * Two mangling classes handled here (verified against a real 250-page export):
 *
 * 1. **Page header/footer noise** — every page injects
 *    `Test Cases\t<N> of<M>` and a `-- <N> of <M> --` marker, sometimes in the
 *    MIDDLE of a step's expected-result list. Left in, they read as spurious
 *    step/expected lines.
 *
 * 2. **Detached list-marker blocks** — the PDF renders step numbers / bullets
 *    in a separate visual column, so extraction floats them to the top (or
 *    bottom) of each page as a run of bare `1.` / `2.` / `•` / `-` lines,
 *    divorced from their text. They convey no information once detached (the
 *    order is already implied by line order) and, worse, a bare `1.` mid-text
 *    looks like a new step. We drop bare marker-only lines.
 *
 * The `TestCase Details` cover-page label is also dropped (it appears once, not
 * per test, and is not a boundary we rely on — the `#NNN …[Status]` header is).
 */
function cleanExtractedPdfText(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();

    // Page footer, English TestOps template: "Test Cases\t12 of250".
    if (/^Test Cases\s+\d+\s+of\s*\d+$/i.test(trimmed)) continue;
    // Generic page-footer form in ANY language, but STRICTLY: either just a
    // bare number pair ("12 of 250", "12 / 250", "12 из 250"), OR that pair
    // prefixed ONLY by a recognised page/counter word ("Page 3 of 9",
    // "Страница 3 из 9", "Seite 3 von 9"). We must NOT allow an arbitrary word
    // prefix — that eats real step text like "Repeat step 3 of 5" / "Do 5 of 8"
    // / "Enter 4 / 5". The whole line must be the counter and nothing else.
    if (/^(?:page|pages|страница|стр|бет|бетте|seite|página|pagina|page\s*n[oº]?|页|ページ|페이지)?\s*\d+\s*(?:of|из|von|de|di|／|\/)\s*\d+$/iu.test(trimmed)) continue;
    // Page marker: "-- 12 of 250 --"
    if (/^--\s*\d+ of \d+ --$/.test(trimmed)) continue;
    // Cover-page / section label (English + common localizations; not a
    // per-test boundary — the "#NNNN …[Status]" header is the real boundary).
    if (/^(?:TestCase Details|Детали тест-кейса|Тест-кейс|Testfall-Details)$/i.test(trimmed)) continue;
    // Report cover lines
    if (/^TestCases report$/i.test(trimmed)) continue;
    if (/^Date:\s/i.test(trimmed) && kept.length < 5) continue;

    // Detached list-marker-only lines: a bare "1.", "2.", "10.", "•", or "-"
    // with NO following text on the same line. These are the floated numbering
    // column — pure noise once separated from their step, and a mid-text "1."
    // masquerades as a new step. A marker WITH text ("1. Do thing") is a real
    // step and is kept.
    if (/^(?:\d+\.|[•-])$/.test(trimmed)) continue;

    kept.push(line);
  }

  // Collapse the runs of blank lines the deletions leave behind so the LLM sees
  // compact, well-delimited blocks.
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip a leading Allure-TestOps sub-numbering prefix from a test-case title,
 * e.g. `#1 Education беті` → `Education беті`. Some suites number their cases
 * inside the title; extraction keeps that `#N ` on the name (distinct from the
 * `#NNN` TestOps id, which the header regex already consumes). Left in, two
 * differently-numbered variants of the same test read as distinct names.
 */
function stripNestedTitlePrefix(name: string): string {
  return name.replace(/^#\d+\s+/, '').trim();
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

  // Merge small adjacent sections up to CHUNK_MAX_CHARS. When a section would
  // overflow the current chunk, flush and start a new one — but seed the new
  // chunk with a trailing overlap from the flushed text so a test case sitting
  // across the cut still appears whole in one chunk (dedup-by-name removes the
  // duplicate downstream).
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    if (current.length + section.length > CHUNK_MAX_CHARS && current) {
      chunks.push(current);
      const overlap = current.slice(-CHUNK_OVERLAP_CHARS);
      current = overlap + '\n' + section;
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
        { role: 'system', content: `${PDF_PARSE_SYSTEM_PROMPT}\n\n${buildLocalizedLabelNote()}` },
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
      // Belt-and-suspenders: the prompt asks the model to drop the leading
      // "#NNNN" id and any "#N " sub-number, but enforce it here too so a stray
      // prefix never (a) pollutes the display name or (b) defeats cross-chunk
      // dedup (two chunks emitting "#3 Foo" vs "Foo" would otherwise both land).
      tc.name = stripNestedTitlePrefix(tc.name.replace(/^#\d{3,}\s+/, '')).trim();
      if (!tc.name) return false;
      tc.steps = Array.isArray(tc.steps) ? tc.steps : [];
      // Normalize each step's `expected` to a clean string[] (the model may
      // return a string, mixed types, or omit it). Drop the field when empty so
      // downstream sees `undefined`, matching the CSV path's shape.
      for (const step of tc.steps) {
        if (!step || typeof step !== 'object') continue;
        const raw = (step as { expected?: unknown }).expected;
        const list = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
          .map((e) => (typeof e === 'string' ? e.trim() : String(e ?? '').trim()))
          .filter(Boolean);
        if (list.length > 0) (step as { expected?: string[] }).expected = list;
        else delete (step as { expected?: string[] }).expected;
      }
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
 * Merge two cross-chunk copies of the SAME test case (same name) that the
 * overlap seam produced as complementary partials. Keeps the longer step list
 * and, for every scalar/array metadata field, fills from whichever copy has a
 * non-empty value (preferring the copy that already has one, then the other).
 * Never drops a field just because the step-richer copy happened to miss it.
 */
function mergeDuplicateTestCases(
  a: ParsedTestCaseFromLLM,
  b: ParsedTestCaseFromLLM,
): ParsedTestCaseFromLLM {
  const richerSteps = b.steps.length > a.steps.length ? b.steps : a.steps;
  const str = (x?: string, y?: string) => (x && x.trim() ? x : (y ?? x));
  const arr = <T>(x: T[] | undefined, y: T[] | undefined): T[] =>
    (x && x.length ? x : (y ?? x ?? []));

  return {
    ...a,
    steps: richerSteps,
    name: str(a.name, b.name) || a.name,
    description: str(a.description, b.description) ?? '',
    moduleName: str(a.moduleName, b.moduleName),
    flowName: str(a.flowName, b.flowName),
    owner: str(a.owner, b.owner),
    status: str(a.status, b.status) ?? a.status,
    preconditions: arr(a.preconditions, b.preconditions),
    tags: arr(a.tags, b.tags),
    links: arr(a.links, b.links),
  };
}

/**
 * Parse an Allure TestOps PDF export into structured test cases using LLM.
 *
 * @param pdfBuffer  - PDF file contents as a Buffer
 * @param onProgress - Optional callback for progress updates
 */
export async function parseAllurePdf(
  pdfBuffer: Buffer,
  onProgress?: (current: number, total: number) => void,
): Promise<PdfParseResult> {
  const result: PdfParseResult = { testCases: [], errors: [] };

  // 1. Extract text from PDF
  let fullText: string;
  try {
    fullText = await extractPdfText(pdfBuffer);
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

  // 1b. Clean the extraction noise BEFORE chunking/LLM. pdf-parse floats page
  // headers/footers and the step-numbering column into the text as stray lines
  // that fragment steps and cause multi-step tests to collapse. Stripping them
  // here is what lets the LLM segment steps reliably. Guard against an
  // over-aggressive clean that empties the text: fall back to the raw text.
  const cleanedText = cleanExtractedPdfText(fullText);
  const textForParsing = cleanedText.trim().length > 0 ? cleanedText : fullText;

  logger.info('[AllurePdfParser] PDF text extracted', {
    textLength: fullText.length,
    cleanedLength: cleanedText.length,
  });

  // 2. Chunk by test case boundaries
  const chunks = chunkPdfText(textForParsing);

  logger.info('[AllurePdfParser] Starting LLM parsing', {
    chunks: chunks.length,
  });

  // 3. Process each chunk through LLM
  // Track by normalized name → index in result.testCases so a later, richer
  // copy (chunk overlap can emit a partial test in one chunk and the full test
  // in the next) REPLACES an earlier thinner one instead of being dropped.
  const nameToIndex = new Map<string, number>();
  const dedupKey = (name: string) => name.trim().toLowerCase();

  for (let i = 0; i < chunks.length; i++) {
    const chunkNum = i + 1;
    onProgress?.(chunkNum, chunks.length);

    try {
      const testCases = await parseChunkWithLLM(chunks[i], chunkNum, chunks.length);

      // Deduplicate across chunks. The overlap seam can split ONE test so each
      // chunk sees a complementary PART: one may have more steps, the other a
      // more complete header (moduleName/flowName/links/description/
      // preconditions were cut on the truncated side). So on collision we MERGE
      // field-by-field — take the longer step list, and for each metadata field
      // fill from whichever copy has it — instead of replacing wholesale (which
      // dropped one side's metadata, MED-2 in the correctness audit).
      for (const tc of testCases) {
        const key = dedupKey(tc.name);
        const existingIdx = nameToIndex.get(key);
        if (existingIdx === undefined) {
          nameToIndex.set(key, result.testCases.length);
          result.testCases.push(tc);
        } else {
          result.testCases[existingIdx] = mergeDuplicateTestCases(
            result.testCases[existingIdx],
            tc,
          );
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
