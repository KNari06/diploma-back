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

import fs from 'fs/promises';
import path from 'path';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { parseAllureZip } from './allure-parser';
import {
  mapAllureResult,
  getWebUiPlatformId,
  resolveHierarchy,
  convertImportedStepsWithAI,
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

      for (const tc of items) names.add(tc.name.toLowerCase());

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
  },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('allure_imports')
    .update({
      status: update.status,
      stats: update.stats,
      error_message: update.error_message ?? null,
      file_name: update.file_name ?? null,
      file_size: update.file_size ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', importId);

  if (error) {
    logger.warn('[AllureImport] Failed to update import record', {
      importId,
      error: error.message,
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
 * @param jobData       - BullMQ job data (importId, projectId, userId, zipFilePath, options)
 * @param emitProgress  - Callback for WebSocket progress events
 * @returns Final stats + hierarchy tree (always — never throws)
 */
export async function processAllureImport(
  jobData: AllureImportJobData,
  emitProgress: ProgressEmitter,
): Promise<AllureImportResult> {
  const { importId, projectId, userId, workspaceId, options } = jobData;
  const filePath = jobData.filePath ?? jobData.zipFilePath!;
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

  /**
   * Clean up the temp ZIP file and its parent directory.
   * Fire-and-forget — failures are logged but don't affect the import result.
   */
  const cleanupTempFile = async (): Promise<void> => {
    try {
      const dir = path.dirname(filePath);
      await fs.rm(dir, { recursive: true, force: true });
      logger.debug('[AllureImport] Cleaned up temp file', { filePath });
    } catch (e) {
      logger.warn('[AllureImport] Failed to clean up temp file (non-fatal)', {
        filePath,
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
    const zipBuffer = await fs.readFile(filePath);
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

    await cleanupTempFile();

    // Only phase where we propagate — caller (job handler) decides whether to retry
    throw err;
  }

  // ── Phase 3: CREATE TEST CASES ────────────────────────────────────────────
  const hierarchyCache = new HierarchyCache();

  if (options.importTestCases && parsedData.results.length > 0) {
    emitPhase('tests', 0, parsedData.results.length, 'Importing test cases…');

    try {
      const webUiPlatformId = await getWebUiPlatformId(projectId, userId);

      // Fetch existing test names for dedup
      const existingNames = options.deduplicateTests
        ? await getExistingTestCaseNames(projectId, userId)
        : new Set<string>();

      for (let i = 0; i < parsedData.results.length; i++) {
        const result = parsedData.results[i];

        emitPhase('tests', i, parsedData.results.length, `Importing: ${result.name}`);

        try {
          // Dedup check — skip entirely without resolving hierarchy.
          // We must NOT call resolveHierarchy here because it would create
          // modules/flows for tests that won't actually be imported.
          if (options.deduplicateTests && existingNames.has(result.name.toLowerCase())) {
            logger.debug('[AllureImport] Skipping duplicate test case', {
              name: result.name,
            });
            stats.testsSkipped++;
            continue;
          }

          // Map Allure result → IntentTestCase params
          const mapped = await mapAllureResult(
            result,
            parsedData.containerByResultUuid,
            hierarchyCache,
            webUiPlatformId,
            {
              projectId,
              userId,
              autoCreateModules: options.autoCreateModules,
              autoCreateFlows: options.autoCreateFlows,
            },
          );

          // Create test case (create() does not support tags/priority)
          const created = await IntentTestCaseService.create({
            projectId: mapped.createParams.projectId,
            userId: mapped.createParams.userId,
            name: mapped.createParams.name,
            description: mapped.createParams.description || undefined,
            steps: mapped.createParams.steps,
            flowId: mapped.createParams.flowId,
            status: mapped.createParams.status,
            kind: mapped.createParams.kind,
            platform: mapped.createParams.platform,
          });

          // Update tags, priority, preconditions via update()
          const hasExtra =
            mapped.createParams.tags.length > 0 ||
            mapped.createParams.priority !== 'medium' ||
            mapped.createParams.preconditions.length > 0;

          if (hasExtra) {
            try {
              await IntentTestCaseService.update({
                id: created.id,
                userId,
                tags: mapped.createParams.tags.length > 0
                  ? mapped.createParams.tags
                  : undefined,
                priority: mapped.createParams.priority,
              });
            } catch (updateErr) {
              // Non-fatal — test case was created successfully, just without tags/priority
              logger.warn('[AllureImport] Could not update tags/priority for test case', {
                testCaseId: created.id,
                error: updateErr instanceof Error ? updateErr.message : String(updateErr),
              });
            }
          }

          // Register name in dedup set to avoid same-batch duplicates
          existingNames.add(result.name.toLowerCase());
          stats.testsImported++;

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

      logger.info('[AllureImport] Test case import phase complete', {
        imported: stats.testsImported,
        skipped: stats.testsSkipped,
        modulesCreated: stats.modulesCreated,
        flowsCreated: stats.flowsCreated,
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
  });

  await cleanupTempFile();

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
  const filePath = jobData.filePath ?? jobData.zipFilePath!;
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

  const cleanupTempFile = async (): Promise<void> => {
    try {
      const dir = path.dirname(filePath);
      await fs.rm(dir, { recursive: true, force: true });
    } catch (e) {
      logger.warn('[AllureCsvPdfImport] Failed to clean up temp file (non-fatal)', {
        filePath,
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
    if (sourceFormat === 'csv') {
      const csvContent = await fs.readFile(filePath, 'utf-8');
      const csvResult = await parseAllureCsv(csvContent, (current, total) => {
        emitPhase('parsing', current, total, `Parsing CSV rows (batch ${current}/${total})…`);
      });
      parsedTestCases = csvResult.testCases;
      stats.errors.push(...csvResult.errors);
    } else {
      const pdfResult = await parseAllurePdf(filePath, (current, total) => {
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
    await cleanupTempFile();
    throw err;
  }

  // ── Phase: TESTS ─────────────────────────────────────────────────────────
  const hierarchyCache = new HierarchyCache();

  if (parsedTestCases.length > 0) {
    emitPhase('tests', 0, parsedTestCases.length, 'Creating test cases…');

    try {
      const webUiPlatformId = await getWebUiPlatformId(projectId, userId);

      const existingNames = options.deduplicateTests
        ? await getExistingTestCaseNames(projectId, userId)
        : new Set<string>();

      for (let i = 0; i < parsedTestCases.length; i++) {
        const tc = parsedTestCases[i];

        emitPhase('tests', i, parsedTestCases.length, `Creating: ${tc.name}`);

        try {
          // Dedup check
          if (options.deduplicateTests && existingNames.has(tc.name.toLowerCase())) {
            stats.testsSkipped++;
            continue;
          }

          // Convert steps using AI (determines correct action types, cleans descriptions)
          // Falls back to 'click' type for all steps if AI fails
          const steps = await convertImportedStepsWithAI(tc.name, tc.steps);

          // Resolve hierarchy (module + flow) via cache
          const { moduleId, flowId } = await resolveHierarchy(
            hierarchyCache,
            webUiPlatformId,
            {
              projectId,
              userId,
              autoCreateModules: options.autoCreateModules,
              autoCreateFlows: options.autoCreateFlows,
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
          const created = await IntentTestCaseService.create({
            projectId,
            userId,
            name: tc.name,
            description: description || undefined,
            steps,
            ...(flowId && { flowId }),
            status: 'draft',
            kind: 'standalone',
            platform: 'web',
          });

          // Update tags/priority via update()
          const tags = tc.tags ?? [];
          const priority = tc.priority ?? 'medium';
          if (tags.length > 0 || priority !== 'medium') {
            try {
              await IntentTestCaseService.update({
                id: created.id,
                userId,
                tags: tags.length > 0 ? tags : undefined,
                priority,
              });
            } catch (updateErr) {
              logger.warn('[AllureCsvPdfImport] Could not update tags/priority', {
                testCaseId: created.id,
                error: updateErr instanceof Error ? updateErr.message : String(updateErr),
              });
            }
          }

          existingNames.add(tc.name.toLowerCase());
          stats.testsImported++;

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

      logger.info('[AllureCsvPdfImport] Test case import phase complete', {
        imported: stats.testsImported,
        skipped: stats.testsSkipped,
        modulesCreated: stats.modulesCreated,
        flowsCreated: stats.flowsCreated,
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

  await updateImportRecord(importId, { status: 'completed', stats });
  await cleanupTempFile();

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
