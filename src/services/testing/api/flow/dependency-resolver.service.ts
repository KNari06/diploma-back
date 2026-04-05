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

const MAX_ENDPOINTS_PER_BATCH = 50; // GPT can handle ~50 endpoints per batch with compact serialization
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
    { temperature: 0.3, response_format: { type: 'json_object' }, max_tokens: 8000, model: AI_TASK_MODELS.apiFlowAnalyst },
    'Analyst',
  );

  // Validate JSON
  try {
    const parsed = JSON.parse(content);
    // Ensure minimum structure
    if (!parsed.domain && !parsed.entities && !parsed.authFlow) {
      logger.warn('[DEPENDENCY_RESOLVER] Analyst output missing key fields, using raw');
    }
  } catch {
    logger.warn('[DEPENDENCY_RESOLVER] Analyst returned invalid JSON');
    // Return a minimal valid analysis so the pipeline continues
    return JSON.stringify({
      domain: { name: 'Unknown', description: `API: ${spec.title}` },
      entities: [],
      authFlow: { type: spec.authSchemes.length > 0 ? 'unknown' : 'none', steps: [], tokenExtraction: null },
      dataFlows: [],
      publicEndpoints: [],
      executionPhases: [{ phase: 1, name: 'All', endpoints: spec.endpoints.map(e => e.operationId), parallelizable: false }],
      edgeCases: ['Analyst failed to parse spec — architect must analyze endpoints directly'],
    });
  }

  logger.info('[DEPENDENCY_RESOLVER] Agent 1: Analyst completed');
  return content;
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
    { temperature: 0.2, response_format: { type: 'json_object' }, model: AI_TASK_MODELS.apiFlowArchitect },
    'Architect',
  );

  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Architect returned invalid JSON: ${content.slice(0, 300)}`);
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
        { temperature: 0.4, response_format: { type: 'json_object' }, model: AI_TASK_MODELS.apiFlowEnricher },
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
    options?: { analysisId?: string; userAnswers?: Record<string, string> },
  ): Promise<ResolveResult> {
    const endpoints = spec.endpoints;

    logger.info('[DEPENDENCY_RESOLVER] Starting pipeline', {
      title: spec.title,
      endpointCount: endpoints.length,
      hasExistingAnalysis: !!options?.analysisId,
      hasUserAnswers: !!options?.userAnswers,
    });

    const deadline = Date.now() + PIPELINE_TIMEOUT_MS;
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
      rawDag = await runArchitect(spec, endpoints, analysisJson);
    } else {
      const chunks: ParsedEndpoint[][] = [];
      for (let i = 0; i < endpoints.length; i += MAX_ENDPOINTS_PER_BATCH) {
        chunks.push(endpoints.slice(i, i + MAX_ENDPOINTS_PER_BATCH));
      }

      logger.info('[DEPENDENCY_RESOLVER] Batching', { chunks: chunks.length });

      const partialDags = await Promise.all(
        chunks.map(chunk => runArchitect(spec, chunk, analysisJson))
      );
      checkTimeout();

      // Merge — pass analyst context so merge AI understands cross-batch deps
      const mergePrompt = buildSwaggerDagMergePrompt(partialDags, spec);
      const mergeContent = await callAiWithRetry(
        [
          { role: 'system', content: buildSwaggerDependencySystemPrompt() },
          { role: 'user', content: `Domain context from analyst:\n${analysisJson.slice(0, 1000)}\n\n${mergePrompt}` },
        ],
        { temperature: 0.1, response_format: { type: 'json_object' }, model: AI_TASK_MODELS.apiFlowArchitect },
        'Merger',
      );
      rawDag = JSON.parse(mergeContent);
    }
    checkTimeout();

    // ── Post-processing ─────────────────────────────────────────────────
    const rawNodes: any[] = Array.isArray(rawDag.nodes) ? rawDag.nodes : [];
    let nodes: DAGNode[] = rawNodes.map((n, i) => normalizeNode(n, i));

    // Deduplicate
    nodes = deduplicateNodes(nodes);

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
      nodes = breakCycles(nodes, sortResult.cycleEdges);
      sortResult = topologicalSort(nodes);
      if (sortResult.hasCycle) {
        logger.error('[DEPENDENCY_RESOLVER] Persistent cycle — forcing flat order');
        sortResult = { order: nodes.map(n => n.id), hasCycle: false, cycleEdges: [] };
      }
    }

    const executionOrder = sortResult.order;

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
