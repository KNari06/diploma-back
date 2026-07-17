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

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { callAiWithRetry, extractJson } from './ai-json.util';
import {
  isAuthTokenVar,
  isAuthOrAuthorizationVar,
  isAuthCredentialVar,
  isUserProvidedVar,
  realmPrefixOf,
  toSnakeCase,
  singularize,
  lastPathSegment,
  isReferenceIdField,
  isSnakeIdVar,
} from './wiring/wiring-policy';
import { seedNodesFromSpec } from './wiring/spec-seed';
import { coerceBodyToSchema, missingRequiredFields } from './wiring/body-validator';
import { scoreDag, securityMapFromSpec, type EvalScore } from './eval/metrics';
import {
  buildAnalystSystemPrompt,
  buildAnalystPrompt,
  buildEnricherSystemPrompt,
  buildEnricherPrompt,
} from '@/ai/prompts/api-flow-prompts';
import type {
  DAGNode,
  ExecutionDAG,
  FlowQuestion,
  ParsedApiSpec,
  ParsedEndpoint,
  UnsupportedEndpoint,
  VariableInjection,
} from './flow.types';

const MAX_ENRICHER_BATCH = 25;
const PIPELINE_TIMEOUT_MS = 600_000; // 10 minutes for very large specs (1000+ endpoints)

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

/**
 * Would adding the edge `consumer.dependsOn += producer` create a cycle? True
 * iff the producer already (transitively) depends on the consumer. `depsOf`
 * returns a node's CURRENT dependencies (including edges an auto-wire pass added
 * earlier in the same run), so this catches 3+ node cycles a direct 2-cycle
 * guard misses. Used by the wiring passes before adding an edge.
 */
