/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION v2 — Agent Type Definitions
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Shared interfaces for the 4-agent exploration system:
 *   1. Cartographer  — page understanding + entry point discovery
 *   2. Strategist    — exploration planning + prioritization
 *   3. Scout         — branch discovery after flow completion
 *   4. Sentinel      — coverage evaluation + gap analysis
 *
 * All agents communicate through ExplorationBlackboard (shared state).
 *
 * Reuses from LiteEngine:
 *   - FormAnalysis from agents/types.ts
 *   - WorkingMemory pattern from agents/types.ts
 *   - LiteSnapshot from lite-types.ts
 */

import type { FormAnalysis } from '../../agents/types';
import type { LiteSnapshot } from '../../lite-types';
import type { BudgetTracker } from '../budget-tracker';
import type { ExplorationTree } from '../exploration-tree';
import type { FlowQueue } from '../flow-queue';
import type { RateLimiter } from '../rate-limiter';
import type { ExplorationTraceService } from '../exploration-trace.service';
import type {
  ExplorationConfig,
  ExplorationProgressCallback,
  EntryPoint,
  FlowExplorationTask,
  DiscoveredStep,
  FlowError,
  ErrorClassification,
  BlockerType,
  TestFlowCategory,
  FlowPriority,
  FlowComplexity,
  RelatedElement,
} from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// EXPLORATION BLACKBOARD — Shared state for all agents
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationBlackboard {
  // ── Immutable (set once at creation) ──
  readonly config: ExplorationConfig;
  readonly explorationId: string;
  readonly entryUrl: string;
  readonly scopeHint?: string;
  readonly hasCredentials: boolean;

  // ── Page Graph (Cartographer writes, all read) ──
  // null before Phase 1 completes — always check before access
  tree: ExplorationTree | null;
  pageInsights: Map<string, CartographerInsight>;

  // ── Strategy (Strategist writes, FlowRunner/Sentinel read) ──
  currentStrategy?: StrategistOutput;
  // null before Phase 1.5 completes — always check before access
  queue: FlowQueue | null;

  // ── Execution Results (FlowRunner writes, Scout/Sentinel/Strategist read) ──
  completedFlows: FlowExecutionResult[];
  activeFlows: Map<string, FlowProgress>;

  // ── Branch Discovery (Scout writes, Strategist reads) ──
  discoveredBranches: ScoutDiscovery[];

  // ── Coverage (Sentinel writes, Strategist/Engine read) ──
  coverageAssessment?: SentinelAssessment;

  // ── Auth State ──
  auth: {
    loginCompleted: boolean;
    loginAttempted: boolean;
    authStateJson?: object;
    detectedLoginPages: string[];
  };

  // ── Working Memory ──
  workingMemory: ExplorationWorkingMemory;

  // ── User Intervention ──
  userDirectives: UserDirective[];

  // ── Infrastructure ──
  budget: BudgetTracker;
  rateLimiter: RateLimiter;
  trace: ExplorationTraceService;
  emitProgress: ExplorationProgressCallback;
}

/** Working memory for exploration — tracks visited pages and accomplishments */
export interface ExplorationWorkingMemory {
  /** Pages visited during exploration: URL → visit info */
  visitedPages: Record<string, { pageType: string; visitCount: number; lastVisitedAt: number }>;
  /** Accomplishments completed so far (bounded, most recent) */
  accomplishments: string[];
  /** Categories of flows we've explored */
  categoriesExplored: Set<string>;
}

/** User directive from WebSocket intervention */
export interface UserDirective {
  type: 'focus' | 'skip' | 'stop' | 'credentials' | 'captcha_response' | 'custom';
  value: string;
  receivedAt: number;
}

/** Live progress for an active flow */
export interface FlowProgress {
  entryPointId: string;
  flowName: string;
  startedAt: number;
  currentStep: number;
  totalStepsEstimate: number;
  status: 'running' | 'completing';
}

/** Completed flow result stored in blackboard */
export interface FlowExecutionResult {
  entryPointId: string;
  name: string;
  category: TestFlowCategory;
  status: 'passed' | 'failed' | 'blocked' | 'timeout' | 'skipped';
  goalAchieved: boolean;
  steps: DiscoveredStep[];
  stepsCount: number;
  durationMs: number;
  errors: FlowError[];
  errorClassification: ErrorClassification;
  blockerType?: BlockerType;
  blockedReason?: string;
  canUserHelp?: boolean;
  progressScore: number;
  roundsUsed: number;
  finalUrl: string;
  /** The full FlowExplorationTask for TestCaseBuilder */
  rawTask: FlowExplorationTask;
}

// ═══════════════════════════════════════════════════════════════════════════
// CARTOGRAPHER — Page Understanding Agent
// ═══════════════════════════════════════════════════════════════════════════

