/**
 * Allure Import Orchestrator
 *
 * Main service that ties the entire Allure import pipeline together:
 *
 *   SCAN       → Parse ZIP + classify all files
 *   CLASSIFY   → AI classification for ambiguous files (already done in parser)
 *   TESTS      → Create IntentTestCase records (with tags/priority via update)
 *   KB         → Push cleaned documentation to Knowledge Base
 *   DONE       → Emit final stats
 *
 * Error handling:
 *  - Each phase is wrapped in try-catch; errors are collected in stats.errors[].
 *  - Partial success is acceptable: some tests may import even if KB fails.
 *  - Never throws from the top-level processImport() method.
 */

import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import {
  downloadAllureObject,
  removeAllureObject,
  resolveStorageKey,
} from './allure-import.storage';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { parseAllureZip } from './allure-parser';
import {
  mapAllureResult,
  getPlatformTreeId,
  resolveHierarchy,
  convertImportedStepsWithAI,
  finalizeTypedSteps,
  HierarchyCache,
} from './allure-mapper';
import { processAllureDocumentation } from './allure-kb-processor';
import { parseAllureCsv } from './allure-csv-parser';
import { parseAllurePdf } from './allure-pdf-parser';
import type {
  AllureImportJobData,
  AllureImportStats,
  AllureImportPhase,
  AllureImportProgressPayload,
  AllureImportCompletedPayload,
  AllureImportFailedPayload,
  AllureImportResultHierarchy,
  ParsedTestCaseFromLLM,
} from './allure-import.types';
import { emptyStats } from './allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Progress emitter type (injected from job handler / controller)
// ─────────────────────────────────────────────────────────────────────────────

export type ProgressEmitter = (
  payload: AllureImportProgressPayload | AllureImportCompletedPayload | AllureImportFailedPayload,
) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate detection helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch existing test case names for a project in a single query.
 * Used for deduplication (skip tests whose name already exists).
 */
