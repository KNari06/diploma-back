/**
 * Multi-Agent Brain Types
 * Shared interfaces for Observer, Strategist, and Actor agents
 */

import type { AICommand, BlacklistedAction, StateDriftAuditResult, VisionHints } from '../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// Observer Agent Types
// ═══════════════════════════════════════════════════════════════════════════

export interface FormFieldInfo {
  ref: string;
  type: string;
  label: string;
  hasValue: boolean;
  required: boolean;
}

export interface FormAnalysis {
  formRef?: string;
  fields: FormFieldInfo[];
  submitButtonRef?: string;
  submitButtonText?: string;
}

/**
 * Manus-style Impact Score for changes
 */
export interface ChangeImpact {
  /** What changed */
  change: string;
  /** Significance for goal: HIGH | MEDIUM | LOW */
  significance: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Type of change: Progress | Regression | Neutral */
  type: 'Progress' | 'Regression' | 'Neutral';
}

/**
 * Visual spatial drift detection (bounding box comparison)
 */
export interface SpatialDrift {
  /** Whether significant spatial changes detected */
  detected: boolean;
  /** Description of spatial changes (e.g., "Content shifted 200px down") */
  description?: string;
  /** Key elements that moved significantly */
  movedElements?: Array<{ ref: string; shift: string }>;
}

/**
 * Network activity state
 */
export interface NetworkActivity {
  /** Whether network requests are pending */
  hasPendingRequests: boolean;
  /** Recent requests (last 3s) */
  recentRequests?: Array<{ url: string; method: string; status?: number }>;
  /** Whether action likely triggered async work */
  asyncWorkTriggered: boolean;
}

/**
 * Expectation validation (Manus-style)
 */
export interface ExpectationDiff {
  /** What was expected */
  expected?: string;
  /** What actually happened */
  actual: string;
  /** Whether expectation was met */
  met: boolean;
  /** Explanation of mismatch */
  mismatch?: string;
}

export interface ObserverOutput {
  /** Classification of current page type */
  pageType: string;
  /** Available high-level actions on this page */
  availableActions: string[];
  /** Detected obstacles (overlays, modals, loading states, disabled elements) */
  obstacles: string[];
  /** Form analysis if forms present */
  formAnalysis?: FormAnalysis;
  /** Error state description if errors are visible */
  errorState?: string;
  /** Modal information if modal is active */
  modalInfo?: string;

  // Manus-style enhancements
  /** Impact-scored changes (top 3) */
  impactScores?: ChangeImpact[];
  /** Spatial drift detection */
  spatialDrift?: SpatialDrift;
  /** Network activity state */
  networkActivity?: NetworkActivity;
  /** Expectation validation */
  expectationDiff?: ExpectationDiff;
}

export interface ObserverInput {
  /** Formatted page snapshot */
  snapshot: string;
  /** State drift information */
  stateDrift?: string;
  /** Vision hints when DOM is weak */
  visionHints?: VisionHints;
  /** Current page URL */
  url: string;
  /** Page title */
  title: string;

