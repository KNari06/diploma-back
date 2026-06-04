/**
 * Allure TestOps CSV Parser (Deterministic)
 *
 * Parses CSV files exported from Allure TestOps into structured test cases.
 * Fully deterministic — zero LLM calls, instant, free.
 *
 * ## Supported CSV variants
 *
 * The parser auto-detects:
 *   - Delimiter: semicolon (;) or comma (,) — detected from header row
 *   - Multi-line fields: quoted with double-quotes (RFC 4180)
 *   - Column mapping: by header name (not position), so extra/missing/reordered columns work
 *   - Encoding: UTF-8 (with or without BOM)
 *
 * ## Known Allure TestOps CSV schema (22 columns, semicolon-delimited):
 *
 *   allure_id;name;full_name;automated;description;precondition;expected_result;
 *   status;scenario;tag;link;example;parameter;JIRA-Latest;Lead;Owner;Auditor;
 *   Robot;Suite;Story;Feature;Epic
 *
 * The parser is NOT hardcoded to this exact schema — it maps columns by name,
 * so it works with subsets, supersets, and reordered columns.
 */

import { parse } from 'csv-parse/sync';
import { logger } from '@/utils/core/logger';
import type { ParsedTestCaseFromLLM } from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Known column names (case-insensitive lookup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps logical field names to possible CSV column header variants.
 * First match wins. This makes the parser resilient to Allure TestOps
 * version differences and localized exports.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  allureId:       ['allure_id', 'id', 'testcaseid', 'test_case_id'],
  name:           ['name', 'title', 'test_name', 'testname'],
  fullName:       ['full_name', 'fullname', 'full_test_name'],
  description:    ['description', 'desc'],
  precondition:   ['precondition', 'preconditions', 'pre_condition'],
  expectedResult: ['expected_result', 'expectedresult', 'expected'],
  status:         ['status', 'state'],
  scenario:       ['scenario', 'steps', 'test_steps', 'teststeps'],
  tag:            ['tag', 'tags', 'label', 'labels'],
  link:           ['link', 'links', 'url', 'urls'],
  jiraLatest:     ['jira-latest', 'jira_latest', 'jira', 'issues', 'issue'],
  lead:           ['lead'],
  owner:          ['owner', 'assignee', 'member', 'members'],
  auditor:        ['auditor', 'reviewer'],
  suite:          ['suite', 'test_suite', 'testsuite'],
  story:          ['story', 'user_story', 'userstory'],
  feature:        ['feature'],
  epic:           ['epic'],
  severity:       ['severity', 'priority'],
  automated:      ['automated', 'is_automated', 'automation'],
};

// ─────────────────────────────────────────────────────────────────────────────
// CSV Parsing (delegated to csv-parse — RFC 4180 compliant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the delimiter from the first physical line.
 *
 * csv-parse needs to be told the delimiter up front; it can't sniff. We count
 * separators on the raw header line (before any quoted multi-line content can
 * appear) and prefer semicolon (Allure TestOps default), then comma, then tab.
 *
 * Counting on a quoted header is theoretically lossy, but Allure TestOps headers
 * are never quoted, so the first physical line is always the true header row.
 */
function detectDelimiter(csvContent: string): string {
  const firstLine = csvContent.split(/\r?\n/, 1)[0] ?? '';
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;

  if (semicolons >= commas && semicolons >= tabs) return ';';
  if (commas >= tabs) return ',';
  return '\t';
}

/**
 * Parse raw CSV content into a header row + data rows using csv-parse.
 *
 * csv-parse handles the parts a hand-rolled parser gets subtly wrong:
 *   - quoted fields containing the delimiter, newlines, or escaped `""`
 *   - BOM stripping (`bom: true`)
 *   - CRLF / LF line endings
 *   - preservation of intentional whitespace inside quoted fields
 *     (we do NOT trim here — callers decide; see `col()`)
 *
 * `relax_column_count` keeps a short/long row from aborting the whole parse;
 * `skip_empty_lines` drops blank trailing lines. Returns the header as the
 * first element and the remaining rows after it.
 */
function readCsvRows(csvContent: string, delimiter: string): string[][] {
  const records = parse(csvContent, {
    delimiter,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: false,
  }) as string[][];

  return records;
}

// ─────────────────────────────────────────────────────────────────────────────
// Column resolver
// ─────────────────────────────────────────────────────────────────────────────

type ColumnMap = Map<string, number>;

/**
 * Build a map from logical field name → column index.
 * Uses COLUMN_ALIASES for fuzzy matching. Case-insensitive.
 */
function buildColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = new Map();
  const lowerHeaders = headers.map((h) => h.toLowerCase().trim());

  for (const [logical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = lowerHeaders.indexOf(alias.toLowerCase());
      if (idx !== -1) {
        map.set(logical, idx);
        break;
      }
    }
  }

  return map;
}

/**
 * Get a column value by logical name, or empty string if missing.
 *
 * Trims the OUTER edges of the field only. Since csv-parse already preserves
 * quoted content faithfully (`trim: false`), this single trim just strips
 * incidental padding around a value — it does not corrupt interior whitespace
 * (e.g. the tab-indented attachment lines inside a multi-line `scenario`
 * field, which `parseScenario` relies on, are untouched).
 */
