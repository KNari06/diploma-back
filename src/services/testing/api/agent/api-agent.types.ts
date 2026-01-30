/**
 * API Agent Types
 * DTOs, run state, and configuration for LIGHT/MEDIUM/HARD API testing agent
 */

// ═══════════════════════════════════════════════════════════════════════════
// LEVEL & POLICY TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ApiAgentLevel = 'light' | 'medium' | 'hard';

/**
 * Execution profile determines safety constraints for the test run.
 * - 'prod_readonly': strictly read-only, no mutations, minimal fuzzing impact (for production)
 * - 'nonprod': allows mutations and aggressive testing (for staging/dev/local)
 */
export type ExecutionProfile = 'prod_readonly' | 'nonprod';

export interface ApiAgentBudget {
  maxSteps: number;
  maxSeconds: number;
  maxAiTokens: number;
  maxEndpointsConsidered: number;
  /** Hard cap on total HTTP requests for this run (across all steps) */
  maxRequests: number;
}

export interface ApiAgentLevelPolicy {
  level: ApiAgentLevel;
  budget: ApiAgentBudget;
  /** Baseline credits charged before execution */
  baselineCredits: number;
  /** Novelty threshold below which agent stops (0..1) */
  noveltyStopThreshold: number;
  /** Whether CRUD/mutation steps are enabled */
  allowMutations: boolean;
  /** Whether fuzzing/adversarial steps are enabled */
  allowFuzzing: boolean;
  /** Whether race-condition probing is enabled */
  allowRaceProbing: boolean;
  /** Max retry attempts on 5xx/high-risk signals */
  maxRetryOnHighRisk: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST / RESPONSE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ApiAgentRequest {
  /** Required: test level from UI */
  level: ApiAgentLevel;
  /** Optional: external testId to keep billing/storage consistent */
  testId?: string;
  /** Target endpoint URL */
  url: string;
  /** HTTP method for happy-path */
  method: string;
  /** Optional request headers */
  headers?: Record<string, string>;
  /** Optional request body */
  body?: any;
  /** Expected status code (default inferred from method) */
  expectedStatus?: number;
  /** User expectation / expected behavior (free-text or JSON string) */
  expectedBehavior?: string;
  /** Optional budget overrides */
  budgetOverrides?: Partial<ApiAgentBudget>;
  /** User ID (for billing/storage) */
  userId: string;
  /** Chat session ID (for WS updates, optional) */
  chatSessionId?: string;
  /** Project ID (optional, for storage) */
  projectId?: string;
  /** User's original message/intent */
  userMessage?: string;
  /**
   * Execution profile override. If not provided, inferred from URL patterns.
   * - 'prod_readonly': strictly read-only, minimal impact (for production)
   * - 'nonprod': allows mutations and aggressive testing
   */
  executionProfile?: ExecutionProfile;
}

export type ApiAgentExpectationResponseType = 'list' | 'object' | 'primitive' | 'unknown';

/**
 * Normalized expectation model derived from user's expectedBehavior (text or JSON).
 * This model is used for deterministic validation and as context for AI planning.
 */
export interface ApiAgentExpectationModel {
  responseType?: ApiAgentExpectationResponseType;
  entity?: string;
  allowedMethods?: string[];
  requiredFields?: string[];
  /**
   * High-level invariants (can be used by deterministic checks and/or AI judge hints).
   * Examples: "non_empty_list", "unique_id", "pagination_stable"
   */
  invariants?: string[];
}

export interface ApiAgentStepResult {
  stepId: string;
  stepType: ApiAgentStepType;
  description: string;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
    durationMs: number;
  } | null;
  success: boolean;
  error?: string;
  /** Findings from this step */
  findings: ApiAgentFinding[];
  /** AI tokens consumed in this step */
  aiTokensUsed: number;
  /** Total HTTP requests executed for this step (multi-request steps use >1) */
  requestsExecuted?: number;
  timestamp: string;
}

export type ApiAgentStepType =
  | 'happy_path'
  | 'method_contract'
  | 'schema_validation'
  | 'negative_case'
  | 'crud_chain'
  | 'consistency_check'
  | 'fuzzing'
  | 'auth_bypass'
  | 'race_probe'
  | 'retry_on_error'
  // New read-only HARD step types for deeper coverage
  | 'auth_matrix'           // Systematic auth header variations (missing/empty/malformed/bad bearer)
  | 'idor_probe'            // Synthetic invalid IDs to detect IDOR vulnerabilities
  | 'header_security_check' // Validate response security headers (CORS, caching, content-type)
  | 'rate_limit_probe_safe' // Small burst to detect 429 and Retry-After behavior
  | 'error_leak_check'      // Detect stack traces, SQL errors, debug info leaks
  | 'content_negotiation';  // Accept header variants to detect unexpected responses

export interface ApiAgentFinding {
  id: string;
  type: ApiAgentFindingType;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  evidence?: {
    request?: any;
    response?: any;
    diff?: any;
  };
  recommendation?: string;
}

