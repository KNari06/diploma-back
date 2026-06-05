/**
 * Resolver query db sublayer
 *
 * Supabase reads for TestQueryResolverService. Per architecture.md, the service
 * goes through this db/ layer rather than importing supabaseAdmin directly —
 * which lets the resolver's scoring/decision logic be unit-tested by stubbing
 * `fetchResolverEntities`, with no DB.
 *
 * Queries + row→type mapping only. No business logic.
 */

import { supabaseAdmin } from '@/db/supabase';
import type { QuerySelectorType } from '../resolver.types';

/** A project-scoped entity row, normalized to the fields scoring needs. */
export interface ResolverEntityRow {
  id: string;
  name: string;
  description?: string;
  url?: string;
  tags?: string[];
}

/**
 * Fetch the candidate entities for a selector type, scoped to one project.
 * The caller is responsible for having already authorized that project.
 */
export async function fetchResolverEntities(
  selectorType: QuerySelectorType,
  projectId: string,
): Promise<ResolverEntityRow[]> {
  switch (selectorType) {
    case 'module': {
      const { data } = await supabaseAdmin
        .from('test_modules')
        .select('id, name')
        .eq('project_id', projectId);
      return (data || []).map((r: any) => ({ id: r.id, name: r.name }));
    }
    case 'flow': {
      // Flows are scoped to the project via their module.
      const { data } = await supabaseAdmin
        .from('test_flows')
        .select('id, name, test_modules!inner(project_id)')
        .eq('test_modules.project_id', projectId);
      return (data || []).map((r: any) => ({ id: r.id, name: r.name }));
    }
    case 'plan': {
      const { data } = await supabaseAdmin
        .from('regression_plans')
        .select('id, name, description, tags')
        .eq('project_id', projectId);
      return (data || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        tags: Array.isArray(r.tags) ? r.tags : [],
      }));
    }
    // test_case, keyword, tag all read published test cases.
    default: {
      const { data } = await supabaseAdmin
        .from('intent_test_cases')
        .select('id, name, description, url, start_url, tags')
        .eq('project_id', projectId)
        .eq('status', 'published');
      return (data || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        url: r.url || r.start_url || '',
        tags: Array.isArray(r.tags) ? r.tags : [],
      }));
    }
  }
}
