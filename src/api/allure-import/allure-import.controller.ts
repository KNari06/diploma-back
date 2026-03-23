/**
 * Allure Import Controller
 *
 * Handles upload validation, project access check, and dispatches to:
 *   - Synchronous processing (< 50 test results) → returns stats directly
 *   - Async BullMQ job (≥ 50 test results) → returns importId for WS tracking
 */

import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { QueueManager } from '@/config/infrastructure/queues';
import { processAllureImport } from '@/services/allure-import/allure-import.service';
import { resolveImportOptions } from '@/services/allure-import/allure-import.types';
import type { AllureImportJobData } from '@/services/allure-import/allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Threshold: if ZIP has fewer test result files, process synchronously
// ─────────────────────────────────────────────────────────────────────────────
const ASYNC_THRESHOLD = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quick estimate of how many *-result.json files are in the buffer.
 * We don't fully parse the ZIP here — we just count filename occurrences
 * in the ZIP central directory (all filenames are stored as plain text).
 */
function estimateResultCount(zipBuffer: Buffer): number {
  // Central directory entry signature: 0x504B0102
  const sig = Buffer.from([0x50, 0x4B, 0x01, 0x02]);
  let count = 0;
  let pos = 0;

  while (pos < zipBuffer.length - 4) {
    const idx = zipBuffer.indexOf(sig, pos);
    if (idx === -1) break;

    // Read filename length field (offset 28 from signature start in central dir)
    // Guard against out-of-bounds if the ZIP is malformed
    if (idx + 46 > zipBuffer.length) break;

    const fnLen = zipBuffer.readUInt16LE(idx + 28);
    const fnEnd = idx + 46 + fnLen;

    // Guard: filename end must be within buffer bounds
    if (fnEnd > zipBuffer.length || fnLen > 1024) {
      pos = idx + 4; // skip past this entry
      continue;
    }

    const fn = zipBuffer.subarray(idx + 46, fnEnd).toString('utf-8');

    if (fn.toLowerCase().endsWith('-result.json')) count++;

    // Advance past this central directory entry (at minimum past the filename)
    pos = fnEnd;
  }

  return count;
}

/**
 * Verify that the requesting user has access to the given project.
 * Returns false if the project doesn't exist or user isn't a member.
 */
async function verifyProjectAccess(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.warn('[AllureImportController] Project access check error', {
      projectId,
      userId,
      error: error.message,
    });
  }

  return !!data;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/allure-import/upload
// ─────────────────────────────────────────────────────────────────────────────

export async function uploadAllure(req: Request, res: Response): Promise<void> {
  try {
    // ── 1. Validate file ──────────────────────────────────────────────────
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ success: false, error: 'No ZIP file provided' });
      return;
    }

    const zipBuffer = req.file.buffer;

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

    // ── 3. Project access check ───────────────────────────────────────────
    const hasAccess = await verifyProjectAccess(projectId, userId);
    if (!hasAccess) {
      res.status(403).json({
        success: false,
        error: 'Project not found or access denied',
      });
      return;
    }

    // ── 4. Resolve import options from request body ───────────────────────
    const options = resolveImportOptions({
      importTestCases:    req.body.importTestCases   !== 'false',
      autoCreateModules:  req.body.autoCreateModules !== 'false',
      autoCreateFlows:    req.body.autoCreateFlows   !== 'false',
      deduplicateTests:   req.body.deduplicateTests  !== 'false',
      saveDocsToKB:       req.body.saveDocsToKB      !== 'false',
    });

    const importId = randomUUID();

    // ── 5. Decide: sync or async ──────────────────────────────────────────
    const estimatedTests = estimateResultCount(zipBuffer);
    const isAsync = estimatedTests >= ASYNC_THRESHOLD;

    logger.info('[AllureImportController] Upload received', {
      importId,
      projectId,
      userId,
      fileSizeBytes: zipBuffer.length,
      estimatedTests,
      isAsync,
    });

    if (!isAsync) {
      // ── 5a. Synchronous path: process inline, return stats ────────────
      const jobData: AllureImportJobData = {
        importId,
        projectId,
        userId,
        workspaceId,
        zipBase64: zipBuffer.toString('base64'),
        options,
      };

      // No-op progress emitter for sync path (client polls or waits for response)
      const result = await processAllureImport(jobData, () => { /* no WS in sync */ });

      res.status(200).json({
        success: true,
        importId,
        async: false,
        stats: result.stats,
        hierarchy: result.hierarchy,
      });
      return;
    }

    // ── 5b. Async path: dispatch BullMQ job ───────────────────────────
    const jobData: AllureImportJobData = {
      importId,
      projectId,
      userId,
      workspaceId,
      zipBase64: zipBuffer.toString('base64'),
      options,
    };

    await QueueManager.addAllureImportJob(jobData);

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
        error: 'ZIP file exceeds 100 MB limit',
      });
      return;
    }

    if (message.includes('Only .zip')) {
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

    // Look up the import record
    const { data, error } = await supabaseAdmin
      .from('allure_imports')
      .select('id, status, stats, error_message, created_at, completed_at')
      .eq('id', importId)
      .eq('user_id', userId)
      .maybeSingle();

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

    res.status(200).json({
      success: true,
      importId,
      status: data.status,
      stats: data.stats,
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
