/**
 * Allure Import Controller
 *
 * Handles upload validation, project access check, and dispatches to
 * async BullMQ job for processing. Supports ZIP, CSV, and PDF uploads.
 */

import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';
import { QueueManager } from '@/config/infrastructure/queues';
import { resolveImportOptions } from '@/services/allure-import/allure-import.types';
import type { AllureImportJobData, AllureSourceFormat } from '@/services/allure-import/allure-import.types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Prefix for temp upload files — makes cleanup easy if orphaned. */
const TEMP_DIR_PREFIX = 'qai-allure-';

/**
 * Write the uploaded buffer to a temp file on disk and return the path.
 * This avoids storing the entire file as base64 in Redis (~133% bloat).
 */
async function writeUploadToTempFile(
  buffer: Buffer,
  importId: string,
  extension: string,
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  const filePath = path.join(tempDir, `${importId}.${extension}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
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
      res.status(400).json({ success: false, error: 'No file provided. Upload a .zip, .csv, or .pdf file.' });
      return;
    }

    const fileBuffer = req.file.buffer;
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

    logger.info('[AllureImportController] Upload received', {
      importId,
      projectId,
      userId,
      sourceFormat,
      fileSizeBytes: fileBuffer.length,
    });

    // ── 5. Write file to temp (avoids base64 bloat in Redis) ──────────
    const extension = sourceFormat === 'csv' ? 'csv' : sourceFormat === 'pdf' ? 'pdf' : 'zip';
    const filePath = await writeUploadToTempFile(fileBuffer, importId, extension);

    // ── 6. Always dispatch via BullMQ (avoids blocking event loop) ────
    const jobData: AllureImportJobData = {
      importId,
      projectId,
      userId,
      workspaceId,
      sourceFormat,
      filePath,
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
