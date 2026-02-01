/**
 * Platform Tree Service
 * Builds nested hierarchy for platforms -> modules -> suites -> flows -> testCases
 * Supports pagination at each level via scoped calls
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

// ============================================================================
// TYPES
// ============================================================================

interface PageInfo {
  limit: number;
  offset: number;
  total: number;
}

interface PaginatedList<T> {
  items: T[];
  pageInfo: PageInfo;
}

interface PlatformSummary {
  id: string;
  projectId: string;
  platformKey: 'web_ui' | 'api';
  name: string;
  description?: string;
}

interface ModuleSummary {
  id: string;
  platformId: string;
  platformKey?: 'web_ui' | 'api';
  name: string;
  description?: string;
  priority?: string;
}

interface SuiteSummary {
  id: string;
  moduleId?: string;
  name: string;
  suiteType: 'ui' | 'api';
  priority?: string;
  createdAt: string;
}

interface FlowSummary {
  id: string;
  suiteId: string;
  name: string;
  flowType: 'ui' | 'api' | 'mixed';
  priority?: string;
  orderIndex: number;
}

interface TestCaseSummary {
  id: string;
  testType: 'ui' | 'api';
  name: string;
  priority?: string;
  status?: 'draft' | 'published' | 'archived';
  createdAt: string;
}

// Response shapes for different modes
export interface BaseModeResponse {
  platforms: {
    items: Array<PlatformSummary & {
      modules: PaginatedList<ModuleSummary>;
    }>;
  };
}

export interface ModuleModeResponse {
  module: ModuleSummary;
  suites: PaginatedList<SuiteSummary>;
}

export interface SuiteModeResponse {
  suite: SuiteSummary;
  flows: PaginatedList<FlowSummary>;
}

export interface FlowModeResponse {
  flow: FlowSummary;
  testCases: PaginatedList<TestCaseSummary>;
}

// ============================================================================
// SERVICE
// ============================================================================

/**
 * Service for building nested platform tree with pagination support
 */
