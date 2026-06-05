/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPLORATION AGENT — Type Definitions
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Types for the autonomous test case discovery system.
 *
 * Architecture:
 *   Phase 1 (Survey): BFS page discovery → ExplorationTree
 *   Phase 2 (Flow Exploration): parallel TestPipeline runs → DiscoveredTestCase[]
 *
 * Reuses:
 *   - TestAction from test-case/types.ts
 *   - LiteSnapshot, LiteElement from lite-types.ts
 *   - TestPipelineResult from pipeline/types.ts
 *   - TestCase, TestStep from test-case/types.ts
 */

import type { TestAction, TestCase, TestStep } from '../test-case/types';
import type { IntentStep, IntentActionType } from '@/services/testing/ui/preview/preview.types';
import type { IntentTestCase, Priority } from '@/types/testing.types';

// ═══════════════════════════════════════════════════════════════════════════
// EXPLORATION CONFIG (input)
// ═══════════════════════════════════════════════════════════════════════════

/** Progress event emitted during exploration for real-time UI updates */
export type ExplorationProgressEvent = {
  explorationId: string;
  phase: 'survey' | 'strategizing' | 'flow' | 'evaluating' | 'complete';
  event:
    | 'page_discovered' | 'survey_complete'
    | 'strategy_planned'
    | 'flow_started' | 'flow_completed' | 'flow_failed' | 'flow_blocked' | 'flow_step' | 'branch_found'
    | 'coverage_evaluated'
    | 'agent_warning' | 'agent_error';
  data: Record<string, any>;
  progressPercent: number;
  timestamp: number;
};

/** Callback for exploration progress reporting */
export type ExplorationProgressCallback = (event: ExplorationProgressEvent) => void;

export interface RateLimitingConfig {
  /** Min delay between Playwright navigations (ms). Default: 500 */
  minDelayBetweenNavigationsMs?: number;
  /** Min delay between AI API calls (ms). Default: 200 */
  minDelayBetweenAiCallsMs?: number;
  /** Max consecutive rate limits per target before degradation. Default: 3 */
  maxConsecutiveRateLimits?: number;
  /** Base backoff delay (ms). Default: 5000 */
  baseBackoffMs?: number;
  /** Max backoff delay (ms). Default: 30000 */
  maxBackoffMs?: number;
}

export interface ExplorationConfig {
  /** Entry URL to start exploring */
  entryUrl: string;
  /** Unique exploration run ID */
  explorationId: string;
  /** Optional credentials for auth-gated pages */
  credentials?: {
    email?: string;
    username?: string;
    phone?: string;
    password: string;
  };
  /**
   * Pre-seeded auth state (Playwright storageState shape) that lets the
   * agent skip the login flow entirely. If both `authFixture` and
   * `credentials` are provided, the fixture wins — credentials are kept
   * only as a fallback if the fixture turns out to be expired. Validated
   * by validateAuthFixture() before being handed to Playwright.
   *
   * Shape matches Playwright's BrowserContextOptions.storageState (a JSON
   * object — the string-path form is NOT accepted over the wire).
   */
  authFixture?: import('./auth-fixture').AuthFixture;
  /** Scope hint from user (e.g. "registration flow", "full site") */
  scopeHint?: string;
  /** Budget constraints */
  budget: ExplorationBudget;
  /** Max concurrent flow explorations (sub-agents) */
  maxConcurrency?: number;
  /** Project ID for context */
  projectId: string;
  /** User ID for WebSocket routing */
  userId?: string;
  /** Chat session ID for WebSocket routing */
  chatSessionId?: string;
  /** Workspace ID for skills context */
  workspaceId?: string;
  /** Optional callback for real-time progress reporting */
  onProgress?: ExplorationProgressCallback;
  /** Rate limiting configuration for external requests */
  rateLimiting?: RateLimitingConfig;
}

export interface ExplorationBudget {
  /** Total time limit for entire exploration (ms). Default: 15 min */
  totalTimeoutMs: number;
  /** Time limit per individual flow (ms). Default: 3 min */
  perFlowTimeoutMs: number;
  /** Max pages to survey in Phase 1. Default: 10 */
  maxSurveyPages: number;
  /** Max flows to explore in Phase 2. Default: 20 */
  maxFlows: number;
  /** Max total pipeline rounds across all flows. Default: 100 */
  maxTotalPipelineRounds: number;
  /**
   * Max flows allowed against a single page pattern (URL normalized via
   * the pattern extractor — /products/123 and /products/456 share one
   * bucket). Prevents a chatty SPA dashboard or Scout-discovered branches
   * on one URL from eating the whole global maxFlows budget while other
   * surveyed pages get zero coverage. 0 disables the gate. Default: 3.
   */
  maxFlowsPerPage?: number;
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
  totalTimeoutMs: 15 * 60 * 1000,
  perFlowTimeoutMs: 3 * 60 * 1000,
  maxSurveyPages: 10,
  maxFlows: 30,
  maxTotalPipelineRounds: 150,
  maxFlowsPerPage: 3,
};

