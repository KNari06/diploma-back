/**
 * Testing Types
 * Type definitions for test hierarchy: Module → Suite → Flow → TestCase → Step
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
 * Suite types
 */
export type SuiteType = 'ui' | 'api' | 'mixed';

/**
 * Execution status for test runs
 */
export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/**
 * Trigger types for test runs
 */
export type RunTrigger = 'manual' | 'chat' | 'scheduled';

/**
 * Fixture scope levels
 */
export type FixtureScope = 'global' | 'project' | 'module' | 'suite' | 'flow';

/**
 * Plan item types
 */
export type PlanItemType = 'module' | 'suite' | 'flow' | 'test_case';

/**
 * Platform key types (top-level test category)
 */
export type PlatformKey = 'web_ui' | 'api';

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
 * Belongs to a platform (web_ui or api)
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
 * Test flow - scenario within a suite (Happy path, Error handling)
 */
export interface TestFlow {
  id: string;
  suiteId: string;
  userId: string;
  name: string;
  description?: string;
  orderIndex: number;
  flowType: FlowType;
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
  suiteId: string;
  userId: string;
  name: string;
  description?: string;
  orderIndex?: number;
  flowType?: FlowType;
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
  suiteId?: string;
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
  suiteId?: string;
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
// SAVED TEST CASE
// ============================================================================

/**
 * Saved test case - reusable UI test for regression
 */
export interface SavedTestCase {
  id: string;
  projectId: string;
  userId: string;
  sourceTestId?: string;
  sourceIntelligentSessionId?: string;
  name: string;
  description?: string;
  kind: 'standalone' | 'regression_member';
  replayStrategy: 'commands' | 'graph_extract';
  url?: string;
  flowId?: string;
  tags: string[];
  priority?: Priority;
  preconditions: any[];
  setupSteps: any[];
  teardownSteps: any[];
  expectedResult?: string;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Dependency suggestion from AI
 */
export interface DependencySuggestion {
  id: string;           // saved_test_cases.id of the suggested dependency
  confidence: number;   // 0.0 - 1.0
  reason: string;       // Human-readable explanation
}

/**
 * Saved test case response with AI suggestions (for create/update)
 */
export interface SavedTestCaseWithSuggestions extends SavedTestCase {
  suggestedDependsOn: DependencySuggestion[];
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
 * Params for creating a regression plan
 */
export interface CreateRegressionPlanParams {
  projectId: string;
  userId: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  tags?: string[];
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
  suiteId?: string;
  flowId?: string;
  testCaseId?: string;
  testCaseType?: TestType;
  orderIndex: number;
  parametersOverride: Record<string, any>;
  createdAt: string;
}

/**
 * Params for adding an item to a regression plan
 */
export interface AddPlanItemParams {
  planId: string;
  itemType: PlanItemType;
  moduleId?: string;
  suiteId?: string;
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
  suiteId?: string;
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
  suiteId?: string;
  flowId?: string;
  browser?: string;
  environment?: string;
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
// EXPANDED TEST CASE (for plan execution)
// ============================================================================

/**
 * Expanded test case reference for plan execution
 */
export interface ExpandedTestCase {
  testCaseId: string;
  testType: TestType;
  moduleId?: string;
  suiteId?: string;
  flowId?: string;
  name: string;
  parameters?: Record<string, any>;
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
  targetType: 'module' | 'suite' | 'plan';
  targetId: string;
  parameters: Record<string, any>;
}
