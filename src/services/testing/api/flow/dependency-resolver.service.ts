/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEPENDENCY RESOLVER SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Uses AI (GPT, JSON mode) to analyze a ParsedApiSpec and produce an
 * ExecutionDAG — a directed acyclic graph of API calls with variable
 * extraction/injection mappings.
 *
 * Also runs topological sort validation and cycle detection (Kahn's algorithm).
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import {
  buildSwaggerDependencyPrompt,
  buildSwaggerDependencySystemPrompt,
  buildSwaggerDagMergePrompt,
} from '@/ai/prompts/api-flow-prompts';
import type {
  DAGNode,
  ExecutionDAG,
  HttpMethod,
  ParsedApiSpec,
  ParsedEndpoint,
  UnsupportedEndpoint,
} from './flow.types';

// Max endpoints per AI batch (GPT context limit safety)
const MAX_ENDPOINTS_PER_BATCH = 30;

// ─────────────────────────────────────────────────────────────────────────────
// TOPOLOGICAL SORT (Kahn's algorithm)
// ─────────────────────────────────────────────────────────────────────────────

function topologicalSort(nodes: DAGNode[]): {
  order: string[];
  hasCycle: boolean;
  cycleEdges: Array<{ from: string; to: string }>;
} {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // id → dependents

  for (const node of nodes) {
    inDegree.set(node.id, inDegree.get(node.id) ?? 0);
    adjacency.set(node.id, adjacency.get(node.id) ?? []);
    for (const dep of node.dependsOn) {
      adjacency.set(dep, [...(adjacency.get(dep) ?? []), node.id]);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const dependent of (adjacency.get(current) ?? [])) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  if (order.length < nodes.length) {
    // Cycle detected — find which edges form cycles
    const visited = new Set(order);
    const cycleEdges: Array<{ from: string; to: string }> = [];
    for (const node of nodes) {
      if (!visited.has(node.id)) {
        for (const dep of node.dependsOn) {
          if (!visited.has(dep)) {
            cycleEdges.push({ from: dep, to: node.id });
          }
        }
      }
    }
    return { order, hasCycle: true, cycleEdges };
  }

  return { order, hasCycle: false, cycleEdges: [] };
}

/**
 * Break cycles by removing the cycle edges and logging warnings.
 * After removal, re-sort.
 */
function breakCycles(nodes: DAGNode[], cycleEdges: Array<{ from: string; to: string }>): DAGNode[] {
  logger.warn('[DEPENDENCY_RESOLVER] Cycle detected in DAG, breaking edges', { cycleEdges });

  return nodes.map(node => ({
    ...node,
    dependsOn: node.dependsOn.filter(dep =>
      !cycleEdges.some(e => e.from === dep && e.to === node.id)
    ),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL GROUPS
// ─────────────────────────────────────────────────────────────────────────────

function buildParallelGroups(nodes: DAGNode[], executionOrder: string[]): string[][] {
  // Compute topological level: longest path from any root to this node
  // Nodes at the same level have no dependency on each other → can run in parallel
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const levelCache = new Map<string, number>();

  function getLevel(nodeId: string): number {
    if (levelCache.has(nodeId)) return levelCache.get(nodeId)!;
    const node = nodeMap.get(nodeId);
    if (!node || node.dependsOn.length === 0) {
      levelCache.set(nodeId, 0);
      return 0;
    }
    const maxParent = Math.max(...node.dependsOn.map(dep => getLevel(dep)));
    const level = maxParent + 1;
    levelCache.set(nodeId, level);
    return level;
  }

  const levelMap = new Map<number, string[]>();
  for (const id of executionOrder) {
    const level = getLevel(id);
    if (!levelMap.has(level)) levelMap.set(level, []);
    levelMap.get(level)!.push(id);
  }

  return Array.from(levelMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, ids]) => ids);
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

function normalizeNode(raw: any, index: number): DAGNode {
  const VALID_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  const method = (String(raw.method || 'GET').toUpperCase()) as HttpMethod;

  return {
    id: String(raw.id || `node_${index}`),
    method: VALID_METHODS.includes(method) ? method : 'GET',
    path: String(raw.path || '/'),
    operationId: String(raw.operationId || raw.id || `op_${index}`),
    summary: raw.summary ? String(raw.summary) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    variableExtractions: Array.isArray(raw.variableExtractions)
      ? raw.variableExtractions.map((e: any) => ({
          variableName: String(e.variableName || ''),
          jsonPath: e.jsonPath ? String(e.jsonPath) : undefined,
          headerSource: e.headerSource ? String(e.headerSource) : undefined,
          regex: e.regex ? String(e.regex) : undefined,
        }))
      : [],
    variableInjections: Array.isArray(raw.variableInjections)
      ? raw.variableInjections.map((i: any) => ({
          variableName: String(i.variableName || ''),
          injectAs: i.injectAs || 'header',
          targetKey: String(i.targetKey || ''),
          prefix: i.prefix ? String(i.prefix) : undefined,
        }))
      : [],
    priority: typeof raw.priority === 'number' ? raw.priority : 0,
    isAuthEndpoint: !!raw.isAuthEndpoint,
    isPagination: !!raw.isPagination,
    hasFileUpload: !!raw.hasFileUpload,
    isUnsupported: !!raw.isUnsupported,
    unsupportedReason: raw.unsupportedReason ? String(raw.unsupportedReason) : undefined,
    canRunParallel: !!raw.canRunParallel,
    sampleRequestBody: raw.sampleRequestBody || undefined,
    sampleQueryParams: raw.sampleQueryParams || undefined,
    expectedStatusCodes: Array.isArray(raw.expectedStatusCodes)
      ? raw.expectedStatusCodes.map(Number)
      : [200, 201],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CALL
// ─────────────────────────────────────────────────────────────────────────────

async function callAiForDag(
  spec: ParsedApiSpec,
  endpoints: ParsedEndpoint[],
): Promise<any> {
  const prompt = buildSwaggerDependencyPrompt(spec, endpoints);
  const systemPrompt = buildSwaggerDependencySystemPrompt();

  logger.info('[DEPENDENCY_RESOLVER] Calling AI for DAG', {
    endpointCount: endpoints.length,
    title: spec.title,
  });

  const response = await getChatCompletionWithMessages(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    {
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }
  );

  try {
    return JSON.parse(response.content);
  } catch {
    throw new Error(`AI returned invalid JSON for DAG. Response: ${response.content.slice(0, 300)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────────────────

export class DependencyResolverService {
  /**
   * Build an execution DAG from a parsed API spec.
   * Handles batching for large specs (>30 endpoints).
   */
  static async resolve(spec: ParsedApiSpec): Promise<ExecutionDAG> {
    const endpoints = spec.endpoints;

    logger.info('[DEPENDENCY_RESOLVER] Starting resolution', {
      title: spec.title,
      endpointCount: endpoints.length,
    });

    let rawDag: any;

    if (endpoints.length <= MAX_ENDPOINTS_PER_BATCH) {
      // Single batch
      rawDag = await callAiForDag(spec, endpoints);
    } else {
      // Batch into chunks of MAX_ENDPOINTS_PER_BATCH
      const chunks: ParsedEndpoint[][] = [];
      for (let i = 0; i < endpoints.length; i += MAX_ENDPOINTS_PER_BATCH) {
        chunks.push(endpoints.slice(i, i + MAX_ENDPOINTS_PER_BATCH));
      }

      logger.info('[DEPENDENCY_RESOLVER] Large spec — batching into chunks', {
        chunks: chunks.length,
        endpointCount: endpoints.length,
      });

      const partialDags = await Promise.all(
        chunks.map(chunk => callAiForDag(spec, chunk))
      );

      // Merge via AI
      const mergePrompt = buildSwaggerDagMergePrompt(partialDags, spec);
      const mergeResponse = await getChatCompletionWithMessages(
        [
          { role: 'system', content: buildSwaggerDependencySystemPrompt() },
          { role: 'user', content: mergePrompt },
        ],
        { temperature: 0.1, response_format: { type: 'json_object' } }
      );
      rawDag = JSON.parse(mergeResponse.content);
    }

    // Normalize nodes
    const rawNodes: any[] = Array.isArray(rawDag.nodes) ? rawDag.nodes : [];
    let nodes: DAGNode[] = rawNodes.map((n, i) => normalizeNode(n, i));

    // Validate all dependsOn references exist
    const nodeIds = new Set(nodes.map(n => n.id));
    nodes = nodes.map(node => ({
      ...node,
      dependsOn: node.dependsOn.filter(dep => {
        if (!nodeIds.has(dep)) {
          logger.warn('[DEPENDENCY_RESOLVER] Unknown dependency reference — removed', {
            nodeId: node.id,
            unknownDep: dep,
          });
          return false;
        }
        return true;
      }),
    }));

    // Topological sort + cycle detection
    let sortResult = topologicalSort(nodes);
    if (sortResult.hasCycle) {
      nodes = breakCycles(nodes, sortResult.cycleEdges);
      sortResult = topologicalSort(nodes);
      if (sortResult.hasCycle) {
        logger.error('[DEPENDENCY_RESOLVER] Could not break all cycles — forcing flat order');
        sortResult = { order: nodes.map(n => n.id), hasCycle: false, cycleEdges: [] };
      }
    }

    const executionOrder = sortResult.order;

    const parallelGroups = buildParallelGroups(nodes, executionOrder);

    // Re-assign priority based on parallel group level (not unique position)
    const levelMap = new Map<string, number>();
    parallelGroups.forEach((group, level) => {
      for (const id of group) levelMap.set(id, level);
    });
    nodes = nodes.map(node => ({
      ...node,
      priority: levelMap.get(node.id) ?? node.priority,
    }));

    logger.info('[DEPENDENCY_RESOLVER] DAG resolved', {
      nodes: nodes.length,
      executionOrder: executionOrder.length,
      parallelGroups: parallelGroups.length,
    });

    return {
      nodes,
      executionOrder,
      parallelGroups,
      summary: typeof rawDag.summary === 'string' ? rawDag.summary : `API flow with ${nodes.length} endpoints`,
      totalEndpoints: endpoints.length + spec.unsupportedEndpoints.length,
      unsupportedEndpoints: spec.unsupportedEndpoints as UnsupportedEndpoint[],
    };
  }
}
