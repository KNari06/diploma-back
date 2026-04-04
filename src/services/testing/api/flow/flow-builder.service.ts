/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOW BUILDER SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Orchestrates the full pipeline:
 *   parse spec → resolve dependencies (AI) → persist to DB → emit WS events
 *
 * Also converts DAG to React Flow nodes/edges for frontend visualization.
 */

import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { SpecParserService } from './spec-parser.service';
import { DependencyResolverService } from './dependency-resolver.service';
import type {
  ApiFlowSpec,
  ApiSpecSourceType,
  DAGNode,
  ExecutionDAG,
  FlowVisualization,
  ParsedApiSpec,
  ParseSpecRequest,
  ReactFlowEdge,
  ReactFlowNode,
} from './flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// REACT FLOW VISUALIZATION
// ─────────────────────────────────────────────────────────────────────────────

// ELK-like layout constants (layered/hierarchical)
const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const H_GAP = 60; // horizontal gap between parallel nodes
const V_GAP = 100; // vertical gap between levels

function buildVisualization(dag: ExecutionDAG): FlowVisualization {
  const nodes: ReactFlowNode[] = [];
  const edges: ReactFlowEdge[] = [];

  // Build level → nodeIds map from parallelGroups
  const levelMap = new Map<number, string[]>();
  dag.parallelGroups.forEach((group, level) => {
    levelMap.set(level, group);
  });

  // Position nodes level by level
  const nodePositions = new Map<string, { x: number; y: number }>();
  let yOffset = 0;

  for (const [level, groupIds] of levelMap) {
    const totalWidth = groupIds.length * NODE_WIDTH + (groupIds.length - 1) * H_GAP;
    let xOffset = -(totalWidth / 2);

    for (const id of groupIds) {
      nodePositions.set(id, { x: xOffset, y: yOffset });
      xOffset += NODE_WIDTH + H_GAP;
    }

    yOffset += NODE_HEIGHT + V_GAP;
  }

  // Create React Flow nodes
  for (const dagNode of dag.nodes) {
    const pos = nodePositions.get(dagNode.id) ?? { x: 0, y: 0 };

    nodes.push({
      id: dagNode.id,
      type: 'apiFlowStep',
      position: pos,
      data: {
        label: `${dagNode.method} ${dagNode.path}`,
        method: dagNode.method,
        path: dagNode.path,
        operationId: dagNode.operationId,
        summary: dagNode.summary,
        status: 'pending',
        isAuthEndpoint: dagNode.isAuthEndpoint,
        isPagination: dagNode.isPagination,
        hasFileUpload: dagNode.hasFileUpload,
        isUnsupported: dagNode.isUnsupported,
        variableExtractions: dagNode.variableExtractions,
        variableInjections: dagNode.variableInjections,
        tags: dagNode.tags,
      },
    });
  }

  // Create React Flow edges from DAG dependencies
  const edgeSet = new Set<string>(); // deduplicate
  for (const dagNode of dag.nodes) {
    for (const depId of dagNode.dependsOn) {
      const edgeId = `${depId}→${dagNode.id}`;
      if (edgeSet.has(edgeId)) continue;
      edgeSet.add(edgeId);

      // Find variable(s) being passed along this edge
      const passedVars = dagNode.variableInjections
        .filter(inj =>
          dag.nodes.find(n => n.id === depId)?.variableExtractions
            .some(ext => ext.variableName === inj.variableName)
        )
        .map(inj => `{{${inj.variableName}}}`)
        .join(', ');

      edges.push({
        id: edgeId,
        source: depId,
        target: dagNode.id,
        label: passedVars || undefined,
        animated: dagNode.isAuthEndpoint || passedVars.length > 0,
        type: 'smoothstep',
        style: passedVars ? { stroke: '#6366f1', strokeWidth: 2 } : undefined,
      });
    }
  }

  return { nodes, edges };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

async function saveFlowSpec(params: {
  userId: string;
  projectId: string;
  environmentId?: string;
  sourceUrl?: string;
  spec: ParsedApiSpec;
  dag: ExecutionDAG;
  errorStrategy?: string;
}): Promise<ApiFlowSpec> {
  const { userId, projectId, environmentId, spec, dag, errorStrategy } = params;

  const { data, error } = await supabaseAdmin
    .from('api_flow_specs')
    .insert({
      user_id: userId,
      project_id: projectId,
      environment_id: environmentId || null,
      name: spec.title,
      source_type: spec.sourceType,
      source_url: (spec as any).sourceUrl || params.sourceUrl || null,
      spec_version: spec.specVersion,
      raw_spec: spec.rawSpec || {},
      execution_dag: dag,
      variable_chain: {},
      total_endpoints: dag.totalEndpoints,
      supported_endpoints: spec.endpoints.length,
      unsupported_endpoints: dag.unsupportedEndpoints,
      error_strategy: errorStrategy || 'stop_on_failure',
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to save flow spec: ${error.message}`);
  }

  return mapDbRowToFlowSpec(data);
}

async function updateFlowSpec(
  id: string,
  updates: Partial<{
    executionDag: ExecutionDAG;
    variableChain: Record<string, any>;
    errorStrategy: string;
    lastRunId: string;
    lastRunStatus: string;
    lastRunAt: string;
  }>
): Promise<void> {
  const dbUpdates: Record<string, any> = {};
  if (updates.executionDag !== undefined) dbUpdates.execution_dag = updates.executionDag;
  if (updates.variableChain !== undefined) dbUpdates.variable_chain = updates.variableChain;
  if (updates.errorStrategy !== undefined) dbUpdates.error_strategy = updates.errorStrategy;
  if (updates.lastRunId !== undefined) dbUpdates.last_run_id = updates.lastRunId;
  if (updates.lastRunStatus !== undefined) dbUpdates.last_run_status = updates.lastRunStatus;
  if (updates.lastRunAt !== undefined) dbUpdates.last_run_at = updates.lastRunAt;

  const { error } = await supabaseAdmin
    .from('api_flow_specs')
    .update(dbUpdates)
    .eq('id', id);

  if (error) {
    logger.error('[FLOW_BUILDER] Failed to update flow spec', { id, error: error.message });
  }
}

function mapDbRowToFlowSpec(row: any): ApiFlowSpec {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    environmentId: row.environment_id || undefined,
    name: row.name,
    sourceType: row.source_type as ApiSpecSourceType,
    sourceUrl: row.source_url || undefined,
    specVersion: row.spec_version || undefined,
    rawSpec: row.raw_spec,
    executionDag: row.execution_dag,
    variableChain: row.variable_chain || {},
    totalEndpoints: row.total_endpoints || 0,
    supportedEndpoints: row.supported_endpoints || 0,
    unsupportedEndpoints: row.unsupported_endpoints || [],
    errorStrategy: row.error_strategy || 'stop_on_failure',
    lastRunId: row.last_run_id || undefined,
    lastRunStatus: row.last_run_status || undefined,
    lastRunAt: row.last_run_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class FlowBuilderService {
  /**
   * Full pipeline: parse spec → AI DAG → persist → return visualization
   */
  static async buildFromSpec(
    request: ParseSpecRequest,
    userId: string,
  ): Promise<{
    flowSpec: ApiFlowSpec;
    visualization: FlowVisualization;
    dag: ExecutionDAG;
    spec: ParsedApiSpec;
  }> {
    const { projectId, environmentId, chatSessionId } = request;

    const emit = (stage: string, progress: number, message: string) => {
      if (!chatSessionId) return;
      webSocketService.emitApiFlowParsing(chatSessionId, {
        flowSpecId: 'pending',
        sessionId: chatSessionId,
        stage: stage as any,
        message,
        progress,
        timestamp: new Date().toISOString(),
      });
    };

    // Step 1: Parse spec
    emit('fetching_spec', 10, 'Fetching and parsing API specification...');
    let spec: ParsedApiSpec;

    try {
      if (request.source === 'url' && request.url) {
        spec = await SpecParserService.parseFromUrl(request.url);
      } else if (request.source === 'file' && request.content) {
        spec = await SpecParserService.parseFromContent(request.content, undefined, request.fileName);
      } else {
        throw new Error('Either url or content must be provided');
      }
    } catch (error: any) {
      throw new Error(`Spec parsing failed: ${error.message}`);
    }

    emit('parsing', 35, `Parsed ${spec.endpoints.length} endpoints from ${spec.title}`);

    logger.info('[FLOW_BUILDER] Spec parsed', {
      title: spec.title,
      endpoints: spec.endpoints.length,
      unsupported: spec.unsupportedEndpoints.length,
      sourceType: spec.sourceType,
    });

    // Step 2: AI dependency resolution
    emit('analyzing_dependencies', 55, `AI is analyzing dependencies for ${spec.endpoints.length} endpoints...`);

    let dag: ExecutionDAG;
    try {
      dag = await DependencyResolverService.resolve(spec);
    } catch (error: any) {
      throw new Error(`Dependency analysis failed: ${error.message}`);
    }

    emit('building_dag', 80, `Built execution DAG with ${dag.nodes.length} nodes`);

    // Step 3: Build visualization
    const visualization = buildVisualization(dag);

    // Step 4: Persist to DB
    emit('building_dag', 90, 'Saving flow spec...');
    const flowSpec = await saveFlowSpec({
      userId,
      projectId,
      environmentId,
      sourceUrl: request.url,
      spec,
      dag,
      errorStrategy: 'stop_on_failure',
    });

    // Step 5: Emit dag-ready event with visualization
    if (chatSessionId) {
      webSocketService.emitApiFlowDagReady(chatSessionId, {
        flowSpecId: flowSpec.id,
        sessionId: chatSessionId,
        nodes: visualization.nodes,
        edges: visualization.edges,
        totalEndpoints: dag.totalEndpoints,
        unsupportedEndpoints: dag.unsupportedEndpoints,
        variableChain: flowSpec.variableChain,
        timestamp: new Date().toISOString(),
      });
    }

    logger.info('[FLOW_BUILDER] Flow built successfully', {
      flowSpecId: flowSpec.id,
      nodes: dag.nodes.length,
      executionOrder: dag.executionOrder.length,
    });

    return { flowSpec, visualization, dag, spec };
  }

  /**
   * Get flow spec by ID
   */
  static async getById(id: string, userId: string): Promise<ApiFlowSpec | null> {
    const { data, error } = await supabaseAdmin
      .from('api_flow_specs')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) return null;
    return mapDbRowToFlowSpec(data);
  }

  /**
   * List flow specs for a project
   */
  static async listByProject(
    projectId: string,
    userId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ specs: ApiFlowSpec[]; total: number }> {
    const { data, error, count } = await supabaseAdmin
      .from('api_flow_specs')
      .select('*', { count: 'exact' })
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[FLOW_BUILDER] Failed to list flow specs', { error: error.message });
      return { specs: [], total: 0 };
    }

    return {
      specs: (data || []).map(mapDbRowToFlowSpec),
      total: count || 0,
    };
  }

  /**
   * Update flow spec (DAG edits, error strategy)
   */
  static async update(
    id: string,
    userId: string,
    updates: {
      executionDag?: ExecutionDAG;
      errorStrategy?: string;
    },
  ): Promise<ApiFlowSpec | null> {
    const existing = await FlowBuilderService.getById(id, userId);
    if (!existing) return null;

    await updateFlowSpec(id, {
      executionDag: updates.executionDag,
      errorStrategy: updates.errorStrategy,
    });

    return FlowBuilderService.getById(id, userId);
  }

  /**
   * Delete flow spec and all associated runs
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    const { error } = await supabaseAdmin
      .from('api_flow_specs')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[FLOW_BUILDER] Failed to delete flow spec', { id, error: error.message });
      return false;
    }
    return true;
  }

  /**
   * Mark a flow spec's last run status (called by executor)
   */
  static async markRunStatus(
    flowSpecId: string,
    runId: string,
    status: string,
  ): Promise<void> {
    await updateFlowSpec(flowSpecId, {
      lastRunId: runId,
      lastRunStatus: status,
      lastRunAt: new Date().toISOString(),
    });
  }

  /**
   * Rebuild visualization from existing DAG (for frontend re-render)
   */
  static buildVisualizationFromDag(dag: ExecutionDAG): FlowVisualization {
    return buildVisualization(dag);
  }

  /**
   * Get runs for a flow spec
   */
  static async getRuns(
    flowSpecId: string,
    userId: string,
    limit = 10,
    offset = 0,
  ): Promise<{ runs: any[]; total: number }> {
    const { data, error, count } = await supabaseAdmin
      .from('api_flow_runs')
      .select('*', { count: 'exact' })
      .eq('flow_spec_id', flowSpecId)
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error('[FLOW_BUILDER] Failed to get flow runs', { error: error.message });
      return { runs: [], total: 0 };
    }

    return { runs: data || [], total: count || 0 };
  }

  /**
   * Get a specific run by ID
   */
  static async getRunById(runId: string, userId: string): Promise<any | null> {
    const { data, error } = await supabaseAdmin
      .from('api_flow_runs')
      .select('*')
      .eq('id', runId)
      .eq('user_id', userId)
      .single();

    if (error || !data) return null;
    return data;
  }
}