export interface CartographerInput {
  /** Current page URL */
  url: string;
  /** Page title */
  title: string;
  /** Full page snapshot — NO truncation */
  snapshot: LiteSnapshot;
  /** Base64-encoded screenshot */
  screenshot?: string;
  /** User scope hint */
  scopeHint?: string;
  /** Whether credentials are available */
  hasCredentials: boolean;
  /** BFS depth of this page */
  depth: number;
  /** Context about what we've explored so far */
  explorationContext: {
    pagesVisited: number;
    categoriesSeen: string[];
    entryPointsSoFar: number;
    recentPageTypes: string[];
  };
  /** Overlays that were dismissed on this page */
  overlaysDismissed?: string[];
  /** Product context collected from DOM (meta tags, headings, nav links, prominent buttons) */
  productContext?: string;
}

export interface CartographerOutput {
  /** AI-classified page type (no fixed enum — AI chooses) */
  pageType: string;
  /** Discovered entry points — NO CAP, AI returns all it finds */
  entryPoints: CartographerEntryPoint[];
  /** Navigation links — NO CAP, AI picks relevant ones */
  navigationLinks: CartographerNavLink[];
  /** Auth detection results */
  authDetection: AuthDetectionResult;
  /** Deep page insight stored in blackboard for other agents */
  pageInsight: CartographerInsight;
  /** Should we explore sub-pages of this page? */
  recommendDeeper: boolean;
  /** If page should be skipped entirely (AI decides, not regex) */
  skipReason?: string;
}

export interface CartographerEntryPoint {
  name: string;
  goal: string;
  category: TestFlowCategory;
  priority: FlowPriority;
  requiresAuth: boolean;
  estimatedComplexity: FlowComplexity;
  relatedElements: RelatedElement[];
  dependsOn?: string;
}

export interface CartographerNavLink {
  ref: string;
  label: string;
  estimatedPageType: string;
  /** AI's reason for including this link */
  relevance?: string;
}

export interface AuthDetectionResult {
  isLoginPage: boolean;
  isAuthGated: boolean;
  loginFormRef?: string;
  loginUrl?: string;
  /** Test/demo credentials found displayed on the page */
  testCredentials?: { username?: string; password?: string };
}

