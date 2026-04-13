/**
 * Platform Tree Service
 * Builds nested hierarchy for platforms -> modules -> flows -> testCases
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
  platformKey: 'web_ui' | 'api' | 'mobile';
  name: string;
  description?: string;
}

interface ModuleSummary {
  id: string;
  platformId: string;
  platformKey?: 'web_ui' | 'api' | 'mobile';
  name: string;
  description?: string;
  priority?: string;
}

interface FlowSummary {
  id: string;
  moduleId: string;
  name: string;
  flowType: 'ui' | 'api' | 'mixed' | 'mobile';
  platform?: string;
  priority?: string;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
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
   *
   * Queries:
   *   1. Fetch platforms (1 query)
   *   2. Fetch paginated modules + counts per platform (parallel, 1 per platform)
   * Total: 1 + N parallel queries (N = number of platforms, typically 2)
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

    // Custom platform order for UI: web_ui first, then api (then anything else)
    const preferredOrder: Record<string, number> = { web_ui: 0, mobile: 1, api: 2 };
    const sortedPlatforms = (platforms || []).slice().sort((a: any, b: any) => {
      const wa = preferredOrder[a.platform_key] ?? 99;
      const wb = preferredOrder[b.platform_key] ?? 99;
      return wa - wb;
    });

    if (sortedPlatforms.length === 0) {
      return { platforms: { items: [] } };
    }

    // Fetch paginated modules + count per platform in parallel (single query per platform)
    const platformResults = await Promise.all(
      sortedPlatforms.map(async (p: any) => {
        const modulesResult = await supabaseAdmin
          .from('test_modules')
          .select('id, platform_id, name, description, priority', { count: 'exact' })
          .eq('platform_id', p.id)
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (modulesResult.error) {
          logger.error('[PLATFORM_TREE] Failed to get modules', { error: modulesResult.error, platformId: p.id });
          throw new Error(`Failed to get modules: ${modulesResult.error.message}`);
        }

        return {
          id: p.id,
          projectId: p.project_id,
          platformKey: p.platform_key,
          name: p.name,
          description: p.description || undefined,
          modules: {
            items: (modulesResult.data || []).map((m: any) => ({
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
              total: modulesResult.count || 0,
            },
          },
        };
      })
    );

    return { platforms: { items: platformResults } };
  }

  /**
   * Module mode: return module with paginated flows
   *
   * Queries: 1 (module + join) + 1 (flows page + count) = 2 queries
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

    // Get paginated flows + count in single query
    const flowsResult = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id, name, flow_type, platform, priority, order_index, created_at, updated_at', { count: 'exact' })
      .eq('module_id', moduleId)
      .eq('user_id', userId)
      .order('order_index', { ascending: true })
      .range(offset, offset + limit - 1);

    if (flowsResult.error) {
      logger.error('[PLATFORM_TREE] Failed to get flows', { error: flowsResult.error });
      throw new Error(`Failed to get flows: ${flowsResult.error.message}`);
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
      flows: {
        items: (flowsResult.data || []).map((f: any) => ({
          id: f.id,
          moduleId: f.module_id,
          name: f.name,
          flowType: f.flow_type,
          platform: f.platform || undefined,
          priority: f.priority || undefined,
          orderIndex: f.order_index,
          createdAt: f.created_at,
          updatedAt: f.updated_at || f.created_at,
        })),
        pageInfo: {
          limit,
          offset,
          total: flowsResult.count || 0,
        },
      },
    };
  }

  /**
   * Flow mode: return flow with paginated test cases (merged from UI + API)
   *
   * Strategy: fetch paginated slices from both tables, merge and re-sort.
   * Over-fetch slightly (limit from each source) to ensure correct merged ordering,
   * then trim to the requested page size.
   *
   * Queries: 1 (flow) + 2 parallel (ui page+count + api page+count) = 3 queries
   */
  static async getFlowModeTree(
    flowId: string,
    userId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<FlowModeResponse> {
    const { limit = 20, offset = 0 } = options;

    // Fetch flow + paginated data+counts all in parallel
    const [flowResult, uiDataResult, apiDataResult] = await Promise.all([
      // 1. Flow itself
      supabaseAdmin
        .from('test_flows')
        .select('id, module_id, name, flow_type, platform, priority, order_index, created_at, updated_at')
        .eq('id', flowId)
        .eq('user_id', userId)
        .single(),
      // 2. UI test cases — data + count in one query
      supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, priority, status, created_at', { count: 'exact' })
        .eq('flow_id', flowId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(0, offset + limit - 1),
      // 3. API test cases — data + count in one query
      supabaseAdmin
        .from('api_test_configs')
        .select('id, name, priority, created_at', { count: 'exact' })
        .eq('flow_id', flowId)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(0, offset + limit - 1),
    ]);

    if (flowResult.error || !flowResult.data) {
      throw new Error('Flow not found or access denied');
    }
    if (uiDataResult.error) {
      throw new Error(`Failed to get UI test cases: ${uiDataResult.error.message}`);
    }
    if (apiDataResult.error) {
      throw new Error(`Failed to get API test cases: ${apiDataResult.error.message}`);
    }

    const flowData = flowResult.data;
    const totalTestCases = (uiDataResult.count || 0) + (apiDataResult.count || 0);

    // Merge and tag with testType
    const merged: TestCaseSummary[] = [
      ...(uiDataResult.data || []).map((tc: any) => ({
        id: tc.id,
        testType: 'ui' as const,
        name: tc.name,
        priority: tc.priority || undefined,
        status: tc.status as 'draft' | 'published' | 'archived',
        createdAt: tc.created_at,
      })),
      ...(apiDataResult.data || []).map((tc: any) => ({
        id: tc.id,
        testType: 'api' as const,
        name: tc.name,
        priority: tc.priority || undefined,
        createdAt: tc.created_at,
      })),
    ];

    // Sort by createdAt desc (stable merge of two pre-sorted arrays)
    merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Apply pagination on the merged set
    const paginatedItems = merged.slice(offset, offset + limit);

    return {
      flow: {
        id: flowData.id,
        moduleId: flowData.module_id,
        name: flowData.name,
        flowType: flowData.flow_type,
        platform: flowData.platform || undefined,
        priority: flowData.priority || undefined,
        orderIndex: flowData.order_index,
        createdAt: flowData.created_at,
        updatedAt: flowData.updated_at || flowData.created_at,
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
