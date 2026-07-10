/**
 * Testing Types
 * Type definitions for test hierarchy: Module → Flow → TestCase → Step
 */

// ============================================================================
// ENUMS AND BASIC TYPES
// ============================================================================

/**
 * Priority levels for tests and modules
 */
export type Priority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Test types (UI vs API)
 */
export type TestType = 'ui' | 'api';

/**
 * Flow types
 */
export type FlowType = 'ui' | 'api' | 'mixed';

/**
 * Execution status for test runs
 */
export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'timeout';

/**
 * Trigger types for test runs
 */
export type RunTrigger = 'manual' | 'chat' | 'scheduled' | 'webhook';

/**
 * How the Smart Resolver matched an existing test case
 */
export type ResolverMatchType = 'none' | 'partial';

/**
 * Metadata stored in test_chat_mappings for the Smart Resolver feedback loop
 */
export interface TestChatMappingMeta {
  resolverMatchType?: ResolverMatchType;
  trigger?: RunTrigger;
}

/**
 * Save-as-test-case suggestion attached to completion messages
 */
export interface SaveSuggestionMeta {
  available: true;
  testId: string;
  buttonLabel: string;
  buttonAction: { intent: 'save_test'; sourceTestId: string };
}

/**
 * Fixture scope levels
 */
export type FixtureScope = 'global' | 'project' | 'module' | 'flow';

/**
 * Plan item types
 */
export type PlanItemType = 'module' | 'flow' | 'test_case';

/**
 * Platform key types (top-level test category)
 */
export type PlatformKey = 'web_ui' | 'api' | 'mobile';

// ============================================================================
// FAILURE ANALYSIS TYPES
// ============================================================================

/**
 * Category of failure root cause
 */
export type FailureCategory =
  | 'network'
  | 'ui_element'
  | 'validation'
  | 'timeout'
  | 'auth'
  | 'server'
  | 'unknown';

/**
 * Structured failure root-cause analysis result
 */
export interface FailureAnalysisResult {
  rootCause: string;
  category: FailureCategory;
  severity: 'critical' | 'high' | 'medium' | 'low';
  suggestions: string[];
  affectedStep?: number;
  errorDetails: string;
}

// ============================================================================
// TEST RECOMMENDATION TYPES
// ============================================================================

/**
 * Type of test recommendation
 */
export type TestRecommendationType =
  | 'retest_failure'
  | 'untested_area'
  | 'stale_test'
  | 'regression_risk';

/**
 * AI-generated test recommendation
 */
export interface TestRecommendation {
  type: TestRecommendationType;
  title: string;
  reason: string;
  url?: string;
  relatedTestCaseId?: string;
  priority: 'high' | 'medium' | 'low';
}

// ============================================================================
// COVERAGE ANALYSIS TYPES
// ============================================================================

/**
 * Type of coverage gap identified
 */
export type CoverageGapType =
  | 'untested_url'
  | 'stale_test'
  | 'unstable_area'
  | 'no_test_case';

/**
 * A single coverage gap with priority and context
 */
