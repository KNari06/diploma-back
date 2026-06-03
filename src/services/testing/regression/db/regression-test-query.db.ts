import { supabaseAdmin } from '@/db/supabase';
import { NotFoundError, ValidationError } from '@/types';
import type { ExecutableTestCase, Priority } from '@/types/testing.types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION TEST QUERY SERVICE
 *
 * Extracted from RegressionRunService (Phase 1-D refactor).
 * Pure DB-query helpers for resolving which test cases to execute in a run.
 * No logic changes — verbatim copies from regression-run.service.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class RegressionTestQueryService {
  /**
   * Get intent test case and verify access.
   * Fetches from intent_test_cases (unified table).
   *
   * @throws {NotFoundError} If intent test case not found
   * @throws {ValidationError} If access denied
   */
  static async getSavedTestCase(
    intentTestCaseId: string,
    userId: string
  ): Promise<any> {
    const { data: intentCase, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('*, projects!inner(user_id)')
      .eq('id', intentTestCaseId)
      .single();

    if (error || !intentCase) {
      throw new NotFoundError('Intent test case', intentTestCaseId);
    }

    // Verify user has access via project ownership
    const projectUserId = (intentCase.projects as any)?.user_id;
    if (!projectUserId || projectUserId !== userId) {
      throw new ValidationError('Access denied to this intent test case');
    }

    return intentCase;
  }

  /**
   * Get all test cases in flows with hierarchy info
   */
  static async getTestCasesInFlows(
    flowIds: string[]
  ): Promise<ExecutableTestCase[]> {
    if (flowIds.length === 0) {
      return [];
    }

    // Map flow -> module (direct, no suite intermediary)
    const { data: flows, error: flowsError } = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id')
      .in('id', flowIds);

    if (flowsError) {
      throw new Error(`Failed to load flows: ${flowsError.message}`);
    }

    const flowToModule = new Map<string, string | undefined>();
    for (const f of flows || []) {
      if (f?.id) {
        flowToModule.set(f.id, f.module_id || undefined);
      }
    }

    const testCases: ExecutableTestCase[] = [];

    // UI test cases from intent_test_cases (unified table)
    const { data: uiCases, error: uiError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, flow_id, depends_on, platform')
      .in('flow_id', flowIds);

    if (uiError) {
      throw new Error(`Failed to load UI test cases: ${uiError.message}`);
    }

    for (const tc of uiCases || []) {
      const flowId = tc.flow_id || undefined;
      const moduleId = flowId ? flowToModule.get(flowId) : undefined;
      testCases.push({
        testCaseId: tc.id,
        testType: 'ui',
        moduleId,
        flowId,
        dependsOn: tc.depends_on || [],
        platform: tc.platform || undefined,
      });
    }

    // API test configs (no depends_on support for API tests)
    const { data: apiCases, error: apiError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, flow_id')
      .in('flow_id', flowIds);

    if (apiError) {
      throw new Error(`Failed to load API test cases: ${apiError.message}`);
    }

    for (const tc of apiCases || []) {
      const flowId = tc.flow_id || undefined;
      const moduleId = flowId ? flowToModule.get(flowId) : undefined;
      testCases.push({
        testCaseId: tc.id,
        testType: 'api',
        moduleId,
        flowId,
        dependsOn: [],
      });
    }

    return testCases;
  }

  /**
   * Get API test configs filtered by project and tag (via api_environments/api_endpoints).
   */
  static async getApiTestConfigsByProjectAndTag(
    projectId: string,
    userId: string,
    tag: string
  ): Promise<Array<{ id: string; flow_id?: string }>> {
    const { data: envs, error: envError } = await supabaseAdmin
      .from('api_environments')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (envError) {
      throw new Error(`Failed to load API environments: ${envError.message}`);
    }

    const envIds = (envs || []).map((e: any) => e.id);
    if (envIds.length === 0) return [];

    const { data: endpoints, error: epError } = await supabaseAdmin
      .from('api_endpoints')
      .select('id')
      .in('environment_id', envIds);

    if (epError) {
      throw new Error(`Failed to load API endpoints: ${epError.message}`);
    }

    const endpointIds = (endpoints || []).map((e: any) => e.id);
    if (endpointIds.length === 0) return [];

    const { data: configs, error: cfgError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, flow_id')
      .eq('user_id', userId)
      .in('endpoint_id', endpointIds)
      .contains('tags', [tag]);

    if (cfgError) {
      throw new Error(`Failed to load API test configs: ${cfgError.message}`);
    }

    return (configs || []).map((c: any) => ({ id: c.id, flow_id: c.flow_id || undefined }));
  }

  /**
   * Get API test configs filtered by project and priority (via api_environments/api_endpoints).
   */
  static async getApiTestConfigsByProjectAndPriority(
    projectId: string,
    userId: string,
    priority: Priority
  ): Promise<Array<{ id: string; flow_id?: string }>> {
    const { data: envs, error: envError } = await supabaseAdmin
      .from('api_environments')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (envError) {
      throw new Error(`Failed to load API environments: ${envError.message}`);
    }

    const envIds = (envs || []).map((e: any) => e.id);
    if (envIds.length === 0) return [];

    const { data: endpoints, error: epError } = await supabaseAdmin
      .from('api_endpoints')
      .select('id')
      .in('environment_id', envIds);

    if (epError) {
      throw new Error(`Failed to load API endpoints: ${epError.message}`);
    }

    const endpointIds = (endpoints || []).map((e: any) => e.id);
    if (endpointIds.length === 0) return [];

    const { data: configs, error: cfgError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id, flow_id')
      .eq('user_id', userId)
      .in('endpoint_id', endpointIds)
      .eq('priority', priority);

    if (cfgError) {
      throw new Error(`Failed to load API test configs: ${cfgError.message}`);
    }

    return (configs || []).map((c: any) => ({ id: c.id, flow_id: c.flow_id || undefined }));
  }

  /**
   * Step-count source rows for credit estimation. Empty input → empty array.
   */
  static async getUiStepCountRows(uiIds: string[]): Promise<any[]> {
    if (uiIds.length === 0) return [];

    const { data } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, commands, graph_ref, steps_json, setup_steps, teardown_steps, replay_strategy')
      .in('id', uiIds);

    return data || [];
  }

  /**
   * List intent test cases for a project (newest first), optionally filtered by
   * platform. Surfaces the query error so the caller can throw.
   */
  static async listByProject(
    projectId: string,
    limit: number,
    platform?: string,
  ): Promise<{ data: any[] | null; error: unknown }> {
    let query = supabaseAdmin
      .from('intent_test_cases')
      .select('*')
      .eq('project_id', projectId);

    if (platform) {
      query = query.eq('platform', platform);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit);

    return { data: (data as any[]) ?? null, error };
  }

  /**
   * depends_on arrays for the given UI test case ids. Empty input → empty array.
   */
  static async getDependsOnRows(
    uiCaseIds: string[],
  ): Promise<Array<{ id: string; depends_on: string[] | null }>> {
    if (uiCaseIds.length === 0) return [];

    const { data } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, depends_on')
      .in('id', uiCaseIds);

    return (data as Array<{ id: string; depends_on: string[] | null }>) || [];
  }

  /**
   * Module row with owner + platform join (for access check + platform resolve).
   */
  static async getModuleWithAccess(
    moduleId: string,
  ): Promise<{ data: any | null; error: unknown }> {
    const { data, error } = await supabaseAdmin
      .from('test_modules')
      .select('*, projects!inner(user_id), test_platforms!inner(platform_key)')
      .eq('id', moduleId)
      .single();

    return { data: data ?? null, error };
  }

  /**
   * Flow ids within a module. Empty result → empty array.
   */
  static async getFlowIdsByModule(moduleId: string): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('test_flows')
      .select('id')
      .eq('module_id', moduleId);

    return ((data as Array<{ id: string }>) || []).map((f) => f.id);
  }

  /**
   * Flow row with module + owner join (for access check).
   */
  static async getFlowWithAccess(
    flowId: string,
  ): Promise<{ data: any | null; error: unknown }> {
    const { data, error } = await supabaseAdmin
      .from('test_flows')
      .select('*, test_modules!inner(project_id, projects!inner(user_id))')
      .eq('id', flowId)
      .single();

    return { data: data ?? null, error };
  }

  /**
   * UI test cases for a project carrying a given tag. Empty result → empty array.
   */
  static async getUiTestCasesByTag(projectId: string, tag: string): Promise<any[]> {
    const { data } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, flow_id, depends_on, platform, priority')
      .eq('project_id', projectId)
      .contains('tags', [tag]);

    return data || [];
  }

  /**
   * UI test cases for a project at a given priority. Empty result → empty array.
   */
  static async getUiTestCasesByPriority(projectId: string, priority: Priority): Promise<any[]> {
    const { data } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id, flow_id, depends_on, platform')
      .eq('project_id', projectId)
      .eq('priority', priority);

    return data || [];
  }
}
