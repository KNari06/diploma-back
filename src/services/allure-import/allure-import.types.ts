/**
 * Allure Import Types
 *
 * All types used by the Allure Report import pipeline:
 * - File classification
 * - Allure result JSON schema
 * - Import job data
 * - Import progress / stats (WebSocket)
 */

// ═══════════════════════════════════════════════════════════════════════════
// FILE CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Category assigned to each file inside the Allure ZIP.
 * Determines which pipeline branch processes it.
 */
export type AllureFileCategory =
  | 'test_result'    // *-result.json  → IntentTestCase
  | 'container'      // *-container.json → preconditions / teardown
  | 'documentation'  // text-based attachments (txt, html, json, log, har…) → KB
  | 'metadata'       // environment.properties, executor.json, categories.json
  | 'structure'      // data/behaviors.csv, data/suites.csv, widgets/summary.json
  | 'video'          // *.webm / *.mp4 — ALWAYS skipped, never imported
  | 'skip';          // generated report UI, plugins/, export/, history/, binaries

/**
 * Result of classifying a single file entry in the ZIP.
 */
export interface ClassifiedFile {
  /** Path inside the ZIP archive (e.g. "allure-results/abc-result.json") */
  path: string;
  /** Filename without directory prefix */
  filename: string;
  /** Assigned category */
  category: AllureFileCategory;
  /**
   * Raw content for text files (first 2000 chars used during AI classification).
   * Undefined for binary files (videos).
   */
  textPreview?: string;
  /**
   * For files that needed AI classification: AI's reasoning summary.
   * E.g. "API response body from checkout endpoint"
   */
  aiSummary?: string;
  /**
   * Granular AI category for documentation files.
   * Preserved from the AI classifier so the KB processor can group files
   * correctly (test_log, api_response, page_snapshot, config, documentation).
   */
  aiCategory?: 'documentation' | 'test_log' | 'api_response' | 'page_snapshot' | 'config';
  /** Whether this documentation file is worth saving to KB (set by AI classifier). */
  kbWorthy?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// ALLURE RESULT JSON SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single step inside an Allure test result (recursive — steps can have sub-steps).
 */
export interface AllureStep {
  name: string;
  status?: 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
  statusDetails?: AllureStatusDetails;
  stage?: string;
  start?: number;
  stop?: number;
  steps?: AllureStep[];
  attachments?: AllureAttachment[];
  parameters?: AllureParameter[];
  description?: string;
}

/**
 * Failure / skip details on a test or step.
 */
export interface AllureStatusDetails {
  message?: string;
  trace?: string;
  known?: boolean;
  muted?: boolean;
  flaky?: boolean;
}

/**
 * Reference to an attachment file stored in the same ZIP.
 * The `source` field is just the filename (e.g. "abc123-attachment.png").
 */
export interface AllureAttachment {
  name: string;
  source: string;
  type?: string;
}

/**
 * A parameter for a parameterized test or a step input.
 */
export interface AllureParameter {
  name: string;
  value: string;
  excluded?: boolean;
  mode?: 'default' | 'masked' | 'hidden';
}

/**
 * A label on a test result (epic, feature, story, severity, tag, owner, layer, …).
 */
export interface AllureLabel {
  name: string;
  value: string;
}

/**
 * An external link (issue tracker, TMS, etc.) on a test result.
 */
export interface AllureLink {
  name?: string;
  url: string;
  type?: string; // "issue" | "tms" | "custom"
}

/**
 * Parsed representation of a *-result.json file.
 */
export interface AllureTestResult {
  uuid: string;
  historyId?: string;
  /** Stable hash that identifies the same test across parameterized runs. */
  testCaseId?: string;
  fullName?: string;
  name: string;
  status: 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown';
  statusDetails?: AllureStatusDetails;
  stage?: string;
  description?: string;
  descriptionHtml?: string;
  labels: AllureLabel[];
  links: AllureLink[];
  parameters: AllureParameter[];
  steps: AllureStep[];
  attachments: AllureAttachment[];
  start?: number;
  stop?: number;
}

/**
 * A fixture step used in before/after hooks (same shape as AllureStep).
 */
export type AllureFixture = AllureStep;

/**
 * Parsed representation of a *-container.json file.
 * Containers describe test fixtures (setup/teardown).
 */
export interface AllureContainer {
  uuid: string;
  name?: string;
  /** UUIDs of *-result.json files that are children of this container. */
  children: string[];
  befores?: AllureFixture[];
  afters?: AllureFixture[];
  start?: number;
  stop?: number;
}

/**
 * All data extracted from a single Allure ZIP.
 * Produced by AllureParser and consumed by the other processors.
 */
export interface AllureParsedData {
  /** Deduplicated test results (parameterized tests → one entry per testCaseId). */
  results: AllureTestResult[];
  containers: AllureContainer[];
  /**
   * Maps result UUID → the container that has it as a child.
   * Used to attach preconditions / teardown to test cases.
   */
  containerByResultUuid: Map<string, AllureContainer>;
  /** Metadata from environment.properties, executor.json, categories.json. */
  metadata: AllureImportMetadata;
  /** Classification summary for all non-result/container files. */
  classified: AllureClassificationSummary;
}

/** Metadata parsed from supplementary Allure files. */
export interface AllureImportMetadata {
  environment?: Record<string, string>;
  executor?: {
    name?: string;
    type?: string;
    buildUrl?: string;
    reportUrl?: string;
    buildName?: string;
  };
  categories?: Array<{ name: string; matchedStatuses?: string[] }>;
}

/** Summary of how files were classified (for stats / logging). */
export interface AllureClassificationSummary {
  documentation: DocumentationFile[];    // text files to push to KB
  videosSkipped: number;                 // always-skipped video files
  filesSkipped: number;                  // report UI, plugins, binaries, images, noise
}

/** A documentation file ready for KB ingestion. */
export interface DocumentationFile {
  filename: string;
  /** Full text content extracted from the ZIP entry. */
  rawContent: string;
  /** AI-generated clean version (stripped HTML/noise, summarised logs). */
  cleanedContent?: string;
  /** Short AI-generated title for the KB document. */
  documentTitle?: string;
  /** AI classification category ("test_log", "api_response", "page_snapshot", etc.) */
  aiCategory?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT RESULT HIERARCHY (for frontend popup)
// ═══════════════════════════════════════════════════════════════════════════

/** A test case node in the result hierarchy. */
export interface AllureImportedTestNode {
  id: string;
  name: string;
  /** Original Allure status (passed/failed/broken/skipped/unknown). */
  status: AllureTestResult['status'];
  priority: 'critical' | 'high' | 'medium' | 'low';
  stepsCount: number;
  /** True if this test was skipped as a duplicate. */
  skipped?: boolean;
}

/** A flow node in the result hierarchy. */
export interface AllureImportedFlowNode {
  id: string;
  name: string;
  /** True if this flow was auto-created during import. */
  isNew: boolean;
  tests: AllureImportedTestNode[];
}

/** A module node in the result hierarchy. */
export interface AllureImportedModuleNode {
  id: string;
  name: string;
  /** True if this module was auto-created during import. */
  isNew: boolean;
  flows: AllureImportedFlowNode[];
}

/** Full result hierarchy returned after import completes. */
export interface AllureImportResultHierarchy {
  modules: AllureImportedModuleNode[];
  /** Test cases not assigned to any module/flow. */
  unassigned: AllureImportedTestNode[];
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT OPTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * User-configurable options for an Allure import.
 * All fields are optional and default to sane values in the service.
 */
export interface AllureImportOptions {
  /** Import test cases from *-result.json files. Default: true */
  importTestCases?: boolean;
  /** Auto-create Modules from Allure `epic` labels. Default: true */
  autoCreateModules?: boolean;
  /** Auto-create Flows from Allure `feature` labels. Default: true */
  autoCreateFlows?: boolean;
  /**
   * Skip test cases whose name already exists in the project.
   * Uses testCaseId for parameterized dedup, then name fallback.
   * Default: true
   */
  deduplicateTests?: boolean;
  /** Save documentation attachments to Knowledge Base. Default: true */
  saveDocsToKB?: boolean;
}

/**
 * Resolved options with defaults applied.
 * Always fully populated — no optional fields.
 */
export interface ResolvedAllureImportOptions {
  importTestCases: boolean;
  autoCreateModules: boolean;
  autoCreateFlows: boolean;
  deduplicateTests: boolean;
  saveDocsToKB: boolean;
}

/**
 * Apply user-provided options on top of defaults.
 */
export function resolveImportOptions(
  opts: AllureImportOptions = {}
): ResolvedAllureImportOptions {
  return {
    importTestCases:  opts.importTestCases  ?? true,
    autoCreateModules: opts.autoCreateModules ?? true,
    autoCreateFlows:   opts.autoCreateFlows   ?? true,
    deduplicateTests:  opts.deduplicateTests  ?? true,
    saveDocsToKB:      opts.saveDocsToKB      ?? true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BULLMQ JOB DATA
// ═══════════════════════════════════════════════════════════════════════════

/** Source file format for Allure imports. */
export type AllureSourceFormat = 'zip' | 'csv' | 'pdf';

/**
 * Data stored in the BullMQ job for async Allure imports.
 *
 * The uploaded file is written to a temp file on disk and only the file path
 * is stored in Redis. This avoids base64-encoding (133% size expansion) into
 * Redis memory, which would cause OOM for large files or concurrent imports.
 */
export interface AllureImportJobData {
  importId: string;
  projectId: string;
  userId: string;
  workspaceId: string;
  /** Source file format: 'zip' (Allure results), 'csv' or 'pdf' (Allure TestOps export). */
  sourceFormat: AllureSourceFormat;
  /** Path to the uploaded file on disk (temp file). Cleaned up after processing. */
  filePath: string;
  /** @deprecated Use filePath. Kept for backward compat with in-flight jobs. */
  zipFilePath?: string;
  options: ResolvedAllureImportOptions;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRESS & STATS  (WebSocket payloads)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Phase identifiers emitted during import.
 * Frontend uses these to show labelled progress bars.
 */
export type AllureImportPhase =
  | 'scanning'    // Unzipping + deterministic classification
  | 'classifying' // AI classification of ambiguous files
  | 'parsing'     // LLM parsing CSV/PDF content
  | 'tests'       // Creating IntentTestCase records
  | 'kb'          // Pushing documentation to Knowledge Base
  | 'done';       // Import complete

/**
 * Running statistics updated throughout the import.
 */
export interface AllureImportStats {
  totalFiles: number;
  testsFound: number;
  testsImported: number;
  testsSkipped: number;
  modulesCreated: number;
  flowsCreated: number;
  kbDocumentsCreated: number;
  filesSkipped: number;
  videosSkipped: number;
  /** Non-fatal errors (one string per issue). */
  errors: string[];
}

/**
 * WebSocket payload for `allure:import:progress` events.
 */
export interface AllureImportProgressPayload {
  importId: string;
  phase: AllureImportPhase;
  current: number;
  total: number;
  message: string;
  stats: AllureImportStats;
  timestamp: string;
}

/**
 * WebSocket payload for `allure:import:completed` events.
 */
export interface AllureImportCompletedPayload {
  importId: string;
  success: boolean;
  stats: AllureImportStats;
  hierarchy: AllureImportResultHierarchy;
  durationMs: number;
  timestamp: string;
}

/**
 * WebSocket payload for `allure:import:failed` events.
 * Emitted only for catastrophic failures (ZIP unreadable, DB unreachable, …).
 */
export interface AllureImportFailedPayload {
  importId: string;
  error: string;
  timestamp: string;
}

/**
 * Empty stats object — used to initialise before processing begins.
 */
export function emptyStats(): AllureImportStats {
  return {
    totalFiles: 0,
    testsFound: 0,
    testsImported: 0,
    testsSkipped: 0,
    modulesCreated: 0,
    flowsCreated: 0,
    kbDocumentsCreated: 0,
    filesSkipped: 0,
    videosSkipped: 0,
    errors: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV / PDF LLM PARSER OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shared output type from LLM-based CSV/PDF parsers.
 * Both parsers produce this same shape, which is then converted to
 * IntentTestCase create params by the orchestration service.
 */
export interface ParsedTestCaseFromLLM {
  name: string;
  description: string;
  preconditions: string[];
  steps: Array<{
    type: string;         // LLM picks from IntentActionType values
    description: string;
    value?: string;
  }>;
  /** Module name — resolved from Epic > Story > Suite fallback chain. */
  moduleName?: string;
  /** Flow name — from Feature column. */
  flowName?: string;
  tags: string[];
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Merged from JIRA-Latest + link columns. */
  links: string[];
  /** Allure TestOps status: Active / Draft / Deprecated. */
  status: string;
  owner?: string;
}
