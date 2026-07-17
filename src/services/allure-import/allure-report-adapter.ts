/**
 * Allure generated-report adapter.
 *
 * `parseAllureZip` natively understands the RAW `allure-results/` directory
 * (files named `*-result.json` with the runtime schema: `uuid`, top-level
 * `steps[]`, `statusDetails`). But the artifact most users actually have on
 * hand is the GENERATED report produced by `allure generate` (the static HTML
 * site CI publishes). That site stores each test under
 * `data/test-cases/<uid>.json` in a DIFFERENT schema:
 *
 *   - `uid` (not `uuid`)
 *   - steps live under `testStage.steps` — top-level `steps` does not exist
 *   - setup/teardown steps under `beforeStages[]` / `afterStages[]`
 *   - `status` is UPPERCASE (`PASSED`/`FAILED`/…)
 *   - failure text is `statusMessage` / `statusTrace` (not `statusDetails`)
 *
 * Without this adapter a zipped report yields ZERO tests (the classifier
 * hard-skips `data/test-cases/` and only `*-result.json` is tagged
 * `test_result`), and the import silently "completes" creating nothing.
 *
 * This module converts each `data/test-cases/<uid>.json` into the existing
 * `AllureTestResult` shape so the rest of the pipeline (dedup, label
 * extraction, AI step conversion, hierarchy) runs unchanged. Preconditions
 * (befores) are surfaced via a synthetic `AllureContainer` per test, matching
 * the raw-results container linkage the mapper already reads.
 *
 * Schema reference: allure2 `io.qameta.allure.entity`
 * (TestResult / StageResult / Step / Label / Parameter / Link).
 */

import { logger } from '@/utils/core/logger';
import type {
  AllureTestResult,
  AllureContainer,
  AllureStep,
  AllureLabel,
  AllureLink,
  AllureParameter,
  AllureStatusDetails,
} from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Generated-report JSON shape (partial — only the fields we consume)
// ─────────────────────────────────────────────────────────────────────────────

interface ReportStep {
  name?: string;
  status?: string;
  statusMessage?: string;
  statusTrace?: string;
  steps?: ReportStep[];
  parameters?: Array<{ name?: string; value?: string }>;
}

interface ReportStageResult {
  name?: string;
  status?: string;
  statusMessage?: string;
  steps?: ReportStep[];
}