function col(fields: string[], colMap: ColumnMap, logical: string): string {
  const idx = colMap.get(logical);
  if (idx === undefined || idx >= fields.length) return '';
  return (fields[idx] ?? '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario parser
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedStep {
  type: string;
  description: string;
}

/**
 * Parse the Allure TestOps `scenario` field into structured steps.
 *
 * Format:
 *   [step 1] Step title
 *   	[attachment 1.1] Attachment description
 *   	[attachment 1.2] Another attachment
 *   [step 2] Another step title
 *
 * Also supports variants:
 *   - Numbered: "1. Step title" or "1) Step title"
 *   - Bracketed: "[Step 1] Title" (case-insensitive)
 *   - Plain numbered: "Step 1: Title"
 */
function parseScenario(scenario: string): ParsedStep[] {
  if (!scenario?.trim()) return [];

  const steps: ParsedStep[] = [];
  const lines = scenario.split(/\r?\n/);

  // Regex patterns for step detection (ordered by specificity)
  const stepPatterns = [
    /^\[step\s+\d+(?:\.\d+)*\]\s*(.+)/i,         // [step 1] Title
    /^\[шаг\s+\d+(?:\.\d+)*\]\s*(.+)/i,           // [шаг 1] Title (Russian)
    /^step\s+\d+[:.]\s*(.+)/i,                      // Step 1: Title
    /^\d+\.\s+(.+)/,                                 // 1. Title
    /^\d+\)\s+(.+)/,                                 // 1) Title
  ];

  // Attachment/sub-item patterns (indented or bracketed)
  const attachmentPatterns = [
    /^\s*\[attachment\s+[\d.]+\]\s*(.+)/i,          // [attachment 1.1] Desc
    /^\s*\[вложение\s+[\d.]+\]\s*(.+)/i,            // [вложение 1.1] Desc (Russian)
    /^\t+(.+)/,                                       // Tab-indented content
  ];

  let currentStep: ParsedStep | null = null;
  const attachmentDescs: string[] = [];

  const flushStep = (): void => {
    if (!currentStep) return;

    // Append meaningful attachment descriptions to the step
    const meaningfulAttachments = attachmentDescs.filter((d) => {
      // Filter out generic "Attachment [NNNNN]" and "image.png" noise
      return d && !/^Attachment\s*\[\d+\]$/i.test(d)
        && !/^image\.\w+$/i.test(d)
        && d.length > 3;
    });

    if (meaningfulAttachments.length > 0) {
      currentStep.description += ' (' + meaningfulAttachments.join('; ') + ')';
    }

    currentStep.description = currentStep.description.slice(0, 120);
    steps.push(currentStep);
    attachmentDescs.length = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    // Try step patterns
    let matched = false;
    for (const pattern of stepPatterns) {
      const m = line.match(pattern);
      if (m) {
        flushStep();
        currentStep = { type: 'click', description: m[1].trim() };
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Try attachment patterns
    for (const pattern of attachmentPatterns) {
      const m = line.match(pattern);
      if (m) {
        attachmentDescs.push(m[1].trim());
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Unmatched non-empty line — could be a continuation or a simple step
    const trimmed = line.trim();
    if (trimmed && !currentStep) {
      // First content before any [step N] — treat as a step
      currentStep = { type: 'click', description: trimmed };
    } else if (trimmed && currentStep) {
      // Continuation of current step context
      attachmentDescs.push(trimmed);
    }
  }

  flushStep();

  return steps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → ParsedTestCaseFromLLM mapping
// ─────────────────────────────────────────────────────────────────────────────

function mapRowToTestCase(
  fields: string[],
  colMap: ColumnMap,
): ParsedTestCaseFromLLM | null {
  const name = col(fields, colMap, 'name');
  if (!name) return null; // name is required

  // ── Description ──────────────────────────────────────────────────────────
  const description = col(fields, colMap, 'description');
  const expectedResult = col(fields, colMap, 'expectedResult');
  const fullDesc = expectedResult
    ? description + (description ? '\n\n' : '') + `**Expected result:** ${expectedResult}`
    : description;

  // ── Preconditions ────────────────────────────────────────────────────────
  const preconditionRaw = col(fields, colMap, 'precondition');
  const preconditions = preconditionRaw
    ? preconditionRaw
      .split('\n')
      .map((p) => p.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean)
    : [];

  // ── Steps ────────────────────────────────────────────────────────────────
  const scenarioRaw = col(fields, colMap, 'scenario');
  const steps = parseScenario(scenarioRaw);

  // ── Status ───────────────────────────────────────────────────────────────
  const status = col(fields, colMap, 'status') || 'Active';

  // ── Hierarchy (Epic > Story > Suite → moduleName, Feature → flowName) ──
  const epic = col(fields, colMap, 'epic');
  const story = col(fields, colMap, 'story');
  const suite = col(fields, colMap, 'suite');
  const feature = col(fields, colMap, 'feature');

  let moduleName: string | undefined;
  if (epic)       moduleName = epic;
  else if (story) moduleName = story;
  else if (suite) moduleName = suite;

  const flowName = feature || undefined;

  // ── Tags ─────────────────────────────────────────────────────────────────
  const tags: string[] = [];

  // tag column (comma-separated)
  const tagRaw = col(fields, colMap, 'tag');
  if (tagRaw) {
    tags.push(...tagRaw.split(',').map((t) => t.trim()).filter(Boolean));
  }

  // If Epic took moduleName and Story exists separately, add Story as tag
  if (epic && story) tags.push(`story:${story}`);

  // Owner as tag
  const owner = col(fields, colMap, 'owner') || undefined;
  if (owner) tags.push(`owner:${owner}`);

  // Automated flag as tag
  const automated = col(fields, colMap, 'automated');
  if (automated.toLowerCase() === 'true') tags.push('automated');

  // ── Priority ─────────────────────────────────────────────────────────────
  const severityRaw = col(fields, colMap, 'severity').toLowerCase();
  let priority: ParsedTestCaseFromLLM['priority'] = 'medium';
  if (severityRaw === 'blocker' || severityRaw === 'critical') priority = 'critical';
  else if (severityRaw === 'major' || severityRaw === 'high')  priority = 'high';
  else if (severityRaw === 'minor' || severityRaw === 'trivial' || severityRaw === 'low') priority = 'low';

  // ── Links (merge JIRA-Latest + link columns) ────────────────────────────
  const links: string[] = [];

  const jiraRaw = col(fields, colMap, 'jiraLatest');
  if (jiraRaw) {
    links.push(...jiraRaw.split(',').map((l) => l.trim()).filter(Boolean));
  }

  const linkRaw = col(fields, colMap, 'link');
  if (linkRaw) {
    links.push(...linkRaw.split(',').map((l) => l.trim()).filter(Boolean));
  }

  return {
    name,
    description: fullDesc,
    preconditions,
    steps,
    moduleName,
    flowName,
    tags,
    priority,
    links,
    status,
    owner,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface CsvParseResult {
  testCases: ParsedTestCaseFromLLM[];
  errors: string[];
}

/**
 * Parse an Allure TestOps CSV export into structured test cases.
 *
 * Fully deterministic — no LLM calls. Handles:
 *   - Auto-detected delimiter (;  ,  TAB)
 *   - Column mapping by name (resilient to reordering/extra columns)
 *   - Multi-line quoted fields (RFC 4180)
 *   - BOM-prefixed files
 *   - Scenario field parsing ([step N] / numbered formats)
 *
 * @param csvContent  - Raw CSV file content (UTF-8 string)
 * @param onProgress  - Optional callback for progress updates (current row, total rows)
 */
export async function parseAllureCsv(
  csvContent: string,
  onProgress?: (current: number, total: number) => void,
): Promise<CsvParseResult> {
  const result: CsvParseResult = { testCases: [], errors: [] };

  if (!csvContent.trim()) {
    logger.info('[AllureCsvParser] Empty CSV content');
    return result;
  }

  // 1. Detect delimiter from the first physical line, then let csv-parse do
  //    the full RFC 4180 parse (quotes, multi-line fields, escaped "", BOM).
  const delimiter = detectDelimiter(csvContent);

  let records: string[][];
  try {
    records = readCsvRows(csvContent, delimiter);
  } catch (err) {
    const msg = `CSV parse failed: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    logger.error('[AllureCsvParser] ' + msg);
    return result;
  }

  if (records.length === 0) {
    logger.info('[AllureCsvParser] No rows found in CSV');
    return result;
  }

  // 2. First record is the header, the rest are data rows.
  const headers = records[0];
  const rows = records.slice(1);

  if (rows.length === 0) {
    logger.info('[AllureCsvParser] No data rows found in CSV');
    return result;
  }

  logger.info('[AllureCsvParser] Starting CSV parse', {
    delimiter: delimiter === ';' ? 'semicolon' : delimiter === ',' ? 'comma' : 'tab',
    columns: headers.length,
    dataRows: rows.length,
    detectedHeaders: headers.slice(0, 5).join(', ') + '…',
  });

  // 3. Build column map (logical name → index)
  const colMap = buildColumnMap(headers);

  if (!colMap.has('name')) {
    const msg = 'CSV header missing required "name" column. Found columns: ' + headers.join(', ');
    result.errors.push(msg);
    logger.error('[AllureCsvParser] ' + msg);
    return result;
  }

  logger.debug('[AllureCsvParser] Column mapping', {
    mapped: Object.fromEntries(colMap),
  });

  // 4. Map each row → test case
  for (let i = 0; i < rows.length; i++) {
    onProgress?.(i + 1, rows.length);

    try {
      const testCase = mapRowToTestCase(rows[i], colMap);

      if (testCase) {
        result.testCases.push(testCase);
      }
    } catch (err) {
      const msg = `Row ${i + 1} parse error: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      logger.warn('[AllureCsvParser] ' + msg);
    }
  }

  logger.info('[AllureCsvParser] CSV parse complete', {
    testCases: result.testCases.length,
    skippedRows: rows.length - result.testCases.length,
    errors: result.errors.length,
  });

  return result;
}
