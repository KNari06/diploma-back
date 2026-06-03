/**
 * PROJECT RESOLVER - Shared project resolution for regression chat handlers
 *
 * The regression chat handlers (run_by_tag, run_module, run_plan, create_plan,
 * add_to_plan) all need to resolve "which project" a chat command targets.
 *
 * The previous per-handler lookup did:
 *   .from('projects').eq('workspace_id', ws).eq('user_id', userId).limit(1)
 * which had two bugs:
 *   1. `.eq('user_id', userId)` scoped to the CREATOR — `projects.user_id` is
 *      the owner, so a non-owner workspace member (full_access / view) matched
 *      no row and got NotFoundError('Project'); they could not use regression
 *      via chat at all.
 *   2. `.limit(1)` with no ordering picked an ARBITRARY project when a user
 *      owned more than one in the workspace.
 *
 * Resolution order mirrors the coverage-analysis / test-recommendations
 * handlers, which already do this correctly:
 *   1. explicit project from the frontend context
 *   2. explicit project from the parsed intent
 *   3. the chat session's bound project_id
 *   4. workspace fallback — membership-scoped (no creator filter), deterministic
 *      ordering so the choice is stable rather than arbitrary.
 *
 * Paths (1)-(3) are client-controllable or session-derived, so each is
 * validated against the request's workspace before being returned (see
 * validateProjectInWorkspace). Path (4) is already workspace-scoped by query.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface ResolveProjectParams {
  workspace_id: string;
  context?: { projectId?: string } | any;
  parsedIntent?: { projectId?: string } | any;
  chatSessionId?: string;
}

/**
 * Confirm a project belongs to the request's workspace. The workspace is
 * already membership-scoped upstream (checkWorkspace / getActiveWorkspaceForUser),
 * so a project whose workspace_id matches is one the caller is authorized for.
 *
 * SECURITY: `context.projectId` / `parsedIntent.projectId` originate from
 * `req.body` (typed `any`) and are attacker-controllable. They MUST be validated
 * here before being returned — a caller that does not itself re-check access
 * (e.g. create_plan → RegressionPlanService.create, which performs NO access
 * check) would otherwise insert/read against a foreign-workspace project (IDOR).
 * Returns the projectId when valid, else null.
 */
async function validateProjectInWorkspace(
  projectId: string,
  workspaceId: string,
): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();

    if (!data) {
      logger.warn('[PROJECT_RESOLVER] projectId not in workspace — rejecting', {
        projectId,
        workspaceId,
      });
      return null;
    }
    return data.id;
  } catch (error) {
    logger.warn('[PROJECT_RESOLVER] Failed to validate projectId', { error });
    return null;
  }
}

/**
 * Fallback: get project_id from the chat session record.
 */
async function getProjectIdFromSession(chatSessionId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('chat_sessions')
      .select('project_id')
      .eq('id', chatSessionId)
      .maybeSingle();

    return data?.project_id || null;
  } catch (error) {
    logger.warn('[PROJECT_RESOLVER] Failed to get projectId from session', { error });
    return null;
  }
}

/**
 * Fallback: the workspace's project, scoped to the workspace only (membership
 * is already enforced upstream by checkWorkspace / getActiveWorkspaceForUser).
 * Deterministic ordering avoids picking an arbitrary row for multi-project
 * workspaces. No `.eq('user_id', ...)` — that filter excluded non-owner members.
 */
async function getProjectIdFromWorkspace(workspaceId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    return data?.id || null;
  } catch (error) {
    logger.warn('[PROJECT_RESOLVER] Failed to get projectId from workspace', { error });
    return null;
  }
}

/**
 * Resolve the project id a regression chat command targets.
 * Returns null if no project can be resolved — callers should surface a
 * NotFoundError / clarification rather than operating on an arbitrary project.
 */
export async function resolveProjectId(params: ResolveProjectParams): Promise<string | null> {
  const explicit = params.context?.projectId || params.parsedIntent?.projectId;
  if (explicit) {
    // Client-supplied — never trust without confirming it is in the workspace.
    return validateProjectInWorkspace(explicit, params.workspace_id);
  }

  if (params.chatSessionId) {
    const fromSession = await getProjectIdFromSession(params.chatSessionId);
    if (fromSession) {
      // Validate the session-bound project too — a session could have been
      // bound to a project that now lives in a different workspace.
      return validateProjectInWorkspace(fromSession, params.workspace_id);
    }
  }

  return getProjectIdFromWorkspace(params.workspace_id);
}
