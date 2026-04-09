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
import { DependencyResolverService, type ResolveResult } from './dependency-resolver.service';
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
// REACT FLOW VISUALIZATION — layered layout with:
//   Layout-1: stable method-based sort, auth force-to-level-0, row wrapping
//   Layout-2: tag-based X-axis column grouping (secondary sort key)
//   Layout-3: barycenter pass to reduce edge crossings
// All three are pure X-axis rearrangements — they never change executionOrder,
// stepNumber, or dependsOn edges. The vertical level (Y) follows parallelGroups
// with one exception: root auth endpoints are force-lifted to level 0.
// ─────────────────────────────────────────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 80;
const H_GAP = 60;            // horizontal gap between nodes in the same row
const V_GAP = 100;           // vertical gap between different topological levels
const SUB_ROW_V_GAP = 40;    // vertical gap between wrapped sub-rows within one level
const MAX_PER_ROW = 6;       // Layout-1: wrap levels wider than this

/**
 * Method priority for STABLE SORT inside a level.
 * POST first (creates), then reads, then mutations, then DELETE last.
 * This is a VISUAL-ONLY ordering — execution still follows executionOrder.
 */
const METHOD_PRIORITY: Record<string, number> = {
  POST: 0,
  GET: 1,
  HEAD: 2,
  OPTIONS: 3,
  PUT: 4,
  PATCH: 5,
  DELETE: 6,
};

/**
 * Get the "primary tag" used for Layout-2 column grouping.
 * A node's first tag wins (OpenAPI convention — primary tag is index 0).
 * Returns the lowercase tag, or null if the node is untagged. Callers must
 * handle the null case explicitly — we deliberately do NOT use a sentinel
 * string like "~" because JS String.localeCompare is locale-sensitive and
 * does not respect ASCII ordering of punctuation.
 */
function primaryTagOf(node: DAGNode): string | null {
  const t = node.tags?.[0];
  return t && t.length > 0 ? t.toLowerCase() : null;
}

/**
 * Comparator for nodes within the same topological level.
 * Sort key (most → least significant):
 *   1. Layout-1: isAuthEndpoint (true first) — auth always leftmost
 *   2. Layout-2: primary tag (alphabetic; untagged nodes sort last)
 *   3. Layout-1: HTTP method priority (POST→GET→PUT→PATCH→DELETE)
 *   4. Layout-1: GET list before GET item (no path-param before path-param)
 *   5. Layout-1: path alpha — stable final tie-breaker
 * Deterministic: same inputs always give same ordering across runs.
 */
function levelNodeComparator(a: DAGNode, b: DAGNode): number {
  // 1. Auth first
  if (a.isAuthEndpoint !== b.isAuthEndpoint) {
    return a.isAuthEndpoint ? -1 : 1;
  }
  // 2. Layout-2: group by primary tag first, so nodes of the same resource
  // family form a visual column before method-priority kicks in.
  // Untagged nodes always sort AFTER tagged ones (tagged first, untagged last).
  const tagA = primaryTagOf(a);
  const tagB = primaryTagOf(b);
  if (tagA !== tagB) {
    if (tagA === null) return 1;   // a untagged → sort after b
    if (tagB === null) return -1;  // b untagged → a goes first
    // Explicit 'en' locale + sensitivity:'base' makes the comparison
    // deterministic across Node runtimes regardless of LANG/LC_ALL.
    return tagA.localeCompare(tagB, 'en', { sensitivity: 'base' });
  }
  // 3. Then HTTP method priority
  const ma = METHOD_PRIORITY[a.method] ?? 9;
  const mb = METHOD_PRIORITY[b.method] ?? 9;
  if (ma !== mb) return ma - mb;
  // 4. GET list before GET item
  const aHasParam = a.path.includes('{') ? 1 : 0;
  const bHasParam = b.path.includes('{') ? 1 : 0;
  if (aHasParam !== bHasParam) return aHasParam - bHasParam;
  // 5. Alphabetic path — explicit 'en' locale for cross-runtime determinism
  return a.path.localeCompare(b.path, 'en', { sensitivity: 'base' });
}

