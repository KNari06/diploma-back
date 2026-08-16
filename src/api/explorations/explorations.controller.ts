/**
 * Explorations Controller
 * REST API for listing and viewing exploration runs + discovered test cases.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { NotFoundError, ValidationError } from '@/types';
import { ExplorationRunService } from '@/services/testing/exploration/exploration-run.service';
import { QueueManager } from '@/config/infrastructure/queues';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ProjectContextService } from '@/services/utils/project-context.service';
import {
  DEFAULT_EXPLORATION_BUDGET,
  EXPLORATION_PRESETS,
  generateExplorationId,
  type ExplorationPreset,
} from '@/agent/core/lite/exploration/types';
import { normalizeEntryUrl } from '@/utils/validation/entry-url';
import { preflightEntryUrl } from '@/services/testing/exploration/entry-preflight.service';
import { projectBelongsToWorkspace } from '@/services/core/db/self-serve.db';
import { hasProjectAccess } from '@/services/core/project-access.service';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import {
  fetchExplorationProjectUnscoped,
  fetchWorkspaceProjectIds,
} from '@/services/testing/exploration/db/exploration-run.db';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

/**
 * Resolve the project an exploration belongs to and authorize the caller
 * against it — owner OR active workspace member, via the shared
 * `hasProjectAccess` gate.
 *
 * Every read here used to filter `exploration_runs.user_id = caller`, while
 * `/explorations/start` authorizes by WORKSPACE (`projectBelongsToWorkspace`
 * has no owner requirement). A teammate could therefore start a run against a
 * shared project and then get 404 on its results, and `run-discovered` silently
 * dropped every case. Reads and writes now answer to the same rule.
 *
 * Returns the projectId on success, or null when the run is missing OR the
 * caller may not see it — the caller renders both as 404, so this never
 * discloses whether an exploration id exists in someone else's workspace.
 */
async function resolveAccessibleExploration(
  explorationId: string,
  userId: string,
): Promise<string | null> {
  const projectId = await fetchExplorationProjectUnscoped(explorationId);
  if (!projectId) return null;
  if (!(await hasProjectAccess(projectId, userId))) return null;
  return projectId;
}

function handleError(res: Response, error: unknown, message: string): void {
  logger.error(`[EXPLORATIONS_API] ${message}`, {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ success: false, error: message });
}

/**
 * List exploration runs for a project.
 * GET /api/v1/explorations?projectId=xxx
 */
export async function listExplorations(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, workspaceId } = req.query;
    const userId = getUserId(req);

    let query = supabaseAdmin
      .from('exploration_runs')
      .select('id, exploration_id, entry_url, project_id, status, summary, duration_ms, test_cases_count, started_at, completed_at')
      .order('started_at', { ascending: false })
      .limit(50);

    if (projectId && typeof projectId === 'string') {
      // Scope to one project the caller may read (owner or workspace member),
      // rather than to rows they personally started — a shared project's runs
      // belong to the team. The access gate REPLACES the `user_id` filter, so
      // it must run before the query is issued, not alongside it.
      if (!(await hasProjectAccess(projectId, userId))) {
        res.status(403).json({ success: false, error: 'Project not found' });
        return;
      }
      query = query.eq('project_id', projectId);
    } else if (workspaceId && typeof workspaceId === 'string') {
      // `workspaceId` is caller-supplied and was previously trusted: the branch
      // only ever narrowed by `user_id`, so it was safe by accident. Dropping
      // that filter without verifying membership would turn this into an IDOR
      // (any workspace id → that workspace's runs), so verify FIRST.
      if (!(await WorkspaceAccessService.isMember(userId, workspaceId))) {
        res.status(403).json({ success: false, error: 'Workspace not found' });
        return;
      }

      const projectIds = await fetchWorkspaceProjectIds(workspaceId);
      if (projectIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      query = query.in('project_id', projectIds);
    } else {
      // No scope given — fall back to the caller's own runs. Widening this to
      // every project they can reach would need a membership lookup per
      // workspace; the clients always send a scope.
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error('[EXPLORATIONS_API] DB error listing explorations', { error: error.message });
      res.status(500).json({ success: false, error: 'Failed to list explorations' });
      return;
    }

    res.json({ success: true, data: data || [] });
  } catch (error) {
    handleError(res, error, 'Failed to list explorations');
  }
}

/**
 * Get a single exploration run with summary.
 * GET /api/v1/explorations/:explorationId
 */
