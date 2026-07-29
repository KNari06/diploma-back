/**
 * ═══════════════════════════════════════════════════════════════════════════
 * API FLOW TYPES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * All TypeScript interfaces for the API Flow Testing feature.
 * Covers: spec parsing, DAG, variable chain, execution, visualization.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE FORMAT
// ─────────────────────────────────────────────────────────────────────────────

export type ApiSpecSourceType =
  | 'openapi_url'
  | 'openapi_file'
  | 'postman'
  | 'curl'
  | 'har'
  | 'insomnia'
  | 'graphql'
  | 'raml'
  | 'python';

// ─────────────────────────────────────────────────────────────────────────────
// PARSED SPEC (unified format — all adapters output this)
// ─────────────────────────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface ParsedParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema?: any;
  description?: string;
  example?: any;
}

export interface ParsedRequestBody {
  contentType: string;
  schema?: any;
  required: boolean;
  example?: any;
}

export interface ParsedResponse {
  description: string;
  schema?: any;
  example?: any;
}

export interface AuthScheme {
  name: string;
  type: 'bearer' | 'apiKey' | 'basic' | 'oauth2' | 'openIdConnect' | 'none';
  in?: 'header' | 'query' | 'cookie';
  headerName?: string;
  description?: string;
}

export interface ParsedEndpoint {
  operationId: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters: ParsedParameter[];
  requestBody?: ParsedRequestBody;
  responses: Record<string, ParsedResponse>; // key = status code (e.g. "200", "201")
  security: string[]; // auth scheme names required
  deprecated?: boolean;
  // Flagged during parsing
  hasFileUpload?: boolean;
  isPagination?: boolean;
}

export interface UnsupportedEndpoint {
  method: string;
  path: string;
  reason: 'websocket' | 'sse' | 'grpc' | 'unsupported_content_type';
}

export interface ParsedApiSpec {
  title: string;
  version: string;
  specVersion: string; // "2.0" | "3.0.x" | "3.1.x"
  baseUrl: string;
  description?: string;
  authSchemes: AuthScheme[];
  endpoints: ParsedEndpoint[];
  unsupportedEndpoints: UnsupportedEndpoint[];
  sourceType: ApiSpecSourceType;
  rawSpec?: any; // The original parsed document (for storage)
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION DAG
// ─────────────────────────────────────────────────────────────────────────────

export interface VariableExtraction {
  variableName: string; // e.g. "auth_token"
  jsonPath?: string; // e.g. "$.data.access_token"
  headerSource?: string; // e.g. "Set-Cookie" (extract from response header)
  regex?: string; // regex capture group for text responses
}

export interface VariableInjection {
  variableName: string; // must match a VariableExtraction.variableName from a prior node
  injectAs: 'header' | 'path_param' | 'query_param' | 'body_field' | 'body_json_path';
  targetKey: string; // e.g. "Authorization" for header, "userId" for body field
  prefix?: string; // e.g. "Bearer " for auth tokens
  // Binding-by-reference: the SPECIFIC producer node whose extraction feeds this
  // injection. When set, the executor reads the value from that node's own output
  // instead of the flat, name-keyed run context — so two producers that share a
  // variable name (e.g. a user-realm and an admin-realm login both extracting
  // `auth_token`) no longer overwrite each other, and a consumer always gets its
  // intended realm's value. Optional + fallback-to-name keeps older persisted DAGs
  // (and injections no pass could attribute to one producer) working unchanged.
  sourceNodeId?: string;
}

export interface DAGNode {
  id: string; // operationId or "METHOD_path"
  method: HttpMethod;
  path: string; // e.g. "/auth/login"
  operationId: string;
  summary?: string;
  tags: string[];
  dependsOn: string[]; // IDs of nodes that must run before this
  variableExtractions: VariableExtraction[];
  variableInjections: VariableInjection[];
  priority: number; // topological sort order (0 = first)
  isAuthEndpoint: boolean;
  isPagination: boolean;
  hasFileUpload: boolean;
  isUnsupported: boolean;
  unsupportedReason?: string;
  // User toggled this request off in the editor — skipped at run time (distinct
  // from `isUnsupported`, which means the endpoint can't be run at all).
  disabled?: boolean;
  canRunParallel: boolean; // can run in parallel with siblings at same priority level
  sampleRequestBody?: any; // AI-generated fake data for testing
  sampleQueryParams?: Record<string, string>;
  sampleHeaders?: Record<string, string>; // user-set request headers (applied at run time, {{vars}} interpolated)
  expectedStatusCodes: number[];
  // Case Matrix (Group 5): when present, this endpoint is tested with N cases
  // (happy / boundary / negative …) run in parallel, each with its own body +
  // expected status. A node with cases is a LEAF test — it does not extract
  // variables for downstream nodes.
  cases?: NodeCase[];
}

/**
 * One test case in a node's case matrix. Maps onto buildResolvedRequest's
 * nodeOverride shape ({requestBody, queryParams, headers}) plus its own
 * expectedStatusCodes — so e.g. a "wrong password → 401" case PASSES on 401.
 */
