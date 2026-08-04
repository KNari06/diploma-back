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
import type { IntentStep, IntentActionType, CompiledStepPlan } from '@/services/testing/ui/preview/preview.types';
import type { IntentTestCase, Priority, TestAssertion } from '@/types/testing.types';
import { isBoundSecretPlaceholder } from '@/utils/interpolation/redact-secrets';
import { extractElementLabel } from './element-label';

// ═══════════════════════════════════════════════════════════════════════════
// EXPLORATION CONFIG (input)
// ═══════════════════════════════════════════════════════════════════════════

/** Progress event emitted during exploration for real-time UI updates */
export type ExplorationProgressEvent = {
  explorationId: string;
  phase: 'survey' | 'strategizing' | 'flow' | 'evaluating' | 'complete';
  event:
    | 'page_discovered' | 'page_skipped' | 'survey_complete'
    | 'strategy_planned'
    | 'auth_started' | 'auth_completed'
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
  /**
   * Which preset produced `budget`. Explicit rather than inferred from the budget
   * numbers, because "is this a quick run?" is a policy question and a timeout
   * threshold is a bad proxy for it (a caller with a custom budget would behave
   * unpredictably).
   *
   * Absent = `full`: the chat producers pass no budget and receive
   * DEFAULT_EXPLORATION_BUDGET, which IS the full preset. Read this via
   * `isQuickPreset()` — never compare the string in two places.
   */
  preset?: ExplorationPreset;
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

/**
 * Budget presets selectable at exploration start.
 *
 * - 'quick': onboarding / "magic first test". Caps total wall-clock at ~2 min
 *   so a self-serve user gets a starter pack of a few tests fast, trading
 *   coverage for time-to-value. Survey shallow, few flows.
 * - 'full': the default thorough sweep (DEFAULT_EXPLORATION_BUDGET).
 *
 * A preset resolves to a Partial<ExplorationBudget> that is shallow-merged
 * over DEFAULT_EXPLORATION_BUDGET by the engine, so omitted fields fall back
 * to defaults.
 */
export type ExplorationPreset = 'quick' | 'full';

export const EXPLORATION_PRESETS: Record<ExplorationPreset, Partial<ExplorationBudget>> = {
  quick: {
    totalTimeoutMs: 2 * 60 * 1000,
    perFlowTimeoutMs: 45 * 1000,
    maxSurveyPages: 3,
    maxFlows: 5,
    maxTotalPipelineRounds: 25,
    maxFlowsPerPage: 2,
  },
  // Spread so callers can't mutate DEFAULT_EXPLORATION_BUDGET through this ref.
  full: { ...DEFAULT_EXPLORATION_BUDGET },
};

/**
 * Is this run on the `quick` (onboarding) preset?
 *
 * **Single source for every preset-gated behaviour** — never compare the string
 * inline. `quick` is 2 min TOTAL and is the self-serve "magic first test" path
 * where time-to-first-test beats depth, so optional phases (Phase 0 product
 * analysis) are skipped there rather than given a smaller budget: a phase that
 * eats 30s of 120s before Phase 1 starts is worse than no phase at all.
 *
 * `undefined` → NOT quick. The chat producers pass no budget and get
 * DEFAULT_EXPLORATION_BUDGET, which IS the full preset; defaulting the other way
 * would silently disable optional phases on every chat-initiated run.
 */
export function isQuickPreset(preset?: ExplorationPreset): boolean {
  return preset === 'quick';
}

/**
 * Build a unique exploration run id. Single source of format for every call
 * site (chat confirmation + REST start) so ids stay greppable.
 */
export function generateExplorationId(userId: string): string {
  return `expl-${Date.now()}-${userId.slice(0, 8)}`;
}

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

/**
 * May a flow in this category author a deterministic `assert_text` step?
 *
 * Only `authentication` is excluded, and for a structural reason rather than a
 * cautious one: an auth flow's replay cannot reproduce its own login (the
 * credential path differs at replay time), so an assertion frozen against the
 * post-login page has nothing to stand on. Every other category replays the
 * steps that produced the asserted value, so the assertion is meaningful there.
 *
 * Deliberately NOT a longer blocklist: value-level risk (timestamps, ids,
 * live totals) is handled by `checkAssertVolatility`, which judges the actual
 * string. Banning whole categories on suspicion would silently delete the
 * feature's value for `e_commerce` and `crud`, which are exactly where a
 * checkable value matters most.
 */
export function categoryAllowsAssertAuthoring(category: TestFlowCategory): boolean {
  return category !== 'authentication';
}

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
export type BlockerType =
  | 'captcha'
  | '2fa'
  | 'payment'
  | 'external_service'
  | 'login_wall'
  | 'file_upload'
  // The flow needs a real value it cannot invent (promo/referral code, account
  // number, a one-time code that isn't strictly 2FA). User-resolvable via the
  // test_data clarification: they type the value, it's filled in, the flow retries.
  | 'needs_data'
  | 'other';

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
  /**
   * Compiled locator plan frozen from the resolved element at action time.
   * Present only for targeting actions whose executor returned a
   * `resolvedElement`. Carries the step into replay's stage-1 fast path so
   * the first regression run does NOT re-resolve the element via the LLM.
   */
  compiled?: CompiledStepPlan;
}

