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
  orderIndex: number;
  flowType: FlowType;
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  tags: string[];
  priority?: Priority;
  preconditions: any[];
  expectedResult?: string;
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
  description?: string;
  orderIndex?: number;
  flowType?: FlowType;
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  tags?: string[];
  priority?: Priority;
  preconditions?: any[];
  expectedResult?: string;
}

/**
 * Params for updating a test flow
 */
export interface UpdateTestFlowParams {
  id: string;
  userId: string;
  name?: string;
  description?: string;
  orderIndex?: number;
  flowType?: FlowType;
  platform?: 'web' | 'mobile_android' | 'mobile_ios' | 'mobile_flutter';
  tags?: string[];
  priority?: Priority;
  preconditions?: any[];
  expectedResult?: string;
}

// ============================================================================
// TEST SCHEDULE
// ============================================================================

/**
 * Test schedule - cron-based scheduling for test runs
 */
export interface TestSchedule {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  moduleId?: string;
  planId?: string;
  cronExpression: string;
  timezone: string;
  isActive: boolean;
  parameters: Record<string, any>;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

/**
 * Params for creating a test schedule
 */
export interface CreateTestScheduleParams {
  projectId: string;
  userId: string;
  name: string;
  cronExpression: string;
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

/**
 * Shared step command - references another test case's commands
 * When encountered during execution, the referenced test case's
 * commands are loaded and executed inline in the same browser session.
 *
 * Usage: Insert into a test case's commands array to reuse steps from another test
 * (e.g., login steps shared across checkout, profile, settings flows)
 */
export interface SharedStepCommand {
  action: 'shared_steps';
  test_case_id: string;   // UUID of the referenced intent_test_cases row
  description?: string;   // Human-readable label (e.g., "Login as student")
}

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
}

/**
 * Full automation configuration stored as JSONB on regression_plans
 */
export interface PlanAutomationConfig {
  schedule?: PlanScheduleConfig;
  gitTriggers?: PlanGitTriggersConfig;
  runtime?: PlanRuntimeConfig;
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
    status: string;
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
  isNegative?: boolean;
  createdAt: string;
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
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  error?: {
    message: string;
    failedReason?: string;
    screenshot?: string;
    /** V11: Root cause classification ('backend' | 'ui' | 'logic') */
    rootCause?: string;
    /** V11: Network verdict ('validation_failure' | 'backend_error' | 'expected_error' | 'clean' | 'warning') */
    networkVerdict?: string;
  };
}

/**
 * Artifacts for a single execution in a run report
 */
export interface RunReportExecArtifacts {
  videoUrl?: string;
  traceUrl?: string;
  screenshots: string[];
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
export interface RunReportExecution {
  id: string;
  testCaseId: string;
  testCaseName: string;
  status: string;
  durationMs: number;
  browser: string;
  bugsCount: number;
  steps: RunReportStep[];
  artifacts: RunReportExecArtifacts;
  isNegative?: boolean;
  negativeMeta?: NegativeMeta;
  healthChecks?: ExecutionHealthChecks;
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
}

/**
 * Aggregated artifacts across all executions (actual data, not counts)
 */
export interface RunReportArtifactsSummary {
  videoUrl?: string;
  traceUrl?: string;
  screenshots: string[];
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
  /** IDs of nodes involved in a cycle (only present when hasCycle=true) */
  cycleNodes?: string[];
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
  targetType: 'module' | 'plan';
  targetId: string;
  parameters: Record<string, any>;
}
