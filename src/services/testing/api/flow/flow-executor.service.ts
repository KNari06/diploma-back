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
import { CookieJar } from './cookie-jar';
import { computeGroupNeedsInput, buildProducersByVar } from './flow-needs-input';
import {
  requestFlowInput,
  cancelFlowInput,
  FlowInputTimeoutError,
  DEFAULT_INPUT_TIMEOUT_MS,
} from './flow-input-gate';
import { redactWithValues } from '@/utils/interpolation/redact-secrets';
import type {
  ApiFlowSpec,
  DAGNode,
  FlowErrorStrategy,
  FlowExecutionConfig,
  FlowRunSummary,
  FlowRunStatus,
  FlowStepBlockedReason,
  FlowStepResult,
  FlowStepStatus,
  NodeCase,
  RunFlowRequest,
  VariableContext,
  VariableExtraction,
  VariableInjection,
} from './flow.types';
import { BASE_URL_VAR, resolveRunBaseUrl } from './base-url';

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

const VAR_REGEX = /\{\{([\w.-]+)\}\}/g;

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
  if (typeof obj === 'string') {
    // Whole-value placeholder (the field IS exactly "{{var}}"): substitute the
    // ctx value with its ORIGINAL type — a JSON API may reject "5"/"false"
    // where a number/boolean is expected. Embedded placeholders (e.g.
    // "Bearer {{token}}") still string-interpolate.
    const whole = obj.match(/^\{\{([\w.-]+)\}\}$/);
    if (whole) {
      const v = ctx[whole[1]];
      return v === undefined || v === null ? obj : v;
    }
    return interpolate(obj, ctx);
  }
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

/**
 * Value for one injection, binding-by-reference aware.
 *
 * When the injection names a specific producer (`sourceNodeId`), read that node's
 * OWN extracted output — so a consumer bound to the admin-realm login gets the
 * admin token even if a user-realm login later overwrote the shared `auth_token`
 * slot in the flat context. Falls back to the name-keyed context when there's no
 * binding (user-provided vars, env vars, older DAGs) or the producer hasn't
 * emitted that name.
 */
