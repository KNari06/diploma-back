/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOW EXECUTOR SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Executes an API flow chain from a saved ApiFlowSpec.
 *
 * Features:
 * - Variable interpolation: {{var}} in URL, headers, body, query params
 * - JSONPath variable extraction from responses
 * - Auth token auto-refresh on 401
 * - Rate limit handling (429 → Retry-After)
 * - 3 error strategies: stop_on_failure | continue_on_failure | retry_then_skip
 * - Real-time WebSocket events per step
 * - Saves each step to api_test_executions
 */

import { randomUUID } from 'crypto';
import { JSONPath } from 'jsonpath-plus';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { executeApiTest } from '../apiTest.service';
import { ApiTestStorageService } from '../api-test-storage.service';
import { FlowBuilderService } from './flow-builder.service';
import type {
  ApiFlowSpec,
  DAGNode,
  FlowErrorStrategy,
  FlowExecutionConfig,
  FlowRunSummary,
  FlowRunStatus,
  FlowStepResult,
  FlowStepStatus,
  NodeCase,
  RunFlowRequest,
  VariableContext,
  VariableExtraction,
  VariableInjection,
} from './flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: FlowExecutionConfig = {
  errorStrategy: 'stop_on_failure',
  maxRetries: 3,
  retryBackoffMs: 1000,
  stepTimeoutMs: 15000,
  totalTimeoutMs: 300000,
  rateLimitDelayMs: 100,
};

// Max simultaneous in-flight requests within a single parallel group, so a wide
// group (e.g. 50 same-level nodes) doesn't fire 50 requests at once.
const MAX_GROUP_CONCURRENCY = 5;

/**
 * Run `tasks` with at most `limit` in flight at once. Settles every task (a
 * thrown task does not abort its siblings); rejections are swallowed because
 * runNode handles its own errors and records a failed step. Zero-dependency —
 * avoids pulling an ESM-only limiter into this CommonJS module.
 */
async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      try {
        await tasks[idx]();
      } catch {
        // runNode is self-contained; ignore so one task can't abort siblings.
      }
    }
  };
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// Sensitive variable name patterns — mask their values in WS events
const SENSITIVE_PATTERNS = /token|secret|password|key|auth|jwt|bearer/i;

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE INTERPOLATION
// ─────────────────────────────────────────────────────────────────────────────

const VAR_REGEX = /\{\{([\w.\-]+)\}\}/g;

function interpolate(template: string, ctx: VariableContext): string {
  if (!template.includes('{{')) return template;
  return template.replace(VAR_REGEX, (match, key) => {
    const value = ctx[key];
    if (value === undefined || value === null) return match; // leave unresolved
    return String(value);
  });
}

function interpolateObject(obj: any, ctx: VariableContext): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return interpolate(obj, ctx);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(item => interpolateObject(item, ctx));
  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = interpolateObject(v, ctx);
    }
    return result;
  }
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE EXTRACTION (JSONPath)
// ─────────────────────────────────────────────────────────────────────────────