export async function getExploration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    // Authorize by project access, not by who started the run.
    if (!(await resolveAccessibleExploration(explorationId, userId))) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('exploration_runs')
      .select('*')
      .eq('exploration_id', explorationId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    res.json({ success: true, data });
  } catch (error) {
    handleError(res, error, 'Failed to get exploration');
  }
}

/**
 * Get discovered test cases for an exploration.
 * GET /api/v1/explorations/:explorationId/test-cases
 */
export async function getExplorationTestCases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    // Authorize by project access (owner or workspace member), not by who
    // started the run.
    const projectId = await resolveAccessibleExploration(explorationId, userId);
    if (!projectId) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    // Test cases created by THIS run.
    //
    // Scoped by `exploration_id` (added 2026-08-03). Before it, this filtered on
    // project + source only and returned every exploration case the project had
    // ever accumulated — 516 rows from 8 runs on one prod project, including
    // cases from entirely different entry URLs. A run that found 20 tests listed
    // hundreds, and any bulk action taken there operated on that wrong set.
    //
    // NO fallback to the project-wide query when this returns nothing. A
    // legacy run genuinely cannot know which rows were its own, and guessing
    // reproduces the exact bug: a NEW run that discovered nothing would show
    // the project's entire history as if it had just found it. An empty list is
    // the honest answer — `run.test_cases_count` already tells the user how
    // many this run produced, so 0 rows next to "0 test cases" reads correctly.
    //
    // Rows are scoped to the run + its project, NOT to the caller: the cases
    // were written under the id of whoever started the exploration, so a
    // `user_id` filter returned an empty list to every teammate who could
    // legitimately open the run. Access was already decided above.
    const { data: testCases, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, entry_point_id, name, description, start_url, steps_json, tags, priority, status, created_at')
      .eq('project_id', projectId)
      .eq('exploration_id', explorationId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('[EXPLORATIONS_API] DB error getting test cases', { error: error.message });
      res.status(500).json({ success: false, error: 'Failed to get test cases' });
      return;
    }

    res.json({ success: true, data: testCases || [] });
  } catch (error) {
    handleError(res, error, 'Failed to get exploration test cases');
  }
}

/**
 * Add selected exploration test cases to a regression plan.
 * POST /api/v1/explorations/:explorationId/add-to-regression
 */
export async function addToRegressionPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const { testCaseIds, regressionPlanId } = req.body;
    const userId = getUserId(req);

    if (!testCaseIds?.length || !regressionPlanId) {
      res.status(400).json({
        success: false,
        error: 'testCaseIds (array) and regressionPlanId are required',
      });
      return;
    }

    // Authorize the exploration by project access, not by who started it.
    const projectId = await resolveAccessibleExploration(explorationId, userId);
    if (!projectId) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    // Verify plan ownership
    const { data: plan } = await supabaseAdmin
      .from('regression_plans')
      .select('id')
      .eq('id', regressionPlanId)
      .eq('user_id', userId)
      .single();

    if (!plan) {
      res.status(404).json({ success: false, error: 'Regression plan not found' });
      return;
    }

    // Select the cases by the RUN's project rather than by `user_id`: the rows
    // belong to whoever started the exploration, so an owner filter added none
    // of them for a teammate. Scoping to `project_id` + `exploration_id` keeps
    // the guard just as tight — a caller cannot smuggle in an arbitrary case id
    // from another project, which a bare `.in(ids)` would have allowed once the
    // ownership filter came off.
    const { data: testCases, error: tcError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name')
      .in('id', testCaseIds)
      .eq('project_id', projectId)
      .eq('exploration_id', explorationId);

    if (tcError || !testCases?.length) {
      res.status(400).json({ success: false, error: 'No valid test cases found' });
      return;
    }

    // Get existing max order_index in plan (maybeSingle for empty plans)
    const { data: maxOrder } = await supabaseAdmin
      .from('regression_plan_items')
      .select('order_index')
      .eq('plan_id', regressionPlanId)
      .order('order_index', { ascending: false })
      .limit(1)
      .maybeSingle();

    let nextOrder = (maxOrder?.order_index ?? -1) + 1;

    // Insert plan items with required fields for CHECK constraint
    const items = testCases.map((tc) => ({
      plan_id: regressionPlanId,
      test_case_id: tc.id,
      item_type: 'test_case',
      test_case_type: 'ui',
      order_index: nextOrder++,
    }));

    const { error: insertError } = await supabaseAdmin
      .from('regression_plan_items')
      .insert(items);

    if (insertError) {
      logger.error('[EXPLORATIONS_API] Failed to add to regression plan', { error: insertError.message });
      res.status(500).json({ success: false, error: 'Failed to add test cases to plan' });
      return;
    }

    res.json({
      success: true,
      data: { added: testCases.length, planId: regressionPlanId },
    });
  } catch (error) {
    handleError(res, error, 'Failed to add to regression plan');
  }
}

