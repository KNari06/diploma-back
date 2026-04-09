/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEPENDENCY RESOLVER SERVICE — 3-Agent Pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pipeline:
 *   Agent 1 (ANALYST)   → reads spec, outputs domain analysis + resource map
 *   Agent 2 (ARCHITECT) → uses analysis + spec, builds DAG with dependencies
 *   Agent 3 (ENRICHER)  → takes DAG, generates realistic test data per node
 *
 * Post-processing: topological sort, cycle detection, variable validation,
 * node deduplication, and parallel group computation.
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import {
  buildAnalystSystemPrompt,
  buildAnalystPrompt,
  buildArchitectSystemPrompt,
  buildArchitectPrompt,
  buildEnricherSystemPrompt,
  buildEnricherPrompt,
  buildSwaggerDagMergePrompt,
  buildSwaggerDependencySystemPrompt,
} from '@/ai/prompts/api-flow-prompts';
import type {
  DAGNode,
  ExecutionDAG,
  FlowQuestion,
  HttpMethod,
  ParsedApiSpec,
  ParsedEndpoint,
  UnsupportedEndpoint,
} from './flow.types';

const MAX_ENDPOINTS_PER_BATCH = 20;

/**
 * Extract JSON from AI response that may contain reasoning text around it.
 * Gemini 2.5 Flash with thinking mode often returns text before/after JSON.
 */
function extractJson(content: string): any {
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // no-op
  }

  // Try to find JSON object in the content
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1));
    } catch {
      // no-op
    }
  }

  // Try to find JSON inside markdown code block
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // no-op
    }
  }

  return null;
}
const MAX_ENRICHER_BATCH = 25;
const PIPELINE_TIMEOUT_MS = 600_000; // 10 minutes for very large specs (1000+ endpoints)
const AGENT_RETRY_COUNT = 1; // 1 retry per agent on failure

// ─────────────────────────────────────────────────────────────────────────────
// TOPOLOGICAL SORT (Kahn's algorithm)
// ─────────────────────────────────────────────────────────────────────────────