/**
 * Layout-1 force-auth-to-level-0:
 * A node with isAuthEndpoint=true AND dependsOn=[] is a "root auth" — it
 * renders at visual level 0 even if topological sort placed it deeper. This
 * fixes the "auth stranded sideways" problem in the screenshot where
 * proctoring POSTs were floating to the right of the main flow.
 *
 * Auth nodes with ANY dependsOn (multi-step chains like register→verify→login,
 * or auth nodes that depend on non-auth setup) keep their topological level.
 * The first step of a multi-step chain still has dependsOn=[] so it still
 * gets lifted; the subsequent steps stay below it.
 */
function computeForcedLevels(
  dag: ExecutionDAG,
  originalLevelOf: Map<string, number>,
): Map<string, number> {
  const forced = new Map<string, number>();
  for (const node of dag.nodes) {
    if (!node.isAuthEndpoint) continue;
    // A "root auth" node is one with NO dependencies at all. Multi-step auth
    // chains (register → verify → login) keep their topological order because
    // only the first step has zero dependencies. This matches how proctoring
    // POSTs in the real screenshot were isAuthEndpoint=true with dependsOn=[].
    if (node.dependsOn.length === 0) {
      forced.set(node.id, 0);
    } else {
      forced.set(node.id, originalLevelOf.get(node.id) ?? 0);
    }
  }
  return forced;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout-3: barycenter crossing reduction (Sugiyama framework)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a neighbor index: for each node, list IDs of nodes connected to it by
 * dependsOn edges. Separated into upward (parents) and downward (children)
 * so a barycenter sweep can look at exactly one side.
 */
function buildNeighborIndex(dag: ExecutionDAG): {
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
} {
  const parentSets = new Map<string, Set<string>>();
  const childSets = new Map<string, Set<string>>();
  for (const node of dag.nodes) {
    parentSets.set(node.id, new Set());
    childSets.set(node.id, new Set());
  }
  for (const node of dag.nodes) {
    for (const depId of node.dependsOn) {
      // Use Sets internally so duplicate dependsOn entries (AI sometimes emits
      // them) don't distort the barycenter average.
      parentSets.get(node.id)!.add(depId);
      if (!childSets.has(depId)) childSets.set(depId, new Set());
      childSets.get(depId)!.add(node.id);
    }
  }
  // Materialize back to arrays for the downstream consumers.
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const [k, v] of parentSets) parents.set(k, Array.from(v));
  for (const [k, v] of childSets) children.set(k, Array.from(v));
  return { parents, children };
}

/**
 * Count edge crossings between two adjacent ordered levels.
 * Two edges (u1→v1) and (u2→v2) cross iff
 *   (indexOf(u1) - indexOf(u2)) * (indexOf(v1) - indexOf(v2)) < 0.
 * O(E²) per pair of levels — cheap for real API flow sizes.
 *
 * LIMITATION: only considers edges between the two given levels. Long edges
 * that span >1 level (e.g. L0 → L3 skipping L1, L2) are not counted. A full
 * Sugiyama-style layered layout would insert dummy nodes on each intermediate
 * level to convert long edges into chains of adjacent edges — we deliberately
 * don't do this (+200 LoC) because realistic API-flow DAGs have short edges
 * almost exclusively.
 */
function countCrossingsBetweenLevels(
  upperNodes: DAGNode[],
  lowerNodes: DAGNode[],
  edges: Array<{ source: string; target: string }>,
): number {
  const upperIdx = new Map<string, number>();
  upperNodes.forEach((n, i) => upperIdx.set(n.id, i));
  const lowerIdx = new Map<string, number>();
  lowerNodes.forEach((n, i) => lowerIdx.set(n.id, i));

  // Keep only edges that go from upperNodes → lowerNodes
  const relevant = edges.filter(e => upperIdx.has(e.source) && lowerIdx.has(e.target));

  let crossings = 0;
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const a = relevant[i];
      const b = relevant[j];
      const su = upperIdx.get(a.source)!;
      const sv = upperIdx.get(b.source)!;
      const tu = lowerIdx.get(a.target)!;
      const tv = lowerIdx.get(b.target)!;
      if ((su - sv) * (tu - tv) < 0) crossings++;
    }
  }
  return crossings;
}

/**
 * Compute barycenter for each node on `levelNodes` based on the neighbors on
 * `referenceNodes` (the "other side" of the sweep — parents for downward,
 * children for upward).
 *
 * Returns a Map<nodeId, barycenter>. Nodes with no relevant neighbors get
 * their current index as fallback so they don't jump around.
 */