/**
 * Get exploration state snapshot (checkpoint + summary).
 * Useful for debugging running/stuck explorations.
 * GET /api/v1/explorations/:explorationId/state
 */
export async function getExplorationState(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    // Authorize by project access, not by who started the run.
    if (!(await resolveAccessibleExploration(explorationId, userId))) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('exploration_runs')
      .select('exploration_id, entry_url, status, config, summary, budget_used, duration_ms, test_cases_count, error_message, checkpoint, started_at, completed_at')
      .eq('exploration_id', explorationId)
      .single();

    if (error || !data) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    // Build state overview
    const state: Record<string, any> = {
      explorationId: data.exploration_id,
      entryUrl: data.entry_url,
      status: data.status,
      startedAt: data.started_at,
      completedAt: data.completed_at,
      durationMs: data.duration_ms,
      testCasesCount: data.test_cases_count,
      errorMessage: data.error_message,
      config: data.config,
      summary: data.summary,
      budgetUsed: data.budget_used,
    };

    // Include checkpoint data for running explorations (debug)
    if (data.status === 'running' && data.checkpoint) {
      state.checkpoint = {
        phase: data.checkpoint.phase,
        flowsCompleted: data.checkpoint.completedFlows?.length ?? 0,
        flowsQueued: data.checkpoint.pendingEntryPoints?.length ?? 0,
        pagesVisited: data.checkpoint.tree?.nodes?.length ?? 0,
        lastActivity: data.checkpoint.lastCheckpointAt,
      };
    }

    res.json({ success: true, data: state });
  } catch (error) {
    handleError(res, error, 'Failed to get exploration state');
  }
}

/**
 * Run the test cases discovered by an exploration in one click. Wraps them in
 * a throwaway regression plan and starts a run; the client then navigates to
 * /runs/:runId for live progress + video.
 *
 * POST /api/v1/explorations/:explorationId/run-discovered
 * Body: { testCaseIds: string[] }
 * Returns 202 { runId, planId, totalTests }
 */
export async function runDiscoveredTestCases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);
    const { testCaseIds } = req.body ?? {};

    const result = await ExplorationRunService.runDiscovered({
      explorationId,
      userId,
      testCaseIds,
    });

    res.status(202).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    if (error instanceof NotFoundError) {
      res.status(404).json({ success: false, error: error.message });
      return;
    }
    handleError(res, error, 'Failed to run discovered test cases');
  }
}

/**
 * Cancel a running exploration.
 *
 * POST /api/v1/explorations/:explorationId/cancel
 *
 * The status flip IS the signal: the worker polls `isRunCancelled` at each
 * phase boundary (the engine runs in another process, so an in-memory flag
 * could never reach it). Cancellation is therefore cooperative — the run stops
 * after its in-flight work rather than instantly — and whatever it discovered
 * before stopping is still saved and left visible. The run is not charged.
 *
 * Returns 409 when the run is already terminal, rather than pretending to have
 * stopped something that had already finished.
 */
export async function cancelExploration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { explorationId } = req.params;
    const userId = getUserId(req);

    // Same gate as the reads: anyone who can see the run can stop it.
    if (!(await resolveAccessibleExploration(explorationId, userId))) {
      res.status(404).json({ success: false, error: 'Exploration not found' });
      return;
    }

    const cancelled = await ExplorationStorageService.cancelRun(explorationId);
    if (!cancelled) {
      res.status(409).json({
        success: false,
        error: 'Exploration is not running — it already finished, failed, or was cancelled.',
      });
      return;
    }

    logger.info('[EXPLORATIONS_API] Exploration cancellation requested', { explorationId, userId });

    res.json({
      success: true,
      data: {
        explorationId,
        status: 'cancelled',
        // Set expectations: the worker stops at its next phase boundary, so the
        // run can stay visibly active for a short while after this returns.
        note: 'The run will stop shortly. Anything discovered before it stops is saved.',
      },
    });
  } catch (error) {
    handleError(res, error, 'Failed to cancel exploration');
  }
}

