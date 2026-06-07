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
  canRunParallel: boolean; // can run in parallel with siblings at same priority level
  sampleRequestBody?: any; // AI-generated fake data for testing
  sampleQueryParams?: Record<string, string>;
  expectedStatusCodes: number[];
}

export interface ExecutionDAG {
  nodes: DAGNode[];
  executionOrder: string[]; // node IDs in topological sort order
  parallelGroups: string[][]; // groups of node IDs that can run in parallel
  summary: string; // human-readable description of the flow
  totalEndpoints: number;
  unsupportedEndpoints: UnsupportedEndpoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// REACT FLOW VISUALIZATION
// ─────────────────────────────────────────────────────────────────────────────

export type FlowNodeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'unsupported';

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
export type FlowStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'retrying' | 'cancelled';

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
}

export interface FlowRunSummary {
  flowRunId: string;
  flowSpecId: string;
  status: FlowRunStatus;
  total: number;
  passed: number;
  failed: number;
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
}

export interface RunFlowRequest {
  config?: Partial<FlowExecutionConfig>;
  chatSessionId?: string;
  // User-provided variables injected into variable context before execution
  // Typically: auth tokens, API keys, base URLs, test credentials
  initialVariables?: Record<string, string>;
  // optional: override sample data per node
  nodeOverrides?: Record<string, {
    requestBody?: any;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
  }>;
}