export interface CoverageGap {
  type: CoverageGapType;
  title: string;
  description: string;
  url?: string;
  testCaseId?: string;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Full coverage analysis report for a project
 */
export interface CoverageReport {
  score: number;                    // 0-100
  totalUrls: number;
  coveredUrls: number;
  totalTestCases: number;
  staleTestCases: number;
  gaps: CoverageGap[];
  summary: string;                  // LLM-generated
}

// ============================================================================
// TEST PLATFORM
// ============================================================================

/**
 * Test platform - top-level grouping (Web UI tests / API tests)
 */
export interface TestPlatform {
  id: string;
  projectId: string;
  userId: string;
  platformKey: PlatformKey;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Params for creating a test platform (typically auto-seeded)
 */
export interface CreateTestPlatformParams {
  projectId: string;
  userId: string;
  platformKey: PlatformKey;
  name: string;
  description?: string;
}

// ============================================================================
// TEST MODULE
// ============================================================================

/**
 * Test module - functional area of the product (Auth, Payments, Profile)
 * Belongs to a platform (web_ui, api, or mobile)
 */
export interface TestModule {
  id: string;
  projectId: string;
  userId: string;
  platformId: string;
  platformKey?: PlatformKey;
  name: string;
  description?: string;
  tags: string[];
  priority?: Priority;
  /** Manual drag order within the platform. null = not manually ordered. */
  orderIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Params for creating a test module
 */
export interface CreateTestModuleParams {
  projectId: string;
  userId: string;
  platformId: string;
  name: string;
  description?: string;
  tags?: string[];
  priority?: Priority;
}

/**
 * Params for updating a test module
 */
export interface UpdateTestModuleParams {
  id: string;
  userId: string;
  name?: string;
  description?: string;
  tags?: string[];
  priority?: Priority;
  /** Move the module to a manual order position within its platform. */
  orderIndex?: number;
}

// ============================================================================
// TEST FLOW
// ============================================================================

/**
 * Test flow - scenario within a module (Happy path, Error handling)
 */
export interface TestFlow {
  id: string;
  moduleId: string;
  userId: string;
  name: string;
  description?: string;
  orderIndex: number | null;
  flowType: FlowType;
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  tags: string[];
  priority?: Priority;
  preconditions: any[];
  expectedResult?: string;
  /** Mobile-only flow variant override. null = inherit (plan → project default → 'default'). */
  mobileVariantLabel?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Params for creating a test flow
 */
export interface CreateTestFlowParams {
  moduleId: string;
  userId: string;
  name: string;
  orderIndex?: number;
  flowType?: FlowType;
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  tags?: string[];
  priority?: Priority;
  preconditions?: any[];
  expectedResult?: string;
  /** Mobile-only flow variant override. null/blank = inherit. */
  mobileVariantLabel?: string | null;
}

/**
 * Params for updating a test flow
 */
export interface UpdateTestFlowParams {
  id: string;
  userId: string;
  name?: string;
  /** Move the flow to a different module (drag-and-drop between folders). */
  moduleId?: string;
  orderIndex?: number;
  flowType?: FlowType;
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  tags?: string[];
  priority?: Priority;
  preconditions?: any[];
  expectedResult?: string;
  /** null clears (inherit); undefined leaves untouched. */
  mobileVariantLabel?: string | null;
}

// ============================================================================
// TEST SCHEDULE
// ============================================================================

/**
 * Test schedule - cron-based scheduling for test runs
 */
export type ScheduleType = 'recurring' | 'one_time';

export interface TestSchedule {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  moduleId?: string;
  planId?: string;
  // recurring: set; one_time: undefined (use runAt instead).
  scheduleType: ScheduleType;
  cronExpression?: string;
  runAt?: string;
  timezone: string;
  isActive: boolean;
  parameters: Record<string, any>;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

/**
 * Params for creating a test schedule.
 * Provide exactly one of cronExpression (recurring) or runAt (one_time).
 */
export interface CreateTestScheduleParams {
  projectId: string;
  userId: string;
  name: string;
  cronExpression?: string;
  runAt?: string;
  timezone?: string;
  moduleId?: string;
  planId?: string;
  parameters?: Record<string, any>;
}

/**
 * Params for updating a test schedule
 */
export interface UpdateTestScheduleParams {
  id: string;
  userId: string;
  name?: string;
  cronExpression?: string;
  runAt?: string;
  timezone?: string;
  parameters?: Record<string, any>;
  isActive?: boolean;
}

// ============================================================================
// TEST FIXTURE
// ============================================================================

/**
 * Test fixture - reusable test data
 */
export interface TestFixture {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  data: any;
  scope: FixtureScope;
  moduleId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Params for creating a test fixture
 */
export interface CreateTestFixtureParams {
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  data: any;
  scope?: FixtureScope;
  moduleId?: string;
  tags?: string[];
}

/**
 * Params for updating a test fixture
 */
export interface UpdateTestFixtureParams {
  id: string;
  userId: string;
  name?: string;
  description?: string;
  data?: any;
  scope?: FixtureScope;
  moduleId?: string;
  tags?: string[];
}

// ============================================================================
// INTENT TEST CASE (UNIFIED UI TEST CASE)
// ============================================================================

/**
 * Intent test case status for lifecycle management
 */
export type IntentTestCaseStatus = 'draft' | 'published' | 'archived';

/**
 * Intent test case - unified UI test for authoring and regression
 * This is the single source of truth for UI test cases.
 * 
 * @deprecated SavedTestCase - use IntentTestCase instead
 */
export interface IntentTestCase {
  id: string;
  projectId: string;
  userId: string;
  
  // Basic info
  name: string;
  description?: string;
  
  // URL fields
  startUrl?: string;
  url?: string;
  
  // Lifecycle
  status: IntentTestCaseStatus;
  kind: 'standalone' | 'regression_member';
  /** Test platform — used to route mobile tests to the mobile runner */
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  
  // Replay data
  replayStrategy?: 'commands' | 'graph_extract';
  commands?: any[];
  graphRef?: any;
  parametersSchema?: Record<string, any>;
  
  // Steps for authoring
  stepsJson?: any[];
  
  // Organization
  flowId?: string;
  dependsOn?: string[];
  
  // Metadata
  /** Natural language description of the test's purpose/intent */
  goal?: string;
  tags?: string[];
  priority?: Priority;
  preconditions?: any[];
  setupSteps?: any[];
  teardownSteps?: any[];
  expectedResult?: string;
  
  // Provenance
  sourceTestId?: string;
  sourceIntelligentSessionId?: string;
  
