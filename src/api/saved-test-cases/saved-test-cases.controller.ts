/**
 * Saved Test Cases Controller (Compatibility Layer)
 * API endpoints for CRUD operations on intent_test_cases (unified table).
 * This controller maintains the /api/v1/saved-test-cases routes for backward
 * compatibility while the frontend migrates to the new intent_test_cases API.
 *
 * NOTE: All operations now target intent_test_cases instead of saved_test_cases.
 */

import { supabaseAdmin } from '@/db/supabase';
import { DependencySuggestion, SavedCaseDependencySuggester } from '@/services/testing/flows/saved-case-dependency-suggester.service';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { Request, Response } from 'express';

// ============================================================================
// TYPES
// ============================================================================

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract and validate user ID from authenticated request
 */
function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) {
    throw new Error('User ID not found - authentication failed');
  }
  return userId;
}

/**
 * Handle controller errors with proper status codes
 */
function handleControllerError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) return;

  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, error: 'Not found', message: error.message });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({ success: false, error: 'Validation error', message: error.message });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Get a saved test case by ID
 *
 * @route GET /api/v1/saved-test-cases/:id
 * @returns Saved test case with dependsOn field
 */
export async function getSavedTestCase(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        res.status(404).json({ success: false, error: 'Saved test case not found' });
        return;
      }
      throw new Error(`Failed to get saved test case: ${error.message}`);
    }

    res.json({
      success: true,
      data: mapToResponse(data),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[SAVED_TEST_CASES_API] Failed to get saved test case', { error });
    handleControllerError(res, error, 'Failed to get saved test case');
  }
}

/**
 * List saved test cases for a project or flow
 *
 * @route GET /api/v1/saved-test-cases?projectId=<uuid>&flowId=<uuid>
 * @query projectId - Required: Project ID
 * @query flowId - Optional: Filter by flow ID
 * @returns List of saved test cases with dependsOn
 */