/** Deep page understanding — stored in blackboard, read by all agents */
export interface CartographerInsight {
  pageId: string;
  pageType: string;
  /** Detected forms with field details (reuses LiteEngine FormAnalysis) */
  forms: FormAnalysis[];
  /** High-level interactive areas on the page */
  interactiveAreas: string[];
  /** Data entities visible on the page (users, products, orders, etc.) */
  dataEntities: string[];
  /** State indicators (logged in, cart items, step progress, etc.) */
  stateIndicators: string[];
  /** AI-assessed page complexity */
  complexity: string;
  /** URLs visible/linked from this page */
  relatedPages: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGIST — Exploration Planning Agent
// ═══════════════════════════════════════════════════════════════════════════

export interface StrategistInput {
  /** Condensed tree summary */
  tree: ExplorationTreeSummary;
  /** ALL entry points — no filtering */
  allEntryPoints: EntryPoint[];
  /** Deep page insights from Cartographer — one per page */
  pageInsights: CartographerInsight[];
  /** Completed flow results */
  completedFlows: FlowSummary[];
  /** Blocked flow info */
  blockedFlows: BlockedFlowSummary[];
  /** Recent discoveries from Scout */
  recentDiscoveries: ScoutDiscovery[];
  /** Coverage assessment from Sentinel (during re-evaluation) */
  coverageAssessment?: SentinelAssessment;
  /** Remaining budget */
  budget: BudgetSummary;
  /** Whether auth credentials are available */
  hasCredentials: boolean;
  /** User scope hint */
  scopeHint?: string;
  /** User directive from WebSocket */
  userDirective?: string;
  /** Nav link URLs discovered during survey but not yet visited — concrete targets for continueSurvey */
  unvisitedNavLinks: Array<{ url: string; label: string; sourcePageUrl: string }>;
}

export interface StrategistOutput {
  /** Prioritized execution plan with reasoning */
  plan: StrategistFlowPlan[];
  /** Auth strategy */
  authPlan: AuthPlan;
  /** Should Phase 1 survey continue? */
  continueSurvey: boolean;
  /** Specific URLs to explore next (if continueSurvey) */
  surveyTargets?: string[];
  /** Flows to skip with reasoning */
  skipFlows: Array<{ id: string; reason: string }>;
  /** Categories to focus on */
  focusAreas: string[];
  /** Narrative reasoning for trace logging */
  strategyReasoning: string;
}

export interface StrategistFlowPlan {
  entryPointId: string;
  name: string;
  /** 1 = highest priority */
  priority: number;
  /** Why this priority order */
  reason: string;
  /** Entry point that must complete first */
  dependsOn?: string;
}

export interface AuthPlan {
  loginFirst: boolean;
  loginEntryPointId?: string;
  loginUrl?: string;
  authGatedFlows: string[];
}

/** Condensed tree summary for Strategist prompt (avoids sending full snapshot data) */
export interface ExplorationTreeSummary {
  pages: Array<{
    id: string;
    url: string;
    pageType: string;
    entryPointCount: number;
    requiresAuth: boolean;
    depth: number;
  }>;
  totalPages: number;
  totalEntryPoints: number;
}

/** Condensed flow result for Strategist/Sentinel */
export interface FlowSummary {
  entryPointId: string;
  name: string;
  category: string;
  status: string;
  goalAchieved: boolean;
  stepsCount: number;
  errorsCount: number;
  durationMs: number;
}

export interface BlockedFlowSummary {
  entryPointId: string;
  name: string;
  blockerType: string;
  reason: string;
  canUserHelp: boolean;
}

export interface BudgetSummary {
  timeRemainingMs: number;
  flowsRemaining: number;
  roundsRemaining: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOUT — Branch Discovery Agent
// ═══════════════════════════════════════════════════════════════════════════

export interface ScoutInput {
  /** Context of the completed flow */
  completedFlow: {
    name: string;
    goal: string;
    category: string;
    status: 'passed' | 'failed' | 'blocked';
    steps: DiscoveredStep[];
    finalUrl: string;
    errorsFound: number;
  };
  /** Current page snapshot (final state after flow) */
  snapshot: LiteSnapshot;
  /** All known flow names (for dedup) */
  knownFlows: string[];
  /** All known page URLs (for dedup) */
  knownPages: string[];
  /** Cartographer insight for current page (if available) */
  pageInsight?: CartographerInsight;
  /** Remaining budget */
  flowsRemaining: number;
}

export interface ScoutOutput {
  /** Newly discovered entry points — NO CAP */
  newEntryPoints: CartographerEntryPoint[];
  /** New pages worth surveying */
  newPages: string[];
  /** Brief observation for Strategist context */
  insight: string;
}

/** Stored in blackboard after each Scout call */
export interface ScoutDiscovery {
  sourceFlowId: string;
  sourceFlowName: string;
  discoveredAt: number;
  newEntryPoints: CartographerEntryPoint[];
  newPages: string[];
  insight: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// SENTINEL — Coverage Evaluation Agent
// ═══════════════════════════════════════════════════════════════════════════

export interface SentinelInput {
  /** Total pages discovered */
  pagesDiscovered: number;
  /** Deep page insights from Cartographer */
  pageInsights: CartographerInsight[];
  /** Completed flow results */
  completedFlows: FlowSummary[];
  /** Blocked flow info */
  blockedFlows: BlockedFlowSummary[];
  /** Skipped flow info */
  skippedFlows: Array<{ name: string; category: string; reason: string }>;
  /** Categories covered */
  categoriesCovered: string[];
  /** Total steps executed */
  totalStepsExecuted: number;
  /** Total errors found */
  errorsFound: number;
  /** Remaining budget */
  budget: BudgetSummary;
  /** User scope hint */
  scopeHint?: string;
}

export interface SentinelAssessment {
  /** Estimated coverage score 0-100 */
  coverageScore: number;
  /** What's missing */
  gaps: string[];
  /** Should we continue exploring? */
  continueExploring: boolean;
  /** If continuing — focus areas */
  focusNext?: string[];
  /** User-facing quality summary */
  qualitySummary: string;
  /** Actionable recommendations */
  recommendations: string[];
  /** Areas with errors/concerns */
  riskAreas: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTENDED PROGRESS EVENT TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** All exploration event types for WebSocket streaming */
export type ExplorationEventType =
  // Phase 1: Survey
  | 'page_discovered'
  | 'page_skipped'
  | 'auth_detected'
  | 'survey_complete'
  // Phase 1.5: Strategy
  | 'strategy_planned'
  | 'strategy_updated'
  | 'auth_started'
  | 'auth_completed'
  // Phase 2: Flow Execution
  | 'flow_queued'
  | 'flow_started'
  | 'flow_step'
  | 'flow_completed'
  | 'flow_failed'
  | 'flow_blocked'
  | 'branch_found'
  // Phase 2.5: Coverage
  | 'coverage_evaluated'
  | 'extra_round_started'
  // User Intervention
  | 'clarification_needed'
  | 'user_directive_applied'
  // Lifecycle
  | 'exploration_complete';