  // Manus-style enhancements
  /** Previous snapshot for visual diff (bounding boxes) */
  previousSnapshot?: string;
  /** Network activity during last action */
  networkActivity?: NetworkActivity;
  /** What was expected from last action */
  lastExpectation?: string;
  /** Last action performed */
  lastAction?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Strategist Agent Types
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategistOutput {
  /** High-level strategy description */
  strategy: string;
  /** Reasoning behind the strategy */
  thought: string;
  /** What we expect to happen after executing this strategy */
  expectedOutcome: string;
  /** Manus-style: Concrete verification criteria (e.g., "URL contains /dashboard OR avatar element visible") */
  verificationCriteria?: string;
  /** Alternative strategies if primary fails — ordered by preference */
  alternatives: string[];
  /** Confidence in this strategy (0-1) */
  confidence: number;
  /** Action cost awareness: estimated risk level of chosen strategy */
  riskLevel?: 'low' | 'medium' | 'high';
  /** Whether the goal is already achieved */
  done?: boolean;
  /** Whether the agent is blocked */
  blockedInfo?: { reason: string; canUserHelp: boolean };
}

export interface StrategistInput {
  /** Observer's structured page understanding */
  observation: ObserverOutput;
  /** Test goal */
  goal: string;
  /** Formatted action history */
  history: string;
  /** Current task plan context */
  taskPlanSummary?: string;
  /** AI guidance from stuck recovery */
  guidance?: string;
  /** Progress score 0-1 */
  progressScore: number;
  /** Failed/blacklisted actions */
  failedActions?: BlacklistedAction[];
  /** Audited drift result */
  auditedDrift?: StateDriftAuditResult;
  /** Current iteration */
  iteration: number;
  /** Whether agent is stuck */
  isStuck: boolean;
  /** Last outcome description */
  lastOutcome?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Actor Agent Types
// ═══════════════════════════════════════════════════════════════════════════

export interface ActorOutput {
  /** The exact command to execute */
  command: AICommand;
  /** Brief reasoning for element choice */
  reasoning: string;
}

export interface ActorInput {
  /** Strategy from Strategist */
  strategy: string;
  /** Filtered elements relevant to the strategy (max 30) */
  relevantElements: string;
  /** Form analysis for deterministic shortcuts */
  formAnalysis?: FormAnalysis;
  /** Goal for context */
  goal: string;
  /** Whether credentials are provided */
  hasCredentials: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Critic Agent Types (Manus-style)
// ═══════════════════════════════════════════════════════════════════════════

/** Security policy violation detected by deterministic checks */
export interface PolicyViolation {
  /** Type of violation */
  type: 'password_exposure' | 'wrong_domain' | 'pii_leak' | 'external_navigation' | 'unsafe_action';
  /** Human-readable description */
  description: string;
  /** Severity: block = stop execution, warn = log but allow */
  severity: 'block' | 'warn';
}

/** Reasoning consistency check across iterations */
export interface ReasoningInconsistency {
  /** The contradicting claim from history */
  previousClaim: string;
  /** The current contradicting claim */
  currentClaim: string;
  /** Which iterations are in conflict */
  iterations: [number, number];
  /** Description of the contradiction */
  description: string;
}

export interface CriticVerdict {
  /** Final verdict: approve (proceed), reject (try alternative), override (critic proposes different action) */
  verdict: 'approve' | 'reject' | 'override';
  /** Risk assessment of the proposed action */
  riskAssessment: string;
  /** At least one reason this action could fail (Red Teaming) */
  failureRisk: string;
  /** If override: what action the Critic thinks should be taken instead */
  suggestedAction?: string;
  /** Confidence in verdict (0-1) */
  confidence: number;
  /** Whether the chosen ref was hallucinated (not in real elements) */
  refExists: boolean;
  /** Security/policy violations found (deterministic, no AI) */
  policyViolations: PolicyViolation[];
  /** Reasoning inconsistencies across iterations */
  reasoningInconsistencies: ReasoningInconsistency[];
}

export interface CriticInput {
  /** The Actor's proposed command */
  proposedCommand: AICommand;
  /** Actor's reasoning for the choice */
  actorReasoning: string;
  /** The test goal (Critic validates alignment) */
  goal: string;
  /** Available elements on page (for hallucination check) */
  availableElements: string;
  /** Observer's page understanding (Critic sees this, NOT Strategist's decision) */
  observation: ObserverOutput;
  /** Current URL for domain safety checks */
  currentUrl: string;
  /** Whether credentials are involved */
  hasCredentials: boolean;
  /** Form analysis for security checks (password field type etc.) */
  formAnalysis?: FormAnalysis;
  /** Condensed reasoning history for consistency checks */
  reasoningHistory?: string[];
  /** Current iteration for consistency tracking */
  iteration: number;
  /** Strategist's thought (for reasoning consistency — but NOT shown to AI critic) */
  strategistThought: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator Types
// ═══════════════════════════════════════════════════════════════════════════

export interface MultiAgentInput {
  /** Formatted page snapshot */
  snapshot: string;
  /** Current page URL */
  url: string;
  /** Page title */
  title: string;
  /** Test goal */
  goal: string;
  /** Formatted action history */
  history: string;
  /** State drift analysis string */
  stateDrift?: string;
  /** Vision hints */
  visionHints?: VisionHints;
  /** Task plan summary */
  taskPlanSummary?: string;
  /** AI guidance */
  guidance?: string;
  /** Progress score */
  progressScore: number;
  /** Blacklisted actions */
  failedActions?: BlacklistedAction[];
  /** Audited drift */
  auditedDrift?: StateDriftAuditResult;
  /** Current iteration */
  iteration: number;
  /** Whether stuck */
  isStuck: boolean;
  /** Last outcome */
  lastOutcome?: string;
  /** Whether credentials are provided */
  hasCredentials: boolean;
  /** Snapshot elements for actor filtering */
  snapshotElements: string;
  /** Content hash for observer cache */
  contentHash: string;

  // Manus-style enhancements
  /** Previous snapshot for visual diff */
  previousSnapshot?: string;
  /** Network activity state */
  networkActivity?: NetworkActivity;
  /** Last action performed */
  lastAction?: string;
  /** What was expected from last action */
  lastExpectation?: string;
}

/** Run-level metrics accumulated across all iterations for A/B comparison */
export interface MultiAgentRunMetrics {
  // Iteration counts
  totalIterations: number;
  multiAgentSuccessCount: number;
  monolithicFallbackCount: number;

  // Agent latency aggregates (ms)
  totalObserverMs: number;
  totalStrategistMs: number;
  totalActorMs: number;
  totalCriticMs: number;
  totalPipelineMs: number;

  // Cache & optimization
  observerCacheHits: number;
  observerCacheMisses: number;
  actorDeterministicCount: number;

  // Critic verdicts
  criticApproveCount: number;
  criticRejectCount: number;
  criticOverrideCount: number;
  criticSkippedCount: number;

  // Branching
  alternativeUsedCount: number;
  policyViolationCount: number;

  // Computed (for convenience)
  avgPipelineMs: number;
  observerCacheHitRate: number;
  multiAgentSuccessRate: number;
}

export interface MultiAgentResult {
  /** Whether the multi-agent pipeline succeeded */
  success: boolean;
  /** The AI decision (if success) */
  decision?: {
    thought: string;
    command: AICommand;
    done?: boolean;
    blocked?: string;
    blockedInfo?: { reason: string; canUserHelp: boolean };
    analysis?: {
      pageState: string;
      availableActions: string[];
      obstacles: string[];
    };
  };
  /** Manus-style: What we expect to happen after this action (fed to Observer next iteration) */
  expectedOutcome?: string;
  /** Manus-style: Concrete verification criteria (e.g., "URL contains /dashboard OR avatar visible") */
  verificationCriteria?: string;
  /** Debug info for tracing */
  debug?: {
    observerCacheHit: boolean;
    actorDeterministic: boolean;
    observerMs: number;
    strategistMs: number;
    actorMs: number;
    criticMs: number;
    totalMs: number;
    /** Whether primary strategy failed and an alternative was used */
    usedAlternative?: boolean;
    /** Which alternative index was used (0 = primary) */
    alternativeIndex?: number;
    /** Critic verdict if critic was invoked */
    criticVerdict?: 'approve' | 'reject' | 'override' | 'skipped';
    /** Number of policy violations found */
    policyViolations?: number;
  };
}