function resolveInjectionValue(
  injection: VariableInjection,
  ctx: VariableContext,
  nodeOutputs?: Map<string, Record<string, any>>,
): any {
  if (injection.sourceNodeId && nodeOutputs) {
    const out = nodeOutputs.get(injection.sourceNodeId);
    if (out && injection.variableName in out) return out[injection.variableName];
  }
  return ctx[injection.variableName];
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

/**
 * Every credential value currently in the run context, longest first.
 *
 * A flow's secrets don't live under the `secrets.*` namespace that
 * `collectSecretValues` keys off — they arrive as `auth_token` / `api_key` from the
 * run dialog, or get extracted from a login response mid-run. So we collect by
 * NAME here and hand the values to the shared `redactWithValues`, rather than
 * writing a second redactor.
 */
function collectFlowSecretValues(ctx: VariableContext): string[] {
  const values: string[] = [];
  for (const [name, raw] of Object.entries(ctx)) {
    if (!SENSITIVE_PATTERNS.test(name)) continue;
    const str = raw == null ? '' : String(raw);
    if (str.length >= 4) values.push(str);
  }
  return values.sort((a, b) => b.length - a.length);
}

/**
 * Strip credential values from a step result before it leaves the process.
 *
 * Hard invariant #10: anything that emits, logs or PERSISTS an interpolated body
 * redacts first. A flow step carries live credentials in four places at once —
 * `Authorization: Bearer <jwt>` and `Cookie` headers, a login's request body, the
 * login response that minted the token, and `variablesExtracted[].value` — and all
 * four land in `api_flow_runs.summary` and `api_test_executions`.
 *
 * Value-based, not name-based: a token pasted into a query string or echoed inside
 * an unrelated response field gets caught too. Over-masking is never worse than a
 * leak.
 */
function redactStepResult(step: FlowStepResult, secretValues: readonly string[]): FlowStepResult {
  if (secretValues.length === 0) return step;
  const scrub = <T,>(v: T): T => {
    if (typeof v === 'string') return redactWithValues(v, secretValues) as unknown as T;
    if (Array.isArray(v)) return v.map(scrub) as unknown as T;
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, scrub(val)])) as unknown as T;
    }
    return v;
  };
  return {
    ...step,
    resolvedUrl: scrub(step.resolvedUrl),
    requestHeaders: scrub(step.requestHeaders),
    requestBody: scrub(step.requestBody),
    responseBody: scrub(step.responseBody),
    responseHeaders: scrub(step.responseHeaders),
    variablesExtracted: step.variablesExtracted.map(e => ({ name: e.name, value: maskValue(e.name, e.value) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST BUILDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Methods that destroy or overwrite data we did not create.
 *
 * POST is excluded on purpose: creating a resource is how a smoke run gets the ids
 * every later step needs, and it leaves what it made behind rather than removing
 * something that was already there.
 */
const DESTRUCTIVE_METHODS: ReadonlySet<string> = new Set(['DELETE', 'PUT', 'PATCH']);

export const isDestructiveMethod = (method: string): boolean => DESTRUCTIVE_METHODS.has(method.toUpperCase());

function buildResolvedRequest(
  node: DAGNode,
  baseUrl: string,
  ctx: VariableContext,
  nodeOverride?: { requestBody?: any; queryParams?: Record<string, string>; headers?: Record<string, string> },
  // Per-producer outputs for binding-by-reference injection resolution. Optional:
  // omitted (or an injection with no sourceNodeId) → name-keyed ctx lookup.
  nodeOutputs?: Map<string, Record<string, any>>,
): {
  resolvedUrl: string;
  resolvedHeaders: Record<string, string>;
  resolvedBody: any;
  variablesInjected: string[];
  unboundVariables: string[];
  unresolvedPathParams: string[];
} {
  const variablesInjected: string[] = [];
  const unboundVariables: string[] = [];
  // Header precedence (low → high): Content-Type default < node.sampleHeaders
  // (user-set in the editor, {{vars}} interpolated) < per-run nodeOverride <
  // variableInjections (applied in the loop below, e.g. Authorization).
  const resolvedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(node.sampleHeaders ? interpolateObject({ ...node.sampleHeaders }, ctx) : {}),
    ...(nodeOverride?.headers || {}),
  };
  const queryParams: Record<string, string> = { ...(nodeOverride?.queryParams || {}) };

  // Build resolved URL from base + path
  let path = node.path;

  // Apply injections
  for (const injection of node.variableInjections) {
    const rawValue = resolveInjectionValue(injection, ctx, nodeOutputs);
    if (rawValue === undefined) {
      unboundVariables.push(injection.variableName);
      logger.warn('[FLOW_EXECUTOR] Unresolved injection variable', {
        nodeId: node.id,
        variableName: injection.variableName,
        injectAs: injection.injectAs,
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

  // Anything still braced is a parameter we could not bind — `{id}` from an
  // unsatisfied path_param, or a `{{var}}` interpolate left alone. Sending it
  // would put a literal brace on the wire and score the resulting 404 against the
  // endpoint. The caller blocks the step instead.
  const unresolvedPathParams = (path.match(/\{{1,2}[^{}]+\}{1,2}/g) || []).map(m => m.replace(/[{}]/g, ''));

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
    const rawValue = resolveInjectionValue(injection, ctx, nodeOutputs);
    if (rawValue === undefined) continue;

    if (injection.injectAs === 'body_field') {
      // Ensure a plain-object container exists — otherwise the injection is
      // silently lost: a missing body no-ops, and a named prop on an array body
      // is dropped by JSON.stringify.
      if (resolvedBody === undefined || resolvedBody === null || typeof resolvedBody !== 'object' || Array.isArray(resolvedBody)) {
        resolvedBody = {};
      }
      resolvedBody[injection.targetKey] = rawValue;
    } else if (injection.injectAs === 'body_json_path') {
      // targetKey is a JSON path (e.g. "$.user.id" or "data.token"). Ensure a
      // container object exists, then set the value at the nested path,
      // creating intermediate objects as needed.
      if (resolvedBody === undefined || resolvedBody === null || typeof resolvedBody !== 'object') {
        resolvedBody = {};
      }
      setByJsonPath(resolvedBody, injection.targetKey, rawValue);
    }
  }

  return { resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected, unboundVariables, unresolvedPathParams };
}

/**
 * Set `value` at the nested `path` within `target`, creating intermediate
 * objects as needed. Accepts `$.`-prefixed JSONPath (`$.user.id`) or plain
 * dot-paths (`data.token`). Bracket segments (`a[0]`, `a['k']`) are supported.
 */
function setByJsonPath(target: Record<string, any>, path: string, value: any): void {
  const segments = path
    .replace(/^\$\.?/, '') // strip leading "$" or "$."
    .replace(/\[['"]?([^'"\]]+)['"]?\]/g, '.$1') // a[0] / a['k'] → a.0 / a.k
    .split('.')
    .filter(seg => seg.length > 0);

  if (segments.length === 0) return;

  const isIndex = (s: string) => /^\d+$/.test(s);
  const keyFor = (cursor: any, seg: string) => (Array.isArray(cursor) && isIndex(seg) ? Number(seg) : seg);

  let cursor: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = keyFor(cursor, segments[i]);
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') {
      // A numeric NEXT segment means this level is an array (`items[0]` → array),
      // not an object with a "0" key.
      cursor[key] = isIndex(segments[i + 1]) ? [] : {};
    }
    cursor = cursor[key];
  }
  cursor[keyFor(cursor, segments[segments.length - 1])] = value;
}

// Test-only surface for the otherwise-private request builder.
export const __testables = { buildResolvedRequest, setByJsonPath, extractVariable };

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
  // If the run is paused waiting for user input, unblock that await too —
  // aborting the signal alone won't wake a promise parked in the input gate.
  cancelFlowInput(runId, 'Flow cancelled by user');
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
    // Per-run cookie jar: carries Set-Cookie sessions (e.g. cookie-based login)
    // across steps so authenticated follow-up requests aren't rejected with 401.
    const cookieJar = new CookieJar();
    // Per-producer extracted values, keyed by node id. Powers binding-by-reference
    // injection: a consumer bound to a specific producer reads THAT node's output
    // here, so realm-shared names (two logins → `auth_token`) don't clobber.
    // Written alongside `ctx` at every extraction; `ctx` stays the name-keyed
    // fallback for `{{var}}` interpolation, user vars, and unbound injections.
    const nodeOutputs = new Map<string, Record<string, any>>();
    const recordOutput = (nodeId: string, name: string, value: any): void => {
      const out = nodeOutputs.get(nodeId) || {};
      out[name] = value;
      nodeOutputs.set(nodeId, out);
    };
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

    // Load saved variable chain from flow spec (user-provided during setup).
    // Skip EMPTY values: an empty variableChain entry is an unfilled "required"
    // input (surfaced by the run dialog) — seeding '' would silently resolve
    // {{var}} to nothing; leaving it out keeps the placeholder visibly unresolved.
    if (flowSpec.variableChain && typeof flowSpec.variableChain === 'object') {
      for (const [key, value] of Object.entries(flowSpec.variableChain)) {
        if (key && value !== undefined && value !== null && value !== '') {
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

    // Set up total timeout. `let` so a needs-input pause can suspend it — the
    // user's typing time must not count against the flow's execution budget.
    // `timedOut` lets the skip labeler tell a time-limit abort apart from a
    // genuine user cancel (both trip abortController).
    let timedOut = false;
    let totalTimer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.totalTimeoutMs);

    // Producers per variable + vars already asked this run — drive the mid-run
    // "needs input" pause (OTP after send, secret, unobtainable auth token).
    const producersByVar = buildProducersByVar(dag.nodes);
    const askedVars = new Set<string>();

    const emit = (event: string, payload: any) => {
      if (!chatSessionId) return;
      (webSocketService as any)[event]?.(chatSessionId, payload);
    };

    // Stable stepIndex per node = its position in executionOrder (preserves
    // report ordering even though parallel groups complete out of order).
    const stepIndexOf = new Map<string, number>();
    dag.executionOrder.forEach((id, i) => stepIndexOf.set(id, i));

    // A run-dialog / environment `{{base_url}}` override wins, else the spec's
    // own server (or, for a URL import, its origin). Empty here → no absolute URL
    // is derivable; the per-node guard below blocks the run with a clear ask
    // instead of firing requests at a relative path that throws "Invalid URL format".
    const baseUrl = resolveRunBaseUrl(flowSpec.rawSpec, flowSpec.sourceUrl, ctx[BASE_URL_VAR]);
    if (!baseUrl) {
      logger.warn('[FLOW_EXECUTOR] No base URL — every node will be blocked', {
        flowSpecId: flowSpec.id,
        sourceType: flowSpec.sourceType,
      });
    }

    const skippedRow = (
      node: DAGNode,
      stepIndex: number,
      status: 'skipped' | 'cancelled' | 'blocked',
      reason: 'unsupported' | 'dependency_failed' | 'cancelled' | 'disabled' | FlowStepBlockedReason,
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
          node, baseUrl, ctx, { requestBody: c.requestBody, queryParams: c.queryParams, headers: c.headers }, nodeOutputs,
        );

        emit('emitApiFlowStepStart', {
          flowSpecId: flowSpec.id, flowRunId, sessionId: chatSessionId || '',
          stepIndex, nodeId, caseId: c.id, caseName: c.name,
          method: node.method, path: node.path, resolvedUrl, variablesInjected,
          timestamp: new Date().toISOString(),
        });

        const result = await FlowExecutorService.executeStep(
          node, resolvedUrl, resolvedHeaders, resolvedBody, stepIndex, flowRunId,
          config, abortController.signal, c.expectedStatusCodes, cookieJar,
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
            const persisted = redactStepResult(result, collectFlowSecretValues(ctx));
            await ApiTestStorageService.saveApiTestExecution({
              userId,
              testId: randomUUID(),
              chatSessionId,
              request: { method: node.method, url: persisted.resolvedUrl, headers: persisted.requestHeaders, body: persisted.requestBody },
              response: {
                status: persisted.responseStatus || 0,
                statusText: String(persisted.responseStatus || 0),
                headers: persisted.responseHeaders,
                body: persisted.responseBody,
                durationMs: persisted.durationMs,
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
      const failedCount = caseResults.filter(r => r.status !== 'passed').length;
      const anyFailed = failedCount > 0;
      if (anyFailed) failedNodes.add(nodeId);

      // Push a PARENT aggregate row (no caseId) so the node — not its cases —
      // is what summary counts and frontend reconcile see. Without this the
      // node's status/counts would be derived per-case and mis-render.
      stepResults.push({
        nodeId,
        stepIndex,
        status: anyFailed ? 'failed' : 'passed',
        method: node.method,
        path: node.path,
        resolvedUrl: '',
        requestHeaders: {},
        durationMs: caseResults.reduce((sum, r) => sum + (r.durationMs || 0), 0),
        variablesInjected: [],
        variablesExtracted: [],
        error: anyFailed ? `${failedCount}/${caseResults.length} case(s) failed` : undefined,
        retryCount: 0,
      });
    };

    const runNode = async (node: DAGNode, stepIndex: number): Promise<void> => {
      // Case Matrix: if this node has enabled cases, run them instead of a single call.
      if ((node.cases || []).some(c => c.enabled !== false)) {
        return runCaseMatrix(node, stepIndex);
      }

      const nodeId = node.id;
      const override = request.nodeOverrides?.[nodeId];
      // `let` so the request can be REBUILT after a 401 auth-refresh updates ctx
      // — otherwise the retry re-sends the stale headers and the new bearer token
      // never lands.
      const built = buildResolvedRequest(node, baseUrl, ctx, override, nodeOutputs);
      let { resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected } = built;
      const { unboundVariables, unresolvedPathParams } = built;

      // INVARIANT: never send a request we could not finish addressing. The URL
      // would carry a literal `{id}`, and the 404 it earns would be reported as
      // this endpoint's failure instead of our unbound variable.
      if (unresolvedPathParams.length > 0) {
        const missing = unboundVariables.length ? unboundVariables.join(', ') : unresolvedPathParams.join(', ');
        skippedRow(
          node, stepIndex, 'blocked', 'unbound_variable',
          `Not attempted: no value for ${missing}. Nothing in this flow produces it — provide it as a run variable, or check the endpoint that should.`,
        );
        return;
      }

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
          node, resolvedUrl, resolvedHeaders, resolvedBody, stepIndex, flowRunId, config, abortController.signal, undefined, cookieJar,
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
            authNode, baseUrl, ctx, authOverride, nodeOutputs,
          );
          const authResult = await FlowExecutorService.executeStep(
            authNode, authUrl, authHeaders, authBody, -1, flowRunId, config, abortController.signal, undefined, cookieJar,
          );
          if (authResult.status === 'passed') {
            for (const ext of authNode.variableExtractions) {
              const value = extractVariable(authResult.responseBody, authResult.responseHeaders || {}, ext);
              if (value !== undefined) {
                ctx[ext.variableName] = value;
                recordOutput(authNodeId, ext.variableName, value);
                variablesResolved++;
              }
            }
            // Rebuild the request so the refreshed token (and any cookie) lands
            // on the retry instead of re-sending the stale headers.
            ({ resolvedUrl, resolvedHeaders, resolvedBody, variablesInjected } = buildResolvedRequest(
              node, baseUrl, ctx, override, nodeOutputs,
            ));
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
            recordOutput(nodeId, ext.variableName, value);
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
          const persisted = redactStepResult(finalStepResult, collectFlowSecretValues(ctx));
          await ApiTestStorageService.saveApiTestExecution({
            userId,
            testId: randomUUID(),
            chatSessionId,
            request: {
              method: node.method,
              url: persisted.resolvedUrl,
              headers: persisted.requestHeaders,
              body: persisted.requestBody,
            },
            response: {
              status: persisted.responseStatus || 0,
              statusText: String(persisted.responseStatus || 0),
              headers: persisted.responseHeaders,
              body: persisted.responseBody,
              durationMs: persisted.durationMs,
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

    // Mark every not-yet-run node in the remaining groups as not-attempted, with a
    // label that reflects WHY the run stopped — a user cancel, a time-limit abort,
    // or an earlier failure under stop-on-error — instead of always "Cancelled by
    // user". A stop-on-error halt is a SKIP (the run moved on without it), not a
    // cancel; only a real user cancel is "Cancelled by user".
    const REMAINING_SKIP: Record<
      'user_cancel' | 'timeout' | 'stopped_on_error',
      { status: 'skipped' | 'cancelled'; reason: 'cancelled' | 'dependency_failed'; message: string }
    > = {
      user_cancel: { status: 'cancelled', reason: 'cancelled', message: 'Cancelled by user' },
      timeout: { status: 'cancelled', reason: 'cancelled', message: 'Not attempted: the run reached its time limit before this step.' },
      stopped_on_error: { status: 'skipped', reason: 'dependency_failed', message: "Not attempted: an earlier step failed and 'Stop on error' is on." },
    };
    const markRemaining = (fromGroupIdx: number, cause: keyof typeof REMAINING_SKIP): void => {
      const { status, reason, message } = REMAINING_SKIP[cause];
      for (let g = fromGroupIdx; g < groups.length; g++) {
        for (const id of groups[g]) {
          if (skippedNodes.has(id) || failedNodes.has(id)) continue;
          const n = nodeMap.get(id);
          if (!n) continue;
          if (stepResults.some(r => r.nodeId === id)) continue;
          skippedRow(n, stepIndexOf.get(id) ?? 0, status, reason, message);
        }
      }
    };

    try {
      for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
        // Abort (user cancel or time limit) — stop launching groups; mark this +
        // later groups not-attempted with the matching reason.
        if (abortController.signal.aborted) {
          logger.info('[FLOW_EXECUTOR] Run aborted', { flowRunId, cause: timedOut ? 'timeout' : 'user_cancel' });
          markRemaining(groupIdx, timedOut ? 'timeout' : 'user_cancel');
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

          if (!baseUrl) {
            skippedRow(
              node, stepIndex, 'blocked', 'unbound_variable',
              'Not attempted: this flow has no base URL. The imported spec declares no absolute server, so requests have nowhere to go. Set {{base_url}} in the run dialog (e.g. https://api.example.com) or link an environment.',
            );
            continue;
          }
          if (node.disabled) {
            skippedRow(node, stepIndex, 'skipped', 'disabled', 'Disabled — turned off in the editor');
            continue;
          }
          if (node.isUnsupported) {
            skippedRow(node, stepIndex, 'skipped', 'unsupported', `Unsupported: ${node.unsupportedReason}`);
            continue;
          }
          if (!request.allowDestructive && isDestructiveMethod(node.method)) {
            skippedRow(
              node, stepIndex, 'blocked', 'destructive_not_consented',
              `Not attempted: ${node.method} can destroy data on this host. Enable destructive operations for this run to include it.`,
            );
            continue;
          }
          const depFailed = node.dependsOn.some(dep => failedNodes.has(dep) || skippedNodes.has(dep));
          if (depFailed && config.errorStrategy !== 'continue_on_failure') {
            skippedRow(node, stepIndex, 'skipped', 'dependency_failed', 'Skipped: dependency failed');
            continue;
          }
          runnable.push(node);
        }

        // Pause & ask for anything the platform can't obtain itself (an OTP just
        // sent, a secret, an auth token whose login failed) BEFORE running the
        // nodes that need it — rather than firing doomed requests that 401 and
        // cascade-block the rest of the flow. Only possible with a WS channel to
        // ask over; headless runs fall through and fail as before.
        if (runnable.length > 0 && chatSessionId && !abortController.signal.aborted) {
          const needed = computeGroupNeedsInput(runnable, {
            ctx,
            producersByVar,
            isFailedOrSkipped: id => failedNodes.has(id) || skippedNodes.has(id),
            alreadyAsked: askedVars,
          });
          if (needed.length > 0) {
            emit('emitApiFlowNeedsInput', {
              flowSpecId: flowSpec.id,
              flowRunId,
              sessionId: chatSessionId,
              nodeId: runnable[0]?.id,
              questions: needed,
              timestamp: new Date().toISOString(),
            });
            clearTimeout(totalTimer); // don't bill the user's typing time to the run budget
            try {
              const provided = await requestFlowInput(flowRunId, needed, { timeoutMs: DEFAULT_INPUT_TIMEOUT_MS });
              for (const [k, v] of Object.entries(provided)) {
                if (v !== undefined && v !== null && String(v) !== '') {
                  ctx[k] = String(v);
                  // Mark asked ONLY once actually answered — a blank/skipped value
                  // stays askable, so a later group that needs it can re-prompt
                  // (a mistyped-then-cleared OTP isn't permanently locked out).
                  askedVars.add(k);
                }
              }
              logger.info('[FLOW_EXECUTOR] Resumed after user input', { flowRunId, provided: Object.keys(provided) });
            } catch (err) {
              // Timeout → nobody answered, abort. Cancellation already aborted via cancelFlowRun.
              if (err instanceof FlowInputTimeoutError) {
                logger.warn('[FLOW_EXECUTOR] Input wait timed out — aborting run', { flowRunId });
                timedOut = true; // a no-answer pause is a time-limit abort, not a user cancel
                abortController.abort();
              }
            } finally {
              if (!abortController.signal.aborted) {
                totalTimer = setTimeout(() => { timedOut = true; abortController.abort(); }, config.totalTimeoutMs);
              }
            }
            if (abortController.signal.aborted) {
              markRemaining(groupIdx, timedOut ? 'timeout' : 'user_cancel');
              break;
            }
          }
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
        // launching later groups and mark them skipped (the run halted after a
        // failure — not a user cancel).
        if (config.errorStrategy === 'stop_on_failure' && failedNodes.size > 0) {
          markRemaining(groupIdx + 1, 'stopped_on_error');
          break;
        }
      }
    } finally {
      clearTimeout(totalTimer);
      activeRuns.delete(flowRunId);
    }

    // Parallel groups complete out of order — restore report ordering.
    stepResults.sort((a, b) => a.stepIndex - b.stepIndex);

    // Build summary — counts are PER-NODE, not per-case: case rows (caseId set)
    // nest under their parent's aggregate row, so we exclude them from the
    // node-level tallies to avoid inflating total/passed/failed.
    // 'cancelled' rolls up under skipped (not executed); per-node status stays distinct.
    const nodeRows = stepResults.filter(r => !r.caseId);
    const passed = nodeRows.filter(r => r.status === 'passed').length;
    const failed = nodeRows.filter(r => r.status === 'failed').length;
    // 'blocked' is counted apart from both: it is our own gap, not an API verdict,
    // so it must never inflate `failed` (a false bug report) nor hide in `skipped`
    // (which means "a dependency already failed"). It is the coverage debt.
    const blocked = nodeRows.filter(r => r.status === 'blocked').length;
    const skipped = nodeRows.filter(r => r.status === 'skipped' || r.status === 'cancelled').length;
    // Sum over node rows only: a parent aggregate row's durationMs is already the
    // sum of its case rows, so summing all rows would double-count case durations.
    const totalDurationMs = nodeRows.reduce((sum, r) => sum + r.durationMs, 0);
    const runStatus: FlowRunStatus = abortController.signal.aborted
      ? 'cancelled'
      : failed > 0 ? 'failed' : 'completed';

    const summary: FlowRunSummary = {
      flowRunId,
      flowSpecId: flowSpec.id,
      status: runStatus,
      total: nodeRows.length,
      passed,
      failed,
      blocked,
      skipped,
      totalDurationMs,
      variablesResolved,
      // Redact ONCE, here: this array is the sole feed for the persisted
      // `api_flow_runs.summary`, the returned summary and the completion emit. The
      // live values stay in `ctx`, which never leaves the process.
      stepResults: stepResults.map(s => redactStepResult(s, collectFlowSecretValues(ctx))),
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
        // Prefer a node row (not a case row) so failedAtNodeId points to the node.
        const firstFailed = nodeRows.find(r => r.status === 'failed');
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
    // Per-run cookie jar: replays stored session cookies and captures Set-Cookie.
    cookieJar?: CookieJar,
  ): Promise<FlowStepResult> {
    const startTime = Date.now();
    const expected = expectedStatusOverride?.length ? expectedStatusOverride : node.expectedStatusCodes;

    // Attach stored cookies for this URL, unless the request already sets Cookie.
    let requestHeaders = headers;
    if (cookieJar) {
      const hasExplicitCookie = Object.keys(headers).some(k => k.toLowerCase() === 'cookie');
      if (!hasExplicitCookie) {
        const cookieHeader = cookieJar.cookieHeaderFor(resolvedUrl);
        if (cookieHeader) requestHeaders = { ...headers, Cookie: cookieHeader };
      }
    }

    try {
      const response = await executeApiTest({
        method: node.method,
        url: resolvedUrl,
        headers: requestHeaders,
        body: ['POST', 'PUT', 'PATCH'].includes(node.method) ? body : undefined,
        timeout: config.stepTimeoutMs,
        expectedStatus: expected?.[0] ?? 200,
        signal: abortSignal,
      });

      // Capture any Set-Cookie so later steps in this run stay authenticated.
      // Use ONLY the un-folded array (Headers.getSetCookie); the folded
      // responseHeaders string can't be split reliably (a value with ", token="
      // would fracture into a bogus cookie).
      if (response.setCookies?.length) cookieJar?.storeFromSetCookie(resolvedUrl, response.setCookies);

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
        requestHeaders,
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
        requestHeaders,
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