export interface NodeCase {
  id: string;
  name: string;
  description?: string;
  requestBody?: any;
  queryParams?: Record<string, string>;
  headers?: Record<string, string>;
  expectedStatusCodes: number[];
  source: 'ai' | 'user';
  enabled?: boolean; // default true; false → skipped at run time
}

/**
 * A variable link the builder could not statically verify. Surfaced to the user
 * so a flow that LOOKS connected doesn't silently fail at run time.
 *  - 'no_producer'      : a node injects a variable no in-flow call produces —
 *                         the user must supply it (auth_token, api_key, base_url…).
 *  - 'producer_after'   : the producing call is ordered AFTER the consumer.
 *  - 'name_collision'   : two calls extract the same variable name (last wins).
 * NOTE: this is STRUCTURAL only. It cannot catch a wrong jsonPath that points at
 * a field absent from the real response — that is knowable only at run time.
 */
export interface UnverifiedLink {
  kind: 'no_producer' | 'producer_after' | 'name_collision';
  variableName: string;
  consumerNodeId?: string;
  producerNodeId?: string;
  injectAs?: string;
  targetKey?: string;
}

/**
 * A single value the platform could not obtain on its own and must pause the run
 * to ask the user for — an out-of-band OTP after it was just sent, a secret that
 * no endpoint produces, or an auth token whose login failed. `name` is the run
 * context key the answer is injected under; `kind` drives UI copy and masking.
 */
export interface FlowInputQuestion {
  name: string;
  label: string;
  reason: string;
  kind: 'otp' | 'otp_target' | 'secret' | 'auth_token' | 'variable';
  secret?: boolean;
}

export interface ExecutionDAG {
  nodes: DAGNode[];
  executionOrder: string[]; // node IDs in topological sort order
  parallelGroups: string[][]; // groups of node IDs that can run in parallel
  summary: string; // human-readable description of the flow
  totalEndpoints: number;
  unsupportedEndpoints: UnsupportedEndpoint[];
  /** Variable links that could not be statically verified (see UnverifiedLink). */
  unverifiedLinks?: UnverifiedLink[];
}

// ─────────────────────────────────────────────────────────────────────────────
// REACT FLOW VISUALIZATION
// ─────────────────────────────────────────────────────────────────────────────

export type FlowNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped' | 'unsupported';

export interface ApiFlowNodeData {
  label: string;
  method: HttpMethod;
  path: string;
  operationId: string;
  summary?: string;
  status: FlowNodeStatus;
  stepNumber?: number;
  isAuthEndpoint: boolean;
  isPagination: boolean;
  hasFileUpload: boolean;
  isUnsupported: boolean;
  variableExtractions: VariableExtraction[];
  variableInjections: VariableInjection[];
  tags: string[];
  // DAG metadata (so frontend can reconstruct if needed)
  dependsOn?: string[];
  sampleRequestBody?: any;
  sampleQueryParams?: Record<string, string>;
  expectedStatusCodes?: number[];
  priority?: number;
  // populated after execution
  statusCode?: number;
  durationMs?: number;
  error?: string;
}

export interface ReactFlowNode {
  id: string;
  type: 'apiFlowStep';
  position: { x: number; y: number };
  data: ApiFlowNodeData;
}

export interface ReactFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string; // variable name being passed (e.g. "{{auth_token}}")
  animated: boolean;
  type?: 'smoothstep' | 'bezier' | 'straight';
  style?: Record<string, any>;
}

