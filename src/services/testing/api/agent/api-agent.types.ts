/**
 * API Agent Types
 * DTOs, run state, and configuration for LIGHT/MEDIUM/HARD API testing agent
 */

// ═══════════════════════════════════════════════════════════════════════════
// LEVEL & POLICY TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ApiAgentLevel = 'light' | 'medium' | 'hard';

export interface ApiAgentBudget {
  maxSteps: number;
  maxSeconds: number;
  maxAiTokens: number;
  maxEndpointsConsidered: number;
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
  | 'retry_on_error';

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
  | 'security_issue'
  | 'performance_anomaly'
  | 'consistency_error'
  | 'auth_issue'
  | 'rate_limit_issue'
  | 'server_error'
  | 'capability_discovered';

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
  };
  /** Stop reason if stopped early */
  stopReason?: ApiAgentStopReason;
}

export type ApiAgentStopReason =
  | 'completed'
  | 'budget_steps'
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
}