/**
 * Single assertion attached to a DiscoveredTestCase — produced by the builder,
 * consumed by users reviewing exploration output and by downstream replay.
 */
/**
 * Re-exported from shared types. The definition moved to
 * [testing.types.ts](../../../../types/testing.types.ts) when `IntentTestCase`
 * gained `networkAssertions` — exploration AUTHORS these, but replay VERIFIES
 * them, so the contract can no longer live in an exploration-private module.
 * `exploration/types.ts` already imports from `testing.types`, so importing back
 * would have made a cycle.
 *
 * Kept as a re-export so existing `from './types'` imports still resolve.
 */
export type { TestAssertion };

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
  // NOTE: `action:'assert'` (deterministic assert authored via the editor path)
  // is NOT handled by the direct-replay TestCaseExecutor — only by the IntentStep
  // chain (toIntentSteps → intent-step-converter → the replay command-executor
  // `assert` case). This is a LATENT gap, not a live one: assert authoring is
  // config-scoped to the editor (which persists via toIntentSteps, never this
  // function), and exploration — the only caller of toTestCase — never emits
  // assert (its pipeline has the flag off). If assert authoring is ever enabled
  // for exploration, add an `assert` case to TestCaseExecutor first.
  return {
    id: discovered.id,
    name: discovered.name,
    description: discovered.description,
    steps: discovered.steps.map((step): TestStep => ({
      id: `step-${step.stepNumber}`,
      description: step.description,
      action: step.action,
      // NOT `|| step.ref`: a snapshot ref is not a selector. Writing `e7` here
      // produced a step whose selector matches nothing on any page, which reads
      // as a real locator and fails at replay instead of falling through to
      // description-based resolution.
      selector: step.selector,
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
export const ACTION_TO_INTENT_TYPE: Record<string, IntentActionType> = {
  navigate: 'navigate',
  click: 'click',
  fill: 'type',
  select: 'select',
  press: 'press',
  hover: 'hover',
  scroll: 'scroll',
  wait: 'wait',
  verify: 'ai_check',
  assert: 'assert',
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
        // A sensitive step whose value is already a `{{secrets.*}}` placeholder
        // was frozen against a BOUND credential resource (see
        // `SecretKeyForKind` in pipeline-step-extractor) — carry it through so
        // replay resolves it from `runVariables`. The legacy `{{password}}`
        // mask stays for any sensitive value that isn't such a placeholder.
        intentStep.value =
          step.isSensitive && !isBoundSecretPlaceholder(step.value)
            ? '{{password}}'
            : step.value;
      } else if (['select', 'navigate', 'press', 'assert'].includes(intentType)) {
        // 'assert' is load-bearing: the converter's `type:'assert'` branch reads
        // `value` as the text-contains `expected`. Dropping it here silently
        // degrades the assert to a visibility check that passes on ANY page
        // (clean AND broken) — the whole deterministic-assert win no-ops.
        intentStep.value = step.value;
      }
    }

    // Add assertion text for verify/ai_check actions
    if (intentType === 'ai_check' && step.expectedOutcome) {
      intentStep.assertionText = step.expectedOutcome;
    }

    // Deterministic assert: pin a STRUCTURAL selector (data-testid / id) captured
    // at authoring time so replay's primary locator is text-independent. Without
    // this the compiled plan's primary is role-full-name (confidence 0.9 > testId
    // 0.8) — e.g. role=heading[name="1 result"] — which on a broken page shows a
    // different value and LOCATOR-MISSES instead of producing a clean text
    // assertion failure. options.cssSelector overrides command.selector (the same
    // pin the deterministic golden steps use).
    if (intentType === 'assert' && step.selector) {
      intentStep.options = { ...(intentStep.options ?? {}), cssSelector: step.selector };
    }

    // Propagate expectedOutcome — DiscoveredStep stores a string description,
    // but IntentStep uses 'success' | 'error' enum. Only set 'error' if the
    // exploration agent explicitly marked the step with that exact value.
    if (step.expectedOutcome === 'error') {
      intentStep.expectedOutcome = 'error';
    }

    // Add binding hints from step metadata.
    //
    // `label` must be a HUMAN name, never the snapshot ref: bindingHints are the
    // PREFERRED semantic-match source (evidence-shortcut.utils prefers them over
    // the description), so passing `e7` sends the resolver hunting for an element
    // labelled "e7" — which exists on no page — and demotes the description that
    // would actually have matched. The real name is recoverable from the
    // description the executor wrote ("Clicked \"Sign in\" (button)").
    if (step.ref || step.selector) {
      const label = extractElementLabel(step.description);
      intentStep.bindingHints = {
        ...(label ? { label } : {}),
        nearText: step.description,
      };
    }

    // Carry the compiled locator plan (frozen at action time) into the
    // persisted step so replay's stage-1 fast path hits on the first run
    // instead of re-resolving every element through the LLM.
    if (step.compiled) {
      intentStep.compiled = step.compiled;
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
    // Machine-checkable network expectations. Previously dropped here entirely:
    // the only trace that survived persist was a lossy `assert:` tag that
    // nothing reads back, so a discovered test's sole pass criterion was the
    // terminal `ai_check`. Only `network` assertions are carried — they are the
    // ones replay can verify (status family + id-parameterized url pattern);
    // `url`/`console` kinds have no verifier yet, and persisting an assertion
    // nothing can check would be decoration that LOOKS like verification.
    networkAssertions: discovered.assertions?.filter((a) => a.type === 'network'),
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
  /**
   * Entry points that yielded no runnable test case (zero-step timeout or
   * runner-level skip). Not a failure — these never ran — and excluded from the
   * rendered `flows`, so surfaced as its own bucket instead of inflating
   * flowsFailed. `flowsExplored === flowsPassed + flowsFailed + flowsBlocked`.
   */
  flowsNotExplored: number;
  /**
   * Runnable test cases = `flows.length`. This is what the results panel renders
   * and what actually persists (zero-step placeholders are dropped on save). Use
   * this for user-facing "test cases" counts, NOT `testCases.length`, which still
   * includes not_explored placeholders.
   */
  runnableTestCases: number;
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
  /**
   * Cached auth storageState (cookies + localStorage) captured after the first
   * successful login. Restored into a Phase-2.5 / resumed FlowRunner's
   * StateManager so its auth-gated flows reuse the session instead of running
   * logged-out with a stale `loginCompleted=true`. Optional / null before any
   * login happened.
   */
  authState?: object | null;
}