function wouldCreateCycle(consumerId: string, producerId: string, depsOf: (id: string) => Iterable<string>): boolean {
  if (consumerId === producerId) return true;
  const seen = new Set<string>();
  const stack = [producerId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === consumerId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of depsOf(id)) stack.push(dep);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARALLEL GROUPS
// ─────────────────────────────────────────────────────────────────────────────

function buildParallelGroups(nodes: DAGNode[], executionOrder: string[]): string[][] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const levelCache = new Map<string, number>();

  function getLevel(nodeId: string, onStack: Set<string> = new Set()): number {
    if (levelCache.has(nodeId)) return levelCache.get(nodeId)!;
    // On-stack guard: if a cycle survived cycle-breaking (or the flat-order
    // fallback left cyclic edges), treat the back-edge as a root so recursion
    // terminates instead of overflowing the stack.
    if (onStack.has(nodeId)) return 0;
    const node = nodeMap.get(nodeId);
    if (!node || node.dependsOn.length === 0) {
      levelCache.set(nodeId, 0);
      return 0;
    }
    onStack.add(nodeId);
    const maxParent = Math.max(...node.dependsOn.map(dep => getLevel(dep, onStack)));
    onStack.delete(nodeId);
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

  // Validate + repair each fabricated body against the endpoint's own JSON schema:
  // coerce type mismatches (LLM emits "42"/"true" as strings) and log omitted
  // required fields. `{{placeholder}}` fields are left untouched (runtime-resolved).
  const schemaByKey = new Map<string, any>();
  for (const e of spec.endpoints) if (e.requestBody?.schema) schemaByKey.set(`${e.method}:${e.path}`, e.requestBody.schema);

  return nodes.map(n => {
    const sample = allSamples[n.id];
    if (!sample) return n;
    const schema = schemaByKey.get(`${n.method}:${n.path}`);
    if (!schema) return { ...n, sampleRequestBody: sample };
    const coerced = coerceBodyToSchema(sample, schema);
    const missing = missingRequiredFields(coerced, schema);
    if (missing.length > 0) {
      logger.warn('[DEPENDENCY_RESOLVER] Enricher body missing required fields', { nodeId: n.id, missing });
    }
    return { ...n, sampleRequestBody: coerced };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-PROCESSING: Deduplication + Validation
// ─────────────────────────────────────────────────────────────────────────────

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

  // Find auth producer nodes (nodes that extract auth variables)
  const authProducerIds = new Set<string>();
  for (const [varName, producerId] of producerMap) {
    if (isAuthCredentialVar(varName)) {
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
 * Coverage safety-net for auth: every endpoint the spec marks as auth-required
 * MUST run after an auth producer so it actually carries a session/token. The
 * Architect frequently wires only SOME protected endpoints — or schedules them
 * before login — leaving the rest to fire unauthenticated → 401 (and, under
 * stop-on-failure, killing the whole run before login even executes). This pass
 * closes that gap deterministically from the spec's `security` field (ground
 * truth), not AI guesses.
 *
 * Modes, decided by how the primary auth endpoint yields its token:
 * - COOKIE / session (token extracted from a Set-Cookie header): add ORDERING
 *   only. The runtime cookie jar carries the session; a raw cookie replayed as
 *   `Authorization: Bearer` breaks auth, so any such bogus injection the
 *   Architect added is STRIPPED here.
 * - BEARER (token extracted from the response body): add ordering AND a missing
 *   `Authorization: Bearer {{auth_token}}` injection.
 */
function autoWireRequiredAuth(nodes: DAGNode[], spec: ParsedApiSpec): DAGNode[] {
  const secByKey = new Map<string, string[]>();
  for (const e of spec.endpoints) secByKey.set(`${e.method}:${e.path}`, e.security || []);

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const AUTH_ENDPOINT_PRODUCERS = nodes.filter(
    n => n.isAuthEndpoint && n.variableExtractions.some(e => isAuthTokenVar(e.variableName)),
  );
  const ANY_AUTH_PRODUCERS = nodes.filter(n => n.variableExtractions.some(e => isAuthTokenVar(e.variableName)));
  const producerPool = AUTH_ENDPOINT_PRODUCERS.length ? AUTH_ENDPOINT_PRODUCERS : ANY_AUTH_PRODUCERS;
  if (producerPool.length === 0) return nodes;

  const authProducerIdSet = new Set(ANY_AUTH_PRODUCERS.map(n => n.id));
  // Count auth-producer ancestors → the TERMINAL producer in a multi-step chain
  // (verifyOtp → register → refresh) is the one that ESTABLISHES the session
  // (register), not the first (verifyOtp yields only a registration token).
  const countAuthAncestors = (start: DAGNode): number => {
    const seen = new Set<string>();
    const stack = [...start.dependsOn];
    let count = 0;
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (authProducerIdSet.has(id)) count++;
      const dep = nodeById.get(id);
      if (dep) stack.push(...dep.dependsOn);
    }
    return count;
  };
  const isRefreshEndpoint = (n: DAGNode) => /refresh/i.test(n.path) || /refresh/i.test(n.id);

  // Partition producers into REALMS by the path prefix before the auth segment
  // (e.g. `/api/v1/admin/auth/login` → realm `/api/v1/admin`; `/api/v1/auth/register`
  // → realm `/api/v1`). A protected endpoint is wired to the producer of the realm
  // whose prefix is the LONGEST prefix of its path — so `/admin/*` depends on the
  // admin login and gets the admin token, not the user login's.
  interface AuthRealm { prefix: string; producer: DAGNode; authVar: string; cookieMode: boolean; }
  const byPrefix = new Map<string, DAGNode[]>();
  for (const p of producerPool) {
    const prefix = realmPrefixOf(p.path);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(p);
  }
  const buildRealm = (prefix: string, group: DAGNode[]): AuthRealm => {
    const rankable = group.filter(n => !isRefreshEndpoint(n));
    const pool = rankable.length ? rankable : group;
    const producer = pool.reduce((best, n) => (countAuthAncestors(n) > countAuthAncestors(best) ? n : best), pool[0]);
    const authVar = producer.variableExtractions.find(e => isAuthTokenVar(e.variableName))!.variableName;
    const ext = producer.variableExtractions.find(e => e.variableName === authVar);
    return { prefix, producer, authVar, cookieMode: !!ext?.headerSource && /cookie/i.test(ext.headerSource) };
  };
  const realms = [...byPrefix.entries()]
    .map(([prefix, group]) => buildRealm(prefix, group))
    .sort((a, b) => b.prefix.length - a.prefix.length); // longest prefix first
  const fallbackRealm = realms[realms.length - 1]; // broadest realm for unmatched paths
  const resolveRealm = (path: string): AuthRealm => {
    for (const r of realms) {
      if (r.prefix && (path === r.prefix || path.startsWith(`${r.prefix}/`))) return r;
    }
    return fallbackRealm;
  };

  // Every node that produces an auth var is part of the auth chain — never make
  // it depend on auth (avoids register→login→refresh cycles). Expand to the full
  // BOOTSTRAP closure: anything an auth producer (transitively) depends on runs
  // before the token exists (e.g. sendOtp before verifyOtp), so it must NOT get
  // an auth injection either — that token would always be empty.
  const authBootstrap = new Set(ANY_AUTH_PRODUCERS.map(n => n.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...authBootstrap]) {
      for (const dep of nodeById.get(id)?.dependsOn || []) {
        if (!authBootstrap.has(dep)) { authBootstrap.add(dep); grew = true; }
      }
    }
  }

  const isBogusBearer = (i: VariableInjection, authVar: string): boolean =>
    i.variableName === authVar &&
    i.injectAs === 'header' &&
    String(i.targetKey).toLowerCase() === 'authorization';

  let orderedCount = 0;
  let injectedCount = 0;
  let strippedCount = 0;

  const result = nodes.map(node => {
    if (authBootstrap.has(node.id)) return node;

    const realm = resolveRealm(node.path);
    const isProtected = (secByKey.get(`${node.method}:${node.path}`) || []).length > 0;
    let dependsOn = node.dependsOn;
    let variableInjections = node.variableInjections;
    let changed = false;

    // Cookie mode: drop bogus "Authorization: Bearer <cookie>" — jar carries it.
    if (realm.cookieMode) {
      const filtered = variableInjections.filter(i => !isBogusBearer(i, realm.authVar));
      if (filtered.length !== variableInjections.length) {
        variableInjections = filtered;
        strippedCount += 1;
        changed = true;
      }
    }

    if (isProtected) {
      // Ordering: run after this realm's auth producer. Skip if it would reverse
      // an existing dependency (the producer already depends on this node).
      if (!dependsOn.includes(realm.producer.id) && !realm.producer.dependsOn.includes(node.id)) {
        dependsOn = [...dependsOn, realm.producer.id];
        orderedCount += 1;
        changed = true;
      }
      // Bearer mode: ensure the token is actually injected.
      if (!realm.cookieMode) {
        const hasAuthInjection = variableInjections.some(
          i => i.variableName === realm.authVar || (i.injectAs === 'header' && String(i.targetKey).toLowerCase() === 'authorization'),
        );
        if (!hasAuthInjection) {
          variableInjections = [
            ...variableInjections,
            { variableName: realm.authVar, injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
          ];
          injectedCount += 1;
          changed = true;
        }
      }
    }

    return changed ? { ...node, dependsOn, variableInjections } : node;
  });

  if (orderedCount > 0 || injectedCount > 0 || strippedCount > 0) {
    logger.info('[DEPENDENCY_RESOLVER] Auto-wired required auth coverage', {
      realms: realms.map(r => ({ prefix: r.prefix, producer: r.producer.id, cookieMode: r.cookieMode })),
      orderedCount, injectedCount, strippedCount,
    });
  }
  return result;
}

/**
 * General variable-dependency wiring: whenever a node INJECTS a variable that
 * another node EXTRACTS from its response, the consumer must run AFTER that
 * producer — otherwise the placeholder resolves to nothing at run time (the
 * "extracted value not used downstream" bug: e.g. deleteFile injects file_id but
 * runs before the upload that produces it). The Architect wires these for auth
 * and obvious CRUD, but misses cross-resource ids in large/batched specs. This
 * closes the gap deterministically from the DAG's own extraction/injection map.
 *
 * Auth variables are skipped here — they are owned by autoWireAuthDependencies /
 * autoWireRequiredAuth, which pick the right producer among a multi-step chain.
 * Only ADDS edges; a direct 2-cycle is avoided and the downstream cycle-breaker
 * handles anything deeper.
 */
function autoWireVariableDependencies(nodes: DAGNode[]): DAGNode[] {
  const producersByVar = new Map<string, string[]>();
  for (const n of nodes) {
    for (const e of n.variableExtractions) {
      if (isAuthOrAuthorizationVar(e.variableName)) continue;
      const ids = producersByVar.get(e.variableName) || [];
      if (!ids.includes(n.id)) ids.push(n.id);
      producersByVar.set(e.variableName, ids);
    }
  }

  // Live dependency map, updated as edges are added, so the cycle check sees
  // edges added earlier in this same pass (catches transitive A→B→C→A).
  const liveDeps = new Map(nodes.map(n => [n.id, new Set(n.dependsOn)]));
  const depsOf = (id: string) => liveDeps.get(id) ?? [];
  let edgesAdded = 0;

  const result = nodes.map(node => {
    const deps = liveDeps.get(node.id)!;
    const before = deps.size;
    for (const inj of node.variableInjections) {
      if (isAuthOrAuthorizationVar(inj.variableName)) continue;
      const producers = producersByVar.get(inj.variableName);
      if (!producers) continue;
      const producerId = producers.find(pid => pid !== node.id);
      if (!producerId || deps.has(producerId)) continue;
      if (wouldCreateCycle(node.id, producerId, depsOf)) continue; // transitive cycle guard
      deps.add(producerId);
    }
    if (deps.size === before) return node;
    edgesAdded += deps.size - before;
    return { ...node, dependsOn: [...deps] };
  });

  if (edgesAdded > 0) {
    logger.info('[DEPENDENCY_RESOLVER] Auto-wired variable dependencies', { edgesAdded });
  }
  return result;
}

/**
 * Reference-id resolution: a request field like `countryId` references an
 * EXISTING entity and must carry a real id, not a fabricated UUID (else the API
 * rejects it — "Country not found"). If a prior step already produces that id
 * (`country_id`), link to it. Otherwise, if a matching GET list endpoint exists
 * (`/geo/countries`), promote it to a producer (`$[0].id`) and link. Rewrites
 * ONLY literal fields whose snake-cased name equals the entity var — high
 * precision, so it does not touch ordinary fake data.
 *
 * Exception — auth bootstrap: an endpoint that PRODUCES the auth token (e.g.
 * `register`) cannot source a reference id from an authed list endpoint, since
 * that endpoint needs the very token this node has not issued yet (chicken and
 * egg). Such ids are surfaced as required run-time variables (`requiredVars`)
 * for the user to provide instead — which also lets the bootstrap node run
 * early and break the cycle.
 */
function autoResolveReferenceIds(nodes: DAGNode[]): { nodes: DAGNode[]; requiredVars: Record<string, string> } {
  // produced *_id vars → earliest producer node
  const producedId = new Map<string, string>();
  for (const n of nodes) {
    for (const e of n.variableExtractions || []) {
      if (isSnakeIdVar(e.variableName) && !producedId.has(e.variableName)) producedId.set(e.variableName, n.id);
    }
  }
  // GET *collection* endpoints keyed by singular entity ("country", "city").
  // Item fetches (`GET /countries/{id}`) are NOT list producers — extracting
  // `$[0].id` from a single-object response yields nothing, and the item needs
  // its own `{id}` anyway.
  const listByEntity = new Map<string, string>();
  for (const n of nodes) {
    if (n.method !== 'GET') continue;
    const rawParts = n.path.split('/').filter(Boolean);
    if (rawParts[rawParts.length - 1]?.startsWith('{')) continue; // item GET, not a list
    const entity = singularize(lastPathSegment(n.path)).toLowerCase();
    if (entity && !listByEntity.has(entity)) listByEntity.set(entity, n.id);
  }
  // array-id jsonPath, learned from an existing list extraction (fallback $[0].id)
  let idPath = '$[0].id';
  for (const n of nodes) {
    const e = (n.variableExtractions || []).find(x => isSnakeIdVar(x.variableName) && x.jsonPath && /\[0\]/.test(x.jsonPath));
    if (e?.jsonPath) { idPath = e.jsonPath; break; }
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Auth-token producers (register / verifyOtp / login …) PLUS their transitive
  // dependency closure (the bootstrap chain — e.g. sendOtp feeding verifyOtp).
  // Reference ids on ANY node in this closure must be user-provided, not pulled
  // from an authed list endpoint: adding an edge from a pre-auth node into an
  // authed endpoint (which itself depends on the auth chain) creates a cycle.
  const authBootstrap = new Set(
    nodes.filter(n => (n.variableExtractions || []).some(e => isAuthTokenVar(e.variableName))).map(n => n.id),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...authBootstrap]) {
      for (const dep of nodeById.get(id)?.dependsOn || []) {
        if (!authBootstrap.has(dep)) { authBootstrap.add(dep); grew = true; }
      }
    }
  }

  const extraExtractions = new Map<string, Set<string>>();
  const extraDeps = new Map<string, Set<string>>();
  const requiredVars: Record<string, string> = {};

  const resolveField = (field: string, value: unknown, ownerId: string): string | null => {
    if (typeof value !== 'string' || /\{\{.+?\}\}/.test(value)) return null;
    if (!isReferenceIdField(field)) return null;
    const canonical = toSnakeCase(field);
    if (!isSnakeIdVar(canonical)) return null;

    // Bootstrap node: ask the user rather than link to an authed producer.
    if (authBootstrap.has(ownerId)) {
      requiredVars[canonical] = '';
      return `{{${canonical}}}`;
    }

    let producerId = producedId.get(canonical);
    if (!producerId) {
      const entity = canonical.replace(/_id$/, '');
      const listId = listByEntity.get(entity);
      if (!listId || listId === ownerId) return null;
      if (!extraExtractions.has(listId)) extraExtractions.set(listId, new Set());
      extraExtractions.get(listId)!.add(canonical);
      producedId.set(canonical, listId); // let siblings reuse this producer
      producerId = listId;
    }
    if (producerId === ownerId) return null;
    // Transitive cycle guard: consider the producer's original deps AND edges
    // added earlier in this same pass (catches 3+ node cycles, not just A<->B).
    const depsOf = (id: string): Iterable<string> => [
      ...(nodeById.get(id)?.dependsOn || []),
      ...(extraDeps.get(id) || []),
    ];
    if (wouldCreateCycle(ownerId, producerId, depsOf)) return null;
    if (!extraDeps.has(ownerId)) extraDeps.set(ownerId, new Set());
    extraDeps.get(ownerId)!.add(producerId);
    return `{{${canonical}}}`;
  };

  const rewriteObj = (val: any, ownerId: string): any => {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(v => rewriteObj(v, ownerId));
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = v !== null && typeof v === 'object' ? rewriteObj(v, ownerId) : (resolveField(k, v, ownerId) ?? v);
    }
    return out;
  };

  // Pass 1 — rewrite consumer bodies / query (collects producers + deps).
  let result = nodes.map(node => {
    let changed = false;
    let sampleRequestBody = node.sampleRequestBody;
    if (sampleRequestBody && typeof sampleRequestBody === 'object') {
      const nb = rewriteObj(sampleRequestBody, node.id);
      if (JSON.stringify(nb) !== JSON.stringify(sampleRequestBody)) { sampleRequestBody = nb; changed = true; }
    }
    let sampleQueryParams = node.sampleQueryParams;
    if (sampleQueryParams && typeof sampleQueryParams === 'object') {
      const nq: Record<string, string> = {};
      let qc = false;
      for (const [k, v] of Object.entries(sampleQueryParams)) {
        const r = resolveField(k, v, node.id);
        if (r) { nq[k] = r; qc = true; } else nq[k] = v as string;
      }
      if (qc) { sampleQueryParams = nq; changed = true; }
    }
    return changed ? { ...node, sampleRequestBody, sampleQueryParams } : node;
  });

  // Pass 2 — add the learned extractions to list endpoints + the new deps.
  result = result.map(node => {
    let n = node;
    const addExt = extraExtractions.get(node.id);
    if (addExt) {
      const existing = new Set((n.variableExtractions || []).map(e => e.variableName));
      const fresh = [...addExt].filter(v => !existing.has(v)).map(v => ({ variableName: v, jsonPath: idPath }));
      if (fresh.length) n = { ...n, variableExtractions: [...(n.variableExtractions || []), ...fresh] };
    }
    const addDep = extraDeps.get(node.id);
    if (addDep) {
      const deps = new Set(n.dependsOn);
      const before = deps.size;
      for (const d of addDep) deps.add(d);
      if (deps.size !== before) n = { ...n, dependsOn: [...deps] };
    }
    return n;
  });

  const linked = [...extraDeps.values()].reduce((s, set) => s + set.size, 0);
  if (linked > 0 || Object.keys(requiredVars).length > 0) {
    logger.info('[DEPENDENCY_RESOLVER] Resolved reference ids', {
      linked, promotedListEndpoints: extraExtractions.size, askUser: Object.keys(requiredVars),
    });
  }
  return { nodes: result, requiredVars };
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

/**
 * Validate-and-REPAIR the variable chain (not warn-only). An injection is kept iff
 * it can actually resolve at run time; otherwise it is dropped so the executor
 * never sends an unresolved `{{placeholder}}` literal:
 *  - no producer AND not a user-provided pattern → orphan, dropped.
 *  - producer runs at/after the consumer (only possible inside a residual cycle,
 *    since topo already ordered everything) → unsatisfiable, dropped.
 * Returns the repaired nodes.
 */
function validateVariableChain(nodes: DAGNode[], executionOrder: string[]): DAGNode[] {
  const producerMap = new Map<string, string>(); // variableName → earliest producerNodeId
  const orderIdx = new Map(executionOrder.map((id, i) => [id, i]));
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
      } else {
        producerMap.set(ext.variableName, node.id);
      }
    }
  }

  let droppedOrphan = 0;
  let droppedOrdering = 0;
  const repaired = nodes.map(node => {
    const consumerIdx = orderIdx.get(node.id) ?? Infinity;
    const kept = node.variableInjections.filter(inj => {
      const producerId = producerMap.get(inj.variableName);
      if (producerId === undefined) {
        if (isUserProvidedVar(inj.variableName)) return true; // user supplies it at run time
        droppedOrphan++;
        return false;
      }
      const producerIdx = orderIdx.get(producerId) ?? -1;
      if (producerIdx >= consumerIdx) {
        droppedOrdering++; // unsatisfiable ordering (residual cycle) → drop
        return false;
      }
      return true;
    });
    return kept.length !== node.variableInjections.length ? { ...node, variableInjections: kept } : node;
  });

  if (droppedOrphan > 0 || droppedOrdering > 0) {
    logger.info('[DEPENDENCY_RESOLVER] Variable-chain repaired', {
      droppedOrphanInjections: droppedOrphan,
      droppedOrderingInjections: droppedOrdering,
    });
  }
  return repaired;
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
  // Reference ids on auth-bootstrap nodes that must be user-provided at run time
  // (var name → '' placeholder). Merged into the flow's variableChain by the builder.
  requiredVars?: Record<string, string>;
  // Structural quality of the built DAG (validate-and-repair gate). `passed`
  // means all hard invariants hold; surfaced for logging / UI.
  qualityScore?: EvalScore;
}

