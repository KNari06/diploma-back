/**
 * test-case-access — single source of truth for "can this user touch this
 * test-case chat?".
 *
 * Authorization model (chosen deliberately, do not loosen without review):
 *   - The chat row itself is keyed by (user_id, test_case_id). Users do NOT
 *     share a chat session for the same test case — even when they share the
 *     workspace, each member has their own private dialog with the AI.
 *   - But the *right to open a chat at all* is workspace-scoped: any active
 *     member of the workspace that owns the test case may open their own chat
 *     for it. This matches `canWriteTestCase` over in
 *     services/testing/ui/preview/intent-test-case.service.ts (line ~44),
 *     which is the existing pattern for test-case mutations.
 *
 * Three failure modes, three distinct errors:
 *   - 404 — test_case_id does not exist (or has been deleted)
 *   - 403 — exists but the user is not in its workspace
 *   - 401 — caller is not authenticated (handled upstream by requireAuth)
 *
 * Both pieces below — the function and the middleware — are exported. The
 * middleware is for vanilla REST routes; the function is what the POST /chat
 * controller branch and the WebSocket subscribe handler call directly (those
 * paths cannot use Express middleware natively).
 */

import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '@/db/supabase';
import { AccessDeniedError, WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { logger } from '@/utils/core/logger';

/**
 * Augment Express Request with the resolved access context. Routes that use
 * `requireTestCaseAccess` get this populated before their handler runs, so
 * they don't have to repeat the workspace lookup.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      testCaseAccess?: TestCaseAccess;
    }
  }
}

export interface TestCaseAccess {
  testCaseId: string;
  /** Owner of the test_case row (intent_test_cases.user_id, TEXT). */
  testCaseOwnerId: string;
  /** Project the test case belongs to. */
  projectId: string;
  /** Workspace that hosts the project — used by registry / WS / handlers. */
  workspaceId: string;
}

/**
 * Custom error so the middleware (and direct callers) can distinguish a
 * "row doesn't exist" 404 from "exists but you can't see it" 403. Throwing
 * generic AccessDeniedError for both would leak existence — we accept that
 * minor info leak in exchange for clearer client UX, since the user already
 * proved workspace membership somewhere to know the testCaseId at all.
 */
export class TestCaseNotFoundError extends Error {
  public readonly code = 'TEST_CASE_NOT_FOUND';
  public readonly statusCode = 404;
  constructor(testCaseId: string) {
    super(`Test case ${testCaseId} not found`);
    this.name = 'TestCaseNotFoundError';
  }
}

/**
 * Resolve and authorize. Returns access context on success. Throws:
 *   - TestCaseNotFoundError (404)
 *   - AccessDeniedError (403)
 *   - any unexpected DB error (caller decides the response — typically 500)
 *
 * Two round-trips by design: (1) test case row + project_id + owner, (2)
 * project's workspace_id + WorkspaceAccessService.isMember. They could be
 * collapsed into a single join, but keeping them separate matches the rest
 * of the codebase and lets us reuse WorkspaceAccessService unchanged.
 */
export async function assertCanAccessTestCase(
  userId: string,
  testCaseId: string,
): Promise<TestCaseAccess> {
  if (!userId || typeof userId !== 'string') {
    throw new AccessDeniedError('Authentication required');
  }
  if (!testCaseId || typeof testCaseId !== 'string') {
    throw new TestCaseNotFoundError(String(testCaseId));
  }

  // Step 1 — does the test case exist? Fetch ownership + project in one shot.
  const { data: tc, error: tcErr } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, user_id, project_id')
    .eq('id', testCaseId)
    .maybeSingle();

  if (tcErr) {
    logger.error('[TC_ACCESS] Failed to read test case', {
      testCaseId,
      error: tcErr instanceof Error ? tcErr.message : String(tcErr),
      code: (tcErr as any).code,
    });
    throw tcErr;
  }
  if (!tc) {
    throw new TestCaseNotFoundError(testCaseId);
  }

  const testCaseOwnerId = (tc as any).user_id as string;
  const projectId = (tc as any).project_id as string;

  if (!projectId) {
    // Defensive — the schema marks project_id NOT NULL, but if a stale row
    // ever sneaks in we fail closed rather than 500.
    logger.error('[TC_ACCESS] test case has no project_id', { testCaseId });
    throw new AccessDeniedError('Test case has no project');
  }

  // Step 2 — owner shortcut: skip the workspace lookup if the caller created
  // the test case. Matches `canWriteTestCase` semantics and saves a query.
  // NB: intent_test_cases.user_id is TEXT (legacy), users.id is UUID. String
  // equality is correct because both sides hold the same UUID string value.
  if (testCaseOwnerId === userId) {
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('workspace_id')
      .eq('id', projectId)
      .maybeSingle();
    const workspaceId = (project as any)?.workspace_id as string | undefined;
    if (!workspaceId) {
      // Project gone but test case still exists — refuse rather than crash.
      throw new TestCaseNotFoundError(testCaseId);
    }
    return { testCaseId, testCaseOwnerId, projectId, workspaceId };
  }

  // Step 3 — non-owner: resolve workspace via project, check membership.
  const { data: project, error: projErr } = await supabaseAdmin
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .maybeSingle();

  if (projErr) {
    logger.error('[TC_ACCESS] Failed to read project for test case', {
      testCaseId,
      projectId,
      error: projErr instanceof Error ? projErr.message : String(projErr),
    });
    throw projErr;
  }
  const workspaceId = (project as any)?.workspace_id as string | undefined;
  if (!workspaceId) {
    throw new TestCaseNotFoundError(testCaseId);
  }

  const isMember = await WorkspaceAccessService.isMember(userId, workspaceId);
  if (!isMember) {
    logger.warn('[TC_ACCESS] Denied — not a workspace member', {
      userId: userId.substring(0, 8) + '...',
      testCaseId,
      workspaceId,
    });
    throw new AccessDeniedError('Not a member of this workspace');
  }

  return { testCaseId, testCaseOwnerId, projectId, workspaceId };
}

/**
 * Express middleware. Reads `testCaseId` from `req.params.testCaseId` (or
 * `req.body.testCaseId` as a fallback for the POST /chat branch path).
 *
 * On success: attaches `req.testCaseAccess` and calls `next()`.
 * On failure: emits the appropriate JSON error response and stops the chain.
 *
 * Why a thin wrapper around `assertCanAccessTestCase` and not direct usage in
 * each handler: keeps the auth shape uniform across all test-case routes,
 * makes audit trivial (every route under /chat/test-cases/* uses this), and
 * gives us a single place to bolt on rate limiting / per-test-case quotas
 * later without touching N handlers.
 */
export function requireTestCaseAccess(
  source: 'params' | 'body' = 'params',
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user?.id) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const testCaseId =
        source === 'params'
          ? (req.params?.testCaseId as string | undefined)
          : (req.body?.testCaseId as string | undefined);

      if (!testCaseId) {
        res
          .status(400)
          .json({ success: false, error: 'Missing testCaseId' });
        return;
      }

      const access = await assertCanAccessTestCase(req.user.id, testCaseId);
      req.testCaseAccess = access;
      next();
    } catch (err) {
      if (err instanceof TestCaseNotFoundError) {
        res.status(404).json({ success: false, error: err.message });
        return;
      }
      if (err instanceof AccessDeniedError) {
        res.status(403).json({ success: false, error: err.message });
        return;
      }
      logger.error('[TC_ACCESS] Unexpected error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        success: false,
        error: 'Internal error verifying test case access',
      });
    }
  };
}