export class PlatformTreeService {
  /**
   * Base mode: return platforms with paginated modules
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @param options - Pagination options for modules
   */
  static async getBaseModeTree(
    projectId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<BaseModeResponse> {
    const { limit = 20, offset = 0 } = options;

    // Get platforms
    const { data: platforms, error: platformsError } = await supabaseAdmin
      .from('test_platforms')
      .select('id, project_id, platform_key, name, description')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('platform_key', { ascending: true });

    if (platformsError) {
      logger.error('[PLATFORM_TREE] Failed to get platforms', { error: platformsError });
      throw new Error(`Failed to get platforms: ${platformsError.message}`);
    }

    const platformIds = (platforms || []).map((p: any) => p.id);
    if (platformIds.length === 0) {
      return { platforms: { items: [] } };
    }

    // Get modules count per platform
    const { data: moduleCounts, error: countError } = await supabaseAdmin
      .from('test_modules')
      .select('platform_id')
      .in('platform_id', platformIds)
      .eq('user_id', userId);

    if (countError) {
      logger.error('[PLATFORM_TREE] Failed to count modules', { error: countError });
      throw new Error(`Failed to count modules: ${countError.message}`);
    }

    // Count per platform
    const countMap = new Map<string, number>();
    for (const m of moduleCounts || []) {
      countMap.set(m.platform_id, (countMap.get(m.platform_id) || 0) + 1);
    }

    // Build result with paginated modules per platform
    const platformResults: BaseModeResponse['platforms']['items'] = [];

    for (const p of platforms || []) {
      const { data: modules, error: modulesError } = await supabaseAdmin
        .from('test_modules')
        .select('id, platform_id, name, description, priority')
        .eq('platform_id', p.id)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (modulesError) {
        logger.error('[PLATFORM_TREE] Failed to get modules', { error: modulesError, platformId: p.id });
        throw new Error(`Failed to get modules: ${modulesError.message}`);
      }

      platformResults.push({
        id: p.id,
        projectId: p.project_id,
        platformKey: p.platform_key,
        name: p.name,
        description: p.description || undefined,
        modules: {
          items: (modules || []).map((m: any) => ({
            id: m.id,
            platformId: m.platform_id,
            platformKey: p.platform_key,
            name: m.name,
            description: m.description || undefined,
            priority: m.priority || undefined,
          })),
          pageInfo: {
            limit,
            offset,
            total: countMap.get(p.id) || 0,
          },
        },
      });
    }

    return { platforms: { items: platformResults } };
  }

  /**
   * Module mode: return module with paginated suites
   * @param moduleId - Module ID
   * @param userId - User ID for access control
   * @param options - Pagination options for suites
   */
  static async getModuleModeTree(
    moduleId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<ModuleModeResponse> {
    const { limit = 20, offset = 0 } = options;

    // Get module with platform info
    const { data: moduleData, error: moduleError } = await supabaseAdmin
      .from('test_modules')
      .select('id, platform_id, name, description, priority, test_platforms!inner(platform_key)')
      .eq('id', moduleId)
      .eq('user_id', userId)
      .single();

    if (moduleError || !moduleData) {
      throw new Error('Module not found or access denied');
    }

    // Get suites count
    const { count: suitesCount, error: countError } = await supabaseAdmin
      .from('regression_suites')
      .select('id', { count: 'exact', head: true })
      .eq('module_id', moduleId)
      .eq('user_id', userId);

    if (countError) {
      logger.error('[PLATFORM_TREE] Failed to count suites', { error: countError });
      throw new Error(`Failed to count suites: ${countError.message}`);
    }

    // Get paginated suites
    const { data: suites, error: suitesError } = await supabaseAdmin
      .from('regression_suites')
      .select('id, module_id, name, suite_type, priority, created_at')
      .eq('module_id', moduleId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (suitesError) {
      logger.error('[PLATFORM_TREE] Failed to get suites', { error: suitesError });
      throw new Error(`Failed to get suites: ${suitesError.message}`);
    }

    return {
      module: {
        id: moduleData.id,
        platformId: moduleData.platform_id,
        platformKey: (moduleData.test_platforms as any)?.platform_key,
        name: moduleData.name,
        description: moduleData.description || undefined,
        priority: moduleData.priority || undefined,
      },
      suites: {
        items: (suites || []).map((s: any) => ({
          id: s.id,
          moduleId: s.module_id || undefined,
          name: s.name,
          suiteType: s.suite_type,
          priority: s.priority || undefined,
          createdAt: s.created_at,
        })),
        pageInfo: {
          limit,
          offset,
          total: suitesCount || 0,
        },
      },
    };
  }

  /**
   * Suite mode: return suite with paginated flows
   * @param suiteId - Suite ID
   * @param userId - User ID for access control
   * @param options - Pagination options for flows
   */
  static async getSuiteModeTree(
    suiteId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<SuiteModeResponse> {
    const { limit = 20, offset = 0 } = options;

    // Get suite
    const { data: suiteData, error: suiteError } = await supabaseAdmin
      .from('regression_suites')
      .select('id, module_id, name, suite_type, priority, created_at')
      .eq('id', suiteId)
      .eq('user_id', userId)
      .single();

    if (suiteError || !suiteData) {
      throw new Error('Suite not found or access denied');
    }

    // Get flows count
    const { count: flowsCount, error: countError } = await supabaseAdmin
      .from('test_flows')
      .select('id', { count: 'exact', head: true })
      .eq('suite_id', suiteId)
      .eq('user_id', userId);

    if (countError) {
      logger.error('[PLATFORM_TREE] Failed to count flows', { error: countError });
      throw new Error(`Failed to count flows: ${countError.message}`);
    }

    // Get paginated flows
    const { data: flows, error: flowsError } = await supabaseAdmin
      .from('test_flows')
      .select('id, suite_id, name, flow_type, priority, order_index')
      .eq('suite_id', suiteId)
      .eq('user_id', userId)
      .order('order_index', { ascending: true })
      .range(offset, offset + limit - 1);

    if (flowsError) {
      logger.error('[PLATFORM_TREE] Failed to get flows', { error: flowsError });
      throw new Error(`Failed to get flows: ${flowsError.message}`);
    }

    return {
      suite: {
        id: suiteData.id,
        moduleId: suiteData.module_id || undefined,
        name: suiteData.name,
        suiteType: suiteData.suite_type,
        priority: suiteData.priority || undefined,
        createdAt: suiteData.created_at,
      },
      flows: {
        items: (flows || []).map((f: any) => ({
          id: f.id,
          suiteId: f.suite_id,
          name: f.name,
          flowType: f.flow_type,
          priority: f.priority || undefined,
          orderIndex: f.order_index,
        })),
        pageInfo: {
          limit,
          offset,
          total: flowsCount || 0,
        },
      },
    };
  }

  /**
   * Flow mode: return flow with paginated test cases (merged from UI + API)
   * UI test cases are now sourced from intent_test_cases (unified table).
   * API test cases continue to come from api_test_configs.
   * @param flowId - Flow ID
   * @param userId - User ID for access control
   * @param options - Pagination options for test cases
   */
  static async getFlowModeTree(
    flowId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<FlowModeResponse> {
    const { limit = 20, offset = 0 } = options;

    // Get flow
    const { data: flowData, error: flowError } = await supabaseAdmin
      .from('test_flows')
      .select('id, suite_id, name, flow_type, priority, order_index')
      .eq('id', flowId)
      .eq('user_id', userId)
      .single();

    if (flowError || !flowData) {
      throw new Error('Flow not found or access denied');
    }

    // Get UI test cases count from intent_test_cases (unified table)
    const { count: uiCount, error: uiCountError } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('flow_id', flowId)
      .eq('user_id', userId);

    if (uiCountError) {
      logger.error('[PLATFORM_TREE] Failed to count UI test cases', { error: uiCountError });
      throw new Error(`Failed to count UI test cases: ${uiCountError.message}`);
    }

    // Get API test cases count (unchanged)
    const { count: apiCount, error: apiCountError } = await supabaseAdmin
      .from('api_test_configs')
      .select('id', { count: 'exact', head: true })
      .eq('flow_id', flowId)
      .eq('user_id', userId);

    if (apiCountError) {
      logger.error('[PLATFORM_TREE] Failed to count API test cases', { error: apiCountError });
      throw new Error(`Failed to count API test cases: ${apiCountError.message}`);
    }

    const totalTestCases = (uiCount || 0) + (apiCount || 0);

    // Get all test cases from both sources (for proper merge/pagination)
    // UI cases now come from intent_test_cases with status field
    const [uiResult, apiResult] = await Promise.all([
      supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, priority, status, created_at')
        .eq('flow_id', flowId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('api_test_configs')
        .select('id, name, priority, created_at')
        .eq('flow_id', flowId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    if (uiResult.error) {
      throw new Error(`Failed to get UI test cases: ${uiResult.error.message}`);
    }
    if (apiResult.error) {
      throw new Error(`Failed to get API test cases: ${apiResult.error.message}`);
    }

    // Merge and tag with testType; UI cases include status
    const merged: TestCaseSummary[] = [
      ...(uiResult.data || []).map((tc: any) => ({
        id: tc.id,
        testType: 'ui' as const,
        name: tc.name,
        priority: tc.priority || undefined,
        status: tc.status as 'draft' | 'published' | 'archived',
        createdAt: tc.created_at,
      })),
      ...(apiResult.data || []).map((tc: any) => ({
        id: tc.id,
        testType: 'api' as const,
        name: tc.name,
        priority: tc.priority || undefined,
        // API test cases don't have status concept yet
        createdAt: tc.created_at,
      })),
    ];

    // Sort by createdAt desc (stable)
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Apply pagination
    const paginatedItems = merged.slice(offset, offset + limit);

    return {
      flow: {
        id: flowData.id,
        suiteId: flowData.suite_id,
        name: flowData.name,
        flowType: flowData.flow_type,
        priority: flowData.priority || undefined,
        orderIndex: flowData.order_index,
      },
      testCases: {
        items: paginatedItems,
        pageInfo: {
          limit,
          offset,
          total: totalTestCases,
        },
      },
    };
  }
}
