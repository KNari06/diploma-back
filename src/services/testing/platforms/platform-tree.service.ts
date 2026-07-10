/**
 * Platform Tree Service
 * Builds nested hierarchy for platforms -> modules -> flows -> testCases
 * Supports pagination at each level via scoped calls
 */

import { supabaseAdmin } from '@/db/supabase';
import {
  getFlowPlatformsByModuleIds,
  getProjectModulesForTree,
  type FlowPlatformRow,
  type PlatformModuleTreeRow,
} from '@/services/testing/modules/db/module.db';
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
  /** Platform the folder was created under. null = platform-agnostic folder. */
  platformId: string | null;
  platformKey?: 'web_ui' | 'api' | 'mobile';
  /** Parent folder id (self-reference). null = top-level folder. */
  parentModuleId: string | null;
  name: string;
  description?: string;
  priority?: string;
  orderIndex: number | null;
  /**
   * Coarse platform kinds (web_ui | mobile | api) of the folder's DIRECT tests.
   * The frontend rolls these up over the subtree to filter folders by tab.
   */
  directPlatforms?: Array<'web_ui' | 'mobile' | 'api'>;
}

interface FlowSummary {
  id: string;
  moduleId: string;
  name: string;
  flowType: 'ui' | 'api' | 'mixed' | 'mobile';
  platform?: string;
  priority?: string;
  tags: string[];
  orderIndex: number | null;
  mobileVariantLabel?: string | null;
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
  /**
   * ALL project modules as one flat, project-level list (folders are
   * platform-agnostic). Each carries its own platformId (may be null) and the
   * coarse platform kinds present in its direct tests (directPlatforms). The
   * frontend assembles a single folder forest from this.
   */
  modules: PaginatedList<ModuleSummary>;
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
   * Base mode: return the project-level folder forest plus platform metadata.
   *
   * Folders are platform-agnostic (a folder's platform_id may be NULL and it can
   * hold web/mobile/api tests together), so modules are returned as ONE flat
   * project-level list carrying parent_module_id; the frontend assembles the
   * nested tree. Each module also reports the coarse platform kinds present in
   * its DIRECT tests (directPlatforms) so the Repository tabs can hide folders
   * that hold no matching test. `platforms.items[]` is kept for tab metadata and
   * back-compat (its per-platform modules exclude platform-null folders).
   *
   * A nested tree CANNOT be offset/limit-paginated — a slice would drop folders
   * and orphan their children — so the full (depth-capped, breadth-modest)
   * module set is returned regardless of limit/offset.
   *
   * Queries: 1 (platforms) + 1 (all project modules) + 1 (flow platforms) = 3.
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

    // Custom platform order for UI: web_ui first, then mobile, then api.
    const preferredOrder: Record<string, number> = { web_ui: 0, mobile: 1, api: 2 };
    const sortedPlatforms = (platforms || []).slice().sort((a: any, b: any) => {
      const wa = preferredOrder[a.platform_key] ?? 99;
      const wb = preferredOrder[b.platform_key] ?? 99;
      return wa - wb;
    });

    const emptyPage = { limit, offset, total: 0 };
    if (sortedPlatforms.length === 0) {
      return { platforms: { items: [] }, modules: { items: [], pageInfo: emptyPage } };
    }

    // Fetch ALL project modules once (incl. platform-null folders) + the flows'
    // platforms for those modules, in parallel.
    const moduleRows = await getProjectModulesForTree(projectId, userId);
    const moduleIds = moduleRows.map((m) => m.id);
    const flowPlatformRows = await getFlowPlatformsByModuleIds(moduleIds, userId);

    // moduleId → set of coarse platform kinds present in its direct tests.
    const directPlatformMap = new Map<string, Set<'web_ui' | 'mobile' | 'api'>>();
    for (const row of flowPlatformRows) {
      const kind = PlatformTreeService.bucketFlowPlatform(row);
      const set = directPlatformMap.get(row.moduleId) ?? new Set();
      set.add(kind);
      directPlatformMap.set(row.moduleId, set);
    }

    const toSummary = (r: PlatformModuleTreeRow): ModuleSummary => ({
      id: r.id,
      platformId: r.platformId,
      platformKey: r.platformKey,
      parentModuleId: r.parentModuleId,
      name: r.name,
      description: r.description,
      priority: r.priority,
      orderIndex: r.orderIndex,
      directPlatforms: Array.from(directPlatformMap.get(r.id) ?? []),
    });

    const allModules: ModuleSummary[] = moduleRows.map(toSummary);

    // Per-platform lists (back-compat): filter the project modules by platform.
    // Platform-null folders belong to no platform bucket (they live only in the
    // project-level `modules` list below).
    const platformResults = sortedPlatforms.map((p: any) => {
      const items = allModules.filter((m) => m.platformId === p.id);
      return {
        id: p.id,
        projectId: p.project_id,
        platformKey: p.platform_key,
        name: p.name,
        description: p.description || undefined,
        modules: {
          items,
          pageInfo: { limit, offset, total: items.length },
        },
      };
    });

    return {
      platforms: { items: platformResults },
      modules: {
        items: allModules,
        pageInfo: { limit, offset, total: allModules.length },
      },
    };
  }

  /**
   * Bucket a flow's (platform, flow_type) into a coarse platform kind used by
   * the Repository tabs: api > mobile > web_ui. flow_type wins for api/mobile
   * classification; platform string refines mobile; everything else is web_ui.
   */
  private static bucketFlowPlatform(row: FlowPlatformRow): 'web_ui' | 'mobile' | 'api' {
    const platform = (row.platform || '').toLowerCase();
    const flowType = (row.flowType || '').toLowerCase();
    if (flowType === 'api') return 'api';
    if (flowType === 'mobile' || platform.startsWith('mobile')) return 'mobile';
    return 'web_ui';
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
      .select('id, platform_id, parent_module_id, name, description, priority, order_index, test_platforms(platform_key)')
      .eq('id', moduleId)
      .eq('user_id', userId)
      .single();

    if (moduleError || !moduleData) {
      throw new Error('Module not found or access denied');
    }

    // Get paginated flows + count in single query
    const flowsResult = await supabaseAdmin
      .from('test_flows')
      .select('id, module_id, name, flow_type, platform, priority, tags, order_index, created_at, updated_at, mobile_variant_label', { count: 'exact' })
      .eq('module_id', moduleId)
      .eq('user_id', userId)
      .order('order_index', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
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
        parentModuleId: moduleData.parent_module_id ?? null,
        name: moduleData.name,
        description: moduleData.description || undefined,
        priority: moduleData.priority || undefined,
        orderIndex: typeof moduleData.order_index === 'number' ? moduleData.order_index : null,
      },
      flows: {
        items: (flowsResult.data || []).map((f: any) => ({
          id: f.id,
          moduleId: f.module_id,
          name: f.name,
          flowType: f.flow_type,
          platform: f.platform || undefined,
          priority: f.priority || undefined,
          tags: f.tags || [],
          orderIndex: f.order_index,
          mobileVariantLabel: f.mobile_variant_label ?? null,
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
        .select('id, module_id, name, flow_type, platform, priority, tags, order_index, created_at, updated_at, mobile_variant_label')
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
        tags: flowData.tags || [],
        orderIndex: flowData.order_index,
        mobileVariantLabel: flowData.mobile_variant_label ?? null,
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