export const DEFAULT_MAX_CONCURRENCY = 5;

/** Desktop user agent — re-exported from centralized config */
export { BROWSER_USER_AGENT as DESKTOP_USER_AGENT } from '@/config/testing/playwright-tuning';

// ═══════════════════════════════════════════════════════════════════════════
// TEST FLOW CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

export type TestFlowCategory =
  | 'authentication'
  | 'navigation'
  | 'search'
  | 'form_submission'
  | 'crud'
  | 'e_commerce'
  | 'content'
  | 'user_management'
  | 'error_handling'
  | 'other';

export type FlowPriority = 'critical' | 'high' | 'medium' | 'low';

export type FlowComplexity = 'simple' | 'medium' | 'complex';

// ═══════════════════════════════════════════════════════════════════════════
// EXPLORATION TREE (Phase 1 output)
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationNode {
  /** Unique node ID */
  id: string;
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** AI-classified page type */
  pageType: string;
  /** Discovered entry points (testable flows) on this page */
  entryPoints: EntryPoint[];
  /** Navigation edges to child pages */
  children: ExplorationEdge[];
  /** Depth in tree (0 = entry URL) */
  depth: number;
  /** Whether this page requires authentication */
  requiresAuth: boolean;
  /** Content hash for SPA dedup (hash of key element structure) */
  contentHash: string;
  /** Timestamp when page was surveyed */
  surveyedAt: number;
  /** Error if page failed to load */
  error?: string;
}

export interface ExplorationEdge {
  /** Navigation action taken to reach child */
  action: NavigationAction;
  /** Child node ID */
  targetNodeId: string;
}