  createdAt: string;
  updatedAt: string;
}

/**
 * @deprecated Use IntentTestCase instead
 * Kept for API compatibility during migration
 */
export type SavedTestCase = IntentTestCase;

/**
 * Dependency suggestion from AI
 */
export interface DependencySuggestion {
  id: string;           // intent_test_cases.id of the suggested dependency
  confidence: number;   // 0.0 - 1.0
  reason: string;       // Human-readable explanation
}

/**
 * Intent test case response with AI suggestions (for create/update)
 */
export interface IntentTestCaseWithSuggestions extends IntentTestCase {
  suggestedDependsOn: DependencySuggestion[];
}

/**
 * @deprecated Use IntentTestCaseWithSuggestions instead
 */
export type SavedTestCaseWithSuggestions = IntentTestCaseWithSuggestions;

// Phase B (May 2026) — SharedStepCommand type DEPRECATED.
// The `action: 'shared_steps'` PlaywrightCommand was a planned-never-built
// mechanism. No producer ever existed; scenario_setup test_resource bindings
// own the "reuse steps across tests" use case now at the IntentStep layer.
// Type kept here in commented form so that any historic JSONB row decoder
// referencing this name can find the original shape during Phase C cleanup.
//
//   export interface SharedStepCommand {
//     action: 'shared_steps';
//     test_case_id: string;   // UUID of the referenced intent_test_cases row
//     description?: string;   // Human-readable label (e.g., "Login as student")
//   }

// ============================================================================
// PLAN AUTOMATION CONFIG
// ============================================================================

/**
 * Automation environment options
 */
export type AutomationEnvironment = 'staging' | 'production' | 'development';

/**
 * Automation browser options
 */
export type AutomationBrowser = 'chrome' | 'firefox' | 'safari' | 'edge';

/**
 * Git trigger types
 */
export type GitTriggerType = 'merge_to_main' | 'pr_opened' | 'release' | 'push_to_branch';

/**
 * Schedule configuration for plan automation
 */
export interface PlanScheduleConfig {
  enabled: boolean;
  days: string[];    // ["*"] or ["monday","tuesday",...]
  time: string;      // "HH:MM"
  timezone: string;
  customCron?: string; // Raw cron expression — when present, bypasses days/time parsing
}

/**
 * Git triggers configuration for plan automation.
 * Uses integrationId to link to an existing git-integration (created via POST /git-integrations).
 * Alternatively, repositoryUrl can be used to find an existing integration by repo URL.
 */
export interface PlanGitTriggersConfig {
  enabled: boolean;
  triggerTypes: GitTriggerType[];
  branch: string;
  /** Git provider; when set, used for matching git_integrations (recommended with repositoryUrl). */
  provider?: 'github' | 'gitlab';
  /** UUID of an existing git_integrations row (from GET /git-integrations). */
  integrationId?: string;
  /** Repository URL to find an existing git-integration by repo (e.g. https://github.com/owner/repo). */
  repositoryUrl?: string;
}

/**
 * Runtime configuration for plan automation
 */
export interface PlanRuntimeConfig {
  environment?: AutomationEnvironment;
  browser?: AutomationBrowser;
  /**
   * When true, the regression run stops dispatching new tests as soon as
   * the first test case fails or is skipped due to a prerequisite failure.
   * Tests already in flight within the current dependency level finish
   * their waiters (we don't abort mid-test); remaining tests are marked
   * 'skipped' with reason "Stopped early: fail-fast policy".
   *
   * Default behaviour (omitted / false): run every test regardless of
   * earlier failures — useful for nightly regressions where the full
   * matrix matters. Flip to `true` for CI gates / quick feedback where a
   * single failure invalidates the rest of the plan (e.g. login smoke
   * breaks → every test that logs in would fail anyway).
   *
   * Credit exhaustion stops the run the same way regardless of this flag.
   */
  failOnFirstFailure?: boolean;
}

/**
 * Full automation configuration stored as JSONB on regression_plans
 */
export interface PlanAutomationConfig {
  schedule?: PlanScheduleConfig;
  gitTriggers?: PlanGitTriggersConfig;
  runtime?: PlanRuntimeConfig;
  /** V14: Auto-retry tests classified as flaky after run completion */
  autoRetryFlaky?: {
    enabled: boolean;
    /** Max retry attempts per test (1-3, default 1) */
    maxRetries: number;
  };
}

// ============================================================================
// REGRESSION PLAN
// ============================================================================

/**
 * Regression plan - reusable custom test set
 */
export interface RegressionPlan {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  isDefault: boolean;
  tags: string[];
  automationConfig?: PlanAutomationConfig;
  notificationsEnabled: boolean;
  scheduleId?: string;
  /**
   * Mobile-only: how this plan picks which APK/IPA to install at dispatch.
   *   'latest' (default) — newest build for the project + platform.
   *   'pinned'           — `pinnedMobileAppBuildId` (falls through to
   *                        'latest' if the pinned build was pruned).
   */
  mobileBuildMode?: 'latest' | 'pinned';
  /** Build id when `mobileBuildMode === 'pinned'`. Null/undefined otherwise. */
  pinnedMobileAppBuildId?: string | null;
  /**
   * Mobile-only: which named variant lane this plan's runs resolve against
   * (matched per platform at dispatch). Null/undefined → the default lane.
   * `mobileBuildMode` / `pinnedMobileAppBuildId` apply WITHIN this variant.
   */
  mobileVariantLabel?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Regression plan with items
 */
export interface RegressionPlanWithItems extends RegressionPlan {
  items: RegressionPlanItem[];
}

/**
 * Regression plan enriched with latest run stats (for list view)
 */
export interface RegressionPlanWithStats extends RegressionPlan {
  scope: {
    testCount: number;
    flowCount: number;
  };
  lastRun: {
    runId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    passRate: number | null;
  } | null;
  health: {
    state: 'passing' | 'warning' | 'failing' | 'unknown';
    passRate: number;
    passed: number;
    failed: number;
    flaky: number;
    total: number;
  };
}

/**
 * Params for creating a regression plan
 */
export interface CreateRegressionPlanParams {
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  tags?: string[];
  automationConfig?: PlanAutomationConfig;
  notificationsEnabled?: boolean;
  /** Mobile build selection mode for this plan (default 'latest'). */
  mobileBuildMode?: 'latest' | 'pinned';
  /** Build id when `mobileBuildMode === 'pinned'`. */
  pinnedMobileAppBuildId?: string | null;
  /** Named variant lane this plan resolves against (default lane when null/absent). */
  mobileVariantLabel?: string | null;
  /**
   * Optional initial items to add to the plan in the same atomic call.
   *
   * Behaviour:
   *   - When omitted/empty, behaves identically to the legacy create
   *     (FE still uses `addItem` calls afterwards for that path).
   *   - When provided, items are added IN ORDER after the plan row is
   *     inserted. If any item insert fails, the plan is rolled back
   *     (deleted) so the user never ends up with a half-built plan
   *     visible in the UI.
   *   - Each item's `planId` is filled in by the service — callers
   *     omit it. `orderIndex` is auto-assigned by array position when
   *     not supplied.
   */
  items?: Array<Omit<AddPlanItemParams, 'planId'>>;
}

/**
 * Params for updating a regression plan
 */
export interface UpdateRegressionPlanParams {
  id: string;
  userId: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
  tags?: string[];
  automationConfig?: PlanAutomationConfig;
  notificationsEnabled?: boolean;
  mobileBuildMode?: 'latest' | 'pinned';
  /** Pass `null` to clear an existing pin. `undefined` leaves it alone. */
  pinnedMobileAppBuildId?: string | null;
  /** Named variant lane. Pass `null` to reset to default; `undefined` leaves it alone. */
  mobileVariantLabel?: string | null;
}

// ============================================================================
// REGRESSION PLAN ITEM
// ============================================================================

/**
 * Regression plan item - what's included in the plan
 */
export interface RegressionPlanItem {
  id: string;
  planId: string;
  itemType: PlanItemType;
  moduleId?: string;
  flowId?: string;
  testCaseId?: string;
  testCaseType?: TestType;
  orderIndex: number;
  parametersOverride: Record<string, any>;
  negativeTestingEnabled: boolean | null;
  createdAt: string;
}

/**
 * Params for adding an item to a regression plan
 */
export interface AddPlanItemParams {
  planId: string;
  itemType: PlanItemType;
  moduleId?: string;
  flowId?: string;
  testCaseId?: string;
  testCaseType?: TestType;
  orderIndex?: number;
  parametersOverride?: Record<string, any>;
}

// ============================================================================
// TEST EXECUTION
// ============================================================================

/**
 * Test execution - unified execution record for UI and API tests
 */
export interface TestExecution {
  id: string;
  runId: string;
  testType: TestType;
  testCaseId: string;
  moduleId?: string;
  flowId?: string;
  status: ExecutionStatus;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  result: any;
  errorMessage?: string;
  screenshotUrl?: string;
  traceUrl?: string;
  browser?: string;
  environment?: string;
  /**
   * Denormalised copy of `intent_test_cases.platform`
   * ('web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter').
   * Null/undefined for legacy rows created before 20260417 migration.
   */
  platform?: string;
  isNegative?: boolean;
  createdAt: string;
  /**
   * Fast-auth telemetry (May 2026). Present only on mobile rows that
   * actually attempted snapshot restore. Surfaced from
   * `test_executions.fast_auth_used` + `fast_auth_restore_ms`.
   *
   *   - `used === true`  → snapshot restored, login recipe skipped
   *   - `used === false` → restore attempted, fell back to recipe (or
   *                        nothing — the test ran logged-out)
   *   - omitted          → no fast-auth path tried (web run, no snapshot,
   *                        pre-fast-auth row). Distinct from `used: false`.
   *
   * Surfaced by `ExecutionService.mapToTestExecution` and consumed by
   * the FE regression run view as a REST fallback when the live WS state
   * has evicted (e.g. user reopens the page after the run completed).
   */
  fastAuth?: {
    used: boolean;
    restoreMs?: number;
  };
}

/**
 * Params for creating test executions
 */
export interface CreateTestExecutionParams {
  runId: string;
  testType: TestType;
  testCaseId: string;
  moduleId?: string;
  flowId?: string;
  browser?: string;
  environment?: string;
  isNegative?: boolean;
}

/**
 * Params for updating test execution status
 */
export interface UpdateExecutionStatusParams {
  id: string;
  status: ExecutionStatus;
  durationMs?: number;
  result?: any;
  errorMessage?: string;
  screenshotUrl?: string;
  traceUrl?: string;
  /**
   * Non-sensitive snapshot of test_resources bound to this execution.
   * Shape: Array<{ kind, resource_id, name, required, status_at_start,
   * healed_during_run, apply_error? }>. Persisted to
   * test_executions.executed_resources for reproducibility / audit.
   * Empty / undefined = run had no resource bindings.
   */
  executedResources?: Array<Record<string, unknown>>;
  /**
   * `mobile_app_builds.id` of the APK/IPA that was installed for this
   * execution. Soft FK (ON DELETE SET NULL) so pruning old builds
   * preserves history rows. Set at mobile dispatch time and never
   * updated afterwards.
   */
  mobileAppBuildId?: string | null;
}

// ============================================================================
// EXECUTION STATS
// ============================================================================

/**
 * Aggregated execution statistics
 */
export interface ExecutionStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  running: number;
  cancelled: number;
  passRate: number;
  avgDurationMs?: number;
}

// ============================================================================
// NEGATIVE TESTING TYPES
// ============================================================================

export type NegativeMutationType =
  | 'empty_field'
  | 'invalid_format'
  | 'xss'
  | 'overflow'
  | 'double_submit'
  | 'skip_step'
  | 'wrong_credentials';

export interface NegativeMeta {
  mutationType: NegativeMutationType;
  mutatedStepIndex: number;
  originalValue: string;
  mutatedValue: string;
  expectedBehavior: string;
  /** Why the generator chose this step + attack (quality signal / audit trail). */
  reasoning?: string;
}

export interface NegativeSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

// ============================================================================
// HEALTH CHECK TYPES
// ============================================================================

export type HealthCheckCategory =
  | 'console_errors'
  | 'network_errors'
  | 'js_exceptions'
  | 'broken_images'
  | 'page_responsive';

export type HealthCheckSeverity = 'pass' | 'warning' | 'fail';

export interface HealthCheckFinding {
  category: HealthCheckCategory;
  severity: HealthCheckSeverity;
  message: string;
  details?: Array<{ url?: string; status?: number; count?: number; text?: string }>;
}

export interface ExecutionHealthChecks {
  findings: HealthCheckFinding[];
  checkedAt: string;
}

export interface HealthSummary {
  totalChecks: number;
  passed: number;
  warnings: number;
  failures: number;
  findings: HealthCheckFinding[];
}

// ============================================================================
// RUN REPORT TYPES
// ============================================================================

/**
 * Step in a run report execution
 */
export interface RunReportStep {
  index: number;
  description: string;
  status: 'passed' | 'failed' | 'warning' | 'skipped';
  /**
   * The step's action type (e.g. 'click', 'type', 'navigate', 'assert').
   * Sourced from the executed command's action at run time so the report
   * timeline can show an accurate action badge per step instead of inferring
   * it by parsing the description text (which misses steps whose description
   * doesn't start with the verb, e.g. a bare field label). Optional — legacy
   * runs persisted before this field was carried through won't have it.
   */
  action?: string;
  durationMs?: number;
  /**
   * Per-step screenshot URL captured for EVERY step (pass or fail) when
   * per-step capture is enabled. Sourced from runtimeMeta.stepScreenshotUrl.
   * The run-report timeline renders this inline; it is also aggregated into
   * the execution's `screenshots` artifact list. Distinct from
   * `error.screenshot` (the failure-only bug screenshot).
   */
  screenshot?: string;
  error?: {
    message: string;
    failedReason?: string;
    screenshot?: string;
    /** V11: Root cause classification ('backend' | 'ui' | 'logic') */
    rootCause?: string;
    /** V11: Network verdict ('validation_failure' | 'backend_error' | 'expected_error' | 'clean' | 'warning') */
    networkVerdict?: string;
  };
  /**
   * True when the step passed only because self-healing rewrote the locator.
   * Surfaced in the UI as a "healed" badge so QA can spot fragile steps.
   * Derived from runtimeMeta.runtimeStatus === 'healed' || source === 'self_heal'.
   */
  healed?: boolean;
  /**
   * Confidence score (0..1) of the self-healing resolution. Only present when
   * healed is true. UI renders as "healed 95%" etc.
   */
  healConfidence?: number;
  /**
   * Self-heal before/after provenance — the original selector that failed and
   * the new selector the self-healer resolved to. Rendered in the run report
   * as a before→after tooltip on the healed badge. Only present when
   * healed === true; forwarded from StepRuntimeMeta.healedFrom / healedTo.
   */
  healedFrom?: string;
  healedTo?: string;
  /** Short human-readable description of what changed during heal. */
  healWhatChanged?: string;
  /**
   * Backend-classified flakiness flag from runtimeMeta.flaky. Independent of
   * healed — a step can be flaky without having been healed in this run, and
   * vice versa. Surfaced as a separate yellow badge.
   */
  flaky?: boolean;
  /**
   * Lifecycle phase this step belonged to when executed. Copied from the
   * dispatched command/step by the test executor and forwarded through the
   * per-step trace. Missing / 'main' means "normal body step" — absence is
   * what legacy runs (before setup_steps / teardown_steps were authored)
   * always have, so downstream UI must tolerate both shapes. Frontend uses
   * this to visually group setup/teardown and relax the verdict on
   * teardown failures.
   */
  phase?: 'setup' | 'main' | 'teardown';
}

/**
 * Artifacts for a single execution in a run report
 */
export interface RunReportExecArtifacts {
  videoUrl?: string;
  traceUrl?: string;
  screenshots: RunReportScreenshot[];
  bugScreenshots: string[];
  consoleLogs: string[];
  networkLogs: Array<{
    method: string;
    url: string;
    status?: number;
    durationMs?: number;
  }>;
  qualityChecks?: RunReportQualityChecks;
}

/**
 * Quality checks collected during test execution
 */
export interface RunReportQualityChecks {
  webVitals?: Record<string, any>;
  accessibility?: {
    warnings: any[];
    totalWarnings: number;
  };
  brokenResources?: any[];
  slowAPIs?: any[];
}

/**
 * Single execution entry in a run report
 */
/**
 * Why a run failed BEFORE any step executed — device attach / session setup /
 * runner unreachable. Surfaced on the run report so the case card can show a
 * "couldn't start" banner with remediation, instead of a bare red ✗.
 */
export interface RunReportFailureReason {
  /** Runner / job error code, e.g. 'FLUTTER_NOT_DETECTED'. 'UNKNOWN' if untyped. */
  code: string;
  /** Short human label, e.g. "Couldn't start test". */
  label: string;
  /** Raw failure message from the runner / job. */
  message: string;
  /** One-line remediation hint, when known. */
  remediation?: string;
  /** Where the failure happened. 'job' = before any step ran. */
  layer: 'job';
  /** Coarse bucket; 'environment' = infrastructure, not a real test outcome. */
  category: 'environment' | 'configuration' | 'unknown';
}

export interface RunReportExecution {
  id: string;
  testCaseId: string;
  testCaseName: string;
  status: string;
  durationMs: number;
  browser: string;
  /**
   * Raw platform of the test case this execution ran.
   * 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter'.
   * Denormalised from `test_executions.platform` (which in turn is copied
   * from `intent_test_cases.platform` at batch create time). Undefined for
   * legacy rows created before the 20260417 migration.
   *
   * Frontend reports use this to route to mobile-specific renderers
   * (device screenshots, compiled plan viewer) without extra joins.
   */
  platform?: string;
  /**
   * Curator-set priority of the saved test case this execution ran, if any.
   * One of 'critical' | 'high' | 'medium' | 'low'. NULL for ad-hoc /
   * chat-lite runs (no saved test case) and for API tests (api_test_configs
   * has no priority column repo-wide — see analytics-query.service:838).
   * Surfaced here so the run-details page can badge / colorize / filter
   * rows without an extra join. Display-only — does NOT affect server-side
   * execution order (see runPlan / runFlow which preserve user-set
   * position / order_index).
   */
  priority?: 'critical' | 'high' | 'medium' | 'low' | null;
  bugsCount: number;
  steps: RunReportStep[];
  artifacts: RunReportExecArtifacts;
  isNegative?: boolean;
  negativeMeta?: NegativeMeta;
  healthChecks?: ExecutionHealthChecks;
  /** V14: AI-determined failure classification */
  failureClassification?: 'flaky' | 'real_bug' | 'environment' | 'test_drift' | null;
  rootCauseStep?: number | null;
  classificationEvidence?: string[];
  /**
   * Set when the run failed BEFORE any step executed (device attach / session
   * setup / runner unreachable). Drives the case-level failure banner in the
   * report. Absent for normal pass / step-failure executions.
   */
  failureReason?: RunReportFailureReason;
}

/**
 * Enriched bug with test case context
 */
export interface EnrichedBug {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'functional' | 'performance' | 'accessibility' | 'visual' | 'security';
  testCaseId: string;
  testCaseName: string;
  executionId: string;
  steps: string[];
  expected: string;
  actual: string;
  selector?: string;
  recommendation: string;
  /**
   * Deterministic identity of the bug (severity + category + normalized title +
   * selector). Duplicates of the same underlying issue across a run's executions
   * share a fingerprint and are collapsed into ONE entry. Follows the
   * `regression_doctor_findings.pattern_hash` convention (SHA-1 hex).
   */
  fingerprint?: string;
  /** How many raw bug instances collapsed into this one (≥1). 1 = unique. */
  occurrences?: number;
  /** Distinct executions this bug was seen in (for the "seen in N runs" UI). */
  seenInExecutions?: string[];
}

/**
 * Merged summary: execution stats + bugs breakdown
 */
export interface RunReportSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  totalBugs: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  /** V14: Failure classification breakdown (flaky, real_bug, environment, test_drift) */
  byClassification?: Record<string, number>;
  /**
   * Phase 7 — count of executions per UI platform in this run.
   * Derived from `test_executions.platform` (see Phase 2 denormalisation);
   * NULL rows bucket to 'web'. API tests tracked via `test_type='api'`.
   *
   * Shape stays stable — zero-filled slices when a platform has no
   * executions in this run. Frontend uses it to show "4 web + 1 mobile"
   * on a run card or in the report header without re-counting executions.
   */
  platformBreakdown: {
    web: { total: number; passed: number; failed: number };
    mobile: { total: number; passed: number; failed: number };
    api: { total: number; passed: number; failed: number };
  };
}

/**
 * Aggregated artifacts across all executions (actual data, not counts)
 */
/**
 * A per-step screenshot with display metadata for the run-report gallery.
 * `url` is the only required field; the rest drive the descriptive label
 * (step name + capture time + outcome) the Screenshots tab renders.
 */
export interface RunReportScreenshot {
  url: string;
  /** Human label, e.g. "Step 3: Click" (or "Final screenshot"). */
  stepName?: string;
  /** Capture time, formatted HH:MM:SS. */
  timestamp?: string;
  status?: 'passed' | 'failed' | 'warning' | 'skipped';
}

export interface RunReportArtifactsSummary {
  videoUrl?: string;
  traceUrl?: string;
  screenshots: RunReportScreenshot[];
  bugScreenshots: string[];
  consoleLogs: string[];
  networkLogs: Array<{
    method: string;
    url: string;
    status?: number;
    durationMs?: number;
  }>;
  qualityChecks?: RunReportQualityChecks;
}

/**
 * Release-readiness verdict — ADR-0012. Computed by a pure, deterministic
 * function (`computeReleaseVerdict` in `release-verdict.util.ts`) over a
 * run's already-deduped bugs + health checks. NEVER decided by an LLM —
 * see `ReleaseNarrative` below for the (optional, LLM-written) explanation
 * layer that sits on top of this without ever being able to contradict it.
 */
export type ReleaseVerdictStatus = 'ready' | 'ready_with_warnings' | 'not_ready';

export interface ReleaseVerdictReason {
  code: string;
  label: string;
  refType: 'bug' | 'health_check' | 'visual_anomaly' | 'execution';
  refId: string;
}

export interface ReleaseVerdict {
  status: ReleaseVerdictStatus;
  rulesetVersion: number;
  reasons: ReleaseVerdictReason[];
}

/**
 * Optional LLM narrative over an already-computed `ReleaseVerdict` — see
 * `release-narrative.service.ts`. No `status`/verdict field by design: the
 * narrative explains/prioritizes given facts, it cannot restate a different
 * verdict. `null` means not yet generated (lazy, first-view-triggered) or
 * the feature is disabled — the frontend renders nothing in that case, not
 * a permanent loading state.
 */
export interface ReleaseNarrative {
  headline: string;
  prioritizedActions: Array<{ bugId: string; why: string }>;
  summary: string;
  generatedAt: string;
}

/**
 * Visual anomaly sweep finding (ADR-0012) — surfaced into a RunReport once
 * it has recurred across >= VISUAL_ANOMALY_MIN_RECURRENCE independent runs
 * (see `visual-anomaly-check.service.ts`). Defaults to 1 (surfaces on first
 * detection) per 2026-07-10 user decision — the gate is still real and
 * configurable, just permissive by default now.
 */
export interface RunReportVisualAnomaly {
  id: string;
  testCaseId: string;
  testCaseName: string;
  category: 'placeholder_text' | 'broken_image' | 'overlapping_cutoff_ui' | 'wrong_locale' | 'structurally_broken_layout' | 'other';
  description: string;
  confidence: number;
  screenshotUrl: string;
  recurrenceCount: number;
  firstSeenAt: string;
}

/**
 * Full run report — aggregated data for a regression run
 */
export interface RunReport {
  id: string;
  planId: string | null;
  planName: string | null;
  status: string;
  trigger: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  aiConfidence: number | null;
  summary: RunReportSummary;
  executions: RunReportExecution[];
  bugs: EnrichedBug[];
  recommendations: string[];
  artifactsSummary: RunReportArtifactsSummary;
  healthSummary?: HealthSummary;
  negativeSummary?: NegativeSummary;
  negativeExecutions?: RunReportExecution[];
  /**
   * Chain view: one entry per segment of a `link_test_case` chain (mobile →
   * web → mobile, etc.) — see `tests.regression_run_id`. Absent/empty for
   * the overwhelming majority of runs (unsegmented, single dispatch).
   */
  chainExecutions?: RunReportExecution[];
  /** Always present once bugs/healthSummary are computed — see ADR-0012. */
  releaseVerdict: ReleaseVerdict;
  /** Frozen audit snapshot, written once at first narrative generation. */
  releaseVerdictAtCompletion?: ReleaseVerdictStatus;
  releaseNarrative?: ReleaseNarrative | null;
  /** Findings scoped to THIS run (status='surfaced' AND this run in affected_run_ids). */
  visualAnomalies?: RunReportVisualAnomaly[];
}

/**
 * Flaky test detected across multiple runs
 */
export interface FlakyTest {
  testCaseId: string;
  testCaseName: string;
  failRate: number;
  totalRuns: number;
  failures: number;
  /**
   * Phase 7 — raw platform string from `intent_test_cases.platform`
   * ('web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter').
   * Absent for legacy rows where the column is NULL; UI should treat
   * missing as 'web' (that's the pre-Phase-2 historical default).
   * Needed so a flaky web test and its mobile namesake show up as two
   * separate flaky entries rather than one pooled count.
   */
  platform?: string | null;
}

/**
 * Phase 7 — one slice of the plan-health breakdown for a single
 * platform scope. `runs` is total executions counted into pass-rate,
 * `passed`/`failed` are that same denominator split by verdict,
 * `flakyCount` is the number of flaky tests belonging to this scope.
 * All zero on legacy projects with no platform data — shape stable.
 */
export interface PlanHealthPlatformSlice {
  runs: number;
  passed: number;
  failed: number;
  flakyCount: number;
}

/**
 * Plan health report with trend history
 */
export interface PlanHealthReport {
  currentHealth: 'passing' | 'warning' | 'failing' | 'unknown';
  passRate: number;
  history: Array<{
    id: string;
    status: string;
    passRate: number;
    startedAt: string;
    bugsFound: number;
  }>;
  flakyTests: FlakyTest[];
  /**
   * Phase 7 — per-platform breakdown aggregated over the same run window
   * used to compute `passRate` + `history`. Enables the frontend health
   * widget to say "Mobile: 12 runs, 2 flaky" beside "Web: 40 runs, 3 flaky"
   * without a second request.
   *
   * Always returned (zero-filled slices when a platform has no data in
   * the window). Sum of `runs` equals overall `passed+failed` — use this
   * as a sanity check when rendering.
   */
  byPlatform: {
    web: PlanHealthPlatformSlice;
    mobile: PlanHealthPlatformSlice;
    api: PlanHealthPlatformSlice;
  };
}

// ============================================================================
// EXPANDED TEST CASE (for plan execution)
// ============================================================================

/**
 * Expanded test case reference for plan execution
 */
export interface ExpandedTestCase {
  testCaseId: string;
  testType: TestType;
  moduleId?: string;
  flowId?: string;
  name: string;
  /** Test case platform — used to route mobile tests to the mobile runner */
  platform?: string;
  parameters?: Record<string, any>;
  isNegative?: boolean;
  sourceTestCaseId?: string;
  negativeMeta?: NegativeMeta;
}

/**
 * Test case enriched with dependency info for execution ordering.
 * Used by executeTestCasesAsync() to resolve topological order.
 */
export interface ExecutableTestCase {
  testCaseId: string;
  testType: TestType;
  moduleId?: string;
  flowId?: string;
  dependsOn: string[];
  isNegative?: boolean;
  /** Test case platform — used to route mobile tests to the mobile runner */
  platform?: string;
  /** Curator-set priority — used to order dispatch within a topological level */
  priority?: string | null;
}

/**
 * Result of topological sort over ExecutableTestCase[].
 */
export interface TopologicalSortResult {
  /** All test cases in topological order */
  sorted: ExecutableTestCase[];
  /** Test cases grouped by execution level (level 0 = no deps) */
  levels: ExecutableTestCase[][];
  /** True if the dependency graph contains a cycle */
  hasCycle: boolean;
  /** IDs of nodes that lie ON a cycle (only present when hasCycle=true) */
  cycleNodes?: string[];
  /**
   * IDs of nodes that are NOT on a cycle themselves but can never run
   * because a (transitive) dependency is. Reported separately so they
   * can be marked "blocked" instead of the misleading "circular".
   */
  blockedByCycleNodes?: string[];
}

// ============================================================================
// RUN PARAMS
// ============================================================================

/**
 * Params for running a regression plan
 */
export interface RunPlanParams {
  planId: string;
  userId: string;
  trigger: RunTrigger;
  parameters?: Record<string, any>;
}

/**
 * Params for running a module
 */
export interface RunModuleParams {
  moduleId: string;
  userId: string;
  trigger: RunTrigger;
  parameters?: Record<string, any>;
}

/**
 * Params for running a flow
 */
export interface RunFlowParams {
  flowId: string;
  userId: string;
  trigger: RunTrigger;
  parameters?: Record<string, any>;
}

/**
 * Params for running tests by tag
 */
export interface RunByTagParams {
  projectId: string;
  tag: string;
  userId: string;
  trigger: RunTrigger;
  parameters?: Record<string, any>;
}

/**
 * Params for running tests by priority
 */
export interface RunByPriorityParams {
  projectId: string;
  priority: Priority;
  userId: string;
  trigger: RunTrigger;
  parameters?: Record<string, any>;
}

// ============================================================================
// RUN RESULTS
// ============================================================================

/**
 * Result of starting a run
 */
export interface RunResult {
  runId: string;
  testIds?: string[];
  executionIds?: string[];
  totalTests: number;
}

// ============================================================================
// SCHEDULE DUE RESULT
// ============================================================================

/**
 * Schedule that is due for execution
 */
export interface DueSchedule {
  scheduleId: string;
  projectId: string;
  userId: string;
  // recurring schedules retry on the next occurrence; a one_time schedule has
  // already been deactivated by claimDueSchedule and will NOT retry — the
  // scheduler branches its failure notification on this.
  scheduleType: ScheduleType;
  // 'suite' is surfaced so the scheduler can reject it explicitly — there is
  // no runSuite() execution path, so a suite schedule must NOT be silently
  // misrouted to runPlan() (which would self-deactivate it as "target deleted").
  targetType: 'module' | 'plan' | 'suite';
  // null when a schedule row has no resolvable runnable target. The scheduler
  // treats a null targetId as unrunnable and deactivates the schedule.
  targetId: string | null;
  parameters: Record<string, any>;
}