export class DependencyResolverService {
  /**
   * Pipeline: Analyst (asks clarifying questions) → deterministic candidate graph
   * from the spec (seedNodesFromSpec + wiring passes) → Enricher (fake bodies) →
   * validate-and-repair gate (scoreDag). Returns questions if the Analyst is
   * uncertain — caller must resume with answers.
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
        const answers = options.userAnswers;
        // Preserve provided-variable METADATA (name/type/context — never the
        // values) so the Enricher can wire user-supplied values into request
        // bodies as {{placeholder}} instead of inventing fake credentials.
        const askedQuestions: any[] = Array.isArray(analysis.questions) ? analysis.questions : [];
        const providedVariables = askedQuestions
          .filter(q => q.variableName && (answers[q.variableName] !== undefined || answers[q.id] !== undefined))
          .map(q => ({ name: q.variableName, type: q.type, context: q.context || q.question }));
        if (providedVariables.length > 0) analysis._providedVariables = providedVariables;
        analysis._userAnswers = answers;
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

    // ── Agent 2: Deterministic candidate graph (replaces the Architect LLM) ──
    // The DAG's wiring metadata (variableExtractions / variableInjections) is
    // DERIVED from the spec's own schemas — response fields (producers) and
    // path/query/body params (consumers) — instead of being hallucinated by an
    // LLM. This eliminates the ordering violations and fabricated reference ids
    // the Architect produced; values that genuinely can't be derived surface as
    // required run-time inputs (handled below) the user is asked to provide.
    emit('building_dag', `Building execution plan from ${endpoints.length} endpoints...`, 55);
    let nodes: DAGNode[] = seedNodesFromSpec(spec);
    if (nodes.length === 0) {
      throw new Error('Spec produced no endpoints to build a flow from.');
    }
    checkTimeout();

    // Enrich request bodies BEFORE the wiring/ordering passes, so the passes
    // that read body content (reference-id resolution) see real fields and the
    // dependencies they add are reflected in the topological order below.
    emit('enriching', `Generating test data for ${nodes.filter(n => ['POST', 'PUT', 'PATCH'].includes(n.method)).length} endpoints...`, 78);
    checkTimeout();
    nodes = await runEnricher(nodes, spec, analysisJson);

    // Safety-net: auto-wire dependencies that AI should have set but missed.
    // These functions only ADD edges — they never remove AI decisions.
    // If they fire, it means the prompt needs improvement for this API pattern.
    const preAuthCount = nodes.reduce((sum, n) => sum + n.dependsOn.length, 0);
    nodes = autoWireAuthDependencies(nodes);
    // Coverage net: wire EVERY spec-declared auth-required endpoint to the auth
    // producer (ordering) — and, per mode, add a Bearer injection or strip a
    // bogus Bearer-of-cookie. Catches protected endpoints the Architect left
    // unauthenticated and running before login.
    nodes = autoWireRequiredAuth(nodes, spec);
    // Generalize the same idea to non-auth vars: consumer of an extracted value
    // must run after its producer (fixes cross-resource ids like file_id).
    nodes = autoWireVariableDependencies(nodes);
    // Reference ids (countryId/cityId/…) fabricated by the Enricher → replace
    // with a real id from a producer/list endpoint, or ask the user for bootstrap ids.
    const refResult = autoResolveReferenceIds(nodes);
    nodes = refResult.nodes;
    const referenceRequiredVars = refResult.requiredVars;
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
        logger.error('[DEPENDENCY_RESOLVER] Persistent cycle — dropping remaining cycle edges + forcing flat order');
        // Strip the still-cyclic edges so the DAG is actually acyclic downstream
        // (buildParallelGroups.getLevel walks dependsOn) — not just non-crashing.
        nodes = breakCycles(nodes, sortResult.cycleEdges);
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

    // Validate-and-repair the variable chain: drops orphan injections (no producer
    // and not user-provided) and injections whose producer runs after the consumer.
    nodes = validateVariableChain(nodes, executionOrder);

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

    // Validate-and-repair GATE — score the finished DAG against the structural
    // invariants (the same scorer the eval harness uses). Values supplied at run
    // time (required inputs + user-provided auth vars) are NOT counted unresolved.
    const producedVars = new Set(nodes.flatMap(n => n.variableExtractions.map(e => e.variableName)));
    const providedVars = new Set<string>(Object.keys(referenceRequiredVars));
    for (const n of nodes) {
      for (const inj of n.variableInjections) {
        if (!producedVars.has(inj.variableName)) providedVars.add(inj.variableName);
      }
    }
    const qualityScore = scoreDag({
      name: spec.title,
      nodes,
      executionOrder,
      securityByEndpoint: securityMapFromSpec(spec),
      providedVars: [...providedVars],
    });

    logger[qualityScore.passed ? 'info' : 'warn']('[DEPENDENCY_RESOLVER] DAG quality gate', {
      passed: qualityScore.passed,
      orderingViolations: qualityScore.orderingViolations,
      unresolvedInjections: qualityScore.unresolvedInjections,
      authCoverage: qualityScore.authCoverage,
      hasCycle: qualityScore.hasCycle,
      fabricatedReferenceIds: qualityScore.fabricatedReferenceIds,
    });

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
        summary: `API flow with ${nodes.length} endpoints`,
        totalEndpoints: endpoints.length + spec.unsupportedEndpoints.length,
        unsupportedEndpoints: spec.unsupportedEndpoints as UnsupportedEndpoint[],
      },
      requiredVars: referenceRequiredVars,
      qualityScore,
    };
  }
}

/** Internal helpers exposed for unit testing only. */
export const __testables = {
  autoWireRequiredAuth,
  autoWireAuthDependencies,
  autoWireVariableDependencies,
  autoResolveReferenceIds,
  autoWireCrudDependencies,
  topologicalSort,
  buildParallelGroups,
  validateVariableChain,
};