export async function listSavedTestCases(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, flowId, platform, limit = '100' } = req.query;
    const userId = getUserId(req);

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId query parameter is required' });
      return;
    }

    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedLimit)) {
      res.status(400).json({ success: false, error: 'limit must be a number' });
      return;
    }
    const safeLimit = Math.min(Math.max(Math.trunc(parsedLimit), 1), 500);

    let query = supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (flowId && typeof flowId === 'string') {
      query = query.eq('flow_id', flowId);
    }

    // Filter by platform: 'web', 'mobile_android', 'mobile_ios', 'mobile_flutter', or 'mobile' (all mobile)
    if (platform && typeof platform === 'string') {
      if (platform === 'mobile') {
        query = query.in('platform', ['mobile_android', 'mobile_ios', 'mobile_flutter']);
      } else {
        query = query.eq('platform', platform);
      }
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to list saved test cases: ${error.message}`);
    }

    res.json({
      success: true,
      data: (data || []).map(mapToResponse),
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[SAVED_TEST_CASES_API] Failed to list saved test cases', { error });
    handleControllerError(res, error, 'Failed to list saved test cases');
  }
}

/**
 * Update a saved test case (with AI suggestions)
 * Returns suggestedDependsOn in the response (not saved to DB).
 *
 * @route PATCH /api/v1/saved-test-cases/:id
 * @body name, description, flowId, tags, priority, etc.
 * @returns Updated saved test case + suggestedDependsOn
 */
export async function updateSavedTestCase(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);
    // Phase A (May 2026) — `setupSteps` / `teardownSteps` PATCH fields removed.
    // The inline-per-test-case columns are being deprecated in favour of the
    // `scenario_setup` test_resource (which yields the same `phase:'setup'`
    // prologue at run time but is reusable across many tests). The columns
    // still default to `[]` and read paths still surface them, so existing
    // clients that omit these fields are unaffected. Any client passing
    // `setupSteps` or `teardownSteps` now is silently ignored.
    const {
      name,
      description,
      flowId,
      tags,
      priority,
      preconditions,
      expectedResult,
    } = req.body;

    // If flowId is being changed, validate flow ownership + project match
    if (flowId !== undefined && flowId !== null) {
      const { data: existing, error: existingError } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, project_id')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (existingError || !existing) {
        res.status(404).json({ success: false, error: 'Saved test case not found' });
        return;
      }

      if (flowId) {
        const { data: flow, error: flowError } = await supabaseAdmin
          .from('test_flows')
          .select('id, module_id, test_modules!inner(project_id)')
          .eq('id', flowId)
          .eq('user_id', userId)
          .single();

        if (flowError || !flow) {
          res.status(404).json({ success: false, error: 'Flow not found or access denied' });
          return;
        }

        const flowProjectId = (flow as any).test_modules?.project_id;
        if (!flowProjectId || flowProjectId !== (existing as any).project_id) {
          res.status(422).json({
            success: false,
            error: 'Validation error',
            message: 'Flow belongs to a different project',
          });
          return;
        }
      }
    }

    // Build update object
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (flowId !== undefined) updates.flow_id = flowId;
    if (tags !== undefined) updates.tags = tags;
    if (priority !== undefined) updates.priority = priority;
    if (preconditions !== undefined) updates.preconditions = preconditions;
    // setupSteps / teardownSteps no longer accepted on PATCH (see destructure
    // note above). Use scenario_setup bindings via /api/v1/test-resource.
    if (expectedResult !== undefined) updates.expected_result = expectedResult;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }

    // Update in DB
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        res.status(404).json({ success: false, error: 'Saved test case not found' });
        return;
      }
      throw new Error(`Failed to update saved test case: ${error.message}`);
    }

    // Invalidate ptree:flow cache for any affected flow
    if (data.flow_id) {
      await cache.delByPattern(`qait:cache:ptree:flow:${data.flow_id}:*`);
    }
    if (flowId !== undefined && flowId !== data.flow_id) {
      await cache.delByPattern(`qait:cache:ptree:flow:${flowId}:*`);
    }

    // Generate AI suggestions if case has a flow_id
    let suggestedDependsOn: DependencySuggestion[] = [];
    if (data.flow_id) {
      const result = await SavedCaseDependencySuggester.suggestForCase(
        id,
        data.flow_id,
        userId
      );
      suggestedDependsOn = result.suggestions;
    }

    res.json({
      success: true,
      data: {
        ...mapToResponse(data),
        suggestedDependsOn,
      },
      timestamp: new Date(),
    });

    logger.info('[SAVED_TEST_CASES_API] Updated saved test case', {
      id,
      suggestionsCount: suggestedDependsOn.length,
    });

    if ((data as any).project_id) {
      void WorkspaceAuditService.logForProject({
        projectId: (data as any).project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.TEST_CASE_UPDATED,
        targetType: 'test_case',
        targetId: id,
        metadata: {
          name: (data as any).name,
          changed_fields: Object.keys(updates),
        },
        ...getAuditContext(req),
      });
    }
  } catch (error) {
    logger.error('[SAVED_TEST_CASES_API] Failed to update saved test case', { error });
    handleControllerError(res, error, 'Failed to update saved test case');
  }
}

/**
 * Set flow_id for a saved test case (with AI suggestions)
 * Convenience endpoint for assigning a case to a flow.
 *
 * @route PUT /api/v1/saved-test-cases/:id/flow
 * @body flowId - Flow ID to assign
 * @returns Updated saved test case + suggestedDependsOn
 */
export async function assignToFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { flowId } = req.body;
    const userId = getUserId(req);

    if (!flowId) {
      res.status(400).json({ success: false, error: 'flowId is required' });
      return;
    }

    // Get saved case for project scoping
    const { data: savedCase, error: savedCaseError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, project_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (savedCaseError || !savedCase) {
      res.status(404).json({ success: false, error: 'Saved test case not found' });
      return;
    }

    // Verify flow exists and belongs to user + same project via module
    const { data: flow, error: flowError } = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id, test_modules!inner(project_id)')
      .eq('id', flowId)
      .eq('user_id', userId)
      .single();

    if (flowError || !flow) {
      res.status(404).json({ success: false, error: 'Flow not found or access denied' });
      return;
    }

    const flowProjectId = (flow as any).test_modules?.project_id;
    if (!flowProjectId || flowProjectId !== (savedCase as any).project_id) {
      res.status(422).json({
        success: false,
        error: 'Validation error',
        message: 'Flow belongs to a different project',
      });
      return;
    }

    // Update saved test case
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .update({ flow_id: flowId })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        res.status(404).json({ success: false, error: 'Saved test case not found' });
        return;
      }
      throw new Error(`Failed to assign to flow: ${error.message}`);
    }

    // Invalidate ptree:flow cache for the assigned flow
    await cache.delByPattern(`qait:cache:ptree:flow:${flowId}:*`);

    // Generate AI suggestions
    const suggestionResult = await SavedCaseDependencySuggester.suggestForCase(
      id,
      flowId,
      userId
    );
    const suggestedDependsOn = suggestionResult.suggestions;

    res.json({
      success: true,
      data: {
        ...mapToResponse(data),
        suggestedDependsOn,
      },
      timestamp: new Date(),
    });

    logger.info('[SAVED_TEST_CASES_API] Assigned to flow', {
      id,
      flowId,
      suggestionsCount: suggestedDependsOn.length,
    });

    if ((data as any).project_id) {
      void WorkspaceAuditService.logForProject({
        projectId: (data as any).project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.TEST_CASE_ASSIGNED_TO_FLOW,
        targetType: 'test_case',
        targetId: id,
        metadata: { name: (data as any).name, flow_id: flowId },
        ...getAuditContext(req),
      });
    }
  } catch (error) {
    logger.error('[SAVED_TEST_CASES_API] Failed to assign to flow', { error });
    handleControllerError(res, error, 'Failed to assign to flow');
  }
}

/**
 * Confirm and save dependencies (depends_on) for a test case.
 * Validates: existence, ownership, same flow, no cycles.
 *
 * @route PATCH /api/v1/saved-test-cases/:id/dependencies
 * @body dependsOn - Array of intent_test_cases IDs
 * @returns Updated test case
 */
export async function updateDependencies(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { dependsOn } = req.body;
    const userId = getUserId(req);

    // Validate input
    if (!Array.isArray(dependsOn)) {
      res.status(400).json({ success: false, error: 'dependsOn must be an array of UUIDs' });
      return;
    }

    // Get target case
    const { data: targetCase, error: targetError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, project_id, flow_id, user_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (targetError || !targetCase) {
      res.status(404).json({ success: false, error: 'Saved test case not found' });
      return;
    }

    // If empty array, just clear dependencies
    if (dependsOn.length === 0) {
      const { data, error } = await supabaseAdmin
        .from('intent_test_cases')
        .update({ depends_on: [] })
        .eq('id', id)
        .eq('user_id', userId)
        .select('*')
        .single();

      if (error) {
        throw new Error(`Failed to clear dependencies: ${error.message}`);
      }

      res.json({
        success: true,
        data: mapToResponse(data),
        message: 'Dependencies cleared',
        timestamp: new Date(),
      });

      void WorkspaceAuditService.logForProject({
        projectId: targetCase.project_id,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.TEST_CASE_DEPENDENCIES_UPDATED,
        targetType: 'test_case',
        targetId: id,
        metadata: { dependencies_count: 0, action: 'cleared' },
        ...getAuditContext(req),
      });
      return;
    }

    // Validate all dependency IDs
    const validationErrors = await validateDependencies(
      id,
      dependsOn,
      targetCase.project_id,
      targetCase.flow_id,
      userId
    );

    if (validationErrors.length > 0) {
      res.status(422).json({
        success: false,
        error: 'Invalid dependencies',
        details: validationErrors,
      });
      return;
    }

    // Check for cycles
    const hasCycle = await detectCycle(id, dependsOn, userId, targetCase.project_id, targetCase.flow_id);
    if (hasCycle) {
      res.status(422).json({
        success: false,
        error: 'Circular dependency detected',
        message: 'The specified dependencies would create a cycle. Dependencies must form a DAG.',
      });
      return;
    }

    // Save dependencies
    const { data, error } = await supabaseAdmin
      .from('intent_test_cases')
      .update({ depends_on: dependsOn })
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to update dependencies: ${error.message}`);
    }

    res.json({
      success: true,
      data: mapToResponse(data),
      message: `${dependsOn.length} dependencies saved`,
      timestamp: new Date(),
    });

    logger.info('[SAVED_TEST_CASES_API] Dependencies updated', {
      id,
      dependenciesCount: dependsOn.length,
    });

    void WorkspaceAuditService.logForProject({
      projectId: targetCase.project_id,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.TEST_CASE_DEPENDENCIES_UPDATED,
      targetType: 'test_case',
      targetId: id,
      metadata: { dependencies_count: dependsOn.length, action: 'set' },
      ...getAuditContext(req),
    });
  } catch (error) {
    logger.error('[SAVED_TEST_CASES_API] Failed to update dependencies', { error });
    handleControllerError(res, error, 'Failed to update dependencies');
  }
}