/**
 * Start an autonomous exploration from a URL — the self-serve "magic first
 * test" entrypoint. Validates the URL, resolves the target project (explicit
 * projectId, else the user's default project in their active workspace), and
 * enqueues an exploration job. Returns immediately with the explorationId;
 * progress and discovered test cases are read via the GET endpoints / WS.
 *
 * POST /api/v1/explorations/start
 * Body: { url: string, projectId?: string, preset?: 'quick' | 'full', scopeHint?: string }
 */
export async function startExploration(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const userId = getUserId(req);
    const { url, projectId: bodyProjectId, preset, scopeHint } = req.body ?? {};

    // Normalize + validate. `normalizeEntryUrl` accepts a bare domain
    // ("app.acme.com") — the most natural thing a user types, which the old
    // sanitizeUrl-only path rejected — while applying the same http(s)
    // allowlist and SSRF blocklist.
    let entryUrl: string;
    try {
      entryUrl = normalizeEntryUrl(url);
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof ValidationError ? err.message : 'A valid http(s) url is required',
      });
      return;
    }

    // Reachability probe BEFORE the job is enqueued — and therefore before the
    // job charges EXPLORATION_DISCOVERY_CREDITS. Without this, a typo'd or dead
    // URL produced a `status:'completed'` run with 0 test cases and still billed
    // 10 credits, while telling the user their site had no flows.
    const preflight = await preflightEntryUrl(entryUrl);
    if (!preflight.ok) {
      logger.info('[EXPLORATIONS_API] Entry preflight rejected exploration', {
        userId,
        entryUrl,
        verdict: preflight.verdict,
        status: preflight.status,
      });
      res.status(400).json({
        success: false,
        error: preflight.message,
        verdict: preflight.verdict,
      });
      return;
    }

    // Resolve preset → budget. Default to 'quick' for the onboarding flow;
    // unknown values fall back to 'quick' rather than erroring.
    const resolvedPreset: ExplorationPreset = preset === 'full' ? 'full' : 'quick';
    const budget = EXPLORATION_PRESETS[resolvedPreset];

    // Resolve the target project. Explicit projectId wins (ownership checked
    // by getDefaultProject's workspace scoping when omitted). For self-serve
    // users we auto-resolve their default project in the active workspace —
    // P0.3 guarantees one exists.
    const workspaceId = await WorkspaceService.getActiveWorkspaceForUser(userId);
    if (!workspaceId) {
      res.status(409).json({
        success: false,
        error: 'No workspace found. Complete onboarding first.',
      });
      return;
    }

    let projectId = typeof bodyProjectId === 'string' ? bodyProjectId : undefined;
    if (projectId) {
      // IDOR guard: an explicit projectId must belong to the caller's active
      // workspace, otherwise a user could start explorations against another
      // user's project (which the job handler would then write under).
      const owns = await projectBelongsToWorkspace(projectId, workspaceId);
      if (!owns) {
        res.status(403).json({ success: false, error: 'Project not found' });
        return;
      }
    } else {
      const defaultProject = await ProjectContextService.getDefaultProject(workspaceId, userId);
      if (!defaultProject) {
        res.status(409).json({
          success: false,
          error: 'No project found in workspace.',
        });
        return;
      }
      projectId = defaultProject.id;
    }

    const explorationId = generateExplorationId(userId);

    await QueueManager.addExplorationJob({
      explorationId,
      entryUrl,
      projectId,
      userId,
      workspaceId,
      scopeHint: typeof scopeHint === 'string' ? scopeHint : undefined,
      budget,
      // Carry the preset, not just the budget it resolved to — preset-gated
      // phases (Phase 0) need the policy, and a timeout threshold is a bad proxy.
      preset: resolvedPreset,
      maxConcurrency: 5,
    });

    logger.info('[EXPLORATIONS_API] Exploration started', {
      explorationId,
      entryUrl,
      projectId,
      preset: resolvedPreset,
      userId,
    });

    res.status(202).json({
      success: true,
      data: {
        explorationId,
        entryUrl,
        projectId,
        preset: resolvedPreset,
        budgetMs: budget.totalTimeoutMs ?? DEFAULT_EXPLORATION_BUDGET.totalTimeoutMs,
      },
    });
  } catch (error) {
    handleError(res, error, 'Failed to start exploration');
  }
}
