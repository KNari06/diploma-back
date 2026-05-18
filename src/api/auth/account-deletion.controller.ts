/**
 * Account-deletion HTTP handlers.
 *
 * Three endpoints, all mounted under `/api/v1/auth/me/...`:
 *
 *   GET  /api/v1/auth/me/deletion-preview
 *   POST /api/v1/auth/me/delete            body: { confirmEmail }
 *   POST /api/v1/auth/me/delete/cancel     support-only path (allowed
 *                                          past the deleted-account
 *                                          middleware guard)
 *
 * All three live in their own file rather than auth.controller.ts so
 * the cross-cutting deletion logic (preview + side-effects + cancel) is
 * easy to find and so auth.controller.ts stays focused on credential
 * flows.
 */

import { supabaseAdmin } from '@/db/supabase';
import {
  cancelAccountDeletion,
  previewAccountDeletion,
  softDeleteAccount,
} from '@/services/auth/account-deletion.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

/**
 * GET /api/v1/auth/me/deletion-preview
 *
 * Surface a summary of what will be deleted so the UI can show:
 *   - "Permanently deleted on May 30, 2026" (scheduledFor)
 *   - List of sole-owned workspaces that will go with the user
 *   - List of blocking workspaces (sole-owner-with-other-members) that
 *     the user must transfer first
 *
 * Returns 409 if the user already started deletion (the UI uses this
 * to show "Already scheduled for deletion in N days").
 */
export async function getDeletionPreview(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const result = await previewAccountDeletion(userId);
    if ('alreadyDeleted' in result) {
      res.status(409).json({
        success: false,
        code: 'ALREADY_DELETED',
        deletedAt: result.deletedAt,
        message: 'Account is already scheduled for deletion',
      });
      return;
    }
    res.json({ success: true, ...result.preview });
  } catch (err) {
    logger.error('[ACCOUNT_DELETION_API] preview failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to compute deletion preview' });
  }
}

/**
 * POST /api/v1/auth/me/delete
 * Body: { confirmEmail: string }
 *
 * Typed-email confirmation is the canonical "are you sure" gesture.
 * Case-insensitive compare against the user's stored email. Returns:
 *   - 400 if confirmEmail missing or mismatched
 *   - 409 if user is the sole owner of a multi-member workspace
 *     (response body lists the blockers so the UI can deep-link to
 *     each workspace's Transfer-Ownership page)
 *   - 409 if the account is already soft-deleted (idempotency)
 *   - 200 { scheduledFor } on success
 */
export async function postDeleteAccount(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const confirmEmailRaw = req.body?.confirmEmail;
  if (typeof confirmEmailRaw !== 'string' || confirmEmailRaw.trim().length === 0) {
    res.status(400).json({
      success: false,
      code: 'CONFIRM_EMAIL_REQUIRED',
      error: 'confirmEmail is required',
    });
    return;
  }

  // Read the canonical email from the database — never trust the JWT
  // claim alone for this destructive op. Compares case-insensitively
  // because some users register with mixed case and won't remember to
  // match it exactly.
  const { data: row, error } = await supabaseAdmin
    .from('users')
    .select('id, email, deleted_at')
    .eq('id', userId)
    .maybeSingle();

  if (error || !row) {
    logger.error('[ACCOUNT_DELETION_API] User row read failed', {
      userId,
      error: error?.message,
    });
    res.status(500).json({ success: false, error: 'Failed to verify account' });
    return;
  }

  if (row.deleted_at) {
    res.status(409).json({
      success: false,
      code: 'ALREADY_DELETED',
      deletedAt: row.deleted_at,
      message: 'Account is already scheduled for deletion',
    });
    return;
  }

  const expected = String(row.email || '').trim().toLowerCase();
  const provided = confirmEmailRaw.trim().toLowerCase();
  if (!expected || provided !== expected) {
    res.status(400).json({
      success: false,
      code: 'CONFIRM_EMAIL_MISMATCH',
      error: 'Confirmation email does not match the account email',
    });
    return;
  }

  try {
    const result = await softDeleteAccount(userId);
    if (result.ok) {
      res.json({ success: true, scheduledFor: result.scheduledFor });
      return;
    }
    if (result.reason === 'blocked_by_workspaces') {
      res.status(409).json({
        success: false,
        code: 'BLOCKED_BY_WORKSPACES',
        blockingWorkspaces: result.blockingWorkspaces,
        message:
          'Transfer ownership of the listed workspaces before deleting your account',
      });
      return;
    }
    if (result.reason === 'already_deleted') {
      res.status(409).json({
        success: false,
        code: 'ALREADY_DELETED',
        deletedAt: result.deletedAt,
      });
      return;
    }
    // user_not_found shouldn't happen — we just looked the user up above
    res.status(500).json({ success: false, error: 'Unexpected deletion failure' });
  } catch (err) {
    logger.error('[ACCOUNT_DELETION_API] delete failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to schedule account deletion' });
  }
}

/**
 * POST /api/v1/auth/me/delete/cancel
 *
 * Support-only path for v1 — auth middleware special-cases this URL to
 * allow soft-deleted users past the 401 guard. No public UI surface
 * yet; intended for a future admin panel or direct DB-bypass.
 *
 * If the calling user isn't soft-deleted, returns a benign 200.
 */
export async function postCancelDeletion(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const result = await cancelAccountDeletion(userId);
    if (!result.ok) {
      res.status(500).json({ success: false, error: 'Failed to cancel deletion' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('[ACCOUNT_DELETION_API] cancel failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ success: false, error: 'Failed to cancel deletion' });
  }
}