function extractVariable(
  responseBody: any,
  responseHeaders: Record<string, string>,
  extraction: VariableExtraction,
): string | undefined {
  try {
    if (extraction.headerSource) {
      return responseHeaders[extraction.headerSource.toLowerCase()];
    }

    if (extraction.jsonPath && responseBody !== null && responseBody !== undefined) {
      const results = JSONPath({ path: extraction.jsonPath, json: responseBody, wrap: false });
      if (results !== undefined && results !== null && results !== false) {
        return String(results);
      }
    }

    if (extraction.regex && typeof responseBody === 'string') {
      const match = responseBody.match(new RegExp(extraction.regex));
      return match?.[1];
    }
  } catch (err) {
    logger.warn('[FLOW_EXECUTOR] Variable extraction failed', {
      variableName: extraction.variableName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
}

function maskValue(name: string, value: string): string {
  if (SENSITIVE_PATTERNS.test(name) && value.length > 8) {
    return `${value.slice(0, 8)}***`;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST BUILDING
// ─────────────────────────────────────────────────────────────────────────────

function buildResolvedRequest(
  node: DAGNode,
  baseUrl: string,
  ctx: VariableContext,
  nodeOverride?: { requestBody?: any; queryParams?: Record<string, string>; headers?: Record<string, string> },
): {
  resolvedUrl: string;
  resolvedHeaders: Record<string, string>;
  resolvedBody: any;
  variablesInjected: string[];
} {
  const variablesInjected: string[] = [];
  const resolvedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(nodeOverride?.headers || {}),
  };
  const queryParams: Record<string, string> = { ...(nodeOverride?.queryParams || {}) };

  // Build resolved URL from base + path
  let path = node.path;

  // Apply injections
  for (const injection of node.variableInjections) {
    const rawValue = ctx[injection.variableName];
    if (rawValue === undefined) {
      logger.warn('[FLOW_EXECUTOR] Unresolved injection variable', {
        nodeId: node.id,
        variableName: injection.variableName,
      });
      continue;
    }
    let value: string;
    if (injection.prefix === 'Basic ' && !String(rawValue).includes(':')) {
      // Basic auth: if rawValue is already base64, use as-is; otherwise assume "user:pass" format
      value = `Basic ${rawValue}`;
    } else if (injection.prefix === 'Basic ') {
      // rawValue contains "user:pass" — encode to base64
      value = `Basic ${Buffer.from(String(rawValue)).toString('base64')}`;
    } else {
      value = injection.prefix ? `${injection.prefix}${rawValue}` : String(rawValue);
    }
    variablesInjected.push(injection.variableName);

    switch (injection.injectAs) {
      case 'header':
        resolvedHeaders[injection.targetKey] = value;
        break;
      case 'path_param':
        path = path.replace(`{${injection.targetKey}}`, encodeURIComponent(String(rawValue)));
        break;
      case 'query_param':
        queryParams[injection.targetKey] = String(rawValue);
        break;
      case 'body_field':
        // handled below in body building
        break;
    }
  }

  // Also resolve any {{var}} in path
  path = interpolate(path, ctx);

  // Build query string
  const qsEntries = Object.entries(queryParams);
  if (node.sampleQueryParams) {
    for (const [k, v] of Object.entries(node.sampleQueryParams)) {
      if (!queryParams[k]) qsEntries.push([k, interpolate(v, ctx)]);
    }
  }
  const qs = qsEntries.length > 0
    ? '?' + qsEntries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  const resolvedUrl = `${baseUrl}${path}${qs}`;

  // Build body
  let resolvedBody: any;
  if (nodeOverride?.requestBody !== undefined) {
    resolvedBody = interpolateObject(nodeOverride.requestBody, ctx);
  } else if (node.sampleRequestBody) {
    resolvedBody = interpolateObject(node.sampleRequestBody, ctx);
  }

  // Apply body field injections
  for (const injection of node.variableInjections) {
    if (injection.injectAs === 'body_field' && resolvedBody && typeof resolvedBody === 'object') {
      const rawValue = ctx[injection.variableName];
      if (rawValue !== undefined) {
        resolvedBody[injection.targetKey] = rawValue;
      }
    }
  }

  return { resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected };
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMIT HANDLING
// ─────────────────────────────────────────────────────────────────────────────

async function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(headers: Record<string, string>): number {
  const retryAfter = headers['retry-after'];
  if (!retryAfter) return 5000; // default 5s
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return Math.min(seconds * 1000, 30000); // cap at 30s
  // Could be HTTP date — not parsing, just use default
  return 5000;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function createFlowRun(
  flowSpecId: string,
  userId: string,
  config: FlowExecutionConfig,
  chatSessionId?: string,
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('api_flow_runs')
    .insert({
      flow_spec_id: flowSpecId,
      user_id: userId,
      status: 'running',
      config,
      chat_session_id: chatSessionId || null,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create flow run: ${error?.message}`);
  }
  return data.id;
}

async function updateFlowRun(
  runId: string,
  update: { status: FlowRunStatus; summary?: FlowRunSummary; completedAt?: string }
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('api_flow_runs')
    .update({
      status: update.status,
      summary: update.summary,
      completed_at: update.completedAt || null,
    })
    .eq('id', runId);

  if (error) {
    logger.error('[FLOW_EXECUTOR] Failed to update flow run', { runId, error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const activeRuns = new Map<string, AbortController>();

export function cancelFlowRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXECUTOR
// ─────────────────────────────────────────────────────────────────────────────

export class FlowExecutorService {
  /**
   * Execute a flow spec chain. Returns a run summary.
   * Emits real-time WebSocket events.
   */
  static async execute(
    flowSpec: ApiFlowSpec,
    userId: string,
    request: RunFlowRequest,
    preCreatedRunId?: string,
  ): Promise<FlowRunSummary> {
    const dag = flowSpec.executionDag;
    const chatSessionId = request.chatSessionId;
    const config: FlowExecutionConfig = {
      ...DEFAULT_CONFIG,
      errorStrategy: flowSpec.errorStrategy as FlowErrorStrategy,
      ...(request.config || {}),
    };

    const startedAt = new Date().toISOString();
    const flowRunId = preCreatedRunId || await createFlowRun(flowSpec.id, userId, config, chatSessionId);

    // Register cancellation controller
    const abortController = new AbortController();
    activeRuns.set(flowRunId, abortController);

    // Update flow spec with run status
    await FlowBuilderService.markRunStatus(flowSpec.id, flowRunId, 'running');

    logger.info('[FLOW_EXECUTOR] Starting flow execution', {
      flowSpecId: flowSpec.id,
      flowRunId,
      nodes: dag.nodes.length,
      errorStrategy: config.errorStrategy,
    });

    // Initialize variable context (pre-load from linked environment if available)
    const ctx: VariableContext = {};
    if (flowSpec.environmentId) {
      try {
        const { data: env } = await supabaseAdmin
          .from('api_environments')
          .select('variables')
          .eq('id', flowSpec.environmentId)
          .maybeSingle();
        if (env?.variables && typeof env.variables === 'object') {
          Object.assign(ctx, env.variables);
          logger.info('[FLOW_EXECUTOR] Loaded environment variables', {
            environmentId: flowSpec.environmentId,
            variableCount: Object.keys(env.variables).length,
          });
        }
      } catch (err) {
        logger.warn('[FLOW_EXECUTOR] Failed to load environment variables', {
          environmentId: flowSpec.environmentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Load saved variable chain from flow spec (user-provided during setup)
    if (flowSpec.variableChain && typeof flowSpec.variableChain === 'object') {
      for (const [key, value] of Object.entries(flowSpec.variableChain)) {
        if (key && value !== undefined && value !== null) {
          ctx[key] = value;
        }
      }
      if (Object.keys(flowSpec.variableChain).length > 0) {
        logger.info('[FLOW_EXECUTOR] Loaded saved variable chain', {
          variableNames: Object.keys(flowSpec.variableChain),
        });
      }
    }

    // Inject user-provided variables from this run (tokens, API keys, credentials)
    // These override saved variable chain values
    if (request.initialVariables && typeof request.initialVariables === 'object') {
      for (const [key, value] of Object.entries(request.initialVariables)) {
        if (key && value !== undefined && value !== null) {
          ctx[key] = value;
        }
      }
      logger.info('[FLOW_EXECUTOR] Injected user-provided variables', {
        variableNames: Object.keys(request.initialVariables),
      });
    }

    // Build node map for quick access
    const nodeMap = new Map(dag.nodes.map(n => [n.id, n]));

    // Track results per step
    const stepResults: FlowStepResult[] = [];
    const skippedNodes = new Set<string>();
    const failedNodes = new Set<string>();
    let variablesResolved = 0;
    let authNodeId: string | undefined = dag.nodes.find(n => n.isAuthEndpoint)?.id;

    // Set up total timeout
    const totalTimer = setTimeout(() => abortController.abort(), config.totalTimeoutMs);

    const emit = (event: string, payload: any) => {
      if (!chatSessionId) return;
      (webSocketService as any)[event]?.(chatSessionId, payload);
    };

    // Stable stepIndex per node = its position in executionOrder (preserves
    // report ordering even though parallel groups complete out of order).
    const stepIndexOf = new Map<string, number>();
    dag.executionOrder.forEach((id, i) => stepIndexOf.set(id, i));

    const baseUrl = flowSpec.rawSpec?.servers?.[0]?.url
      || (flowSpec.rawSpec?.host
        ? `${(flowSpec.rawSpec.schemes?.[0] || 'https')}://${flowSpec.rawSpec.host}${flowSpec.rawSpec.basePath || ''}`
        : '');

    const skippedRow = (
      node: DAGNode,
      stepIndex: number,
      status: 'skipped' | 'cancelled',
      reason: 'unsupported' | 'dependency_failed' | 'cancelled',
      message: string,
    ): void => {
      skippedNodes.add(node.id);
      stepResults.push({
        nodeId: node.id,
        stepIndex,
        status,
        method: node.method,
        path: node.path,
        resolvedUrl: '',
        requestHeaders: {},
        durationMs: 0,
        variablesInjected: [],
        variablesExtracted: [],
        error: message,
        retryCount: 0,
      });
      emit('emitApiFlowStepSkipped', {
        flowSpecId: flowSpec.id,
        flowRunId,
        sessionId: chatSessionId || '',
        stepIndex,
        nodeId: node.id,
        reason,
        status,
        message,
        timestamp: new Date().toISOString(),
      });
    };

    /**
     * Run a single node end-to-end: build → emit start → retry loop
     * (429/401) → extract variables → emit complete → persist. Pushes its
     * result to stepResults and tracks failure. Safe to call concurrently for
     * nodes in the SAME parallel group: such nodes never depend on each other
     * (topological-level grouping), so their ctx writes touch disjoint keys.
     */
    /**
     * Case Matrix (Group 5): run a node's N enabled cases concurrently. Each
     * case is judged against ITS OWN expected status codes (so "wrong password
     * → 401" passes on 401). Cases share the node's upstream ctx but produce NO
     * downstream variables (leaf test). The parent node aggregates: passed only
     * if every enabled case passed. Each case is emitted/persisted/tracked as a
     * step result tagged with caseId/caseName (nodeId stays the parent).
     */
    const runCaseMatrix = async (node: DAGNode, stepIndex: number): Promise<void> => {
      const nodeId = node.id;
      const enabledCases = (node.cases || []).filter(c => c.enabled !== false);

      const runOneCase = async (c: NodeCase): Promise<void> => {
        const { resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected } = buildResolvedRequest(
          node, baseUrl, ctx, { requestBody: c.requestBody, queryParams: c.queryParams, headers: c.headers },
        );

        emit('emitApiFlowStepStart', {
          flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
          stepIndex, nodeId, caseId: c.id, caseName: c.name,
          method: node.method, path: node.path, resolvedUrl, variablesInjected,
          timestamp: new Date().toISOString(),
        });

        const result = await FlowExecutorService.executeStep(
          node, resolvedUrl, resolvedHeaders, resolvedBody, stepIndex, flowRunId,
          config, abortController.signal, c.expectedStatusCodes,
        );
        result.caseId = c.id;
        result.caseName = c.name;
        result.nodeId = nodeId;
        result.stepIndex = stepIndex;
        result.variablesInjected = variablesInjected;
        result.variablesExtracted = []; // leaf — never produces downstream vars
        stepResults.push(result);

        emit('emitApiFlowStepComplete', {
          flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
          stepIndex, nodeId, caseId: c.id, caseName: c.name,
          success: result.status === 'passed',
          statusCode: result.responseStatus || 0,
          durationMs: result.durationMs,
          variablesExtracted: [],
          error: result.error,
          timestamp: new Date().toISOString(),
        });

        if (result.responseStatus !== undefined) {
          try {
            await ApiTestStorageService.saveApiTestExecution({
              userId,
              testId: randomUUID(),
              chatSessionId,
              request: { method: node.method, url: result.resolvedUrl, headers: result.requestHeaders, body: result.requestBody },
              response: {
                status: result.responseStatus || 0,
                statusText: String(result.responseStatus || 0),
                headers: result.responseHeaders,
                body: result.responseBody,
                durationMs: result.durationMs,
              },
              success: result.status === 'passed',
              errorMessage: result.error,
              // case identity lives in the run summary's stepResults (caseId);
              // api_test_executions has no case_id column, so we don't pass one.
              metadata: { flow_spec_id: flowSpec.id, flow_run_id: flowRunId, flow_step_index: stepIndex },
            });
          } catch (err) {
            logger.warn('[FLOW_EXECUTOR] Failed to save case to api_test_executions', { err });
          }
        }
      };

      // Run cases concurrently (bounded by the same group cap).
      await runWithConcurrency(enabledCases.map(c => () => runOneCase(c)), MAX_GROUP_CONCURRENCY);

      // Aggregate → parent node fails if ANY enabled case failed.
      const caseResults = stepResults.filter(r => r.caseId && r.stepIndex === stepIndex);
      const anyFailed = caseResults.some(r => r.status !== 'passed');
      if (anyFailed) failedNodes.add(nodeId);
    };

    const runNode = async (node: DAGNode, stepIndex: number): Promise<void> => {
      // Case Matrix: if this node has enabled cases, run them instead of a single call.
      if ((node.cases || []).some(c => c.enabled !== false)) {
        return runCaseMatrix(node, stepIndex);
      }

      const nodeId = node.id;
      const override = request.nodeOverrides?.[nodeId];
      const { resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected } = buildResolvedRequest(
        node, baseUrl, ctx, override,
      );

      emit('emitApiFlowStepStart', {
        flowSpecId: flowSpec.id,
        flowRunId,
        sessionId: chatSessionId || '',
        stepIndex,
        nodeId,
        method: node.method,
        path: node.path,
        resolvedUrl,
        variablesInjected,
        timestamp: new Date().toISOString(),
      });

      let stepResult: FlowStepResult | null = null;
      let retryCount = 0;
      const maxRetries = config.errorStrategy === 'retry_then_skip' ? config.maxRetries : 2;

      while (retryCount < maxRetries) {
        const result = await FlowExecutorService.executeStep(
          node, resolvedUrl, resolvedHeaders, resolvedBody, stepIndex, flowRunId, config, abortController.signal,
        );

        // 429 rate limit
        if (result.responseStatus === 429) {
          const waitMs = parseRetryAfter(result.responseHeaders || {});
          logger.info('[FLOW_EXECUTOR] Rate limited — waiting', { waitMs, nodeId });
          await sleepMs(waitMs);
          retryCount++;
          if (retryCount < maxRetries) {
            emit('emitApiFlowStepRetrying', {
              flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
              stepIndex, nodeId, attempt: retryCount, maxRetries,
              reason: 'rate_limited', timestamp: new Date().toISOString(),
            });
            continue;
          }
        }

        // 401 auth refresh (skip when this IS the auth node)
        if (result.responseStatus === 401 && authNodeId && node.id !== authNodeId) {
          logger.info('[FLOW_EXECUTOR] 401 detected — re-executing auth endpoint', { authNodeId });
          const authNode = nodeMap.get(authNodeId)!;
          const authOverride = request.nodeOverrides?.[authNodeId];
          const { resolvedUrl: authUrl, resolvedHeaders: authHeaders, resolvedBody: authBody } = buildResolvedRequest(
            authNode, baseUrl, ctx, authOverride,
          );
          const authResult = await FlowExecutorService.executeStep(
            authNode, authUrl, authHeaders, authBody, -1, flowRunId, config, abortController.signal,
          );
          if (authResult.status === 'passed') {
            for (const ext of authNode.variableExtractions) {
              const value = extractVariable(authResult.responseBody, authResult.responseHeaders || {}, ext);
              if (value !== undefined) {
                ctx[ext.variableName] = value;
                variablesResolved++;
              }
            }
            retryCount++;
            if (retryCount < maxRetries) {
              emit('emitApiFlowStepRetrying', {
                flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
                stepIndex, nodeId, attempt: retryCount, maxRetries,
                reason: 'auth_refresh', timestamp: new Date().toISOString(),
              });
              continue;
            }
          }
        }

        stepResult = result;
        break;
      }

      if (!stepResult) {
        stepResult = {
          nodeId, stepIndex, status: 'failed', method: node.method, path: node.path,
          resolvedUrl, requestHeaders: resolvedHeaders, requestBody: resolvedBody,
          durationMs: 0, variablesInjected, variablesExtracted: [],
          error: 'Max retries exceeded', retryCount,
        };
      }

      const finalStepResult = stepResult!;
      // Stamp identity defensively — report ordering & dedup rely on these even
      // if a future executeStep variant forgets to set them.
      finalStepResult.stepIndex = stepIndex;
      finalStepResult.nodeId = nodeId;
      finalStepResult.retryCount = retryCount;

      // Extract variables. Within a group, nodes don't read each other's outputs
      // (no intra-group dependency), so writing into the shared ctx here is safe.
      const extractedThisStep: Array<{ name: string; value: string }> = [];
      if (finalStepResult.status === 'passed' || finalStepResult.status === 'failed') {
        for (const ext of node.variableExtractions) {
          const value = extractVariable(finalStepResult.responseBody, finalStepResult.responseHeaders || {}, ext);
          if (value !== undefined) {
            ctx[ext.variableName] = value;
            variablesResolved++;
            extractedThisStep.push({ name: ext.variableName, value });
            // Safe across groups: a hard barrier separates groups, so an auth
            // node at level N has fully set authNodeId before level N+1 reads it
            // for 401-refresh. (A same-group auth+protected pair would imply a
            // missing dependency edge from the builder, not an executor fault.)
            if (node.isAuthEndpoint) authNodeId = node.id;
            emit('emitApiFlowVariableExtracted', {
              flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
              nodeId, stepIndex, variableName: ext.variableName,
              extractedFrom: `${node.method} ${node.path} → ${ext.jsonPath || ext.headerSource || ext.regex}`,
              value: maskValue(ext.variableName, value),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      finalStepResult.variablesExtracted = extractedThisStep;
      finalStepResult.variablesInjected = variablesInjected;
      stepResults.push(finalStepResult);

      emit('emitApiFlowStepComplete', {
        flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
        stepIndex, nodeId,
        success: finalStepResult.status === 'passed',
        statusCode: finalStepResult.responseStatus || 0,
        durationMs: finalStepResult.durationMs,
        variablesExtracted: extractedThisStep,
        error: finalStepResult.error,
        timestamp: new Date().toISOString(),
      });

      if (finalStepResult.status === 'failed') failedNodes.add(nodeId);

      if (finalStepResult.responseStatus !== undefined) {
        try {
          await ApiTestStorageService.saveApiTestExecution({
            userId,
            testId: randomUUID(),
            chatSessionId,
            request: {
              method: node.method,
              url: finalStepResult.resolvedUrl,
              headers: finalStepResult.requestHeaders,
              body: finalStepResult.requestBody,
            },
            response: {
              status: finalStepResult.responseStatus || 0,
              statusText: String(finalStepResult.responseStatus || 0),
              headers: finalStepResult.responseHeaders,
              body: finalStepResult.responseBody,
              durationMs: finalStepResult.durationMs,
            },
            success: finalStepResult.status === 'passed',
            errorMessage: finalStepResult.error,
            metadata: {
              flow_spec_id: flowSpec.id,
              flow_run_id: flowRunId,
              flow_step_index: stepIndex,
            },
          });
        } catch (err) {
          logger.warn('[FLOW_EXECUTOR] Failed to save step to api_test_executions', { err });
        }
      }
    };

    // Execution order: group nodes by topological level so independent nodes run
    // concurrently. Fall back to one-node-per-group (pure sequential) if the DAG
    // didn't provide parallelGroups — preserves legacy behavior.
    //
    // COVERAGE GUARD: parallelGroups is persisted in the spec and can be edited /
    // reparsed independently of executionOrder. If a node appears in
    // executionOrder but is missing from parallelGroups, the old sequential loop
    // would still have run it — so we must too. Any uncovered node is appended as
    // its own trailing group (run last, sequentially) rather than silently dropped.
    let groups: string[][];
    if (Array.isArray(dag.parallelGroups) && dag.parallelGroups.length > 0) {
      groups = dag.parallelGroups.map(g => [...g]);
      const covered = new Set(groups.flat());
      const missing = dag.executionOrder.filter(id => !covered.has(id));
      if (missing.length > 0) {
        logger.warn('[FLOW_EXECUTOR] parallelGroups missing nodes from executionOrder — appending', {
          flowRunId, missing,
        });
        for (const id of missing) groups.push([id]);
      }
    } else {
      groups = dag.executionOrder.map(id => [id]);
    }

    const markRemainingCancelled = (fromGroupIdx: number): void => {
      for (let g = fromGroupIdx; g < groups.length; g++) {
        for (const id of groups[g]) {
          if (skippedNodes.has(id) || failedNodes.has(id)) continue;
          const n = nodeMap.get(id);
          if (!n) continue;
          if (stepResults.some(r => r.nodeId === id)) continue;
          skippedRow(n, stepIndexOf.get(id) ?? 0, 'cancelled', 'cancelled', 'Cancelled by user');
        }
      }
    };

    try {
      for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
        // Cancellation — stop launching groups; mark this + later groups cancelled.
        if (abortController.signal.aborted) {
          logger.info('[FLOW_EXECUTOR] Flow cancelled', { flowRunId });
          markRemainingCancelled(groupIdx);
          break;
        }

        // Pacing: one rate-limit delay before each group after the first.
        if (groupIdx > 0) await sleepMs(config.rateLimitDelayMs);

        // Resolve which nodes in this group are runnable vs skipped up front.
        const runnable: DAGNode[] = [];
        for (const id of groups[groupIdx]) {
          const node = nodeMap.get(id);
          if (!node) continue;
          const stepIndex = stepIndexOf.get(id) ?? 0;

          if (node.isUnsupported) {
            skippedRow(node, stepIndex, 'skipped', 'unsupported', `Unsupported: ${node.unsupportedReason}`);
            continue;
          }
          const depFailed = node.dependsOn.some(dep => failedNodes.has(dep) || skippedNodes.has(dep));
          if (depFailed && config.errorStrategy !== 'continue_on_failure') {
            skippedRow(node, stepIndex, 'skipped', 'dependency_failed', 'Skipped: dependency failed');
            continue;
          }
          runnable.push(node);
        }

        // Run the group concurrently (bounded). One node's throw doesn't tear
        // down its siblings — we let the group finish, then decide.
        if (runnable.length > 0) {
          await runWithConcurrency(
            runnable.map(node => () => runNode(node, stepIndexOf.get(node.id) ?? 0)),
            MAX_GROUP_CONCURRENCY,
          );
        }

        // stop_on_failure: if anything failed in (or before) this group, stop
        // launching later groups and mark them cancelled.
        if (config.errorStrategy === 'stop_on_failure' && failedNodes.size > 0) {
          markRemainingCancelled(groupIdx + 1);
          break;
        }
      }
    } finally {
      clearTimeout(totalTimer);
      activeRuns.delete(flowRunId);
    }

    // Parallel groups complete out of order — restore report ordering.
    stepResults.sort((a, b) => a.stepIndex - b.stepIndex);

    // Build summary — 'cancelled' steps roll up under the skipped count for the
    // summary card (they were not executed); the per-node status is still distinct.
    const passed = stepResults.filter(r => r.status === 'passed').length;
    const failed = stepResults.filter(r => r.status === 'failed').length;
    const skipped = stepResults.filter(r => r.status === 'skipped' || r.status === 'cancelled').length;
    const totalDurationMs = stepResults.reduce((sum, r) => sum + r.durationMs, 0);
    const runStatus: FlowRunStatus = abortController.signal.aborted
      ? 'cancelled'
      : failed > 0 ? 'failed' : 'completed';

    const summary: FlowRunSummary = {
      flowRunId,
      flowSpecId: flowSpec.id,
      status: runStatus,
      total: stepResults.length,
      passed,
      failed,
      skipped,
      totalDurationMs,
      variablesResolved,
      stepResults,
      startedAt,
      completedAt: new Date().toISOString(),
    };

    // Update run record
    await updateFlowRun(flowRunId, {
      status: runStatus,
      summary,
      completedAt: summary.completedAt,
    });

    // Update flow spec last run
    await FlowBuilderService.markRunStatus(flowSpec.id, flowRunId, runStatus);

    // Emit final event
    if (chatSessionId) {
      if (runStatus === 'failed' || runStatus === 'cancelled') {
        const firstFailed = stepResults.find(r => r.status === 'failed');
        emit('emitApiFlowFailed', {
          flowSpecId: flowSpec.id,
          flowRunId,
          sessionId: chatSessionId,
          error: runStatus === 'cancelled' ? 'Flow cancelled by user' : 'Flow completed with failures',
          failedAtStep: firstFailed?.stepIndex,
          failedAtNodeId: firstFailed?.nodeId,
          timestamp: new Date().toISOString(),
        });
      } else {
        emit('emitApiFlowCompleted', {
          flowSpecId: flowSpec.id,
          flowRunId,
          sessionId: chatSessionId,
          summary: {
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            skipped: summary.skipped,
            totalDurationMs: summary.totalDurationMs,
            variablesResolved: summary.variablesResolved,
          },
          timestamp: new Date().toISOString(),
        });
      }
    }

    logger.info('[FLOW_EXECUTOR] Flow execution completed', {
      flowRunId,
      status: runStatus,
      passed,
      failed,
      skipped,
      totalDurationMs,
    });

    return summary;
  }

  /**
   * Execute a single step (HTTP request with timeout)
   */
  private static async executeStep(
    node: DAGNode,
    resolvedUrl: string,
    headers: Record<string, string>,
    body: any,
    stepIndex: number,
    flowRunId: string,
    config: FlowExecutionConfig,
    abortSignal?: AbortSignal,
    // Case-matrix override: a case judges pass/fail against ITS own expected
    // codes, not the node's. Falls back to the node's when not provided.
    expectedStatusOverride?: number[],
  ): Promise<FlowStepResult> {
    const startTime = Date.now();
    const expected = expectedStatusOverride?.length ? expectedStatusOverride : node.expectedStatusCodes;

    try {
      const response = await executeApiTest({
        method: node.method,
        url: resolvedUrl,
        headers,
        body: ['POST', 'PUT', 'PATCH'].includes(node.method) ? body : undefined,
        timeout: config.stepTimeoutMs,
        expectedStatus: expected?.[0] ?? 200,
        signal: abortSignal,
      });

      const durationMs = Date.now() - startTime;
      const expectedCodes = expected?.length ? expected : [200, 201];
      const success = response.success || expectedCodes.includes(response.status);

      return {
        nodeId: node.id,
        stepIndex,
        status: success ? 'passed' : 'failed',
        method: node.method,
        path: node.path,
        resolvedUrl,
        requestHeaders: headers,
        requestBody: body,
        responseStatus: response.status,
        responseBody: response.responseBody,
        responseHeaders: response.responseHeaders,
        durationMs,
        variablesInjected: [],
        variablesExtracted: [],
        error: success ? undefined : `Expected ${expectedCodes.join('/')} but got ${response.status}${response.error ? ': ' + response.error : ''}`,
        retryCount: 0,
      };
    } catch (error: any) {
      return {
        nodeId: node.id,
        stepIndex,
        status: 'failed',
        method: node.method,
        path: node.path,
        resolvedUrl,
        requestHeaders: headers,
        requestBody: body,
        durationMs: Date.now() - startTime,
        variablesInjected: [],
        variablesExtracted: [],
        error: error.message || 'Request failed',
        retryCount: 0,
      };
    }
  }
}