function computeBarycentersForLevel(
  levelNodes: DAGNode[],
  referenceNodes: DAGNode[],
  neighborsOf: (nodeId: string) => string[],
): Map<string, number> {
  const refIdx = new Map<string, number>();
  referenceNodes.forEach((n, i) => refIdx.set(n.id, i));

  const barycenters = new Map<string, number>();
  levelNodes.forEach((node, i) => {
    const neighborIds = neighborsOf(node.id).filter(id => refIdx.has(id));
    if (neighborIds.length === 0) {
      barycenters.set(node.id, i); // fallback: keep current position
      return;
    }
    const sum = neighborIds.reduce((s, id) => s + refIdx.get(id)!, 0);
    barycenters.set(node.id, sum / neighborIds.length);
  });
  return barycenters;
}

/**
 * Sort one level in place by barycenter. Auth nodes (isAuthEndpoint) are
 * PINNED — they keep their positions from the input regardless of what the
 * barycenter would have done.
 *
 * The sort is performed on non-auth nodes only, then auth nodes are spliced
 * back into their original slots. This guarantees Layout-1's "auth first"
 * invariant survives Layout-3 even in adversarial barycenter cases.
 *
 * Ties between barycenters fall back to the Layout-1+2 comparator so that
 * (1) tag grouping is preserved for nodes with equal pull, and (2) the sort
 * is deterministic.
 */
function sortLevelByBarycenter(
  levelNodes: DAGNode[],
  barycenters: Map<string, number>,
): DAGNode[] {
  // Separate auth pins from movable nodes, remembering their original slots.
  const pinnedSlots: Array<{ idx: number; node: DAGNode }> = [];
  const movable: Array<{ node: DAGNode; origIdx: number }> = [];
  levelNodes.forEach((n, i) => {
    if (n.isAuthEndpoint) {
      pinnedSlots.push({ idx: i, node: n });
    } else {
      movable.push({ node: n, origIdx: i });
    }
  });

  // Sort only the movable nodes by barycenter
  movable.sort((a, b) => {
    const ba = barycenters.get(a.node.id) ?? a.origIdx;
    const bb = barycenters.get(b.node.id) ?? b.origIdx;
    if (ba !== bb) return ba - bb;
    // Tie: use Layout-1+2 comparator (tag → method → path)
    const cmp = levelNodeComparator(a.node, b.node);
    if (cmp !== 0) return cmp;
    // Final deterministic tie-breaker: original index
    return a.origIdx - b.origIdx;
  });

  // Rebuild the level: splice pinned nodes back into their original slots,
  // fill the gaps with the sorted movable nodes.
  const result: DAGNode[] = new Array(levelNodes.length);
  const pinnedIdxSet = new Set(pinnedSlots.map(p => p.idx));
  for (const p of pinnedSlots) result[p.idx] = p.node;
  let movableCursor = 0;
  for (let i = 0; i < levelNodes.length; i++) {
    if (pinnedIdxSet.has(i)) continue;
    result[i] = movable[movableCursor++].node;
  }
  return result;
}

const BARYCENTER_SWEEPS = 4;

