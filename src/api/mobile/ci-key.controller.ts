/**
 * CI API Key Management Controller
 *
 * CRUD for project-level CI/CD API keys.
 * Keys are stored as SHA-256 hashes in projects.settings.ciApiKey.
 * The cleartext key is shown ONCE at creation time (like GitHub tokens).
 *
 * All endpoints require JWT auth (owner/full_access only).
 */

import { ProjectService } from '@/services/core/project.service';
import { hashApiKey } from '@/middleware/api-key.middleware';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE CI KEY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/projects/:projectId/ci-key
 *
 * Generate a new CI API key for a project. Replaces existing key if any.
 * Returns the cleartext key ONCE — store it securely.
 */
export async function generateCiKey(req: Request, res: Response): Promise<void> {
  const userId = (req as any).userId;
  const { projectId } = req.params;

  // Verify project access (write required)
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  // Generate key: qai_ci_<64 hex chars> (32 random bytes)
  const rawKey = crypto.randomBytes(32).toString('hex');
  const clearTextKey = `qai_ci_${rawKey}`;
  const hash = hashApiKey(clearTextKey);
  const prefix = clearTextKey.slice(0, 15); // "qai_ci_" + first 8 hex

  logger.info('[CI_KEY] Generating new CI API key', {
    projectId,
    userId,
    prefix,
  });

  // Store hash in project settings
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      ciApiKey: {
        hash,
        prefix,
        createdAt: new Date().toISOString(),
      },
    },
  });

  logger.info('[CI_KEY] CI API key generated successfully', {
    projectId,
    prefix,
  });

  res.status(201).json({
    success: true,
    key: clearTextKey,
    prefix,
    message: 'Store this key securely — it will not be shown again.',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REVOKE CI KEY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/mobile/projects/:projectId/ci-key
 *
 * Revoke the CI API key for a project.
 */
export async function revokeCiKey(req: Request, res: Response): Promise<void> {
  const userId = (req as any).userId;
  const { projectId } = req.params;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  logger.info('[CI_KEY] Revoking CI API key', { projectId, userId });

  await ProjectService.updateProject(projectId, userId, {
    settings: {
      ciApiKey: null,
    },
  });

  logger.info('[CI_KEY] CI API key revoked', { projectId });

  res.json({ success: true, message: 'CI API key revoked' });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET CI KEY STATUS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/projects/:projectId/ci-key
 *
 * Check if a CI API key exists for the project.
 * Does NOT return the key itself — only prefix + metadata.
 */
export async function getCiKeyStatus(req: Request, res: Response): Promise<void> {
  const userId = (req as any).userId;
  const { projectId } = req.params;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const ciApiKey = project.settings?.ciApiKey as {
    hash: string;
    prefix: string;
    createdAt: string;
  } | null | undefined;

  if (!ciApiKey) {
    res.json({ success: true, exists: false });
    return;
  }

  res.json({
    success: true,
    exists: true,
    prefix: ciApiKey.prefix,
    createdAt: ciApiKey.createdAt,
  });
}