export interface NavigationAction {
  /** Type of navigation */
  type: 'click_link' | 'click_button' | 'navigate_url';
  /** Element ref used */
  ref?: string;
  /** Element text/label */
  label: string;
  /** Target URL (if known before clicking) */
  targetUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINTS (discovered testable flows)
// ═══════════════════════════════════════════════════════════════════════════

export interface EntryPoint {
  /** Unique entry point ID */
  id: string;
  /** Generated test case name (e.g. "User Login", "Product Search") */
  name: string;
  /** Generated test goal description */
  goal: string;
  /** Category of the test flow */
  category: TestFlowCategory;
  /** Priority for exploration order */
  priority: FlowPriority;
  /** Whether credentials are needed for this flow */
  requiresAuth: boolean;
  /** Estimated complexity */
  estimatedComplexity: FlowComplexity;
  /** Elements involved (form fields, buttons, links) */
  relatedElements: RelatedElement[];
  /** Page node where this entry point was discovered */
  sourceNodeId: string;
  /** Source page URL */
  sourcePageUrl: string;
  /** Precondition: another entry point that must complete first */
  dependsOn?: string;
}

export interface RelatedElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// AI CLASSIFICATION RESULT (from PageClassifier prompt)
// ═══════════════════════════════════════════════════════════════════════════

export interface PageClassificationResult {
  pageType: string;
  entryPoints: Array<{
    name: string;
    goal: string;
    category: TestFlowCategory;
    priority: FlowPriority;
    requiresAuth: boolean;
    estimatedComplexity: FlowComplexity;
    relatedElements: RelatedElement[];
    dependsOn?: string;
  }>;
  navigationLinks: Array<{
    ref: string;
    label: string;
    estimatedPageType: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR TRACKING
// ═══════════════════════════════════════════════════════════════════════════

export interface FlowError {
  /** Error source */
  source: 'network' | 'console' | 'dom' | 'playwright' | 'ai';
  /** Error message */
  message: string;
  /** Severity level */
  severity: 'info' | 'warning' | 'error' | 'critical';
  /** Step number where error occurred */
  stepNumber: number;
  /** Whether the agent recovered from this error */
  recovered: boolean;
  /** Context: page URL + action that caused it */
  context: string;
}

export type ErrorClassification = 'no_errors' | 'recoverable' | 'blocking' | 'app_bug';

/** Type of blocker that prevents automation */
export type BlockerType = 'captcha' | '2fa' | 'payment' | 'external_service' | 'login_wall' | 'file_upload' | 'other';

// ═══════════════════════════════════════════════════════════════════════════
// FLOW EXPLORATION (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════

export type FlowExplorationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'timeout';

export interface FlowExplorationTask {
  /** Entry point being explored */
  entryPoint: EntryPoint;
  /** Current status */
  status: FlowExplorationStatus;
  /** Discovered test steps (extracted from pipeline rounds) */
  discoveredSteps: DiscoveredStep[];
  /** Branch points noticed during exploration */
  branchPoints: EntryPoint[];
  /** Errors encountered during exploration */
  errors: FlowError[];
  /** Error classification */
  errorClassification: ErrorClassification;
  /** Execution time (ms) */
  durationMs: number;
  /** Whether the flow goal was achieved */
  goalAchieved: boolean;
  /** Blocked reason if flow was blocked */
  blockedReason?: string;
  /** Blocker type for classification (captcha, 2fa, payment, etc.) */
  blockerType?: BlockerType;
  /** Whether a human user can unblock this (e.g. solve CAPTCHA) */
  canUserHelp?: boolean;
  /** Pipeline progress score (0-100) */
  progressScore: number;
  /** Pipeline rounds used */
  roundsUsed: number;
  /** Error info if failed at infra level */
  infraError?: string;
  /** Actual page URL when the flow finished (before context teardown). Falls back to the source page when unavailable. */
  finalUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVERED STEPS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Successful XHR/fetch call captured during a step's execution window.
 * Used as the source for network-level assertions in generated test cases.
 * URLs are stored as patterns (id-shaped segments replaced) so assertions
 * are stable across runs.
 */
export interface CapturedApiCall {
  method: string;
  /** URL pattern (id-shaped segments collapsed, query dropped) */
  urlPattern: string;
  status: number;
  /** Relative timestamp (ms after flow start) */
  timestampMs: number;
}

export interface DiscoveredStep {
  /** Step number (1-based) */
  stepNumber: number;
  /** Human-readable description */
  description: string;
  /** Action type (reuses TestAction from test-case/types.ts) */
  action: TestAction;
  /** Element selector (CSS or AI-friendly) */
  selector?: string;
  /** Element ref from snapshot */
  ref?: string;
  /** Value for fill/select actions */
  value?: string;
  /** Whether value is a credential placeholder */
  isSensitive?: boolean;
  /** URL where step was executed */
  pageUrl: string;
  /** Expected outcome description */
  expectedOutcome?: string;
  /**
   * Successful XHR/fetch calls observed in the window following this action.
   * Empty/undefined for reads (observe_page) and on non-interactive steps.
   */
  networkCalls?: CapturedApiCall[];
}

/**
 * Single assertion attached to a DiscoveredTestCase — produced by the builder,
 * consumed by users reviewing exploration output and by downstream replay.
 */
export interface TestAssertion {
  type: 'network' | 'url' | 'console';
  /** Human-readable expectation, e.g. "POST /api/auth returns 2xx" */
  expect: string;
  /** For type=network: the captured call that sourced this assertion */
  source?: {
    method?: string;
    urlPattern?: string;
    status?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVERED TEST CASE (final output per flow)
// ═══════════════════════════════════════════════════════════════════════════

/** Test case type: positive (happy path) or negative (error scenario) */
export type TestCaseType = 'positive' | 'negative';

export interface DiscoveredTestCase {
  /** Unique test case ID */
  id: string;
  /** Test case name */
  name: string;
  /** Test case description */
  description: string;
  /** Category */
  category: TestFlowCategory;
  /** Priority */
  priority: FlowPriority;
  /** Test type: positive (happy path) or negative (empty submit, invalid data) */
  testType: TestCaseType;
  /** Whether this was successfully explored */
  explored: boolean;
  /** Exploration status */
  status: 'passed' | 'failed' | 'blocked' | 'not_explored';
  /** Ordered test steps */
  steps: DiscoveredStep[];
  /** Entry URL for this test case */
  entryUrl: string;
  /** Whether credentials are needed */
  requiresAuth: boolean;
  /** Tags for filtering */
  tags: string[];
  /** Estimated duration based on exploration (ms) */
  estimatedDurationMs?: number;
  /** Errors found during exploration */
  errors: FlowError[];
  /** Error classification */
  errorClassification: ErrorClassification;
  /** Source page where this flow was discovered */
  sourcePageUrl: string;
  /** Expected result description */
  expectedResult?: string;
  /** Preconditions for this test case */
  preconditions?: string[];
  /**
   * Test-case-level assertions (network / URL / console).
   * Built by TestCaseBuilder from captured step-level signals. Empty array
   * when the flow did not produce network activity worth asserting on.
   */
  assertions?: TestAssertion[];
  /** Blocker info if flow was blocked (CAPTCHA, 2FA, etc.) */
  blocker?: {
    type: BlockerType;
    reason: string;
    /** Step number where blocker was encountered */
    atStep: number;
    /** Whether a human can unblock this */
    canUserHelp: boolean;
  };
}

/**
 * Convert a DiscoveredTestCase to the existing TestCase format
 * for direct replay execution via TestCaseExecutor.
 */
export function toTestCase(discovered: DiscoveredTestCase): TestCase {
  return {
    id: discovered.id,
    name: discovered.name,
    description: discovered.description,
    steps: discovered.steps.map((step): TestStep => ({
      id: `step-${step.stepNumber}`,
      description: step.description,
      action: step.action,
      selector: step.selector || step.ref,
      value: step.value,
      screenshot: true,
    })),
    timeout: discovered.estimatedDurationMs
      ? discovered.estimatedDurationMs * 2
      : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTENT STEP CONVERSION (for stepsJson in IntentTestCase)
// ═══════════════════════════════════════════════════════════════════════════

/** Map DiscoveredStep action to IntentActionType */
const ACTION_TO_INTENT_TYPE: Record<string, IntentActionType> = {
  navigate: 'navigate',
  click: 'click',
  fill: 'type',
  select: 'select',
  press: 'press',
  hover: 'hover',
  scroll: 'scroll',
  wait: 'wait',
  verify: 'ai_check',
  custom: 'click',
  toggle: 'toggle',
  setRange: 'type',
  selectDate: 'type',
  clear: 'click',
};

/**
 * Convert DiscoveredStep[] to IntentStep[] format.
 * This is the format stored in IntentTestCase.stepsJson.
 */
export function toIntentSteps(steps: DiscoveredStep[]): IntentStep[] {
  return steps.map((step, index): IntentStep => {
    const intentType = ACTION_TO_INTENT_TYPE[step.action] || 'click';

    const intentStep: IntentStep = {
      id: `step-${index + 1}`,
      type: intentType,
      description: step.description,
    };

    // Add value for actions that carry data
    if (step.value) {
      if (intentType === 'type') {
        intentStep.value = step.isSensitive ? '{{password}}' : step.value;
      } else if (['select', 'navigate', 'press'].includes(intentType)) {
        intentStep.value = step.value;
      }
    }

    // Add assertion text for verify/ai_check actions
    if (intentType === 'ai_check' && step.expectedOutcome) {
      intentStep.assertionText = step.expectedOutcome;
    }

    // Propagate expectedOutcome — DiscoveredStep stores a string description,
    // but IntentStep uses 'success' | 'error' enum. Only set 'error' if the
    // exploration agent explicitly marked the step with that exact value.
    if (step.expectedOutcome === 'error') {
      intentStep.expectedOutcome = 'error';
    }

    // Add binding hints from step metadata
    if (step.ref || step.selector) {
      intentStep.bindingHints = {
        label: step.ref,
        nearText: step.description,
      };
    }

    return intentStep;
  });
}

/**
 * Convert a DiscoveredTestCase to IntentTestCase format.
 * This is the format used for database storage and regression testing.
 */
export function toIntentTestCase(
  discovered: DiscoveredTestCase,
  projectId: string,
  userId: string,
): Partial<IntentTestCase> {
  return {
    id: discovered.id,
    projectId,
    userId,
    name: discovered.name,
    description: discovered.description,
    startUrl: discovered.entryUrl,
    url: discovered.entryUrl,
    status: 'draft',
    kind: 'standalone',
    stepsJson: toIntentSteps(discovered.steps),
    tags: discovered.tags,
    priority: discovered.priority as Priority,
    expectedResult: discovered.expectedResult,
    preconditions: discovered.preconditions,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPLORATION RESULT (final output)
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationResult {
  /** Exploration run ID */
  explorationId: string;
  /** Entry URL that was explored */
  entryUrl: string;
  /** Total exploration duration (ms) */
  durationMs: number;
  /** Exploration tree (page graph) */
  tree: ExplorationNode[];
  /** All discovered test cases */
  testCases: DiscoveredTestCase[];
  /** Summary statistics */
  summary: ExplorationSummary;
  /** Budget usage */
  budgetUsed: BudgetUsage;
  /** Flows that were skipped (budget exhausted) */
  skippedFlows: Array<{
    entryPoint: EntryPoint;
    reason: string;
  }>;
}

export interface ExplorationSummary {
  /** Total pages surveyed */
  pagesSurveyed: number;
  /** Total entry points discovered */
  entryPointsDiscovered: number;
  /** Total flows explored */
  flowsExplored: number;
  /** Successful flows */
  flowsPassed: number;
  /** Failed flows */
  flowsFailed: number;
  /** Blocked flows */
  flowsBlocked: number;
  /** Skipped flows (budget exhausted) */
  flowsSkipped: number;
  /** Total steps discovered */
  totalStepsDiscovered: number;
  /** Unique pages visited */
  uniquePages: number;
  /** Categories discovered */
  categories: TestFlowCategory[];
  /** Sentinel coverage score (0-100), set after Phase 2.5 */
  coverageScore?: number;
  /** Sentinel quality summary, set after Phase 2.5 */
  qualitySummary?: string;
  /** Sentinel coverage gaps, set after Phase 2.5 */
  gaps?: string[];
  /** Sentinel recommendations, set after Phase 2.5 */
  recommendations?: string[];
  /** Sentinel risk areas, set after Phase 2.5 */
  riskAreas?: string[];
  /** Discovered pages for history view */
  pages?: Array<{
    url: string;
    title: string;
    pageType: string;
    entryPointCount: number;
    depth: number;
  }>;
  /** Individual flow results for history view (populated on completeRun) */
  flows?: Array<{
    name: string;
    category: string;
    status: string;
    durationMs?: number;
    stepsCount: number;
    blockerType?: string;
    /** Human-readable blocker reason (e.g. "CAPTCHA required"). */
    blockerReason?: string;
    /** Whether a human can manually unblock this flow. */
    canUserHelp?: boolean;
    errorMessage?: string;
    /**
     * Network-level assertions derived from captured XHR/fetch calls — one
     * entry per unique method+pattern+status-family tuple. Carried through
     * the summary so the frontend can render them without a second lookup.
     */
    assertions?: Array<{
      type: 'network' | 'url' | 'console';
      expect: string;
    }>;
    steps: Array<{
      stepNumber: number;
      action: string;
      description: string;
      value?: string;
      pageUrl?: string;
    }>;
  }>;
}

export interface BudgetUsage {
  timeUsedMs: number;
  timeRemainingMs: number;
  flowsUsed: number;
  flowsRemaining: number;
  pipelineRoundsUsed: number;
  pipelineRoundsRemaining: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECKPOINT / RESUME (crash recovery)
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationCheckpoint {
  version: 1;
  phase: 'survey' | 'flow';
  timestamp: number;

  /** ExplorationTree state */
  tree: TreeCheckpoint;

  /** BudgetTracker state */
  budget: BudgetCheckpoint;

  /** FlowQueue state (only if phase === 'flow') */
  queue?: QueueCheckpoint;

  /** FlowRunner state (only if phase === 'flow') */
  flowRunner?: FlowRunnerCheckpoint;

  /** Auth state (cached storageState JSON) */
  authState?: object;

  /** Cartographer page insights (serialized from Map) */
  pageInsights?: Array<[string, any]>;
}

export interface TreeCheckpoint {
  nodes: ExplorationNode[];
  visitedUrls: string[];
  visitedContentHashes: string[];
  allEntryPoints: Array<[string, EntryPoint]>;
  nodeIdCounter: number;
  discoveredNavLinks?: Array<[string, { url: string; label: string; sourcePageUrl: string }]>;
}

export interface BudgetCheckpoint {
  flowsCompleted: number;
  pipelineRoundsUsed: number;
  pagesSurveyed: number;
  startTime: number;
}

export interface QueueCheckpoint {
  queue: EntryPoint[];
  completed: string[];
  allGoals: Array<[string, string]>;
  allNames?: string[]; // normalized names for dedup — optional for backward compat
}

export interface FlowRunnerCheckpoint {
  loginCompleted: boolean;
  knownFlowNames: string[];
  flowsCompleted: number;
  completedTasks: FlowExplorationTask[];
}
