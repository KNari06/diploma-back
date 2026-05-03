/**
 * Multi-Agent Brain Types
 * Shared interfaces for Observer, Strategist, and Actor agents
 */

import type { AICommand, BlacklistedAction, BlockerInfo, NetworkValidationError, ObstacleFact, ObstacleType, StateDriftAuditResult, VisionHints } from '../lite-types';
import type { NetworkError } from '../collectors/network-tracker';
import type { ParsedSnapshot } from './parsed-snapshot';

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

  // Manus parity: structural analysis
  /** Table structure analysis (when tables detected) */
  tableAnalysis?: {
    ref: string;
    headers: string[];
    rowCount: number;
    isSortable: boolean;
    hasPagination: boolean;
    hasBulkActions: boolean;
    hasInlineEditing: boolean;
  } | null;
  /** List/feed analysis (when significant lists detected) */
  listAnalysis?: {
    ref: string;
    estimatedItems: number;
    hasLoadMore: boolean;
    isVirtualized: boolean;
    scrollDirection: 'vertical' | 'horizontal';
  } | null;
  /** Loading state interpretation */
  loadingState?: {
    isLoading: boolean;
    type: string;
    affectedArea: string;
    ref?: string;
  } | null;
  /** Elements covered by overlays */
  overlapInfo?: Array<{
    coveredRef: string;
    coveredBy: string;
  }> | null;

  /** Layer 2: LLM-classified obstacles from ObstacleFacts */
  classifiedObstacles?: Array<{
    ref: string;
    type: ObstacleType;
    isBlocking: boolean;
    isDismissible: boolean;
    dismissStrategy?: string;
    affectedArea?: string;
    reason: string;
  }>;

  /**
   * Widgets currently in an OPEN/ACTIVE state — Radix/shadcn dropdowns,
   * dialogs, popovers, tabs, accordions whose `[STATE=open]` /
   * `[EXPANDED]` / `[STATE=active]` markers indicate they are already
   * showing content. Used by Strategist + Critic to detect "goal
   * already done" or to avoid clicking a trigger that would CLOSE
   * an already-open widget (canonical Radix toggle regression).
   *
   * `kind` is informational — observer can leave it 'unknown' if the
   * widget type isn't obvious from markers alone.
   */
  openWidgets?: Array<{
    ref: string;
    /** What the widget likely is (best-effort from role/markers) */
    kind: 'dialog' | 'menu' | 'popover' | 'tab' | 'accordion' | 'tooltip' | 'unknown';
    /** Short human-readable label of the widget or its trigger */
    label: string;
  }>;

  /** LLM holistic page state analysis — overall blocking/loading assessment */
  pageStateAnalysis?: {
    /** Whether page is actively loading (skeleton, spinner, progress bar) */
    isLoading: boolean;
    /** Whether a full-viewport overlay is blocking all interaction */
    hasFullViewportOverlay: boolean;
    /** Number of stacked obstacles detected simultaneously */
    stackedObstacleCount: number;
    /** Whether the user flow is completely blocked */
    isFlowBlocked: boolean;
    /** Reason why flow is blocked (if isFlowBlocked=true) */
    blockReason?: string;
  };
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
  /** Whether user provided login credentials */
  hasCredentials?: boolean;
  /** Test goal for context-aware observation */
  goal?: string;

  // Manus-style enhancements
  /** Previous snapshot for visual diff (bounding boxes) */
  previousSnapshot?: string;
  /** Network activity during last action */
  networkActivity?: NetworkActivity;
  /** What was expected from last action */
  lastExpectation?: string;
  /** Last action performed */
  lastAction?: string;
  /** Transient loading state (skeleton, spinner, progressbar) */
  transientState?: { isTransient: boolean; type?: string; ref?: string; text?: string };
  /** Page metadata (DOM weakness, vision recommendation) */
  pageMetadata?: { isDOMWeak: boolean; recommendVision: boolean; interactiveElementCount: number };
  /** Structured page data: tables, lists, pagination detected */
  pageStructure?: import('../lite-types').PageStructureMetadata;
  /** Supervisor Blackboard — shared recovery context */
  blackboard?: SupervisorBlackboard;
  /** Layer 2: Structured facts about positioned elements for obstacle classification */
  obstacleFacts?: ObstacleFact[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Working Memory Types (Cognitive Agent)
// ═══════════════════════════════════════════════════════════════════════════

/** Structured strategy action — replaces free-form text between Strategist→Actor */
export interface StrategyAction {
  /** What type of action to take */
  actionType: 'fill' | 'click' | 'scroll' | 'wait' | 'goto' | 'select' | 'press' | 'hover' | 'toggle' | 'setRange' | 'clear' | 'selectDate';
  /** Target description (e.g., "email field", "submit button") */
  target: string;
  /** Optional target ref if Strategist can identify it from Observer's formAnalysis */
  targetRef?: string;
  /** Value to fill (for fill/select) */
  value?: string;
  /** Whether this targets a sensitive field */
  isSensitive?: boolean;
}

/** Visited page entry in working memory */
export interface VisitedPageEntry {
  pageType: string;
  visitCount: number;
  lastIteration: number;
}

/** Successful action record in working memory */
export interface SuccessfulActionRecord {
  iteration: number;
  action: string;
  ref: string;
  outcome: string;
}

/** Critic rejection record — captures WHY an action was rejected (cross-ref pattern learning) */
export interface CriticRejectionRecord {
  /** Iteration when rejection occurred */
  iteration: number;
  /** The action that was rejected (e.g., "click") */
  action: string;
  /** The element ref that was targeted — optional because some actions have no ref */
  ref?: string;
  /** Why the Critic rejected this action (the pattern-level lesson) */
  reason: string;
  /** Risk assessment from the Critic */
  riskAssessment: string;
}

/**
 * PR1B: Critic concerns on an APPROVED action (warnings, not rejections).
 * Recorded whenever the Critic approves an action but flagged warn-level
 * policy violations. Fed back to Strategist on the next iteration so it
 * can avoid repeating the same risky pattern.
 */
export interface CriticConcernRecord {
  /** Iteration when the concern was raised */
  iteration: number;
  /** The action that was approved-with-warnings */
  action: string;
  /** The element ref that was targeted */
  ref?: string;
  /** Concise concern summary (from Critic's riskAssessment or failureRisk) */
  concern: string;
  /** Warn-level violation types (e.g., "external_navigation", "password_exposure") */
  violationTypes: string[];
}

/** Structured working memory persisted across iterations */
export interface WorkingMemory {
  /** Form fields we've interacted with: ref → status */
  formProgress: Record<string, 'filled' | 'failed' | 'skipped'>;
  /** Elements we've successfully interacted with (bounded, last 20) */
  successfulActions: SuccessfulActionRecord[];
  /** Current sub-goal from Strategist decomposition */
  currentSubGoal?: string;
  /** What the agent has accomplished so far (structured, not narrative) */
  accomplishments: string[];
  /** Known page topology: URL → page info */
  visitedPages: Record<string, VisitedPageEntry>;
  /** Accumulated form state from Observer across iterations */
  lastFormAnalysis?: FormAnalysis;
  /** Critic rejection history: captures rejection reasons for cross-ref pattern avoidance (bounded) */
  criticRejections?: CriticRejectionRecord[];
  /**
   * PR1B: Critic concerns on APPROVED actions (warn-level violations).
   * Distinct from criticRejections — these are actions that went through
   * but the Critic flagged something worth remembering. Bounded.
   */
  criticConcerns?: CriticConcernRecord[];
  /** Consecutive expectation mismatches count (predictions that were wrong) */
  consecutiveExpectationMisses?: number;
  /** Last expectation mismatch description */
  lastExpectationMismatch?: string;
}

/** Supervisor Blackboard — shared reactive state visible to ALL agents.
 *  Tier 1: computed deterministically (<5ms, zero AI).
 *  Tier 2: AI diagnosis appended only when stuck 5+ iterations. */
export interface SupervisorBlackboard {
  /** All agents adjust behavior when true */
  recoveryMode: boolean;
  /** Tier of recovery: 1 = deterministic, 2 = AI-diagnosed */
  recoveryTier: 0 | 1 | 2;
  /** Detected blocker (Tier 1: regex pattern, Tier 2: AI-diagnosed semantic blocker) */
  currentBlocker?: string;
  /** Actions from last N iterations — BLOCKED by Critic in recovery mode */
  forbiddenActions: Array<{ action: string; ref?: string; url?: string }>;
  /** Stack of last 3 URLs where meaningful progress was made (most recent first) */
  knownGoodUrls: string[];
  /** Backtrack failures on current knownGoodUrl (pop to next after 2 failures) */
  backtrackFailures: number;
  /** Consecutive Supervisor interventions (resets on progress) */
  interventionCount: number;
  /** State hash for loop detection */
  stateHash: string;
  /** Consecutive state hash repeats */
  stateHashRepeatCount: number;
  /** Force goto(knownGoodUrl), skip entire pipeline */
  hardBacktrack: boolean;
  /** Consecutive iterations on wrong page */
  wrongPageCount: number;
  /** Tier 2 AI diagnosis: suggested recovery strategy (only when tier=2) */
  aiDiagnosis?: string;
  /** Tier 2 mandatory action override — Orchestrator skips Strategist+Actor and executes this directly */
  mandatoryAction?: { action: string; ref?: string; value?: string; url?: string };
  /** Jaccard similarity between current and previous element signature sets (0–1) */
  jaccardSimilarity: number;
  /** Consecutive iterations with high Jaccard similarity (soft loop indicator) */
  softLoopCount: number;
}

/** Accumulated context for monolithic fallback — don't lose knowledge */
export interface AccumulatedContext {
  /** Last known form progress (formatted string) */
  formProgress?: string;
  /** Recent reasoning insights */
  recentInsights?: string[];
  /** Last expected outcome (for continuity) */
  lastExpectedOutcome?: string;
  /** Accomplishments so far */
  accomplishments?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Strategist Agent Types
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategistOutput {
  /** High-level strategy description */
  strategy: string;
  /** Structured strategy action — used by Actor directly without regex parsing */
  structuredStrategy?: StrategyAction;
  /** Reasoning behind the strategy */
  thought: string;
  /** What we expect to happen after executing this strategy */
  expectedOutcome: string;
  /** Manus-style: Concrete verification criteria (e.g., "URL contains /dashboard OR avatar element visible") */
  verificationCriteria?: string;
  /** Alternative strategies if primary fails — ordered by preference */
  alternatives: string[];
  /** Structured alternatives with confidence — validated before branching */
  structuredAlternatives?: Array<{ action: StrategyAction; confidence: number }>;
  /** Confidence in this strategy (0-1) */
  confidence: number;
  /** Action cost awareness: estimated risk level of chosen strategy */
  riskLevel?: 'low' | 'medium' | 'high';
  /** Whether the goal is already achieved */
  done?: boolean;
  /**
   * Whether the agent is blocked. PR1C: extended with optional blockerType
   * and requestedAction for richer frontend UX in background pauseMode.
   * The full structure matches lite-types.ts BlockedInfo.
   */
  blockedInfo?: import('../lite-types').BlockedInfo;
  /** Current sub-goal the agent is focused on (persists in working memory) */
  subGoal?: string;
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
  /** Cognitive: Structured working memory from previous iterations */
  workingMemory?: WorkingMemory;
  /** Critic feedback from a rejected action — re-strategize with this as negative constraint */
  criticFeedback?: string;
  /** Whether user provided login credentials */
  hasCredentials?: boolean;
  /** Current page URL for URL-aware decisions */
  currentUrl?: string;
  /** Summary of last meaningful state transition for done detection */
  transitionSummary?: string;

  // Manus parity: structured context from Observer
  /** Table context from Observer (for table navigation strategies) */
  tableContext?: ObserverOutput['tableAnalysis'];
  /** List context from Observer (for scroll/load-more strategies) */
  listContext?: ObserverOutput['listAnalysis'];
  /** Loading state from Observer (wait vs act decision) */
  loadingContext?: ObserverOutput['loadingState'];
  /** Covered elements from Observer (dismiss overlay first) */
  overlapContext?: ObserverOutput['overlapInfo'];
  /** Recent confidence trend — 'declining' if last 2 iterations had confidence < 0.4 */
  confidenceTrend?: 'stable' | 'declining';
  /** Original goal URL — for wrong-page detection and recovery */
  goalUrl?: string;
  /** Supervisor Blackboard — shared recovery context */
  blackboard?: SupervisorBlackboard;
  /** Time pressure level from TimeoutGovernor — affects strategy directness */
  urgencyLevel?: 'normal' | 'hurry' | 'critical';
  /**
   * PR1C: Vision escalation signal from page metadata. When `isDOMWeak` is
   * true (e.g., SPA with <div onClick>, canvas apps, custom-rendered UI),
   * the DOM snapshot may not describe the page accurately. Strategist
   * should prefer coordinate-based or scroll-oriented actions, widen the
   * visibility of visionHints, and avoid being too confident about ref
   * targeting. When `recommendVision` is true, the agent should actively
   * consider visionHints as primary evidence.
   */
  visionRecommendation?: {
    isDOMWeak: boolean;
    recommendVision: boolean;
    interactiveElementCount: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Actor Agent Types
// ═══════════════════════════════════════════════════════════════════════════

export interface ActorOutput {
  /** The exact command to execute */
  command: AICommand;
  /** Brief reasoning for element choice */
  reasoning: string;
  /** Whether this action was resolved deterministically (no AI call) */
  deterministic?: boolean;
}

export interface ActorInput {
  /** Strategy from Strategist (text fallback) */
  strategy: string;
  /** Structured strategy action — bypasses regex parsing when available */
  structuredStrategy?: StrategyAction;
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
  /** If override: what action the Critic thinks should be taken instead (text, for logs) */
  suggestedAction?: string;
  /** Structured override command — actionable, not just advisory */
  structuredOverride?: { action: string; ref?: string; value?: string };
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
  /** Vision-detected conflicts for the target element (covered/hidden/disabled) */
  visionConflicts?: VisionHints['conflicts'];
  /** Whether page is in loading state (skeleton/spinner active) */
  isPageLoading?: boolean;
  /** Refs of elements currently covered by overlays */
  coveredElements?: string[];
  /** Supervisor Blackboard — shared recovery context */
  blackboard?: SupervisorBlackboard;
  /** Layer 3: Blocker info from previous iteration's failed click */
  lastBlockerInfo?: BlockerInfo;
  /**
   * Pre-parsed snapshot for O(1) ref existence checks.
   * Optional for backwards compat — checkRefExists falls back to regex
   * over availableElements when this is absent. See parsed-snapshot.ts.
   */
  parsedSnapshot?: ParsedSnapshot;
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
  /** Summary of last meaningful state transition for done detection */
  transitionSummary?: string;
  /** Whether credentials are provided */
  hasCredentials: boolean;
  /** Snapshot elements for actor filtering */
  snapshotElements: string;
  /** Content hash for observer cache */
  contentHash: string;
  /**
   * Pre-parsed snapshot for O(1) ref existence checks in deterministic
   * code paths (Critic, Orchestrator ref validation). Built once per
   * iteration in lite-engine.ts getAIDecision().
   *
   * Optional for backwards compat — every consumer must provide a regex
   * fallback when this is absent. See parsed-snapshot.ts.
   */
  parsedSnapshot?: ParsedSnapshot;

  // Manus-style enhancements
  /** Previous snapshot for visual diff */
  previousSnapshot?: string;
  /** Network activity state */
  networkActivity?: NetworkActivity;
  /** Last action performed */
  lastAction?: string;
  /** What was expected from last action */
  lastExpectation?: string;

  // Manus parity: snapshot-level context
  /** Transient state (loading indicators) from snapshot */
  transientState?: { isTransient: boolean; type?: string; ref?: string; text?: string };
  /** Page metadata from snapshot */
  pageMetadata?: { isDOMWeak: boolean; recommendVision: boolean; interactiveElementCount: number };
  /** Page structure (tables, lists, pagination) from snapshot */
  pageStructure?: import('../lite-types').PageStructureMetadata;
  /** Original goal URL — for wrong-page detection and recovery */
  goalUrl?: string;
  /** Number of consecutive critic rejections (from orchestrator) */
  consecutiveCriticRejections?: number;
  /** Loop detected by state-drift-auditor */
  loopDetected?: boolean;
  /** Loop description */
  loopDescription?: string;
  /** Recent console errors (last action) — for Supervisor blocker detection */
  recentConsoleErrors?: string[];
  /** Recent network errors (last action) — for Supervisor blocker detection */
  recentNetworkErrors?: NetworkError[];
  /** Recent API validation errors (last action) — for Supervisor blocker detection */
  recentValidationErrors?: NetworkValidationError[];
  /** Optional callback for emitting real-time thinking steps to the user */
  onThinkingStep?: (phase: string, message: string) => void;

  // TimeoutGovernor: time pressure signal
  /** Time pressure level from TimeoutGovernor — affects Strategist and Critic behavior */
  urgencyLevel?: 'normal' | 'hurry' | 'critical';

  // Layer 2/3: Universal Obstacle Intelligence
  /** Structured facts about positioned elements for Observer LLM classification */
  obstacleFacts?: ObstacleFact[];
  /** Layer 3: Blocker info from previous iteration's failed click */
  lastBlockerInfo?: BlockerInfo;
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

  // Cognitive enhancements
  /** Times circuit breaker skipped multi-agent */
  circuitBreakerSkipCount: number;
  /** Times critic was skipped for low-risk actions */
  criticLowRiskSkipCount: number;
  /** Times critic override was applied */
  criticOverrideAppliedCount: number;
  /** Times re-strategize was attempted after critic rejection */
  reStrategizeCount: number;

  // Supervisor
  /** Times Supervisor triggered recovery mode */
  supervisorRecoveryModeCount: number;
  /** Times Supervisor forced hard backtrack */
  supervisorHardBacktrackCount: number;
  /** Times Supervisor Tier 2 AI diagnosis was invoked */
  supervisorTier2Count: number;

  // SafetyInterceptor (PR2)
  /** Times SafetyInterceptor blocked an action on the skip path */
  skipPathSafetyBlockCount: number;

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
    /** PR1C: extended BlockedInfo with blockerType and requestedAction */
    blockedInfo?: import('../lite-types').BlockedInfo;
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
    /** Whether circuit breaker skipped this iteration */
    circuitBreakerSkipped?: boolean;
    /** Whether critic was skipped for low-risk action */
    criticSkippedLowRisk?: boolean;
    /** Whether critic override was applied */
    criticOverrideApplied?: boolean;
    /** Whether re-strategize was attempted after critic rejection */
    reStrategized?: boolean;
    /** Whether Supervisor triggered recovery mode */
    supervisorRecoveryMode?: boolean;
    /** Whether Supervisor forced hard backtrack */
    supervisorHardBacktrack?: boolean;
    /** Supervisor recovery tier (0=none, 1=deterministic, 2=AI) */
    supervisorTier?: 0 | 1 | 2;
    /** PR2: SafetyInterceptor blocked an action on the skip path */
    skipPathSafetyBlocked?: boolean;
  };
  /** Action rejected by Critic (for blacklist recording by caller) */
  rejectedAction?: {
    action: string;
    ref: string;
    elementHint: string;
    reason: string;
  };
}