export interface FlowVisualization {
  nodes: ReactFlowNode[];
  edges: ReactFlowEdge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLE CONTEXT (runtime)
// ─────────────────────────────────────────────────────────────────────────────

export interface VariableContext {
  [key: string]: any;
  // Naming conventions:
  // "auth_token"          → plain value
  // "auth_token.expires_at" → expiry timestamp (ms)
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOW EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

export type FlowErrorStrategy = 'stop_on_failure' | 'continue_on_failure' | 'retry_then_skip';
export type FlowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
/**
 * `blocked` is NOT `failed`, and the distinction is the point of the whole feature:
 * `failed` means the API answered and the answer was wrong — a finding about THEIR
 * system. `blocked` means we never asked a valid question (an unbound path param, a
 * destructive call without consent) — a finding about OURS. Conflating them reports
 * our own gaps as their bugs and makes coverage unmeasurable.
 */
export type FlowStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped' | 'retrying' | 'cancelled';

/** Why a step could not be attempted. Mirrors `ApiFlowStepSkippedPayload.reason`. */
export type FlowStepBlockedReason = 'unbound_variable' | 'destructive_not_consented';

export interface FlowExecutionConfig {
  errorStrategy: FlowErrorStrategy;
  maxRetries: number; // default: 3
  retryBackoffMs: number; // default: 1000
  stepTimeoutMs: number; // default: 15000
  totalTimeoutMs: number; // default: 300000
  rateLimitDelayMs: number; // default: 100
}

export interface FlowStepResult {
  nodeId: string;
  stepIndex: number;
  status: FlowStepStatus;
  method: string;
  path: string;
  resolvedUrl: string;
  requestHeaders: Record<string, string>;
  requestBody?: any;
  responseStatus?: number;
  responseBody?: any;
  responseHeaders?: Record<string, string>;
  durationMs: number;
  variablesInjected: string[]; // variable names used in this step
  variablesExtracted: Array<{ name: string; value: string }>; // extracted in this step
  error?: string;
  retryCount: number;
  executionId?: string; // FK to api_test_executions
  // Case Matrix (Group 5): set when this result is one case of a node's matrix.
  // nodeId stays the parent node so results nest under it.
  caseId?: string;
  caseName?: string;
}

export interface FlowRunSummary {
  flowRunId: string;
  flowSpecId: string;
  status: FlowRunStatus;
  total: number;
  passed: number;
  failed: number;
  blocked: number; // never attempted — see FlowStepStatus
  skipped: number;
  totalDurationMs: number;
  variablesResolved: number;
  stepResults: FlowStepResult[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB ENTITY (mirrors api_flow_specs table)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiFlowSpec {
  id: string;
  userId: string;
  projectId: string;
  environmentId?: string;
  name: string;
  sourceType: ApiSpecSourceType;
  sourceUrl?: string;
  specVersion?: string;
  rawSpec: any;
  executionDag: ExecutionDAG;
  variableChain: Record<string, any>;
  totalEndpoints: number;
  supportedEndpoints: number;
  unsupportedEndpoints: UnsupportedEndpoint[];
  errorStrategy: FlowErrorStrategy;
  lastRunId?: string;
  lastRunStatus?: FlowRunStatus;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiFlowRun {
  id: string;
  flowSpecId: string;
  userId: string;
  status: FlowRunStatus;
  summary?: FlowRunSummary;
  startedAt: string;
  completedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST TYPES (API controller inputs)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlowQuestion {
  id: string;       // unique question ID
  question: string;  // human-readable question
  context: string;   // why the AI is asking this
  type: 'text' | 'select' | 'confirm' | 'secret'; // 'secret' for tokens/keys — masked in UI
  options?: string[]; // for 'select' type
  defaultValue?: string;
  // If set, the answer will be injected into variable context at execution time
  variableName?: string; // e.g. "auth_token", "api_key" — maps to {{variableName}} in DAG
}

export interface ParseSpecRequest {
  source: 'url' | 'file';
  url?: string;
  content?: string; // raw JSON or YAML string for file upload
  fileName?: string;
  projectId: string;
  environmentId?: string;
  chatSessionId?: string;
  // For resuming after user answers questions
  analysisId?: string; // ID of cached analysis to resume
  userAnswers?: Record<string, string>; // question ID → answer
  // Opt-in probe phase: with consent, call SAFE endpoints (GET reads, login) during
  // build to observe real response shapes and correct extraction jsonPaths.
  probe?: boolean;
  // Large-spec narrowing: when a spec exceeds the endpoint threshold the builder
  // returns group choices instead of rejecting; the client re-parses the SAME
  // source with the chosen group name here to restrict the flow to that group.
  apiGroup?: string;
}

export interface RunFlowRequest {
  config?: Partial<FlowExecutionConfig>;
  chatSessionId?: string;
  // User-provided variables injected into variable context before execution
  // Typically: auth tokens, API keys, base URLs, test credentials
  initialVariables?: Record<string, string>;
  // Consent to run DELETE/PUT/PATCH against the target. Default OFF: a spec says
  // nothing about whose data is behind it, and a smoke run is one click from a
  // production host. Without it those endpoints are reported `blocked`, not run.
  allowDestructive?: boolean;
  // optional: override sample data per node
  nodeOverrides?: Record<string, {
    requestBody?: any;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
  }>;
}
