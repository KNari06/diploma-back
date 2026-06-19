/**
 * Allure Import Controller
 *
 * Handles upload validation, project access check, and dispatches to
 * async BullMQ job for processing. Supports ZIP, CSV, and PDF uploads.
 */

import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { QueueManager } from '@/config/infrastructure/queues';
import { resolveImportOptions } from '@/services/allure-import/allure-import.types';
import {
  ALLURE_IMPORTS_BUCKET,
  buildStorageKey,
  contentTypeForFormat,
  removeAllureObject,
} from '@/services/allure-import/allure-import.storage';
import { PERMISSIONS, WorkspaceAccessService } from '@/services/core/workspace-access.service';
import type { AllureImportJobData, AllureImportOptions, AllureSourceFormat } from '@/services/allure-import/allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload the buffer to Supabase Storage and return the object key.
 * Both API and worker pods read this bucket, so the worker can fetch the file
 * regardless of which pod the upload landed on.
 */
async function uploadToStorage(
  buffer: Buffer,
  storageKey: string,
  contentType: string,
): Promise<void> {
  const { error } = await supabaseAdmin.storage
    .from(ALLURE_IMPORTS_BUCKET)
    .upload(storageKey, buffer, {
      contentType,
      upsert: false,
      cacheControl: '3600',
    });

  if (error) {
    logger.error('[AllureImportController] Storage upload failed', {
      storageKey,
      error: error.message,
    });
    throw new Error(`Failed to upload Allure file to storage: ${error.message}`);
  }
}

/**
 * Parse a multipart-form boolean field with strict semantics.
 *
 * Multer/multipart turns every body field into a string, so a JSON `false` is
 * sent as the literal `"false"`. Treat any of `"false"|"0"|"off"|"no"` (case
 * insensitive) as opt-out. Missing field → default (true for our toggles).
 */
function parseBoolField(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'false' || normalized === '0' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  return true;
}

/**
 * Detect source format from the uploaded file's name/mimetype.
 */
function detectSourceFormat(file: Express.Multer.File): AllureSourceFormat {
  const lowerName = file.originalname.toLowerCase();
  if (lowerName.endsWith('.csv')) return 'csv';
  if (lowerName.endsWith('.pdf')) return 'pdf';
  return 'zip';
}

/**
 * Verify the user can write tests in the given project.
 *
 * Looks up the project's workspace, then checks `TEST_WRITE` membership in that
 * workspace. Allows owner + any teammate with the right role — not just the
 * project's original creator.
 *
 * Returns false if the project is missing, the workspace doesn't match, or the
 * user lacks permission. Also returns false on transient DB errors (logged).
 */
async function verifyProjectWriteAccess(
  projectId: string,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { data: project, error } = await supabaseAdmin
    .from('projects')
    .select('id, workspace_id')
    .eq('id', projectId)
    .maybeSingle();

  if (error) {
    logger.warn('[AllureImportController] Project lookup error', {
      projectId,
      userId,
      error: error.message,
    });
    return false;
  }

  if (!project || project.workspace_id !== workspaceId) {
    return false;
  }

  return WorkspaceAccessService.hasPermission(userId, workspaceId, PERMISSIONS.TEST_WRITE);
}

/**
 * Verify the user can read import records in the given workspace.
 *
 * Used by GET status/details endpoints. Workspace is resolved via the import
 * record itself, so callers don't need to pass it.
 */
