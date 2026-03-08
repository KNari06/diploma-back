/**
 * CI/CD API Key Authentication Middleware
 *
 * Validates project-level API keys for external CI/CD integrations.
 * API keys are stored as SHA-256 hashes in projects.settings.ciApiKey.hash.
 *
 * Usage:
 *   router.post('/ci/run', requireCiApiKey, asyncHandler(handler));
 *
 * Sets on req:
 *   - req.ciProject  (full project row)
 *   - req.ciUserId   (project.user_id — the system actor for CI operations)
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

// ── Type augmentation ─────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Project resolved from CI API key */
      ciProject?: {
        id: string;
        user_id: string;
        workspace_id: string;
        settings: Record<string, unknown>;
        [key: string]: unknown;
      };
      /** System actor userId derived from project owner */
      ciUserId?: string;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Hash an API key with SHA-256 (deterministic, no salt — simple for MVP).
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Timing-safe comparison of two hex strings.
 * Pattern from: src/services/integrations/git-webhook.service.ts
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Require a valid CI API key in Authorization header.
 *
 * Authorization: Bearer qai_ci_<hex>
 *
 * Looks up projects where settings->'ciApiKey'->>'hash' matches.
 * For MVP this scans all projects with a CI key set — acceptable at
 * low scale. At scale, move to a dedicated `project_api_keys` table.
 */
export const requireCiApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // ── Extract token ───────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: No API key provided',
        message: 'Provide a project CI API key via Authorization: Bearer <key>',
      });
      return;
    }

    const apiKey = authHeader.slice(7); // strip "Bearer "

    if (!apiKey || !apiKey.startsWith('qai_ci_') || apiKey.length < 20) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid API key format',
        message: 'API key must start with "qai_ci_" prefix',
      });
      return;
    }

    // ── Hash the incoming key ───────────────────────────────────
    const incomingHash = hashApiKey(apiKey);

    // ── Lookup project by hash ──────────────────────────────────
    // Query projects that have a ciApiKey set (JSONB filter)
    const { data: projects, error } = await supabaseAdmin
      .from('projects')
      .select('*')
      .not('settings->ciApiKey', 'is', null)
      .limit(100);

    if (error) {
      logger.error('[CI_API_KEY] Failed to query projects', { error });
      res.status(500).json({
        success: false,
        error: 'Internal error during authentication',
      });
      return;
    }

    // Find the project whose stored hash matches
    const matchedProject = projects?.find((p: any) => {
      const storedHash = p.settings?.ciApiKey?.hash;
      if (!storedHash || typeof storedHash !== 'string') return false;
      return timingSafeCompare(incomingHash, storedHash);
    });

    if (!matchedProject) {
      logger.debug('[CI_API_KEY] No project matched for API key', {
        path: req.path,
        method: req.method,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid API key',
        message: 'The provided API key does not match any project',
      });
      return;
    }

    // ── Attach to request ───────────────────────────────────────
    req.ciProject = matchedProject as any;
    req.ciUserId = matchedProject.user_id;

    logger.debug('[CI_API_KEY] Authentication successful', {
      projectId: matchedProject.id,
      userId: matchedProject.user_id,
      path: req.path,
    });

    next();
  } catch (error) {
    logger.error('[CI_API_KEY] Authentication error', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      method: req.method,
    });
    res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication failed',
    });
  }
};
