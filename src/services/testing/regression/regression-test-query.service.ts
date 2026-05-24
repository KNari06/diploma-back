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
}