async function verifyWorkspaceReadAccess(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return WorkspaceAccessService.hasPermission(userId, workspaceId, PERMISSIONS.PROJECT_READ);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/allure-import/upload
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadAllure(req: Request, res: Response): Promise<void> {
  try {
    // ── 1. Validate file ──────────────────────────────────────────────────
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ success: false, error: 'No file provided. Upload a .zip, .csv, or .pdf file.' });
      return;
    }

    const fileBuffer = req.file.buffer;
    if (fileBuffer.length === 0) {
      res.status(400).json({ success: false, error: 'Uploaded file is empty.' });
      return;
    }

    const sourceFormat = detectSourceFormat(req.file);

    // ── 2. Validate required fields ───────────────────────────────────────
    const projectId = req.body.projectId as string | undefined;
    const workspaceId = req.body.workspaceId as string | undefined;
    const userId = (req as any).user?.id as string | undefined;

    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }
    if (!workspaceId) {
      res.status(400).json({ success: false, error: 'workspaceId is required' });
      return;
    }
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // ── 3. Project access check (workspace membership + TEST_WRITE) ──────
    const hasAccess = await verifyProjectWriteAccess(projectId, workspaceId, userId);
    if (!hasAccess) {
      res.status(403).json({
        success: false,
        error: 'Project not found or access denied',
      });
      return;
    }

    // ── 4. Resolve import options from request body ───────────────────────
    // Multipart fields arrive as strings; pass `defaultStartUrl` straight
    // through so the type-level `normaliseDefaultStartUrl` helper validates
    // + canonicalises in one place. Empty values (string "" / undefined)
    // resolve to `null` and the service skips the start_url write.
    const options = resolveImportOptions({
      importTestCases:   parseBoolField(req.body.importTestCases,   true),
      autoCreateModules: parseBoolField(req.body.autoCreateModules, true),
      autoCreateFlows:   parseBoolField(req.body.autoCreateFlows,   true),
      deduplicateTests:  parseBoolField(req.body.deduplicateTests,  true),
      saveDocsToKB:      parseBoolField(req.body.saveDocsToKB,      true),
      defaultStartUrl:   typeof req.body.defaultStartUrl === 'string' ? req.body.defaultStartUrl : undefined,
      // Multipart field arrives as a string; `resolveImportOptions` validates
      // it against the enum and falls back to 'web' for anything unexpected.
      platform:          typeof req.body.platform === 'string' ? req.body.platform as AllureImportOptions['platform'] : undefined,
    });

    const importId = randomUUID();

    logger.info('[AllureImportController] Upload received', {
      importId,
      projectId,
      userId,
      sourceFormat,
      fileSizeBytes: fileBuffer.length,
    });

    // ── 5. Upload file to Supabase Storage (shared between API + worker) ─
    const storageKey = buildStorageKey(userId, importId, sourceFormat);
    await uploadToStorage(fileBuffer, storageKey, contentTypeForFormat(sourceFormat));

    // ── 6. Always dispatch via BullMQ (avoids blocking event loop) ────
    const jobData: AllureImportJobData = {
      importId,
      projectId,
      userId,
      workspaceId,
      sourceFormat,
      storageKey,
      originalFileName: req.file.originalname,
      originalFileSize: fileBuffer.length,
      options,
    };

    try {
      await QueueManager.addAllureImportJob(jobData);
    } catch (queueErr) {
      // Storage upload already succeeded but the job never got queued — drop the
      // object so we don't leak it into the bucket forever.
      await removeAllureObject(storageKey);
      throw queueErr;
    }

    res.status(202).json({
      success: true,
      importId,
      async: true,
      message: `Import queued. Subscribe to WebSocket event allure:import:progress with importId "${importId}" for real-time progress.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[AllureImportController] Upload handler error', { error: message });

    // Multer-specific errors (file too large, wrong type)
    if (message.includes('File too large')) {
      res.status(413).json({
        success: false,
        error: 'File exceeds 100 MB limit',
      });
      return;
    }

    if (message.includes('Only .zip') || message.includes('Only .zip, .csv')) {
      res.status(400).json({ success: false, error: message });
      return;
    }

    res.status(500).json({ success: false, error: 'Import failed: ' + message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/allure-import/status/:importId
// ─────────────────────────────────────────────────────────────────────────────

export async function getImportStatus(req: Request, res: Response): Promise<void> {
  try {
    const { importId } = req.params;
    const userId = (req as any).user?.id as string | undefined;

    if (!importId) {
      res.status(400).json({ success: false, error: 'importId is required' });
      return;
    }
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // `hierarchy` may not exist in the DB yet (pre-migration deployments).
    // Selecting it returns null rather than failing the whole query as long
    // as the column was added in 20260504_allure_imports_hierarchy.sql; if
    // for some reason the column is still missing, the fallback handler
    // below catches the "column ... does not exist" error and retries
    // without it so legacy environments keep working.
    // Initial select includes the optional `hierarchy` column. The TS type
    // returned by .select() is non-narrowable to "field may not exist", so
    // we widen the local binding with `as any` and let the runtime fallback
    // (below) handle pre-migration deployments.
    let data: Record<string, unknown> | null = null;
    let error: { message?: string } | null = null;
    {
      const r = await supabaseAdmin
        .from('allure_imports')
        .select('id, workspace_id, status, stats, error_message, hierarchy, created_at, completed_at')
        .eq('id', importId)
        .maybeSingle();
      data = (r.data as unknown) as Record<string, unknown> | null;
      error = r.error;
    }
    if (error && /hierarchy/i.test(error.message ?? '') && /(column|does not exist|not found)/i.test(error.message ?? '')) {
      const retry = await supabaseAdmin
        .from('allure_imports')
        .select('id, workspace_id, status, stats, error_message, created_at, completed_at')
        .eq('id', importId)
        .maybeSingle();
      data = (retry.data as unknown) as Record<string, unknown> | null;
      error = retry.error;
    }

    if (error) {
      logger.warn('[AllureImportController] Status check DB error', {
        importId,
        error: error.message,
      });
      res.status(500).json({ success: false, error: 'Database error' });
      return;
    }

    if (!data) {
      res.status(404).json({ success: false, error: 'Import not found' });
      return;
    }

    const workspaceId = data.workspace_id as string | undefined;
    if (!workspaceId || !(await verifyWorkspaceReadAccess(workspaceId, userId))) {
      res.status(404).json({ success: false, error: 'Import not found' });
      return;
    }

    res.status(200).json({
      success: true,
      importId,
      status: data.status,
      stats: data.stats,
      // Persisted hierarchy snapshot — frontend reads this when the WS
      // completion event was missed (network blip, dialog re-opened later,
      // polling fallback). Null/undefined for in-flight or pre-migration
      // imports — caller treats those as "no tree to render".
      hierarchy: data.hierarchy ?? null,
      errorMessage: data.error_message ?? null,
      createdAt: data.created_at,
      completedAt: data.completed_at ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[AllureImportController] Status handler error', { error: message });
    res.status(500).json({ success: false, error: message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/allure-import/status/:importId/details
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get full import details: import record + all test cases created during this import.
 * Test cases are identified by matching project_id + created_at window.
 */
export async function getImportDetails(req: Request, res: Response): Promise<void> {
  try {
    const { importId } = req.params;
    const userId = (req as any).user?.id as string | undefined;

    if (!importId) {
      res.status(400).json({ success: false, error: 'importId is required' });
      return;
    }
    if (!userId) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    // 1. Fetch the import record
    const { data: importRecord, error: importError } = await supabaseAdmin
      .from('allure_imports')
      .select('id, project_id, user_id, workspace_id, status, stats, error_message, file_name, created_at, completed_at')
      .eq('id', importId)
      .maybeSingle();

    if (importError) {
      res.status(500).json({ success: false, error: 'Database error' });
      return;
    }
    if (!importRecord) {
      res.status(404).json({ success: false, error: 'Import not found' });
      return;
    }

    if (!(await verifyWorkspaceReadAccess(importRecord.workspace_id, userId))) {
      res.status(404).json({ success: false, error: 'Import not found' });
      return;
    }

    // 2. Fetch test cases belonging to this import.
    //
    //    Primary path: filter by `import_id` (exact — set by the import on each
    //    created test). This is precise: no leakage from a teammate's parallel
    //    import, no leakage from the user's own manual creates during the
    //    import window, and no over-capture for an import still `processing`.
    //
    //    Fallback path: imports created before the 20260604 provenance
    //    migration have no `import_id` on their tests. For those we fall back to
    //    the legacy project_id + user_id + created_at-window match (its
    //    known caveat: a teammate's parallel import isn't included, which is the
    //    safe direction). Detected by `import_id` query returning zero rows.
    //
    //    Cap of 500 is intentional — we don't ship a 10 MB response for a
    //    5000-test import. Frontend shows a banner when the count is hit.
    const projectId = importRecord.project_id;
    const importUserId = (importRecord as { user_id?: string }).user_id ?? userId;
    const TEST_CASE_HARD_LIMIT = 500;
    const SELECT_COLS =
      'id, name, description, steps_json, preconditions, flow_id, tags, priority, status, source_status, steps_degraded, created_at, test_flows(name, module_id, test_modules(name))';

    let { data: testCases, error: tcError } = await supabaseAdmin
      .from('intent_test_cases')
      .select(SELECT_COLS)
      .eq('import_id', importId)
      .order('created_at', { ascending: true })
      .limit(TEST_CASE_HARD_LIMIT);

    // Legacy fallback: pre-migration import with no import_id on its tests.
    if (!tcError && (!testCases || testCases.length === 0)) {
      const importStart = importRecord.created_at;
      const importEnd = importRecord.completed_at ?? new Date().toISOString();
      const legacy = await supabaseAdmin
        .from('intent_test_cases')
        .select(SELECT_COLS)
        .eq('project_id', projectId)
        .eq('user_id', importUserId)
        .gte('created_at', importStart)
        .lte('created_at', importEnd)
        .order('created_at', { ascending: true })
        .limit(TEST_CASE_HARD_LIMIT);
      testCases = legacy.data;
      tcError = legacy.error;
    }

    if (tcError) {
      logger.warn('[AllureImportController] Failed to fetch test cases for import', {
        importId,
        error: tcError.message,
      });
    }

    // 3. Map test cases to a clean response shape
    const mappedTestCases = (testCases ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.name,
      description: tc.description ?? null,
      stepsCount: Array.isArray(tc.steps_json) ? tc.steps_json.length : 0,
      steps: Array.isArray(tc.steps_json) ? tc.steps_json.map((s: any) => ({
        type: s.type,
        description: s.description,
        value: s.value ?? undefined,
      })) : [],
      preconditions: Array.isArray(tc.preconditions) ? tc.preconditions : [],
      flowId: tc.flow_id ?? null,
      flowName: tc.test_flows?.name ?? null,
      moduleName: tc.test_flows?.test_modules?.name ?? null,
      tags: tc.tags ?? [],
      priority: tc.priority ?? 'medium',
      status: tc.status ?? 'draft',
      // Provenance (null for pre-migration / non-Allure tests).
      sourceStatus: tc.source_status ?? null,
      stepsDegraded: tc.steps_degraded ?? false,
      createdAt: tc.created_at,
    }));

    // Surface truncation so the frontend can show "showing first N of M"
    // when the cap was hit. Stats already carry the real testsImported
    // count, but the array length is what the table renders, and the gap
    // between the two is otherwise invisible to the user.
    const totalImported = (importRecord.stats as { testsImported?: number } | null)?.testsImported ?? 0;
    const truncated =
      mappedTestCases.length === TEST_CASE_HARD_LIMIT &&
      totalImported > TEST_CASE_HARD_LIMIT;

    res.status(200).json({
      success: true,
      import: {
        importId: importRecord.id,
        status: importRecord.status,
        stats: importRecord.stats,
        errorMessage: importRecord.error_message ?? null,
        fileName: importRecord.file_name ?? null,
        createdAt: importRecord.created_at,
        completedAt: importRecord.completed_at ?? null,
      },
      testCases: mappedTestCases,
      testCaseLimit: TEST_CASE_HARD_LIMIT,
      truncated,
      totalCount: totalImported,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[AllureImportController] Details handler error', { error: message });
    res.status(500).json({ success: false, error: message });
  }
}
