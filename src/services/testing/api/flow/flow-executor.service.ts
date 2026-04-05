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

    try {
      for (let stepIndex = 0; stepIndex < dag.executionOrder.length; stepIndex++) {
        // Check cancellation
        if (abortController.signal.aborted) {
          logger.info('[FLOW_EXECUTOR] Flow cancelled', { flowRunId });
          break;
        }

        const nodeId = dag.executionOrder[stepIndex];
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        // Skip unsupported nodes
        if (node.isUnsupported) {
          stepResults.push({
            nodeId,
            stepIndex,
            status: 'skipped',
            method: node.method,
            path: node.path,
            resolvedUrl: '',
            requestHeaders: {},
            durationMs: 0,
            variablesInjected: [],
            variablesExtracted: [],
            error: `Unsupported: ${node.unsupportedReason}`,
            retryCount: 0,
          });
          continue;
        }

        // Skip if dependencies failed (stop_on_failure / retry_then_skip)
        const hasFailed = node.dependsOn.some(dep => failedNodes.has(dep) || skippedNodes.has(dep));
        if (hasFailed && config.errorStrategy !== 'continue_on_failure') {
          skippedNodes.add(nodeId);
          stepResults.push({
            nodeId,
            stepIndex,
            status: 'skipped',
            method: node.method,
            path: node.path,
            resolvedUrl: '',
            requestHeaders: {},
            durationMs: 0,
            variablesInjected: [],
            variablesExtracted: [],
            error: 'Skipped: dependency failed',
            retryCount: 0,
          });
          continue;
        }

        // Rate limit delay
        if (stepIndex > 0) await sleepMs(config.rateLimitDelayMs);

        // Build request
        const override = request.nodeOverrides?.[nodeId];
        const baseUrl = flowSpec.rawSpec?.servers?.[0]?.url
          || (flowSpec.rawSpec?.host
            ? `${(flowSpec.rawSpec.schemes?.[0] || 'https')}://${flowSpec.rawSpec.host}${flowSpec.rawSpec.basePath || ''}`
            : '');
        const { resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected } = buildResolvedRequest(
          node,
          baseUrl,
          ctx,
          override,
        );

        // Emit step start
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

        // Execute with retry logic
        let stepResult: FlowStepResult | null = null;
        let retryCount = 0;
        // Always allow at least 2 attempts: 1 original + 1 for 401 auth refresh
        const maxRetries = config.errorStrategy === 'retry_then_skip' ? config.maxRetries : 2;

        while (retryCount < maxRetries) {
          const result = await FlowExecutorService.executeStep(
            node,
            resolvedUrl,
            resolvedHeaders,
            resolvedBody,
            stepIndex,
            flowRunId,
            config,
            abortController.signal,
          );

          // Handle 429 rate limit
          if (result.responseStatus === 429) {
            const waitMs = parseRetryAfter(result.responseHeaders || {});
            logger.info('[FLOW_EXECUTOR] Rate limited — waiting', { waitMs, nodeId });
            await sleepMs(waitMs);
            retryCount++;
            if (retryCount < maxRetries) continue;
          }

          // Handle 401 auth refresh (if there's an auth node and this is not the auth node itself)
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
              // Re-extract auth variables
              for (const ext of authNode.variableExtractions) {
                const value = extractVariable(authResult.responseBody, authResult.responseHeaders || {}, ext);
                if (value !== undefined) {
                  ctx[ext.variableName] = value;
                  variablesResolved++;
                }
              }
              // Retry the original step
              retryCount++;
              continue;
            }
          }

          stepResult = result;
          break;
        }

        if (!stepResult) {
          stepResult = {
            nodeId,
            stepIndex,
            status: 'failed',
            method: node.method,
            path: node.path,
            resolvedUrl,
            requestHeaders: resolvedHeaders,
            requestBody: resolvedBody,
            durationMs: 0,
            variablesInjected,
            variablesExtracted: [],
            error: 'Max retries exceeded',
            retryCount,
          };
        }

        const finalStepResult = stepResult!;
        finalStepResult.retryCount = retryCount;

        // Extract variables from response
        const extractedThisStep: Array<{ name: string; value: string }> = [];
        if (finalStepResult.status === 'passed' || finalStepResult.status === 'failed') {
          for (const ext of node.variableExtractions) {
            const value = extractVariable(finalStepResult.responseBody, finalStepResult.responseHeaders || {}, ext);
            if (value !== undefined) {
              ctx[ext.variableName] = value;
              variablesResolved++;
              extractedThisStep.push({ name: ext.variableName, value });

              // Track auth token for refresh
              if (node.isAuthEndpoint) {
                authNodeId = node.id;
              }

              // Emit variable extracted event
              emit('emitApiFlowVariableExtracted', {
                flowSpecId: flowSpec.id,
                flowRunId,
                sessionId: chatSessionId || '',
                variableName: ext.variableName,
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

        // Emit step complete
        emit('emitApiFlowStepComplete', {
          flowSpecId: flowSpec.id,
          flowRunId,
          sessionId: chatSessionId || '',
          stepIndex,
          nodeId,
          success: finalStepResult.status === 'passed',
          statusCode: finalStepResult.responseStatus || 0,
          durationMs: finalStepResult.durationMs,
          variablesExtracted: extractedThisStep,
          error: finalStepResult.error,
          timestamp: new Date().toISOString(),
        });

        // Track failures
        if (finalStepResult.status === 'failed') {
          failedNodes.add(nodeId);
          if (config.errorStrategy === 'stop_on_failure') {
            // Skip all remaining nodes that depend on this one
            // (handled at the top of the loop via skippedNodes check)
          }
        }

        // Save to api_test_executions
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
      }
    } finally {
      clearTimeout(totalTimer);
      activeRuns.delete(flowRunId);
    }

    // Build summary
    const passed = stepResults.filter(r => r.status === 'passed').length;
    const failed = stepResults.filter(r => r.status === 'failed').length;
    const skipped = stepResults.filter(r => r.status === 'skipped').length;
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
        emit('emitApiFlowFailed', {
          flowSpecId: flowSpec.id,
          flowRunId,
          sessionId: chatSessionId,
          error: runStatus === 'cancelled' ? 'Flow cancelled by user' : 'Flow completed with failures',
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
  ): Promise<FlowStepResult> {
    const startTime = Date.now();

    try {
      const response = await executeApiTest({
        method: node.method,
        url: resolvedUrl,
        headers,
        body: ['POST', 'PUT', 'PATCH'].includes(node.method) ? body : undefined,
        timeout: config.stepTimeoutMs,
        expectedStatus: node.expectedStatusCodes?.[0] ?? 200,
        signal: abortSignal,
      });

      const durationMs = Date.now() - startTime;
      const expectedCodes = node.expectedStatusCodes?.length ? node.expectedStatusCodes : [200, 201];
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