export type ApiAgentFindingType =
  | 'contract_violation'
  | 'unexpected_status'
  | 'schema_mismatch'
  | 'validation_bypass'
  | 'network_error'
  | 'invalid_method_handling'
  | 'expectation_violation'
  | 'invalid_input_handling'
  | 'security_issue'
  | 'performance_anomaly'
  | 'consistency_error'
  | 'auth_issue'
  | 'rate_limit_issue'
  | 'server_error'
  | 'capability_discovered'
  // New finding types for expanded HARD coverage
  | 'auth_matrix_issue'       // Auth header variation revealed weakness
  | 'idor_vulnerability'      // Potential IDOR detected
  | 'header_security_issue'   // Missing/misconfigured security headers
  | 'error_leak'              // Stack trace, SQL error, or debug info leaked
  | 'content_type_mismatch'   // Unexpected content type returned
  | 'sql_injection_indicator' // Potential SQL injection signal
  | 'xss_reflection'          // Potential XSS reflection detected
  | 'command_injection_indicator' // Potential command injection signal
  | 'ssrf_indicator'          // Potential SSRF signal
  | 'path_traversal_indicator'; // Potential path traversal signal

export interface ApiAgentRunState {
  runId: string;
  testId: string;
  level: ApiAgentLevel;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  startedAt: string;
  completedAt?: string;
  /** Current step index */
  currentStep: number;
  /** All executed steps */
  steps: ApiAgentStepResult[];
  /** Aggregated findings */
  findings: ApiAgentFinding[];
  /** Inferred schema from responses */
  inferredSchema: Record<string, any> | null;
  /** Known resource IDs discovered during test */
  knownIds: string[];
  /** Discovered endpoint capabilities */
  discoveredMethods: string[];
  /** Error signatures seen (for deduplication) */
  errorSignatures: Set<string>;
  /** Current novelty score (0..1) */
  novelty: number;
  /** Budget consumption */
  consumed: {
    steps: number;
    seconds: number;
    aiTokens: number;
    endpointsConsidered: number;
    /** Total HTTP requests executed across all steps */
    requests: number;
  };
  /** Stop reason if stopped early */
  stopReason?: ApiAgentStopReason;

  /** Parsed expectation model (derived once per run from request.expectedBehavior) */
  expectationModel?: ApiAgentExpectationModel;
}

export type ApiAgentStopReason =
  | 'completed'
  | 'budget_steps'
  | 'budget_requests'
  | 'budget_time'
  | 'budget_tokens'
  | 'novelty_threshold'
  | 'contract_broken'
  | 'user_cancelled'
  | 'error';

export interface ApiAgentSummary {
  level: ApiAgentLevel;
  runId: string;
  testId: string;
  url: string;
  method: string;
  /** Execution profile used for this run */
  executionProfile?: ExecutionProfile;
  /** User-facing mode label for UI */
  modeLabel?: string;
  /** Disclaimer to reduce legal ambiguity on production testing */
  disclaimer?: string;
  /** Overall success (happy-path worked + no critical issues) */
  success: boolean;
  /** Total duration in ms */
  durationMs: number;
  /** Total steps executed */
  stepsExecuted: number;
  /** Findings by severity */
  findingsCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  /** Top 5 most important findings */
  topFindings: ApiAgentFinding[];
  /** Discovered capabilities */
  discoveredMethods: string[];
  /** Security score (0-10, 10 = best) */
  securityScore: number;
  /** Stop reason */
  stopReason: ApiAgentStopReason;
  /** Credits charged */
  creditsCharged: number;
  /** AI tokens used */
  aiTokensUsed: number;
  /** Trace log reference */
  traceLogPath?: string;

  /** Whether the agent considers the expectation satisfied */
  expectationSatisfied?: boolean;
  /** Single source-of-truth final verdict */
  finalVerdict?: 'pass' | 'pass_with_risks' | 'fail';
}

export interface ApiAgentResponse {
  success: boolean;
  summary: ApiAgentSummary;
  /** Full state for detailed view (optional, not always returned) */
  fullState?: ApiAgentRunState;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// AI DECISION TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ApiAgentAIDecision {
  /** Next step to execute */
  nextStep: ApiAgentPlannedStep | null;
  /** Reasoning for the decision */
  reasoning: string;
  /** Should stop after this? */
  shouldStop: boolean;
  /** Stop reason if shouldStop */
  stopReason?: ApiAgentStopReason;
  /** Updated novelty estimate */
  noveltyEstimate: number;
}

export interface ApiAgentPlannedStep {
  stepType: ApiAgentStepType;
  description: string;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  };
  expectedOutcome: string;
  riskLevel: 'safe' | 'low' | 'medium' | 'high';
}

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY GATE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SafetyGateResult {
  allowed: boolean;
  reason?: string;
  /** If not allowed, what was skipped */
  skippedAction?: string;
}

export interface SafetyGateContext {
  url: string;
  method: string;
  stepType: ApiAgentStepType;
  policy: ApiAgentLevelPolicy;
  currentState: ApiAgentRunState;
  /** Execution profile for safety decisions (prod_readonly blocks mutations entirely) */
  executionProfile?: ExecutionProfile;
}