interface ReportTestResult {
  uid?: string;
  name?: string;
  fullName?: string;
  historyId?: string;
  testId?: string;
  status?: string;
  statusMessage?: string;
  statusTrace?: string;
  description?: string;
  descriptionHtml?: string;
  testStage?: ReportStageResult;
  beforeStages?: ReportStageResult[];
  afterStages?: ReportStageResult[];
  labels?: Array<{ name?: string; value?: string }>;
  parameters?: Array<{ name?: string; value?: string }>;
  links?: Array<{ name?: string; url?: string; type?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recognise a per-test-case JSON path inside a generated Allure report.
 * Matches `<anything>/data/test-cases/<uid>.json` (the wrapping folder is
 * `allure-report/` by convention but not required — some users re-zip the
 * inner `data/` folder).
 */
export function isReportTestCasePath(entryPath: string): boolean {
  return /(^|\/)data\/test-cases\/[^/]+\.json$/i.test(entryPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field normalisation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set<AllureTestResult['status']>([
  'passed', 'failed', 'broken', 'skipped', 'unknown',
]);

/** Report status is UPPERCASE (`PASSED`); the pipeline uses lowercase. */
function normaliseStatus(raw: unknown): AllureTestResult['status'] {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  return VALID_STATUSES.has(s as AllureTestResult['status'])
    ? (s as AllureTestResult['status'])
    : 'unknown';
}

/** Same lowercasing, but for the optional step status (may be absent). */
function normaliseStepStatus(raw: unknown): AllureStep['status'] | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.toLowerCase() as AllureTestResult['status'];
  return VALID_STATUSES.has(s) ? s : undefined;
}

function mapParameters(
  params: Array<{ name?: string; value?: string }> | undefined,
): AllureParameter[] {
  if (!Array.isArray(params)) return [];
  return params
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({ name: p.name as string, value: p.value ?? '' }));
}

/**
 * Convert a report Step tree into the pipeline's `AllureStep` tree. The shapes
 * are nearly identical; the only translations are status-lowercasing and
 * folding `statusMessage`/`statusTrace` into `statusDetails` (so the mapper's
 * "expected result from failure message" logic works the same as for raw
 * results).
 */
function mapStep(step: ReportStep): AllureStep {
  const statusDetails: AllureStatusDetails | undefined =
    step.statusMessage || step.statusTrace
      ? { message: step.statusMessage, trace: step.statusTrace }
      : undefined;

  const status = normaliseStepStatus(step.status);

  return {
    name: step.name ?? '',
    ...(status && { status }),
    ...(statusDetails && { statusDetails }),
    ...(Array.isArray(step.steps) && step.steps.length > 0 && {
      steps: step.steps.map(mapStep),
    }),
    ...(step.parameters && { parameters: mapParameters(step.parameters) }),
  };
}

function mapLabels(
  labels: Array<{ name?: string; value?: string }> | undefined,
): AllureLabel[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .filter((l) => l && typeof l.name === 'string' && typeof l.value === 'string')
    .map((l) => ({ name: l.name as string, value: l.value as string }));
}

function mapLinks(
  links: Array<{ name?: string; url?: string; type?: string }> | undefined,
): AllureLink[] {
  if (!Array.isArray(links)) return [];
  return links
    .filter((l) => l && typeof l.url === 'string')
    .map((l) => ({ url: l.url as string, ...(l.name && { name: l.name }), ...(l.type && { type: l.type }) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface AdaptedReportData {
  results: AllureTestResult[];
  containers: AllureContainer[];
}

/**
 * Convert a collection of parsed generated-report `data/test-cases/<uid>.json`
 * objects into pipeline `AllureTestResult`s (plus synthetic containers that
 * carry the setup steps as preconditions).
 *
 * @param rawEntries  Map of `entryPath → parsed JSON` (already `JSON.parse`d by
 *                    the caller; malformed entries should be omitted upstream).
 */
export function adaptReportTestCases(
  rawEntries: Array<{ path: string; json: unknown }>,
): AdaptedReportData {
  const results: AllureTestResult[] = [];
  const containers: AllureContainer[] = [];

  for (const { path: entryPath, json } of rawEntries) {
    const tc = json as ReportTestResult;
    if (!tc || typeof tc !== 'object') continue;

    const uid = typeof tc.uid === 'string' && tc.uid ? tc.uid : undefined;
    // Fall back to a path-derived id so two files can't collide on an empty uid.
    const uuid = uid ?? entryPath;

    const resolvedName =
      (typeof tc.name === 'string' && tc.name.trim()) ||
      (typeof tc.fullName === 'string' && tc.fullName.split('.').pop()) ||
      '';
    if (!resolvedName) {
      logger.warn('[AllureReportAdapter] Skipping report test case with no name', { entryPath });
      continue;
    }

    const testStageSteps = Array.isArray(tc.testStage?.steps) ? tc.testStage!.steps! : [];
    const steps = testStageSteps.map(mapStep);

    const statusDetails: AllureStatusDetails | undefined =
      tc.statusMessage || tc.statusTrace
        ? { message: tc.statusMessage, trace: tc.statusTrace }
        : undefined;

    results.push({
      uuid,
      // historyId is the report's cross-run identity — the closest equivalent
      // of the raw format's `testCaseId`, so parameterised dedup still works.
      ...(tc.historyId && { testCaseId: tc.historyId }),
      ...(tc.fullName && { fullName: tc.fullName }),
      name: resolvedName,
      status: normaliseStatus(tc.status),
      ...(statusDetails && { statusDetails }),
      ...(tc.description && { description: tc.description }),
      ...(tc.descriptionHtml && { descriptionHtml: tc.descriptionHtml }),
      labels: mapLabels(tc.labels),
      links: mapLinks(tc.links),
      parameters: mapParameters(tc.parameters),
      steps,
      attachments: [],
    });

    // Surface setup steps as preconditions the same way raw-results containers
    // do: the mapper reads `container.befores[].name`. Each beforeStage's own
    // name (or its leaf step names when the stage is unnamed) becomes a
    // precondition line. afterStages (teardown) are intentionally NOT mapped —
    // the mapper only consumes befores, matching raw-results behaviour.
    const befores = (Array.isArray(tc.beforeStages) ? tc.beforeStages : [])
      .flatMap((stage) => beforeStageToPreconditionNames(stage))
      .filter(Boolean)
      .map((name) => ({ name } as AllureStep));

    if (befores.length > 0) {
      containers.push({
        uuid: `report-container::${uuid}`,
        children: [uuid],
        befores,
        afters: [],
      });
    }
  }

  logger.info('[AllureReportAdapter] Adapted generated-report test cases', {
    results: results.length,
    containers: containers.length,
  });

  return { results, containers };
}

/**
 * Derive precondition line(s) from a single beforeStage. Prefer the stage's own
 * name (e.g. "Login as admin"); when unnamed, fall back to its leaf step names.
 */
function beforeStageToPreconditionNames(stage: ReportStageResult): string[] {
  const named = typeof stage?.name === 'string' ? stage.name.trim() : '';
  if (named) return [named];

  const steps = Array.isArray(stage?.steps) ? stage.steps : [];
  return steps
    .map((s) => (typeof s.name === 'string' ? s.name.trim() : ''))
    .filter(Boolean);
}