/**
 * Get AI dependency suggestions for a saved test case
 *
 * @route GET /api/v1/saved-test-cases/:id/suggestions
 * @returns Array of suggested dependencies
 */
export async function getDependencySuggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    // Get case
    const { data: testCase, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, name, description, url, flow_id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !testCase) {
      res.status(404).json({ success: false, error: 'Saved test case not found' });
      return;
    }

    if (!testCase.flow_id) {
      res.json({
        success: true,
        data: [],
        nearMisses: [],
        message: 'No suggestions available - case is not assigned to a flow',
        timestamp: new Date(),
      });
      return;
    }

    const result = await SavedCaseDependencySuggester.suggestForCase(
      id,
      testCase.flow_id,
      userId
    );

    res.json({
      success: true,
      // `data` keeps the same shape (array of confident suggestions) for
      // backward compatibility. `nearMisses` is the new sibling — populated
      // only when `data` is empty so the UI can offer "AI considered these
      // but wasn't sure" instead of a blank "no suggestions" state.
      data: result.suggestions,
      nearMisses: result.nearMisses,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[SAVED_TEST_CASES_API] Failed to get suggestions', { error });
    handleControllerError(res, error, 'Failed to get suggestions');
  }
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate that all dependency IDs exist, belong to the same project/flow, and are owned by user
 */
async function validateDependencies(
  targetId: string,
  dependsOn: string[],
  projectId: string,
  flowId: string | null,
  userId: string
): Promise<string[]> {
  const errors: string[] = [];

  // Self-reference check
  if (dependsOn.includes(targetId)) {
    errors.push('Cannot depend on itself');
    return errors;
  }

  // Fetch all referenced cases
  const { data: cases, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, project_id, flow_id, user_id')
    .in('id', dependsOn);

  if (error) {
    errors.push(`Database error: ${error.message}`);
    return errors;
  }

  const foundIds = new Set((cases || []).map(c => c.id));

  for (const depId of dependsOn) {
    // Existence check
    if (!foundIds.has(depId)) {
      errors.push(`Dependency ${depId} not found`);
      continue;
    }

    const depCase = cases?.find(c => c.id === depId);
    if (!depCase) continue;

    // Ownership check
    if (depCase.user_id !== userId) {
      errors.push(`Dependency ${depId} is not owned by current user`);
      continue;
    }

    // Project check
    if (depCase.project_id !== projectId) {
      errors.push(`Dependency ${depId} is in a different project`);
      continue;
    }

    // Flow check: allow cross-flow dependencies within the same project.
    // Common case: "Login" in Auth Flow is a prerequisite for "Payment" in Checkout Flow.
  }

  return errors;
}

/**
 * Detect if adding dependencies would create a cycle (DFS-based)
 */
async function detectCycle(
  targetId: string,
  newDependsOn: string[],
  userId: string,
  projectId: string,
  flowId: string | null
): Promise<boolean> {
  // Adding edge: targetId -> depId introduces a cycle if depId can already reach targetId.

  // Fetch all cases in the project for full graph traversal (cross-flow deps allowed)
  const { data: allCases, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, depends_on')
    .eq('user_id', userId)
    .eq('project_id', projectId);
  if (error) {
    logger.warn('[SAVED_TEST_CASES_API] Cycle detection query failed', {
      error: error.message,
      projectId,
      flowId,
    });
    // Fail-safe: treat as cycle risk
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const c of allCases || []) {
    const deps = Array.isArray((c as any).depends_on) ? (c as any).depends_on : [];
    adjacency.set((c as any).id, deps);
  }

  const canReachTarget = (startId: string): boolean => {
    const stack = [startId];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === targetId) return true;
      if (visited.has(node)) continue;
      visited.add(node);

      const next = adjacency.get(node) || [];
      for (const n of next) {
        if (!visited.has(n)) stack.push(n);
      }
    }
    return false;
  };

  return newDependsOn.some(depId => canReachTarget(depId));
}

// ============================================================================
// MAPPING
// ============================================================================

/**
 * Map database row to API response format
 */
function mapToResponse(row: any): any {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    sourceTestId: row.source_test_id,
    sourceIntelligentSessionId: row.source_intelligent_session_id,
    name: row.name,
    description: row.description || undefined,
    kind: row.kind,
    platform: row.platform || 'web',
    replayStrategy: row.replay_strategy,
    url: row.url,
    flowId: row.flow_id || undefined,
    tags: row.tags || [],
    priority: row.priority || undefined,
    preconditions: row.preconditions || [],
    setupSteps: row.setup_steps || [],
    teardownSteps: row.teardown_steps || [],
    expectedResult: row.expected_result || undefined,
    dependsOn: row.depends_on || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