function applyBarycenterSweeps(
  dag: ExecutionDAG,
  visualLevelOf: Map<string, number>,
  levelToNodes: Map<number, DAGNode[]>,
): void {
  // Flatten dependsOn into an edge list once.
  const edges: Array<{ source: string; target: string }> = [];
  for (const node of dag.nodes) {
    for (const depId of node.dependsOn) {
      edges.push({ source: depId, target: node.id });
    }
  }

  const { parents, children } = buildNeighborIndex(dag);
  const sortedLevelKeys = Array.from(levelToNodes.keys()).sort((a, b) => a - b);
  if (sortedLevelKeys.length < 2) return; // nothing to reduce

  // Count initial crossings as a sanity metric (we only use it for logging).
  const countTotalCrossings = (): number => {
    let total = 0;
    for (let i = 0; i < sortedLevelKeys.length - 1; i++) {
      const up = levelToNodes.get(sortedLevelKeys[i])!;
      const lo = levelToNodes.get(sortedLevelKeys[i + 1])!;
      total += countCrossingsBetweenLevels(up, lo, edges);
    }
    return total;
  };

  const initialCrossings = countTotalCrossings();

  for (let sweep = 0; sweep < BARYCENTER_SWEEPS; sweep++) {
    const downward = sweep % 2 === 0;
    if (downward) {
      // Top-down: for each level L > 0, re-sort by parent barycenter
      for (let i = 1; i < sortedLevelKeys.length; i++) {
        const ref = levelToNodes.get(sortedLevelKeys[i - 1])!;
        const cur = levelToNodes.get(sortedLevelKeys[i])!;
        const bcs = computeBarycentersForLevel(cur, ref, id => parents.get(id) ?? []);
        levelToNodes.set(sortedLevelKeys[i], sortLevelByBarycenter(cur, bcs));
      }
    } else {
      // Bottom-up: for each level L < max, re-sort by child barycenter
      for (let i = sortedLevelKeys.length - 2; i >= 0; i--) {
        const ref = levelToNodes.get(sortedLevelKeys[i + 1])!;
        const cur = levelToNodes.get(sortedLevelKeys[i])!;
        const bcs = computeBarycentersForLevel(cur, ref, id => children.get(id) ?? []);
        levelToNodes.set(sortedLevelKeys[i], sortLevelByBarycenter(cur, bcs));
      }
    }
  }

  const finalCrossings = countTotalCrossings();
  if (finalCrossings < initialCrossings) {
    logger.info('[FLOW_BUILDER] Layout-3 barycenter reduced crossings', {
      before: initialCrossings,
      after: finalCrossings,
      reduction: initialCrossings - finalCrossings,
    });
  }
  // Suppress unused warning — visualLevelOf is used implicitly via levelToNodes
  void visualLevelOf;
}