/**
 * Canonical key for test-case name dedup. Trim THEN lowercase so that
 * "Login", " login " and "LOGIN" collapse to one key — the old code only
 * lowercased, so leading/trailing whitespace produced phantom non-duplicates.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

async function getExistingTestCaseNames(
  projectId: string,
  userId: string,
): Promise<Set<string>> {
  try {
    // Paginate in chunks of 1000 to handle large projects
    const names = new Set<string>();
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const { items } = await IntentTestCaseService.listByProject({
        projectId,
        userId,
        limit: pageSize,
        offset,
      });

      for (const tc of items) names.add(normalizeName(tc.name));

      if (items.length < pageSize) break;
      offset += pageSize;
    }

    return names;
  } catch (err) {
    logger.warn('[AllureImport] Could not fetch existing test case names', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import record helpers (for allure_imports DB table)
// ─────────────────────────────────────────────────────────────────────────────

async function createImportRecord(data: {
  importId: string;
  projectId: string;
  userId: string;
  workspaceId: string;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('allure_imports').insert({
    id: data.importId,
    project_id: data.projectId,
    user_id: data.userId,
    workspace_id: data.workspaceId,
    status: 'processing',
  });

  if (error) {
    // Non-fatal — import can proceed without DB tracking record
    logger.warn('[AllureImport] Failed to create import record', {
      error: error.message,
    });
  }
}

async function updateImportRecord(
  importId: string,
  update: {
    status: 'completed' | 'failed';
    stats: AllureImportStats;
    error_message?: string;
    file_name?: string;
    file_size?: number;
    /**
     * Optional hierarchy snapshot. Stored alongside stats so the REST
     * status endpoint can return the Module/Flow/TestCase tree without
     * relying on the WebSocket completion event (which can be missed if
     * the user closes the dialog at the wrong moment, or the socket
     * dropped). Skipped for legacy DBs where the column doesn't exist —
     * the supabase error is logged but never thrown.
     */
    hierarchy?: AllureImportResultHierarchy;
  },
): Promise<void> {
  // Build the patch dynamically so we don't write `hierarchy: null` when the
  // caller didn't supply one (failed imports, mid-flight failures): leaving
  // the column untouched is the right behaviour for those rows.
  const patch: Record<string, unknown> = {
    status: update.status,
    stats: update.stats,
    error_message: update.error_message ?? null,
    file_name: update.file_name ?? null,
    file_size: update.file_size ?? null,
    completed_at: new Date().toISOString(),
  };
  if (update.hierarchy !== undefined) {
    patch.hierarchy = update.hierarchy;
  }

  const { error } = await supabaseAdmin
    .from('allure_imports')
    .update(patch)
    .eq('id', importId);

  if (error) {
    // If the `hierarchy` column doesn't exist yet (old DB without the
    // 20260504 migration applied) Supabase returns "column ... does not
    // exist". Retry once without that field so the rest of the update
    // (status/stats) still lands.
    const msg = error.message ?? '';
    if (update.hierarchy !== undefined && /hierarchy/i.test(msg) && /(column|does not exist|not found)/i.test(msg)) {
      logger.warn('[AllureImport] hierarchy column missing — retrying without it', {
        importId,
      });
      delete patch.hierarchy;
      const retry = await supabaseAdmin
        .from('allure_imports')
        .update(patch)
        .eq('id', importId);
      if (retry.error) {
        logger.warn('[AllureImport] Failed to update import record (retry)', {
          importId,
          error: retry.error.message,
        });
      }
      return;
    }
    logger.warn('[AllureImport] Failed to update import record', {
      importId,
      error: msg,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Result returned from processAllureImport — stats + hierarchy for the frontend popup. */
export interface AllureImportResult {
  stats: AllureImportStats;
  hierarchy: AllureImportResultHierarchy;
}

/**
 * Process a full Allure ZIP import.
 *
 * @param jobData       - BullMQ job data (importId, projectId, userId, storageKey, options)
 * @param emitProgress  - Callback for WebSocket progress events
 * @returns Final stats + hierarchy tree (always — never throws)
 */
export async function processAllureImport(
  jobData: AllureImportJobData,
  emitProgress: ProgressEmitter,
): Promise<AllureImportResult> {
  const { importId, projectId, userId, workspaceId, options } = jobData;
  const storageKey = resolveStorageKey(jobData);
  const stats = emptyStats();
  const startTime = Date.now();

  const emitPhase = (
    phase: AllureImportPhase,
    current: number,
    total: number,
    message: string,
  ): void => {
    try {
      emitProgress({
        importId,
        phase,
        current,
        total,
        message,
        stats: { ...stats },
        timestamp: new Date().toISOString(),
      } satisfies AllureImportProgressPayload);
    } catch (e) {
      logger.warn('[AllureImport] Progress emit failed', {
        phase,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────
  await createImportRecord({ importId, projectId, userId, workspaceId });

  // ── Phase 1 & 2: SCAN + CLASSIFY ─────────────────────────────────────────
  emitPhase('scanning', 0, 1, 'Unpacking and classifying ZIP contents…');

  let parsedData: Awaited<ReturnType<typeof parseAllureZip>>;

  try {
    const zipBuffer = await downloadAllureObject(storageKey);
    parsedData = await parseAllureZip(zipBuffer);

    stats.totalFiles =
      parsedData.results.length +
      parsedData.containers.length +
      parsedData.classified.documentation.length +
      parsedData.classified.videosSkipped +
      parsedData.classified.filesSkipped;
    stats.testsFound = parsedData.results.length;
    stats.videosSkipped = parsedData.classified.videosSkipped;
    stats.filesSkipped = parsedData.classified.filesSkipped;

    emitPhase(
      'classifying',
      1,
      1,
      `Found ${stats.testsFound} test results, ${parsedData.classified.documentation.length} docs`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[AllureImport] ZIP parsing failed (fatal)', { importId, error: message });

    try {
      emitProgress({
        importId,
        error: message,
        timestamp: new Date().toISOString(),
      } satisfies AllureImportFailedPayload);
    } catch (_) { /* ignore */ }

    await updateImportRecord(importId, {
      status: 'failed',
      stats,
      error_message: message,
    });

    await removeAllureObject(storageKey);

    // Only phase where we propagate — caller (job handler) decides whether to retry
    throw err;
  }

  // ── Phase 3: CREATE TEST CASES ────────────────────────────────────────────
  const hierarchyCache = new HierarchyCache();

  if (options.importTestCases && parsedData.results.length > 0) {
    emitPhase('tests', 0, parsedData.results.length, 'Importing test cases…');

    try {
      const platformTreeId = await getPlatformTreeId(projectId, userId, options.platform);

      // Pre-import names (already in the project) vs names seen during THIS
      // batch. A skip against a pre-existing name is an expected re-import; a
      // skip against a same-batch name means two distinct imported tests share
      // a name → one is silently lost, which we surface as a warning.
      const existingNames = options.deduplicateTests
        ? await getExistingTestCaseNames(projectId, userId)
        : new Set<string>();
      const batchNames = new Set<string>();

      for (let i = 0; i < parsedData.results.length; i++) {
        const result = parsedData.results[i];

        emitPhase('tests', i, parsedData.results.length, `Importing: ${result.name}`);

        try {
          // Dedup check — skip entirely without resolving hierarchy.
          // We must NOT call resolveHierarchy here because it would create
          // modules/flows for tests that won't actually be imported.
          const key = normalizeName(result.name);
          if (options.deduplicateTests && (existingNames.has(key) || batchNames.has(key))) {
            const sameBatch = batchNames.has(key);
            logger.debug('[AllureImport] Skipping duplicate test case', {
              name: result.name,
              reason: sameBatch ? 'same-batch name collision' : 'already exists in project',
            });
            stats.testsSkipped++;
            if (sameBatch) {
              stats.errors.push(
                `Skipped "${result.name}" — another imported test has the same name. ` +
                `Distinct tests with identical names can't both be imported; rename to keep both.`,
              );
            }
            continue;
          }

          // Map Allure result → IntentTestCase params
          const mapped = await mapAllureResult(
            result,
            parsedData.containerByResultUuid,
            hierarchyCache,
            platformTreeId,
            {
              projectId,
              userId,
              autoCreateModules: options.autoCreateModules,
              autoCreateFlows: options.autoCreateFlows,
              platform: options.platform,
            },
          );

          // Create test case (create() does not support tags/priority)
          // `defaultStartUrl` is null when the user didn't supply one — pass
          // `undefined` (not `null`) so the service falls through to its own
          // default branch (`start_url = null`) instead of writing a literal
          // "null" string. Identical end state, but the explicit `undefined`
          // documents intent and matches the function signature.
          // `defaultStartUrl` is null when the user didn't supply one — pass
          // `undefined` (not `null`) so the service falls through to its own
          // default branch (`start_url = null`).
          //
          // priority + preconditions are written in this single create() call:
          // create() accepts both (priority natively, preconditions via the
          // `preconditions` TEXT[] column). Only `tags` still needs a follow-up
          // update() because create() doesn't accept it. This removes a write
          // for priority-only tests and closes the old bug where preconditions
          // were built but silently dropped (update() never accepted them).
          const created = await IntentTestCaseService.create({
            projectId: mapped.createParams.projectId,
            userId: mapped.createParams.userId,
            name: mapped.createParams.name,
            description: mapped.createParams.description || undefined,
            startUrl: options.defaultStartUrl ?? undefined,
            steps: mapped.createParams.steps,
            flowId: mapped.createParams.flowId,
            status: mapped.createParams.status,
            kind: mapped.createParams.kind,
            platform: mapped.createParams.platform,
            priority: mapped.createParams.priority,
            ...(mapped.createParams.preconditions.length > 0 && {
              preconditions: mapped.createParams.preconditions,
            }),
            // Import provenance — links the test to this import, records the
            // Allure run verdict, and flags unreliable (all-click) steps.
            importId,
            sourceStatus: result.status,
            stepsDegraded: mapped.stepsDegraded,
          });

          // Tags are the only field create() doesn't accept — set via update().
          if (mapped.createParams.tags.length > 0) {
            try {
              await IntentTestCaseService.update({
                id: created.id,
                userId,
                tags: mapped.createParams.tags,
              });
            } catch (updateErr) {
              // Non-fatal — the test case itself was created (with priority +
              // preconditions already persisted). Surface in `stats.errors` so
              // the user sees the warning in the results panel instead of
              // having tags silently dropped with no UI indication.
              const errMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
              logger.warn('[AllureImport] Could not update tags for test case', {
                testCaseId: created.id,
                error: errMsg,
              });
              stats.errors.push(
                `Tags not saved for "${created.name}": ${errMsg}`,
              );
            }
          }

          // Register name so a later same-batch collision is detected.
          batchNames.add(normalizeName(result.name));
          stats.testsImported++;
          if (mapped.stepsDegraded) stats.testsWithDegradedSteps++;

          // Track in hierarchy tree for the frontend popup
          hierarchyCache.addTestNode(
            {
              id: created.id,
              name: created.name,
              status: result.status,
              priority: mapped.createParams.priority,
              stepsCount: mapped.createParams.steps.length,
            },
            mapped.createParams.flowId,
            mapped.moduleId,
          );

          logger.debug('[AllureImport] Test case imported', {
            id: created.id,
            name: created.name,
          });
        } catch (testErr) {
          const msg = `Failed to import "${result.name}": ${testErr instanceof Error ? testErr.message : String(testErr)}`;
          stats.errors.push(msg);
          stats.testsSkipped++;
          logger.error('[AllureImport] Test case import failed', {
            testName: result.name,
            error: msg,
          });
        }
      }

      // Pull module/flow creation counts from the cache
      stats.modulesCreated = hierarchyCache.modulesCreated;
      stats.flowsCreated = hierarchyCache.flowsCreated;

      // One summary warning for degraded tests (not one per test) so the
      // warnings panel stays readable. The exact tests are flagged in logs.
      if (stats.testsWithDegradedSteps > 0) {
        stats.errors.push(
          `${stats.testsWithDegradedSteps} test(s) imported with unreliable step types ` +
          `(AI step conversion failed — all steps defaulted to "click"). Review these before running.`,
        );
      }

      logger.info('[AllureImport] Test case import phase complete', {
        imported: stats.testsImported,
        skipped: stats.testsSkipped,
        modulesCreated: stats.modulesCreated,
        flowsCreated: stats.flowsCreated,
        degraded: stats.testsWithDegradedSteps,
        errors: stats.errors.length,
      });
    } catch (phaseErr) {
      const msg = `Test case import phase failed: ${phaseErr instanceof Error ? phaseErr.message : String(phaseErr)}`;
      stats.errors.push(msg);
      logger.error('[AllureImport] Tests phase error', { importId, error: msg });
    }
  }

  emitPhase(
    'tests',
    parsedData.results.length,
    parsedData.results.length,
    `${stats.testsImported} test cases imported`,
  );

  // ── Phase 4: KNOWLEDGE BASE ───────────────────────────────────────────────
  if (options.saveDocsToKB && parsedData.classified.documentation.length > 0) {
    emitPhase('kb', 0, 1, 'Processing documentation for Knowledge Base…');

    try {
      const kbResult = await processAllureDocumentation(
        parsedData.classified.documentation,
        projectId,
        userId,
        importId,
      );

      stats.kbDocumentsCreated = kbResult.documentsCreated;
      stats.filesSkipped += kbResult.filesSkipped;
      stats.errors.push(...kbResult.errors);

      emitPhase('kb', 1, 1, `${stats.kbDocumentsCreated} KB documents created`);
    } catch (kbErr) {
      const msg = `KB processing failed: ${kbErr instanceof Error ? kbErr.message : String(kbErr)}`;
      stats.errors.push(msg);
      logger.error('[AllureImport] KB phase error', { importId, error: msg });
      emitPhase('kb', 0, 1, 'KB processing failed (non-fatal)');
    }
  }

  // ── Phase 5: DONE ──────────────────────────────────────────────────────────
  const durationMs = Date.now() - startTime;
  const hierarchy = hierarchyCache.buildHierarchy();

  logger.info('[AllureImport] Import complete', {
    importId,
    durationMs,
    stats,
    hierarchyModules: hierarchy.modules.length,
    hierarchyUnassigned: hierarchy.unassigned.length,
  });

  try {
    emitProgress({
      importId,
      success: stats.errors.length === 0,
      stats: { ...stats },
      hierarchy,
      durationMs,
      timestamp: new Date().toISOString(),
    } satisfies AllureImportCompletedPayload);
  } catch (_) { /* ignore */ }

  await updateImportRecord(importId, {
    status: 'completed',
    stats,
    file_name: jobData.originalFileName,
    file_size: jobData.originalFileSize,
    // Snapshot the tree alongside stats so the REST endpoint can return it
    // even if the user missed the WS completion event.
    hierarchy,
  });

  await removeAllureObject(storageKey);

  return { stats, hierarchy };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV / PDF Import Processor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a CSV or PDF file exported from Allure TestOps.
 *
 * Simplified pipeline compared to ZIP:
 *   PARSING → Deterministic CSV parsing / LLM-based PDF text extraction → ParsedTestCaseFromLLM[]
 *   TESTS   → AI step conversion + IntentTestCase creation (reuses HierarchyCache, dedup, etc.)
 *   DONE    → Emit final stats
 *
 * No file classification or KB processing — CSV/PDF contain only test case definitions.
 */
async function processCsvPdfImport(
  jobData: AllureImportJobData,
  emitProgress: ProgressEmitter,
): Promise<AllureImportResult> {
  const { importId, projectId, userId, workspaceId, options } = jobData;
  const storageKey = resolveStorageKey(jobData);
  const sourceFormat = jobData.sourceFormat ?? 'csv';
  const stats = emptyStats();
  const startTime = Date.now();

  const emitPhase = (
    phase: AllureImportPhase,
    current: number,
    total: number,
    message: string,
  ): void => {
    try {
      emitProgress({
        importId,
        phase,
        current,
        total,
        message,
        stats: { ...stats },
        timestamp: new Date().toISOString(),
      } satisfies AllureImportProgressPayload);
    } catch (e) {
      logger.warn('[AllureCsvPdfImport] Progress emit failed', {
        phase,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────
  await createImportRecord({ importId, projectId, userId, workspaceId });

  // ── Phase: PARSING ───────────────────────────────────────────────────────
  emitPhase('parsing', 0, 1, `Parsing ${sourceFormat.toUpperCase()} file…`);

  let parsedTestCases: ParsedTestCaseFromLLM[];

  try {
    const objectBuffer = await downloadAllureObject(storageKey);

    if (sourceFormat === 'csv') {
      const csvContent = objectBuffer.toString('utf-8');
      const csvResult = await parseAllureCsv(csvContent, (current, total) => {
        emitPhase('parsing', current, total, `Parsing CSV rows (batch ${current}/${total})…`);
      });
      parsedTestCases = csvResult.testCases;
      stats.errors.push(...csvResult.errors);
    } else {
      const pdfResult = await parseAllurePdf(objectBuffer, (current, total) => {
        emitPhase('parsing', current, total, `Parsing PDF pages (chunk ${current}/${total})…`);
      });
      parsedTestCases = pdfResult.testCases;
      stats.errors.push(...pdfResult.errors);
    }

    stats.totalFiles = 1;
    stats.testsFound = parsedTestCases.length;

    emitPhase('parsing', 1, 1, `Found ${stats.testsFound} test cases`);

    logger.info('[AllureCsvPdfImport] Parsing complete', {
      importId,
      sourceFormat,
      testsFound: stats.testsFound,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[AllureCsvPdfImport] Parsing failed (fatal)', { importId, error: message });

    try {
      emitProgress({
        importId,
        error: message,
        timestamp: new Date().toISOString(),
      } satisfies AllureImportFailedPayload);
    } catch (_) { /* ignore */ }

    await updateImportRecord(importId, { status: 'failed', stats, error_message: message });
    await removeAllureObject(storageKey);
    throw err;
  }

  // ── Phase: TESTS ─────────────────────────────────────────────────────────
  const hierarchyCache = new HierarchyCache();

  if (parsedTestCases.length > 0) {
    emitPhase('tests', 0, parsedTestCases.length, 'Creating test cases…');

    try {
      const platformTreeId = await getPlatformTreeId(projectId, userId, options.platform);

      const existingNames = options.deduplicateTests
        ? await getExistingTestCaseNames(projectId, userId)
        : new Set<string>();
      const batchNames = new Set<string>();

      for (let i = 0; i < parsedTestCases.length; i++) {
        const tc = parsedTestCases[i];

        emitPhase('tests', i, parsedTestCases.length, `Creating: ${tc.name}`);

        try {
          // Dedup check (see ZIP branch for the same-batch vs pre-existing split)
          const key = normalizeName(tc.name);
          if (options.deduplicateTests && (existingNames.has(key) || batchNames.has(key))) {
            const sameBatch = batchNames.has(key);
            stats.testsSkipped++;
            if (sameBatch) {
              stats.errors.push(
                `Skipped "${tc.name}" — another imported test has the same name. ` +
                `Distinct tests with identical names can't both be imported; rename to keep both.`,
              );
            }
            continue;
          }

          // PDF steps already carry real action types + expected results from
          // the PDF parser's LLM pass — finalize them deterministically instead
          // of running a SECOND lossy LLM pass over the same data (that double
          // conversion dropped steps in production). CSV steps are placeholder
          // 'click' entries that still need AI type inference.
          const { steps, degraded: stepsDegraded } =
            sourceFormat === 'pdf'
              ? { steps: finalizeTypedSteps(tc.steps), degraded: false }
              : await convertImportedStepsWithAI(tc.name, tc.steps, options.platform);

          // Resolve hierarchy (module + flow) via cache
          const { moduleId, flowId } = await resolveHierarchy(
            hierarchyCache,
            platformTreeId,
            {
              projectId,
              userId,
              autoCreateModules: options.autoCreateModules,
              autoCreateFlows: options.autoCreateFlows,
              platform: options.platform,
            },
            tc.moduleName,
            tc.flowName,
          );

          // Build description
          const descParts: string[] = [];
          if (tc.description) descParts.push(tc.description);
          if (tc.preconditions?.length) {
            descParts.push(`**Preconditions:**\n${tc.preconditions.map((p) => `- ${p}`).join('\n')}`);
          }
          if (tc.links?.length) {
            descParts.push(`**Links:**\n${tc.links.map((l) => `- ${l}`).join('\n')}`);
          }
          if (tc.owner) descParts.push(`**Owner:** ${tc.owner}`);
          const description = descParts.join('\n\n');

          // Create test case
          // CSV/PDF imports also benefit from a default start URL — symmetric
          // with the ZIP path above. See note there for why we pass `undefined`
          // instead of `null` when the option is unset.
          //
          // priority + preconditions go in this single create() call (mirror of
          // the ZIP path). The preconditions also remain inlined in the markdown
          // `description` above for human readability; the structured column is
          // what downstream tooling reads.
          const tags = tc.tags ?? [];
          const priority = tc.priority ?? 'medium';
          const preconditions = tc.preconditions ?? [];
          const created = await IntentTestCaseService.create({
            projectId,
            userId,
            name: tc.name,
            description: description || undefined,
            startUrl: options.defaultStartUrl ?? undefined,
            steps,
            ...(flowId && { flowId }),
            status: 'draft',
            kind: 'standalone',
            platform: options.platform,
            priority,
            ...(preconditions.length > 0 && { preconditions }),
            // Import provenance. `source_status` is defined as the SOURCE RUN
            // VERDICT (passed/failed/broken/skipped). CSV/PDF are design-time
            // TestOps exports with no run, so it stays NULL here — consistent
            // with the ZIP path, not a gap. NOTE: the TestOps lifecycle status
            // (Active/Draft/Deprecated, parsed into `tc.status`) is a DIFFERENT
            // concept and is intentionally NOT written to source_status — it
            // would corrupt the verdict semantics. It is currently not mapped
            // anywhere (imported tests are always lifecycle 'draft' by design).
            importId,
            stepsDegraded,
          });

          // Tags are the only field create() doesn't accept — set via update().
          if (tags.length > 0) {
            try {
              await IntentTestCaseService.update({
                id: created.id,
                userId,
                tags,
              });
            } catch (updateErr) {
              // Mirror of the ZIP-path handling above: surface in stats.errors
              // so the user sees the warning instead of silently losing tags.
              const errMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
              logger.warn('[AllureCsvPdfImport] Could not update tags', {
                testCaseId: created.id,
                error: errMsg,
              });
              stats.errors.push(
                `Tags not saved for "${created.name}": ${errMsg}`,
              );
            }
          }

          batchNames.add(normalizeName(tc.name));
          stats.testsImported++;
          if (stepsDegraded) stats.testsWithDegradedSteps++;

          hierarchyCache.addTestNode(
            {
              id: created.id,
              name: created.name,
              status: 'passed', // CSV/PDF have design-time status, use 'passed' as neutral
              priority,
              stepsCount: steps.length,
            },
            flowId,
            moduleId,
          );
        } catch (testErr) {
          const msg = `Failed to import "${tc.name}": ${testErr instanceof Error ? testErr.message : String(testErr)}`;
          stats.errors.push(msg);
          stats.testsSkipped++;
          logger.error('[AllureCsvPdfImport] Test case import failed', {
            testName: tc.name,
            error: msg,
          });
        }

        // Rate-limit protection between AI calls (skip after last item)
        if (i < parsedTestCases.length - 1) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      stats.modulesCreated = hierarchyCache.modulesCreated;
      stats.flowsCreated = hierarchyCache.flowsCreated;

      // Mirror of the ZIP path — one summary warning for degraded tests.
      if (stats.testsWithDegradedSteps > 0) {
        stats.errors.push(
          `${stats.testsWithDegradedSteps} test(s) imported with unreliable step types ` +
          `(AI step conversion failed — all steps defaulted to "click"). Review these before running.`,
        );
      }

      logger.info('[AllureCsvPdfImport] Test case import phase complete', {
        imported: stats.testsImported,
        skipped: stats.testsSkipped,
        modulesCreated: stats.modulesCreated,
        flowsCreated: stats.flowsCreated,
        degraded: stats.testsWithDegradedSteps,
      });
    } catch (phaseErr) {
      const msg = `Test case import phase failed: ${phaseErr instanceof Error ? phaseErr.message : String(phaseErr)}`;
      stats.errors.push(msg);
      logger.error('[AllureCsvPdfImport] Tests phase error', { importId, error: msg });
    }
  }

  emitPhase('tests', parsedTestCases.length, parsedTestCases.length, `${stats.testsImported} test cases imported`);

  // ── Phase: DONE ──────────────────────────────────────────────────────────
  const durationMs = Date.now() - startTime;
  const hierarchy = hierarchyCache.buildHierarchy();

  logger.info('[AllureCsvPdfImport] Import complete', {
    importId,
    sourceFormat,
    durationMs,
    stats,
  });

  try {
    emitProgress({
      importId,
      success: stats.errors.length === 0,
      stats: { ...stats },
      hierarchy,
      durationMs,
      timestamp: new Date().toISOString(),
    } satisfies AllureImportCompletedPayload);
  } catch (_) { /* ignore */ }

  await updateImportRecord(importId, {
    status: 'completed',
    stats,
    file_name: jobData.originalFileName,
    file_size: jobData.originalFileSize,
    // Mirror of the ZIP-path behaviour — REST status returns the tree even
    // if the WS completion event was missed.
    hierarchy,
  });
  await removeAllureObject(storageKey);

  return { stats, hierarchy };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch an Allure import job to the appropriate processor based on source format.
 *
 * - 'zip' → existing processAllureImport (ZIP with *-result.json)
 * - 'csv' / 'pdf' → processCsvPdfImport (Allure TestOps export)
 */
export async function processAllureImportDispatch(
  jobData: AllureImportJobData,
  emitProgress: ProgressEmitter,
): Promise<AllureImportResult> {
  const format = jobData.sourceFormat ?? 'zip';

  if (format === 'csv' || format === 'pdf') {
    return processCsvPdfImport(jobData, emitProgress);
  }

  return processAllureImport(jobData, emitProgress);
}