function topologicalSort(nodes: DAGNode[]): {
  order: string[];
  hasCycle: boolean;
  cycleEdges: Array<{ from: string; to: string }>;
} {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

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

function breakCycles(nodes: DAGNode[], cycleEdges: Array<{ from: string; to: string }>): DAGNode[] {
  logger.warn('[DEPENDENCY_RESOLVER] Cycle detected, breaking edges', { cycleEdges });
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
      ? raw.variableExtractions
          .filter((e: any) => e.variableName && String(e.variableName).trim())
          .map((e: any) => ({
            variableName: String(e.variableName).trim(),
            jsonPath: e.jsonPath ? String(e.jsonPath) : undefined,
            headerSource: e.headerSource ? String(e.headerSource) : undefined,
            regex: e.regex ? String(e.regex) : undefined,
          }))
      : [],
    variableInjections: Array.isArray(raw.variableInjections)
      ? raw.variableInjections
          .filter((i: any) => i.variableName && String(i.variableName).trim() && i.targetKey)
          .map((i: any) => ({
            variableName: String(i.variableName).trim(),
            injectAs: ['header', 'path_param', 'query_param', 'body_field', 'body_json_path'].includes(i.injectAs)
              ? i.injectAs : 'header',
            targetKey: String(i.targetKey),
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
    expectedStatusCodes: Array.isArray(raw.expectedStatusCodes) && raw.expectedStatusCodes.length > 0
      ? raw.expectedStatusCodes.map(Number)
      : [200, 201],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CALL WITH RETRY
// ─────────────────────────────────────────────────────────────────────────────

async function callAiWithRetry(
  messages: Array<{ role: string; content: string }>,
  options: any,
  agentName: string,
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= AGENT_RETRY_COUNT; attempt++) {
    try {
      const response = await getChatCompletionWithMessages(messages as any, options);
      return response.content;
    } catch (err: any) {
      lastError = err;
      logger.warn(`[DEPENDENCY_RESOLVER] ${agentName} attempt ${attempt + 1} failed`, {
        error: err.message,
        willRetry: attempt < AGENT_RETRY_COUNT,
      });
      if (attempt < AGENT_RETRY_COUNT) {
        await new Promise(r => setTimeout(r, 2000)); // 2s backoff
      }
    }
  }

  throw new Error(`${agentName} failed after ${AGENT_RETRY_COUNT + 1} attempts: ${lastError?.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 1: ANALYST
// ─────────────────────────────────────────────────────────────────────────────

async function runAnalyst(spec: ParsedApiSpec): Promise<string> {
  logger.info('[DEPENDENCY_RESOLVER] Agent 1: Analyst starting', {
    title: spec.title,
    endpointCount: spec.endpoints.length,
  });

  const content = await callAiWithRetry(
    [
      { role: 'system', content: buildAnalystSystemPrompt() },
      { role: 'user', content: buildAnalystPrompt(spec) },
    ],
    { temperature: 0.3, response_format: { type: 'json_object' }, max_tokens: 8000, model: AI_TASK_MODELS.apiFlowAnalyst, timeout: 180000 } as any,
    'Analyst',
  );

  // Extract JSON from response (Gemini may include reasoning text around JSON)
  const parsed = extractJson(content);
  if (parsed && (parsed.domain || parsed.entities || parsed.authFlow)) {
    logger.info('[DEPENDENCY_RESOLVER] Agent 1: Analyst completed', {
      hasDomain: !!parsed.domain,
      entityCount: parsed.entities?.length || 0,
    });
    return JSON.stringify(parsed);
  }

  logger.warn('[DEPENDENCY_RESOLVER] Analyst returned invalid/empty JSON, using fallback', {
    contentLength: content.length,
    contentPreview: content.slice(0, 200),
  });
  return JSON.stringify({
    domain: { name: 'Unknown', description: `API: ${spec.title}` },
    entities: [],
    authFlow: { type: spec.authSchemes.length > 0 ? 'unknown' : 'none', steps: [], tokenExtraction: null },
    dataFlows: [],
    publicEndpoints: [],
    executionPhases: [{ phase: 1, name: 'All', endpoints: spec.endpoints.map(e => e.operationId), parallelizable: false }],
    edgeCases: ['Analyst could not parse — architect must analyze endpoints directly'],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2: ARCHITECT
// ─────────────────────────────────────────────────────────────────────────────

async function runArchitect(
  spec: ParsedApiSpec,
  endpoints: ParsedEndpoint[],
  analysisJson: string,
): Promise<any> {
  logger.info('[DEPENDENCY_RESOLVER] Agent 2: Architect starting', {
    endpointCount: endpoints.length,
  });

  const content = await callAiWithRetry(
    [
      { role: 'system', content: buildArchitectSystemPrompt() },
      { role: 'user', content: buildArchitectPrompt(spec, endpoints, analysisJson) },
    ],
    { temperature: 0.2, response_format: { type: 'json_object' }, max_tokens: 65000, model: AI_TASK_MODELS.apiFlowArchitect, timeout: 180000 } as any,
    'Architect',
  );

  // Try extracting JSON (Gemini may include reasoning text)
  const parsed = extractJson(content);
  if (parsed?.nodes && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
    return parsed;
  }

  // If extractJson failed or returned no nodes, try salvaging from raw content
  {
    logger.warn('[DEPENDENCY_RESOLVER] Architect JSON truncated, attempting repair', {
      contentLength: content.length,
    });

    try {
      // Strategy: find each complete node object in the nodes array
      const nodesStart = content.indexOf('"nodes"');
      if (nodesStart === -1) throw new Error('no nodes key');

      const arrayStart = content.indexOf('[', nodesStart);
      if (arrayStart === -1) throw new Error('no array start');

      // Extract individual node objects by finding balanced {} pairs.
      // IMPORTANT: the scanner must be STRING-AWARE — otherwise a literal '{'
      // or '}' inside a JSON string value (e.g. "summary": "uses {userId}")
      // corrupts the depth counter. Unbalanced braces in strings used to
      // swallow subsequent nodes entirely (see json-repair test scenario 4b).
      const recoveredNodes: any[] = [];
      let depth = 0;
      let nodeStart = -1;
      let inString = false;
      let escaped = false;

      for (let i = arrayStart + 1; i < content.length; i++) {
        const ch = content[i];

        // Handle escape sequences inside strings (e.g. \" or \\)
        if (escaped) {
          escaped = false;
          continue;
        }

        if (inString) {
          if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue; // braces inside strings are literal, not structural
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === '{' && depth === 0) {
          nodeStart = i;
          depth = 1;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0 && nodeStart !== -1) {
            // Found a complete node object
            const nodeStr = content.slice(nodeStart, i + 1);
            try {
              const node = JSON.parse(nodeStr);
              if (node.id && node.method && node.path) {
                recoveredNodes.push(node);
              }
            } catch {
              // Malformed node, skip
            }
            nodeStart = -1;
          }
        }
      }

      if (recoveredNodes.length > 0) {
        logger.info('[DEPENDENCY_RESOLVER] Architect JSON repaired', {
          nodesRecovered: recoveredNodes.length,
          totalContentLength: content.length,
        });
        return {
          nodes: recoveredNodes,
          executionOrder: recoveredNodes.map(n => n.id),
          summary: `Partially recovered ${recoveredNodes.length} nodes from truncated response`,
        };
      }
    } catch (repairErr: any) {
      logger.warn('[DEPENDENCY_RESOLVER] JSON repair failed', { error: repairErr.message });
    }

    throw new Error(`Architect returned invalid JSON (${content.length} chars, likely truncated). Try a smaller API spec or select a specific API group.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 3: ENRICHER (with batching for large specs)
// ─────────────────────────────────────────────────────────────────────────────

async function runEnricher(
  nodes: DAGNode[],
  spec: ParsedApiSpec,
  analysisJson: string,
): Promise<DAGNode[]> {
  const needsData = nodes.filter(n =>
    ['POST', 'PUT', 'PATCH'].includes(n.method) && !n.sampleRequestBody
  );

  if (needsData.length === 0) return nodes;

  logger.info('[DEPENDENCY_RESOLVER] Agent 3: Enricher starting', {
    nodesToEnrich: needsData.length,
  });

  // Batch enricher calls if too many nodes
  const batches: DAGNode[][] = [];
  for (let i = 0; i < needsData.length; i += MAX_ENRICHER_BATCH) {
    batches.push(needsData.slice(i, i + MAX_ENRICHER_BATCH));
  }

  const allSamples: Record<string, any> = {};

  for (const batch of batches) {
    // Build a subset of nodes for this batch prompt
    const batchNodes = nodes.map(n =>
      batch.some(b => b.id === n.id) ? n : { ...n, sampleRequestBody: '__SKIP__' as any }
    );
    const prompt = buildEnricherPrompt(batchNodes.filter(n => n.sampleRequestBody !== '__SKIP__'), spec, analysisJson);
    if (!prompt) continue;

    try {
      const content = await callAiWithRetry(
        [
          { role: 'system', content: buildEnricherSystemPrompt() },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.4, response_format: { type: 'json_object' }, max_tokens: 8000, model: AI_TASK_MODELS.apiFlowEnricher, timeout: 90000 } as any,
        'Enricher',
      );

      const result = JSON.parse(content);
      Object.assign(allSamples, result.samples || {});
    } catch (err: any) {
      logger.warn('[DEPENDENCY_RESOLVER] Enricher batch failed, skipping', {
        batchSize: batch.length,
        error: err.message,
      });
    }
  }

  logger.info('[DEPENDENCY_RESOLVER] Agent 3: Enricher completed', {
    samplesGenerated: Object.keys(allSamples).length,
    expected: needsData.length,
  });

  return nodes.map(n => {
    if (allSamples[n.id]) {
      return { ...n, sampleRequestBody: allSamples[n.id] };
    }
    return n;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-PROCESSING: Deduplication + Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove phantom nodes — nodes fabricated by AI that don't exist in the original spec.
 * The AI sometimes creates helper nodes like "initial_setup", "auth_token_provider"
 * that have no corresponding endpoint in the parsed spec.
 */
function removePhantomNodes(nodes: DAGNode[], spec: ParsedApiSpec): DAGNode[] {
  // Build a set of valid method:path combinations from the spec
  const validPaths = new Set<string>();
  for (const ep of spec.endpoints) {
    validPaths.add(`${ep.method}:${ep.path}`);
    // Also add with/without trailing slash for tolerance
    const normalized = ep.path.endsWith('/') ? ep.path.slice(0, -1) : ep.path + '/';
    validPaths.add(`${ep.method}:${normalized}`);
  }

  const phantoms: string[] = [];
  const valid: DAGNode[] = [];

  for (const node of nodes) {
    const key = `${node.method}:${node.path}`;
    if (validPaths.has(key)) {
      valid.push(node);
    } else {
      phantoms.push(`${node.id} (${node.method} ${node.path})`);
    }
  }

  if (phantoms.length > 0) {
    logger.warn('[DEPENDENCY_RESOLVER] Phantom nodes removed (not in spec)', {
      count: phantoms.length,
      phantoms,
    });

    // Clean up dependsOn references to removed phantom nodes
    const phantomIds = new Set(nodes.filter(n => !validPaths.has(`${n.method}:${n.path}`)).map(n => n.id));
    return valid.map(node => ({
      ...node,
      dependsOn: node.dependsOn.filter(dep => !phantomIds.has(dep)),
      variableInjections: node.variableInjections.filter(inj => {
        // Remove injections that only come from phantom producers
        const producers = valid.filter(v =>
          v.variableExtractions.some(ext => ext.variableName === inj.variableName)
        );
        return producers.length > 0;
      }),
    }));
  }

  return valid;
}

function deduplicateNodes(nodes: DAGNode[]): DAGNode[] {
  const seen = new Map<string, DAGNode>();
  const duplicates: string[] = [];

  for (const node of nodes) {
    if (seen.has(node.id)) {
      duplicates.push(node.id);
    } else {
      seen.set(node.id, node);
    }
  }

  if (duplicates.length > 0) {
    logger.warn('[DEPENDENCY_RESOLVER] Duplicate node IDs removed', { duplicates });
  }

  return Array.from(seen.values());
}

/**
 * Auto-wire auth dependencies: ensure every node that injects an auth variable
 * has a dependsOn edge to the node that extracts it.
 * Also ensures auth nodes (isAuthEndpoint) have no spurious dependencies.
 * This fixes the cross-batch dependency loss when merger is skipped.
 */
function autoWireAuthDependencies(nodes: DAGNode[]): DAGNode[] {
  // Build producer map: variableName → producerNodeId
  const producerMap = new Map<string, string>();
  for (const node of nodes) {
    for (const ext of node.variableExtractions) {
      producerMap.set(ext.variableName, node.id);
    }
  }

  // Common auth variable patterns
  const AUTH_VAR_PATTERNS = /^(auth_token|access_token|jwt|bearer_token|api_key|session_token|token|authorization)$/i;

  // Find auth producer nodes (nodes that extract auth variables)
  const authProducerIds = new Set<string>();
  for (const [varName, producerId] of producerMap) {
    if (AUTH_VAR_PATTERNS.test(varName)) {
      authProducerIds.add(producerId);
    }
  }

  // Also include nodes explicitly marked as auth endpoints
  for (const node of nodes) {
    if (node.isAuthEndpoint && node.variableExtractions.length > 0) {
      authProducerIds.add(node.id);
    }
  }

  if (authProducerIds.size === 0) return nodes;

  let wiredCount = 0;
  const result = nodes.map(node => {
    if (authProducerIds.has(node.id)) return node; // Don't wire auth to itself

    // Check if this node injects any variable produced by an auth node
    const missingDeps = new Set<string>();
    for (const inj of node.variableInjections) {
      const producerId = producerMap.get(inj.variableName);
      if (producerId && authProducerIds.has(producerId) && !node.dependsOn.includes(producerId)) {
        missingDeps.add(producerId);
      }
    }

    if (missingDeps.size > 0) {
      wiredCount++;
      return {
        ...node,
        dependsOn: [...node.dependsOn, ...missingDeps],
      };
    }

    return node;
  });

  if (wiredCount > 0) {
    logger.info('[DEPENDENCY_RESOLVER] Auto-wired auth dependencies', {
      authProducers: Array.from(authProducerIds),
      nodesWired: wiredCount,
    });
  }

  return result;
}

/**
 * CRUD + nested-resource dependency wiring.
 *
 * Solves these problems:
 *
 * 1. SAME-RESOURCE CRUD ORDER:
 *    POST /students → GET/PUT/PATCH /students/{id} → DELETE /students/{id}
 *
 * 2. NESTED RESOURCE PARENT DEPENDENCY:
 *    POST /students/{studentId}/grades needs studentId
 *    → auto-wire to POST /students (which creates studentId)
 *
 * 3. PATH-PARAM PRODUCER DETECTION:
 *    Any node with path param {fooId} must depend on the node that
 *    creates that entity — even if AI didn't set variableInjections.
 *
 * 4. NESTED DELETE ORDER (Rule 5):
 *    DELETE /students/{id} must run AFTER DELETE /students/{id}/grades/{gid}.
 *
 * 5. BODY-FIELD PRODUCER DETECTION (Rule 6):
 *    POST /orders has `cartId` in its request body schema — depend on POST /carts.
 *    This is critical in BATCHING: when the spec is split into chunks, AI can
 *    only see its own chunk and cannot wire cross-chunk body references.
 *    Rule 6 reads the spec's schema to recover those edges deterministically.
 *
 * Works by analyzing URL structure and request body schemas, not AI output —
 * so it's reliable even when Architect batches miss cross-resource dependencies.
 */
function autoWireCrudDependencies(nodes: DAGNode[], spec: ParsedApiSpec): DAGNode[] {
  /**
   * Parse a path into segments, identifying resource names and param slots.
   * /api/v1/students/{studentId}/grades/{gradeId}
   * → [ { resource: "students", param: "studentId" },
   *     { resource: "grades",   param: "gradeId" } ]
   */
  function parsePathSegments(path: string): Array<{ resource: string; param?: string }> {
    // Remove common API prefixes
    const cleaned = path.replace(/^\/(api\/)?v\d+\/?/, '/');
    const parts = cleaned.split('/').filter(Boolean);
    const segments: Array<{ resource: string; param?: string }> = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('{')) continue; // skip param-only segments

      const nextPart = parts[i + 1];
      const paramName = nextPart?.startsWith('{') ? nextPart.slice(1, -1) : undefined;
      segments.push({ resource: part, param: paramName });
      if (paramName) i++; // skip the param part
    }
    return segments;
  }

  /**
   * Get the "collection path" — the path for creating this resource.
   * /students/{studentId}/grades/{gradeId} → /students/{studentId}/grades
   * /students/{studentId} → /students
   */
  function getCollectionPath(path: string): string {
    // Remove trailing path param: /foo/bar/{id} → /foo/bar
    return path.replace(/\/\{[^}]+\}$/, '');
  }

  /**
   * Get parent resource collection path.
   * /students/{studentId}/grades → /students (parent creates studentId)
   * /students/{studentId}/grades/{gradeId}/comments → /students/{studentId}/grades (parent creates gradeId)
   */
  function getParentCollectionPath(path: string): string | null {
    const collection = getCollectionPath(path);
    // Find the last resource segment and go up one level
    const match = collection.match(/^(.+\/\{[^}]+\})\/[^/]+$/);
    if (match) {
      // e.g., /students/{studentId}/grades → parent collection is /students
      return getCollectionPath(match[1]);
    }
    return null;
  }

  // Index: collection path → POST node(s) that create resources in this collection
  const postByCollection = new Map<string, DAGNode[]>();
  for (const node of nodes) {
    if (node.method === 'POST') {
      // POST /students → collection "/students" creates student resources
      // POST /students/{id}/grades → collection "/students/{id}/grades" creates grade resources
      const normalizedPath = node.path.replace(/\/$/, ''); // strip trailing slash
      if (!postByCollection.has(normalizedPath)) postByCollection.set(normalizedPath, []);
      postByCollection.get(normalizedPath)!.push(node);
    }
  }

  // Also index without API version prefix for fuzzy matching
  const postByCollectionFuzzy = new Map<string, DAGNode[]>();
  for (const [path, postNodes] of postByCollection) {
    const fuzzy = path.replace(/^\/(api\/)?v\d+\/?/, '/');
    if (!postByCollectionFuzzy.has(fuzzy)) postByCollectionFuzzy.set(fuzzy, []);
    postByCollectionFuzzy.get(fuzzy)!.push(...postNodes);
  }

  let wiredCount = 0;
  const depsToAdd = new Map<string, Set<string>>();

  function addDep(nodeId: string, depId: string) {
    if (nodeId === depId) return;
    if (!depsToAdd.has(nodeId)) depsToAdd.set(nodeId, new Set());
    depsToAdd.get(nodeId)!.add(depId);
    wiredCount++;
  }

  // Group nodes by collection path for same-resource CRUD ordering
  const byCollection = new Map<string, DAGNode[]>();
  for (const node of nodes) {
    const col = getCollectionPath(node.path.replace(/\/$/, ''));
    if (!byCollection.has(col)) byCollection.set(col, []);
    byCollection.get(col)!.push(node);
  }

  for (const [collection, collectionNodes] of byCollection) {
    const posts = collectionNodes.filter(n => n.method === 'POST');
    const gets = collectionNodes.filter(n => n.method === 'GET' && n.path.includes('{'));
    const puts = collectionNodes.filter(n => n.method === 'PUT');
    const patches = collectionNodes.filter(n => n.method === 'PATCH');
    const deletes = collectionNodes.filter(n => n.method === 'DELETE');

    // Rule 1: POST → GET/{id}, PUT/{id}, PATCH/{id}, DELETE/{id}
    for (const post of posts) {
      for (const node of [...gets, ...puts, ...patches, ...deletes]) {
        if (!node.dependsOn.includes(post.id)) {
          addDep(node.id, post.id);
        }
      }
    }

    // Rule 2: DELETE runs after PUT/PATCH (test update before you delete)
    for (const del of deletes) {
      for (const mut of [...puts, ...patches]) {
        if (!del.dependsOn.includes(mut.id)) {
          addDep(del.id, mut.id);
        }
      }
    }
  }

  // Rule 3: Nested resources depend on parent POST
  // e.g., anything under /students/{studentId}/grades/* needs POST /students
  for (const node of nodes) {
    const parentCol = getParentCollectionPath(node.path.replace(/\/$/, ''));
    if (!parentCol) continue;

    // Find POST nodes for the parent collection
    const parentPosts = postByCollection.get(parentCol) || [];
    for (const parentPost of parentPosts) {
      if (!node.dependsOn.includes(parentPost.id) && node.id !== parentPost.id) {
        addDep(node.id, parentPost.id);
      }
    }
  }

  // Rule 5: Parent DELETE must run AFTER nested DELETE.
  //
  // Without this, deleteStudent runs before deleteGrade — and when deleteGrade
  // finally fires, the parent student no longer exists (404 or cascade-deleted).
  // Matches Morest's (ICSE'22) CRUD filter rule: "delete must not precede
  // another operation on the same resource tree".
  //
  // "nested" = strict path-segment descendant, computed via parsePathSegments
  // so we don't false-match on string prefixes like /student vs /students.
  {
    const deleteNodes = nodes.filter(n => n.method === 'DELETE');
    // Pre-compute segments once per DELETE node.
    const segmentCache = new Map<string, Array<{ resource: string; param?: string }>>();
    for (const del of deleteNodes) {
      segmentCache.set(del.id, parsePathSegments(del.path.replace(/\/$/, '')));
    }

    const isStrictDescendant = (
      parentSegs: Array<{ resource: string; param?: string }>,
      childSegs: Array<{ resource: string; param?: string }>,
    ): boolean => {
      if (childSegs.length <= parentSegs.length) return false;
      for (let i = 0; i < parentSegs.length; i++) {
        if (parentSegs[i].resource !== childSegs[i].resource) return false;
      }
      return true;
    };

    for (const parentDel of deleteNodes) {
      const parentSegs = segmentCache.get(parentDel.id)!;
      // Only DELETE on an identified resource (last segment has a param, e.g.
      // /students/{studentId}) can be a "parent" in a nesting sense. DELETE on
      // a bare collection like /students (bulk delete) shouldn't gate nested
      // deletes — it's a different semantic.
      const lastSeg = parentSegs[parentSegs.length - 1];
      if (!lastSeg || !lastSeg.param) continue;

      for (const nestedDel of deleteNodes) {
        if (nestedDel.id === parentDel.id) continue;
        const nestedSegs = segmentCache.get(nestedDel.id)!;
        if (!isStrictDescendant(parentSegs, nestedSegs)) continue;
        // CYCLE GUARD: if the nested DELETE already depends on the parent
        // DELETE (AI set it explicitly, or another rule wired it), adding
        // parent → nested would create a 2-cycle. Skip this edge — the
        // nested-before-parent ordering is still recovered by breakCycles
        // later, but without producing an unstable cycle here.
        if (nestedDel.dependsOn.includes(parentDel.id)) continue;
        // Parent DELETE now depends on nested DELETE (nested runs first).
        if (!parentDel.dependsOn.includes(nestedDel.id)) {
          addDep(parentDel.id, nestedDel.id);
        }
      }
    }
  }

  // Rule 4: Path-param matching — if a node has {fooId} in path, find who creates "foo"
  // e.g., GET /grades/{gradeId}/report → needs whoever creates grades (POST /…/grades)
  for (const node of nodes) {
    const pathParams = node.path.match(/\{([^}]+)\}/g);
    if (!pathParams) continue;

    for (const rawParam of pathParams) {
      const paramName = rawParam.slice(1, -1); // strip { }
      // Derive resource name from param: studentId → student, grade_id → grade
      const resourceGuess = paramName
        .replace(/Id$/, '').replace(/_id$/, '')
        .replace(/ID$/, '').toLowerCase();

      if (!resourceGuess) continue;

      // Find POST nodes whose path ends with /resourceGuess (pluralized or not)
      for (const [col, postNodes] of postByCollection) {
        const colResource = col.split('/').filter(Boolean).pop()?.toLowerCase() || '';
        // Match: "student" → "students", "grade" → "grades" (simple plural)
        if (colResource === resourceGuess ||
            colResource === resourceGuess + 's' ||
            colResource === resourceGuess + 'es' ||
            resourceGuess === colResource + 's' ||
            resourceGuess === colResource + 'es') {
          for (const postNode of postNodes) {
            if (node.id !== postNode.id && !node.dependsOn.includes(postNode.id)) {
              addDep(node.id, postNode.id);
            }
          }
        }
      }
    }
  }

  // Rule 6: Body-field producer matching — scan POST/PUT/PATCH request body
  // schemas for *Id / *_id fields, and depend on whoever creates that resource.
  //
  // WHY THIS EXISTS: When the spec is split into batches (>20 endpoints), each
  // Architect call sees ONLY its own chunk. Cross-batch body references are
  // structurally invisible to the AI. Example: batch 2 has POST /orders with
  // body { cartId }, batch 1 has POST /carts → AI in batch 2 cannot set
  // dependsOn: ['createCart'] because createCart isn't in its input. Rule 4
  // only inspects URL path params, so it misses body-field refs entirely.
  //
  // Rule 6 reads the original spec (not normalized DAG node) to find request
  // body schemas, walks their properties looking for ID-like fields, and wires
  // the same producer-matching logic as Rule 4.
  {
    // Build lookup from "METHOD:/path" → spec endpoint (has requestBody.schema)
    const endpointByKey = new Map<string, ParsedEndpoint>();
    for (const ep of spec.endpoints) {
      endpointByKey.set(`${ep.method}:${ep.path}`, ep);
    }

    /**
     * Extract ID-like field names from a request body schema.
     * Handles:
     *   - Flat objects:       { cartId, userId }
     *   - Nested objects:     { cart: { cartId } }
     *   - Arrays of items:    { items: [{ productId }] }
     *   - Arrays of arrays:   { batches: [{ items: [{ productId }] }] }
     *   - oneOf/anyOf:        take the first variant
     *
     * We recurse up to MAX_SCHEMA_DEPTH=5 to cover realistic nesting without
     * runaway recursion on self-referential schemas. Every recursive call
     * increments depth so the cap is enforced uniformly across object/array
     * paths. Depth 5 lets us find e.g. { data: { order: { items: [{ product:
     * { productId } } } } } — common in wrapped-response API designs.
     */
    const MAX_SCHEMA_DEPTH = 5;
    function extractIdFields(schema: any, depth = 0): string[] {
      if (!schema || typeof schema !== 'object' || depth > MAX_SCHEMA_DEPTH) return [];
      const out: string[] = [];

      // oneOf / anyOf — pick first variant, same as Enricher's rule
      const variants = schema.oneOf || schema.anyOf;
      if (Array.isArray(variants) && variants.length > 0) {
        return extractIdFields(variants[0], depth + 1);
      }

      // Object with properties — check field names + recurse into nested
      if (schema.type === 'object' || schema.properties) {
        const props = schema.properties || {};
        for (const [name, def] of Object.entries(props)) {
          if (/(Id|_id|ID)$/.test(name)) {
            out.push(name);
          }
          if (def && typeof def === 'object') {
            out.push(...extractIdFields(def, depth + 1));
          }
        }
      }

      // Array — check items (array-of-objects is common for bulk endpoints)
      if (schema.type === 'array' && schema.items) {
        out.push(...extractIdFields(schema.items, depth + 1));
      }

      return out;
    }

    for (const node of nodes) {
      if (!['POST', 'PUT', 'PATCH'].includes(node.method)) continue;
      const ep = endpointByKey.get(`${node.method}:${node.path}`);
      if (!ep?.requestBody?.schema) continue;

      const idFields = extractIdFields(ep.requestBody.schema);
      if (idFields.length === 0) continue;

      for (const fieldName of idFields) {
        // Same resource-name derivation as Rule 4
        const resourceGuess = fieldName
          .replace(/Id$/, '').replace(/_id$/, '')
          .replace(/ID$/, '').toLowerCase();
        if (!resourceGuess) continue;

        // Same plural matching as Rule 4
        for (const [col, postNodes] of postByCollection) {
          const colResource = col.split('/').filter(Boolean).pop()?.toLowerCase() || '';
          if (colResource === resourceGuess ||
              colResource === resourceGuess + 's' ||
              colResource === resourceGuess + 'es' ||
              resourceGuess === colResource + 's' ||
              resourceGuess === colResource + 'es') {
            for (const postNode of postNodes) {
              if (node.id === postNode.id) continue;
              if (node.dependsOn.includes(postNode.id)) continue;
              // CYCLE GUARD: mutual body references (A's body has bId while
              // B's body has aId) would create A→B→A. Skip when the producer
              // already depends on this node.
              if (postNode.dependsOn.includes(node.id)) continue;
              addDep(node.id, postNode.id);
            }
          }
        }
      }
    }
  }

  if (wiredCount === 0) return nodes;

  const result = nodes.map(node => {
    const extra = depsToAdd.get(node.id);
    if (!extra || extra.size === 0) return node;
    return {
      ...node,
      dependsOn: [...new Set([...node.dependsOn, ...extra])],
    };
  });

  logger.info('[DEPENDENCY_RESOLVER] Auto-wired CRUD dependencies', {
    collections: byCollection.size,
    edgesAdded: wiredCount,
  });

  return result;
}

function validateVariableChain(nodes: DAGNode[], executionOrder: string[]): void {
  // Build map: which variables are extracted and by which nodes
  const producerMap = new Map<string, string>(); // variableName → producerNodeId
  for (const id of executionOrder) {
    const node = nodes.find(n => n.id === id);
    if (!node) continue;
    for (const ext of node.variableExtractions) {
      if (producerMap.has(ext.variableName)) {
        logger.warn('[DEPENDENCY_RESOLVER] Variable name collision', {
          variable: ext.variableName,
          firstProducer: producerMap.get(ext.variableName),
          secondProducer: node.id,
        });
      }
      producerMap.set(ext.variableName, node.id);
    }
  }

  // Check every injection has a matching extraction
  for (const node of nodes) {
    for (const inj of node.variableInjections) {
      if (!producerMap.has(inj.variableName)) {
        logger.warn('[DEPENDENCY_RESOLVER] Broken injection — no producer', {
          nodeId: node.id,
          variable: inj.variableName,
          injectAs: inj.injectAs,
          targetKey: inj.targetKey,
        });
      } else {
        // Verify producer is in dependsOn chain (direct or transitive)
        const producerId = producerMap.get(inj.variableName)!;
        const producerIdx = executionOrder.indexOf(producerId);
        const consumerIdx = executionOrder.indexOf(node.id);
        if (producerIdx >= consumerIdx) {
          logger.warn('[DEPENDENCY_RESOLVER] Producer runs AFTER consumer', {
            variable: inj.variableName,
            producer: producerId,
            consumer: node.id,
          });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────────────────

// In-memory cache for analysis results (so user can answer questions and resume)
const analysisCache = new Map<string, { analysis: string; spec: ParsedApiSpec; expiresAt: number }>();

export interface ResolveResult {
  dag?: ExecutionDAG;
  // If questions are present, the pipeline paused and needs user input
  questions?: FlowQuestion[];
  analysisId?: string; // cache key for resuming
  confidence?: { overall: number; auth: number; dependencies: number; dataFlow: number };
}

export class DependencyResolverService {
  /**
   * 3-agent pipeline: Analyst → Architect → Enricher
   * Returns questions if analyst is uncertain — caller must resume with answers.
   */
  static async resolve(
    spec: ParsedApiSpec,
    options?: {
      analysisId?: string;
      userAnswers?: Record<string, string>;
      onProgress?: (stage: string, message: string, progress: number) => void;
    },
  ): Promise<ResolveResult> {
    const endpoints = spec.endpoints;

    logger.info('[DEPENDENCY_RESOLVER] Starting pipeline', {
      title: spec.title,
      endpointCount: endpoints.length,
      hasExistingAnalysis: !!options?.analysisId,
      hasUserAnswers: !!options?.userAnswers,
    });

    const deadline = Date.now() + PIPELINE_TIMEOUT_MS;
    const emit = options?.onProgress || (() => {});
    const checkTimeout = () => {
      if (Date.now() > deadline) {
        throw new Error(`Pipeline timed out after ${PIPELINE_TIMEOUT_MS / 1000}s`);
      }
    };

    // ── Agent 1: Analyst ────────────────────────────────────────────────
    let analysisJson: string;

    if (options?.analysisId) {
      // Resume from cached analysis — user answered questions
      const cached = analysisCache.get(options.analysisId);
      if (!cached || cached.expiresAt < Date.now()) {
        throw new Error('Analysis expired. Please start over.');
      }

      // Merge user answers into the analysis
      const analysis = JSON.parse(cached.analysis);
      if (options.userAnswers) {
        analysis._userAnswers = options.userAnswers;
        // Clear questions since user answered them
        analysis.questions = [];
      }
      analysisJson = JSON.stringify(analysis);
      analysisCache.delete(options.analysisId);

      logger.info('[DEPENDENCY_RESOLVER] Resumed from cached analysis with user answers', {
        answerCount: Object.keys(options.userAnswers || {}).length,
      });
    } else {
      // Fresh analysis
      emit('analyzing', `AI is understanding the API domain (${spec.endpoints.length} endpoints)...`, 40);
      analysisJson = await runAnalyst(spec);
      checkTimeout();

      // Check if analyst has questions for the user
      try {
        const analysis = JSON.parse(analysisJson);
        const questions: FlowQuestion[] = (analysis.questions || []).filter(
          (q: any) => q.id && q.question && q.type,
        );
        const confidence = analysis.confidence || { overall: 1, auth: 1, dependencies: 1, dataFlow: 1 };

        if (questions.length > 0) {
          // Cache the analysis and return questions to caller
          const analysisId = `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          analysisCache.set(analysisId, {
            analysis: analysisJson,
            spec,
            expiresAt: Date.now() + 10 * 60 * 1000, // 10 minute TTL
          });

          // Clean old cache entries
          for (const [key, val] of analysisCache) {
            if (val.expiresAt < Date.now()) analysisCache.delete(key);
          }

          logger.info('[DEPENDENCY_RESOLVER] Analyst has questions for user', {
            questionCount: questions.length,
            confidence,
            analysisId,
          });

          return { questions, analysisId, confidence };
        }
      } catch {
        // Analysis wasn't valid JSON — continue without questions
      }
    }

    // ── Agent 2: Architect ──────────────────────────────────────────────
    let rawDag: any;

    if (endpoints.length <= MAX_ENDPOINTS_PER_BATCH) {
      emit('building_dag', `AI is building execution plan for ${endpoints.length} endpoints...`, 55);
      rawDag = await runArchitect(spec, endpoints, analysisJson);
    } else {
      const chunks: ParsedEndpoint[][] = [];
      for (let i = 0; i < endpoints.length; i += MAX_ENDPOINTS_PER_BATCH) {
        chunks.push(endpoints.slice(i, i + MAX_ENDPOINTS_PER_BATCH));
      }

      emit('building_dag', `Building execution plan in ${chunks.length} batches (${endpoints.length} endpoints)...`, 55);
      logger.info('[DEPENDENCY_RESOLVER] Batching', { chunks: chunks.length });

      const partialDags = await Promise.all(
        chunks.map(async (chunk, idx) => {
          const result = await runArchitect(spec, chunk, analysisJson);
          const nodeCount = Array.isArray(result?.nodes) ? result.nodes.length : 0;
          logger.info('[DEPENDENCY_RESOLVER] Architect batch completed', {
            batch: idx + 1,
            totalBatches: chunks.length,
            inputEndpoints: chunk.length,
            outputNodes: nodeCount,
          });
          return result;
        })
      );
      checkTimeout();

      // Collect all nodes from partial DAGs
      const allPartialNodes = partialDags.flatMap(d => Array.isArray(d.nodes) ? d.nodes : []);
      logger.info('[DEPENDENCY_RESOLVER] Partial DAGs collected', {
        partialDagCount: partialDags.length,
        totalPartialNodes: allPartialNodes.length,
      });

      if (allPartialNodes.length === 0) {
        throw new Error('All Architect batches returned 0 nodes. The API spec may be too complex or malformed.');
      }

      // For large specs (many batches), skip AI merge — just concatenate
      // AI merge is unreliable for 100+ nodes and wastes time/tokens
      if (chunks.length > 4) {
        logger.info('[DEPENDENCY_RESOLVER] Skipping AI merge for large spec, concatenating directly', {
          chunks: chunks.length,
          totalNodes: allPartialNodes.length,
        });
        emit('building_dag', `Combining ${allPartialNodes.length} nodes from ${chunks.length} batches...`, 70);
        rawDag = {
          nodes: allPartialNodes,
          executionOrder: allPartialNodes.map((n: any) => n.id),
          summary: `API flow with ${allPartialNodes.length} endpoints across ${chunks.length} groups`,
        };
      } else {
        // Small number of batches — try AI merge
        emit('building_dag', `Merging ${chunks.length} batches into one execution plan...`, 70);
        try {
          const mergePrompt = buildSwaggerDagMergePrompt(partialDags, spec);
          logger.info('[DEPENDENCY_RESOLVER] Merger starting', {
            promptLength: mergePrompt.length,
            totalNodes: allPartialNodes.length,
          });
          const mergeContent = await callAiWithRetry(
            [
              { role: 'system', content: buildSwaggerDependencySystemPrompt() },
              { role: 'user', content: `Domain context:\n${analysisJson.slice(0, 800)}\n\n${mergePrompt}` },
            ],
            { temperature: 0.1, response_format: { type: 'json_object' }, max_tokens: 65000, model: AI_TASK_MODELS.apiFlowArchitect, timeout: 180000 } as any,
            'Merger',
          );
          const mergedDag = extractJson(mergeContent);

          if (mergedDag?.nodes && Array.isArray(mergedDag.nodes) && mergedDag.nodes.length > 0) {
            logger.info('[DEPENDENCY_RESOLVER] Merger succeeded', { mergedNodes: mergedDag.nodes.length });
            rawDag = mergedDag;
          } else {
            logger.warn('[DEPENDENCY_RESOLVER] Merger returned 0 nodes, using concatenation', {
              mergedContent: (mergeContent || '').slice(0, 200),
            });
            rawDag = {
              nodes: allPartialNodes,
              executionOrder: allPartialNodes.map((n: any) => n.id),
              summary: `Concatenated ${chunks.length} partial DAGs`,
            };
          }
        } catch (mergeErr: any) {
          logger.warn('[DEPENDENCY_RESOLVER] Merger failed, using concatenation', {
            error: mergeErr.message?.slice(0, 150),
            totalNodes: allPartialNodes.length,
          });
          rawDag = {
            nodes: allPartialNodes,
            executionOrder: allPartialNodes.map((n: any) => n.id),
            summary: `Concatenated ${chunks.length} partial DAGs (merger failed)`,
          };
        }
      }
    }
    checkTimeout();

    // ── Post-processing ─────────────────────────────────────────────────
    const rawNodes: any[] = Array.isArray(rawDag.nodes) ? rawDag.nodes : [];
    if (rawNodes.length === 0) {
      throw new Error('AI could not generate any API flow nodes. Try selecting a smaller API group or a different spec.');
    }
    let nodes: DAGNode[] = rawNodes.map((n, i) => normalizeNode(n, i));

    // Remove phantom nodes (AI-fabricated endpoints not in spec)
    nodes = removePhantomNodes(nodes, spec);
    if (nodes.length === 0) {
      throw new Error('All nodes were phantom (not in spec). AI may have misunderstood the specification.');
    }

    // Deduplicate
    nodes = deduplicateNodes(nodes);

    // Safety-net: auto-wire dependencies that AI should have set but missed.
    // These functions only ADD edges — they never remove AI decisions.
    // If they fire, it means the prompt needs improvement for this API pattern.
    const preAuthCount = nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
    nodes = autoWireAuthDependencies(nodes);
    const postAuthCount = nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
    if (postAuthCount > preAuthCount) {
      logger.warn('[DEPENDENCY_RESOLVER] PROMPT_GAP: Auth auto-wire added edges AI missed', {
        edgesAdded: postAuthCount - preAuthCount,
      });
    }

    const preCrudCount = nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
    nodes = autoWireCrudDependencies(nodes, spec);
    const postCrudCount = nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
    if (postCrudCount > preCrudCount) {
      logger.warn('[DEPENDENCY_RESOLVER] PROMPT_GAP: CRUD auto-wire added edges AI missed', {
        edgesAdded: postCrudCount - preCrudCount,
      });
    }

    // Validate dependencies exist
    const nodeIds = new Set(nodes.map(n => n.id));
    nodes = nodes.map(node => ({
      ...node,
      dependsOn: node.dependsOn.filter(dep => {
        if (!nodeIds.has(dep)) {
          logger.warn('[DEPENDENCY_RESOLVER] Unknown dep removed', { nodeId: node.id, dep });
          return false;
        }
        return true;
      }),
    }));

    // Topological sort + cycle detection
    let sortResult = topologicalSort(nodes);
    if (sortResult.hasCycle) {
      // Notify caller so they can surface a warning to the user via WebSocket
      emit(
        'building_dag',
        `Circular dependencies detected between ${sortResult.cycleEdges.length} endpoint(s) — automatically resolved. Execution order may differ from the original spec.`,
        78,
      );
      nodes = breakCycles(nodes, sortResult.cycleEdges);
      sortResult = topologicalSort(nodes);
      if (sortResult.hasCycle) {
        logger.error('[DEPENDENCY_RESOLVER] Persistent cycle — forcing flat order');
        sortResult = { order: nodes.map(n => n.id), hasCycle: false, cycleEdges: [] };
      }
    }

    let executionOrder = sortResult.order;

    // INVARIANT: executionOrder must contain ALL node IDs.
    // If topological sort dropped some (should not happen after cycle-breaking),
    // append them at the end so no nodes are ever lost.
    {
      const inOrder = new Set(executionOrder);
      const orphans = nodes.filter(n => !inOrder.has(n.id));
      if (orphans.length > 0) {
        logger.warn('[DEPENDENCY_RESOLVER] Orphan nodes not in topological order — appending', {
          orphanCount: orphans.length,
          orphanIds: orphans.map(n => n.id),
        });
        executionOrder = [...executionOrder, ...orphans.map(n => n.id)];
      }
    }

    // Repair broken variable injections:
    // - Remove injections where no producer exists AND variable isn't a known user-provided pattern
    // - Keep injections for auth_token, api_key etc. (user may provide via initialVariables)
    const USER_PROVIDED_VARS = /^(auth_token|access_token|api_key|bearer_token|jwt|session_token|oauth_client_id|oauth_client_secret|base_url|token|authorization)$/i;
    {
      const producerVars = new Set<string>();
      for (const n of nodes) {
        for (const ext of n.variableExtractions) producerVars.add(ext.variableName);
      }
      let repairedCount = 0;
      nodes = nodes.map(node => {
        const validInjections = node.variableInjections.filter(inj => {
          if (producerVars.has(inj.variableName)) return true;
          if (USER_PROVIDED_VARS.test(inj.variableName)) return true; // user may provide
          repairedCount++;
          return false;
        });
        if (validInjections.length !== node.variableInjections.length) {
          return { ...node, variableInjections: validInjections };
        }
        return node;
      });
      if (repairedCount > 0) {
        logger.info('[DEPENDENCY_RESOLVER] Removed broken variable injections', { count: repairedCount });
      }
    }

    // Validate variable chain
    validateVariableChain(nodes, executionOrder);

    // Parallel groups + priority assignment
    const parallelGroups = buildParallelGroups(nodes, executionOrder);
    const levelMap = new Map<string, number>();
    parallelGroups.forEach((group, level) => {
      for (const id of group) levelMap.set(id, level);
    });
    nodes = nodes.map(node => ({
      ...node,
      priority: levelMap.get(node.id) ?? node.priority,
    }));

    emit('enriching', `Generating test data for ${nodes.filter(n => ['POST','PUT','PATCH'].includes(n.method)).length} endpoints...`, 80);
    // ── Agent 3: Enricher ───────────────────────────────────────────────
    checkTimeout();
    nodes = await runEnricher(nodes, spec, analysisJson);

    logger.info('[DEPENDENCY_RESOLVER] Pipeline completed', {
      nodes: nodes.length,
      executionOrder: executionOrder.length,
      parallelGroups: parallelGroups.length,
    });

    return {
      dag: {
        nodes,
        executionOrder,
        parallelGroups,
        summary: typeof rawDag.summary === 'string' ? rawDag.summary : `API flow with ${nodes.length} endpoints`,
        totalEndpoints: endpoints.length + spec.unsupportedEndpoints.length,
        unsupportedEndpoints: spec.unsupportedEndpoints as UnsupportedEndpoint[],
      },
    };
  }
}