export function buildVisualization(dag: ExecutionDAG): FlowVisualization {
  const nodes: ReactFlowNode[] = [];
  const edges: ReactFlowEdge[] = [];

  // Original level-of from parallelGroups — this is what Layout-1 starts with.
  const originalLevelOf = new Map<string, number>();
  dag.parallelGroups.forEach((group, level) => {
    for (const id of group) originalLevelOf.set(id, level);
  });

  // Layout-1: force root-auth nodes to visual level 0.
  const forcedLevels = computeForcedLevels(dag, originalLevelOf);
  const visualLevelOf = new Map<string, number>();
  for (const node of dag.nodes) {
    visualLevelOf.set(node.id, forcedLevels.get(node.id) ?? originalLevelOf.get(node.id) ?? 0);
  }

  // Rebuild level → nodes map using the adjusted visual levels.
  const levelToNodes = new Map<number, DAGNode[]>();
  for (const node of dag.nodes) {
    const lvl = visualLevelOf.get(node.id)!;
    if (!levelToNodes.has(lvl)) levelToNodes.set(lvl, []);
    levelToNodes.get(lvl)!.push(node);
  }

  // Layout-1 + Layout-2: initial stable sort inside each level.
  // This gives each level a "good starting point" before Layout-3 runs.
  for (const [lvl, levelNodes] of levelToNodes) {
    levelNodes.sort(levelNodeComparator);
    levelToNodes.set(lvl, levelNodes);
  }

  // Layout-3: barycenter sweep to reduce edge crossings between adjacent
  // levels. Classic Sugiyama-framework algorithm — for each node on level L,
  // compute the average INDEX of its neighbors on level L-1, then re-sort L
  // by those averages. Repeat alternating sweeps down/up until we converge
  // or hit a small iteration cap.
  //
  // Important invariants:
  //   - Auth endpoints (isAuthEndpoint=true) are PINNED to their current
  //     position — barycenter never moves them. Otherwise the force-to-level-0
  //     logic from Layout-1 would fight with this pass.
  //   - Nodes with no neighbors on the reference level keep their current
  //     position (we use current index as fallback barycenter).
  //   - Ties between barycenters fall back to the Layout-1+2 comparator so
  //     tag grouping is preserved where the barycenter is silent.
  applyBarycenterSweeps(dag, visualLevelOf, levelToNodes);

  // Position nodes level by level, wrapping levels wider than MAX_PER_ROW.
  const nodePositions = new Map<string, { x: number; y: number }>();
  let yOffset = 0;

  const sortedLevels = Array.from(levelToNodes.keys()).sort((a, b) => a - b);
  for (const lvl of sortedLevels) {
    const levelNodes = levelToNodes.get(lvl)!;

    // Layout-1: row-wrap — split into chunks of MAX_PER_ROW, center each row.
    const chunks: DAGNode[][] = [];
    for (let i = 0; i < levelNodes.length; i += MAX_PER_ROW) {
      chunks.push(levelNodes.slice(i, i + MAX_PER_ROW));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const rowWidth = chunk.length * NODE_WIDTH + (chunk.length - 1) * H_GAP;
      let xOffset = -(rowWidth / 2);
      for (const node of chunk) {
        nodePositions.set(node.id, { x: xOffset, y: yOffset });
        xOffset += NODE_WIDTH + H_GAP;
      }
      // After the last chunk we still advance one full V_GAP — otherwise the
      // next topological level visually blends into the current one.
      if (ci < chunks.length - 1) {
        yOffset += NODE_HEIGHT + SUB_ROW_V_GAP;
      }
    }
    yOffset += NODE_HEIGHT + V_GAP;
  }

  // INVARIANT: every node in dag.nodes MUST have a position.
  // If any node wasn't placed (shouldn't happen, but be safe), drop it into an
  // orphan row at the bottom and emit a warning so we can investigate.
  const orphanNodes = dag.nodes.filter(n => !nodePositions.has(n.id));
  if (orphanNodes.length > 0) {
    const orphanChunks: DAGNode[][] = [];
    for (let i = 0; i < orphanNodes.length; i += MAX_PER_ROW) {
      orphanChunks.push(orphanNodes.slice(i, i + MAX_PER_ROW));
    }
    for (let ci = 0; ci < orphanChunks.length; ci++) {
      const chunk = orphanChunks[ci];
      const rowWidth = chunk.length * NODE_WIDTH + (chunk.length - 1) * H_GAP;
      let xOffset = -(rowWidth / 2);
      for (const node of chunk) {
        nodePositions.set(node.id, { x: xOffset, y: yOffset });
        xOffset += NODE_WIDTH + H_GAP;
      }
      if (ci < orphanChunks.length - 1) {
        yOffset += NODE_HEIGHT + SUB_ROW_V_GAP;
      }
    }
    logger.warn('[FLOW_BUILDER] Orphan nodes positioned at bottom row', {
      count: orphanNodes.length,
      ids: orphanNodes.map(n => n.id),
    });
  }

  // Build stepNumber map from executionOrder for display
  const stepNumberMap = new Map<string, number>();
  dag.executionOrder.forEach((id, i) => {
    stepNumberMap.set(id, i + 1);
  });

  // Create React Flow nodes
  for (const dagNode of dag.nodes) {
    const pos = nodePositions.get(dagNode.id)!; // guaranteed to exist now

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
        stepNumber: stepNumberMap.get(dagNode.id) || 0,
        isAuthEndpoint: dagNode.isAuthEndpoint,
        isPagination: dagNode.isPagination,
        hasFileUpload: dagNode.hasFileUpload,
        isUnsupported: dagNode.isUnsupported,
        variableExtractions: dagNode.variableExtractions,
        variableInjections: dagNode.variableInjections,
        tags: dagNode.tags,
        // Include DAG metadata so frontend can reconstruct if needed
        dependsOn: dagNode.dependsOn,
        sampleRequestBody: dagNode.sampleRequestBody,
        sampleQueryParams: dagNode.sampleQueryParams,
        expectedStatusCodes: dagNode.expectedStatusCodes,
        priority: dagNode.priority,
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
    flowSpec?: ApiFlowSpec;
    visualization?: FlowVisualization;
    dag?: ExecutionDAG;
    spec: ParsedApiSpec;
    // If questions are returned, the pipeline paused — user must answer
    questions?: import('./flow.types').FlowQuestion[];
    analysisId?: string;
    confidence?: { overall: number; auth: number; dependencies: number; dataFlow: number };
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
      // Multi-spec Swagger UI — return API group choices to caller
      if (error.message === 'MULTI_SPEC' && error.specGroups) {
        const groups = error.specGroups as Array<{ url: string; name: string }>;
        // Return as needsInput with specGroups — frontend shows selector,
        // user picks one, frontend calls /parse again with the direct spec URL
        const multiSpecError: any = new Error(
          `This Swagger UI has ${groups.length} API groups (${groups.map(g => g.name).join(', ')}). ` +
          `Please select which group to test.`
        );
        multiSpecError.specGroups = groups;
        multiSpecError.isMultiSpec = true;
        throw multiSpecError;
      }
      logger.error('[FLOW_BUILDER] Spec parsing failed', { error: error.message });
      // Provide a meaningful message for connectivity vs parse errors
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ERR_CONNECTION|AggregateError/i.test(error.message)) {
        throw new Error('Could not connect to the API URL. The server may be down, behind a VPN, or unreachable.');
      }
      throw new Error('Spec parsing failed. Please check the format and try again.');
    }

    emit('parsing', 35, `Parsed ${spec.endpoints.length} endpoints from ${spec.title}`);

    logger.info('[FLOW_BUILDER] Spec parsed', {
      title: spec.title,
      endpoints: spec.endpoints.length,
      unsupported: spec.unsupportedEndpoints.length,
      sourceType: spec.sourceType,
    });

    // Guard: reject specs that are too large for reliable AI processing
    if (spec.endpoints.length > 300) {
      throw new Error(
        `This API has ${spec.endpoints.length} endpoints — too many for reliable analysis. ` +
        `Please select a specific API group (e.g., "Admin API" or "Student API") instead of "All API". ` +
        `Most Swagger UIs let you pick a group from the dropdown at the top.`
      );
    }

    // Warn user about expected analysis time for large specs
    if (spec.endpoints.length > 50) {
      const batchCount = Math.ceil(spec.endpoints.length / 20);
      const estimatedMinutes = Math.ceil(batchCount * 0.5); // ~30s per Architect batch
      emit(
        'fetching_spec',
        12,
        `Large spec detected (${spec.endpoints.length} endpoints, ~${estimatedMinutes} min to analyze). This may take a while…`,
      );
    }

    // Step 2: AI dependency resolution
    emit('analyzing_dependencies', 40, `AI is analyzing ${spec.endpoints.length} endpoints...`);

    let resolveResult: ResolveResult;
    try {
      resolveResult = await DependencyResolverService.resolve(spec, {
        analysisId: request.analysisId,
        userAnswers: request.userAnswers,
        onProgress: (stage, message, progress) => emit(stage, progress, message),
      });
    } catch (error: any) {
      logger.error('[FLOW_BUILDER] Dependency analysis failed', { error: error.message });
      throw new Error('Dependency analysis failed. Please try again or use a different spec format.');
    }

    // If analyst has questions, return them to the caller (don't build DAG yet)
    if (resolveResult.questions && resolveResult.questions.length > 0) {
      emit('analyzing_dependencies', 45, 'AI needs some clarification before building the execution plan...');
      return {
        spec,
        questions: resolveResult.questions,
        analysisId: resolveResult.analysisId,
        confidence: resolveResult.confidence,
      };
    }

    const dag = resolveResult.dag!;
    emit('building_dag', 80, `Built execution DAG with ${dag.nodes.length} nodes`);

    // Step 3: Build visualization
    const visualization = buildVisualization(dag);

    // Step 4: Persist to DB
    // Extract user-provided variables from answers (questions with variableName)
    // These will be pre-loaded into variable context at execution time
    const userProvidedVariables: Record<string, string> = {};
    if (request.userAnswers) {
      try {
        // The analysis JSON may contain questions with variableName mappings
        const cachedAnalysis = JSON.parse(resolveResult.dag ? '{}' : '{}'); // analysis is consumed
        // Check the original questions from the cached analysis
        // userAnswers keys are question IDs — we need to map them to variableNames
        // For now, store all answers as potential variables
        // The frontend sends answers with question IDs as keys
        Object.assign(userProvidedVariables, request.userAnswers);
      } catch {
        // Non-critical
      }
    }

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

    // Store user-provided variables in variable_chain (encrypted in future)
    if (Object.keys(userProvidedVariables).length > 0) {
      await updateFlowSpec(flowSpec.id, { variableChain: userProvidedVariables });
      flowSpec.variableChain = userProvidedVariables;
    }

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
