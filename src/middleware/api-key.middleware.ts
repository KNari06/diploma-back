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

import {
  CiKeyLookupError,
  findProjectByCiKeyHash,
  getCiOwnerAuthState,
} from '@/services/mobile/db/ci-auth.db';
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

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Require a valid CI API key in Authorization header.
 *
 * Authorization: Bearer qai_ci_<hex>
 *
 * Resolves the project by an indexed lookup on settings->'ciApiKey'->>'hash'
 * (see `ci-auth.db.ts`), then applies the two gates a JWT caller gets from
 * `requireAuth` + `requireApproved` but a CI caller never did: the owning
 * account must not be soft-deleted and must be `approved`.
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
    let matchedProject;
    try {
      matchedProject = await findProjectByCiKeyHash(incomingHash);
    } catch (lookupError) {
      if (lookupError instanceof CiKeyLookupError) {
        logger.error('[CI_API_KEY] Failed to query projects', {
          error: lookupError.message,
        });
        res.status(500).json({
          success: false,
          error: 'Internal error during authentication',
        });
        return;
      }
      throw lookupError;
    }

    if (!matchedProject) {
      // WARN, not debug: at the default log level a key being probed or a
      // customer's pipeline silently 401ing left no visible trace at all.
      logger.warn('[CI_API_KEY] No project matched for API key', {
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid API key',
        message: 'The provided API key does not match any project',
      });
      return;
    }

    // ── Owner account gates ─────────────────────────────────────
    // A CI key outlives its owner's account state: the key keeps working
    // after the owner soft-deletes or is un-approved unless we check here.
    // On a lookup failure we fail OPEN (same trade-off as `requireAuth`'s
    // deleted_at check) — one Supabase blip must not 401 every pipeline.
    const ownerLookup = await getCiOwnerAuthState(matchedProject.user_id);
    if (ownerLookup.ok) {
      const owner = ownerLookup.owner;
      if (!owner) {
        logger.warn('[CI_API_KEY] Owning account not found', {
          projectId: matchedProject.id,
          userId: matchedProject.user_id,
        });
        res.status(401).json({
          success: false,
          error: 'Unauthorized: Invalid API key',
          code: 'OWNER_NOT_FOUND',
          message: 'The project owning this API key has no active owner',
        });
        return;
      }
      if (owner.deletedAt) {
        logger.warn('[CI_API_KEY] Owning account is deleted', {
          projectId: matchedProject.id,
          userId: matchedProject.user_id,
        });
        res.status(401).json({
          success: false,
          error: 'Account deleted',
          code: 'ACCOUNT_DELETED',
          message: 'The account owning this API key has been scheduled for deletion.',
        });
        return;
      }
      if (owner.status !== 'approved') {
        logger.warn('[CI_API_KEY] Owning account is not approved', {
          projectId: matchedProject.id,
          userId: matchedProject.user_id,
          status: owner.status,
        });
        res.status(401).json({
          success: false,
          error: 'Account pending approval',
          code: 'OWNER_NOT_APPROVED',
          message: 'The account owning this API key is not approved.',
        });
        return;
      }
    } else {
      logger.warn('[CI_API_KEY] Owner state unavailable — failing open', {
        projectId: matchedProject.id,
        userId: matchedProject.user_id,
      });
    }

    // ── Attach to request ───────────────────────────────────────
    req.ciProject = matchedProject;
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
