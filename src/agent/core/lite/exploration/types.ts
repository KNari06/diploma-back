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
  phase: 'survey' | 'flow' | 'complete';
  event: 'page_discovered' | 'survey_complete' | 'flow_started' | 'flow_completed' | 'flow_failed' | 'flow_blocked' | 'branch_found';
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
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
  totalTimeoutMs: 15 * 60 * 1000,
  perFlowTimeoutMs: 3 * 60 * 1000,
  maxSurveyPages: 10,
  maxFlows: 20,
  maxTotalPipelineRounds: 100,
};

export const DEFAULT_MAX_CONCURRENCY = 5;

/** Desktop user agent to prevent mobile redirects during exploration */
export const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVERED STEPS
// ═══════════════════════════════════════════════════════════════════════════

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
}

export interface BudgetUsage {
  timeUsedMs: number;
  timeRemainingMs: number;
  flowsUsed: number;
  flowsRemaining: number;
  pipelineRoundsUsed: number;
  pipelineRoundsRemaining: number;
}
