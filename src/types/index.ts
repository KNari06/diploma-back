// Auth types
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: string;
  status?: string;
  avatar?: string;
  /** When true, user can see the AI/system logs FAB and modal. */
  showLogs?: boolean;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface AuthResponse {
  user: AuthUser;
  tokens: AuthTokens;
}

// Test related types
export interface TestRunRequest {
  url: string;
  browsers: BrowserType[];
  projectId: string;
  userId?: string;
  options?: TestOptions;
  // Intelligent testing fields
  intelligentMode?: boolean; // Enable AI-driven intelligent/adaptive testing
  testGoal?: string; // High-level testing goal for intelligent mode
  estimatedCost?: string; // Estimated cost from test plan (e.g., "$0.10-0.20")
  commands?: PlaywrightCommand[]; // Playwright commands to execute
  intent?: string; // Original user intent for context
  mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
  chatSessionId?: string; // Chat session ID for WebSocket routing isolation
  /** Prefilled steps from Smart Test Case Resolver for fast replay */
  prefilledSteps?: import('@/services/testing/resolver/resolver.types').PrefilledStep[];
  /**
   * Test resources (Login, Environment, Secret, ...) bound to the source
   * intent_test_case. Threaded through into TestJobData so the runner
   * can apply each resource to the browser context before step 1.
   */
  resourceBindings?: Array<{
    kind: string;
    resource_id: string;
    required?: boolean;
  }>;
  /** V2: Additional metadata for linking and reporting */
  metadata?: {
    /** Intent test case ID if run from intent test case */
    intentTestCaseId?: string;
    /** Intent test case name */
    intentTestCaseName?: string;
    /** Source of the test run */
    source?: 'intent_test_case' | 'chat' | 'api' | 'manual' | 'jira_qa_orchestrator';
    /** Jira issue key that triggered this test (for feedback loop) */
    sourceJiraIssueKey?: string;
    /** Jira cloud ID for the source issue */
    sourceJiraCloudId?: string;
    /** Any additional custom data */
    [key: string]: any;
  };
}

export interface TestOptions {
  mobile?: boolean;
  viewport?: {
    width?: number;
    height?: number;
  };
  timeout?: number;
  retries?: number;
  waitForSelector?: string;
  customScripts?: string[];
  headers?: Record<string, string>;
  credentials?: {
    email?: string;
    username?: string;
    phone?: string;
    password: string;
  };
  mode?: 'lite' | 'pro'; // Persisted execution mode (used by retry logic)
}

export type BrowserType = 'chrome' | 'firefox' | 'safari' | 'edge' | 'mobile-chrome' | 'mobile-safari' | 'mobile-android' | 'mobile-ios' | 'mobile-flutter';

export interface TestResult {
  id: string;
  testId: string;
  browser: BrowserType;
  status: TestStatus;
  screenshot?: string; // base64
  dom?: string;
  logs: string[];
  networkLogs: NetworkLog[];
  errors: TestError[];
  performance?: PerformanceMetrics;
  aiSummary?: AISummary;
  /** Quality checks: accessibility, performance, broken resources, slow APIs */
  qualityChecks?: any;
  // ✅ NEW: Video & Trace support
  videoUrl?: string; // Supabase Storage URL
  videoPath?: string; // Local path (temp)
  traceUrl?: string; // Supabase Storage URL
  tracePath?: string; // Local path (temp)
  createdAt: Date;
  completedAt?: Date;
}

export type TestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface NetworkLog {
  url: string;
  method: string;
  status: number;
  statusText: string;
  responseTime: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  body?: string;
  responseBody?: any; // ✅ NEW: Response body for API requests (parsed JSON or truncated text)
  timestamp: Date;
}

export interface TestError {
  type: 'javascript' | 'network' | 'timeout' | 'assertion' | 'other';
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: Date;
}

export interface PerformanceMetrics {
  loadTime: number;
  domContentLoaded: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  firstInputDelay: number;
  cumulativeLayoutShift: number;
  totalBlockingTime: number;
}

export interface QualityCheckReport {
  performance: PerformanceMetrics;
  brokenResources: Array<{
    type: 'broken_image' | 'failed_stylesheet' | 'failed_script';
    url: string;
    element?: string;
  }>;
  accessibility: {
    warnings: Array<{
      message: string;
      selector?: string;
      wcag?: string;
    }>;
    totalWarnings: number;
  };
  apiPerformance: {
    totalRequests: number;
    averageResponseTime: number;
    p95ResponseTime: number;
    slowCalls: Array<{
      url: string;
      method: string;
      status: number;
      responseTime: number;
    }>;
  };
}

export type FailureClassification = 'flaky' | 'real_bug' | 'environment' | 'test_drift';

/**
 * Shape of a test drift — structured, machine-readable signal that the
 * downstream Regression Doctor (aggregation job) uses to group failures
 * across multiple tests into one "product change" pattern.
 *
 * Populated by the Bug Inspector (per-test AI analysis) only when
 * `failureClassification === 'test_drift'`. Absent otherwise.
 *
 * Why these fields:
 *   • urlPattern — normalized URL (`/tutors/:id` not `/tutors/cmbi1pgyz…`)
 *     so two failures on different tutor pages group as one pattern.
 *   • targetElementKey — stable key for the element the step targeted:
 *     `"button:Подготовка к ВОУД"` / `"input:email"`. Concrete refs
 *     (e217) are useless for grouping across tests.
 *   • errorShape — coarse classification of HOW the step failed. Four
 *     values cover ~95% of drift modes observed in practice.
 *   • beforeState / afterState — the "did the world change mid-action?"
 *     signal that often distinguishes a genuine overlay from a flaky
 *     selector.
 */
export interface DriftSignals {
  /** Normalized URL (GUID/ID segments replaced with `:id`). */
  urlPattern: string;
  /** Stable identifier for the target element (tag:text, aria:label, etc). */
  targetElementKey: string;
  /** Coarse failure shape — used as a grouping key alongside url+element. */
  errorShape:
    | 'selector_not_found'     // resolver returned nothing — element gone or renamed
    | 'timeout_on_visible'     // element was visible but click didn't connect
    | 'covered_by_overlay'     // element present but obscured by a new modal/overlay
    | 'value_mismatch';        // verify step saw different value than recorded
  beforeState?: { visible: boolean; covered: boolean };
  afterState?: { visible: boolean; domChanged: boolean };
}

export interface AISummary {
  summary: string;
  bugs: BugReport[];
  recommendations: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number; // 0-100
  generatedAt: Date;
  // V14: Step-aware root cause analysis
  rootCauseStep?: number | null;
  causedByStep?: number | null;
  failureClassification?: FailureClassification | null;
  classificationEvidence?: string[];
  /**
   * Phase-1 addition: structured drift signals consumed by the
   * Regression Doctor. Populated ONLY when failureClassification
   * === 'test_drift'. Undefined on passed tests or non-drift failures.
   */
  driftSignals?: DriftSignals | null;
}

export interface BugReport {
  id: string;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'visual' | 'functional' | 'performance' | 'accessibility' | 'security';
  steps: string[];
  expectedResult: string;
  actualResult: string;
  screenshot?: string;
  domSelector?: string;
  line?: number;
  column?: number;
}

// Database types
export interface Test {
  id: string;
  url: string;
  projectId: string;
  userId?: string;
  status: TestStatus;
  browsers: BrowserType[];
  options?: TestOptions;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  results?: TestResult[];
  executedSteps?: any; // JSONB: persisted after completion
  // ✅ Intelligent testing fields (from DB migration)
  intelligentMode?: boolean;
  testGoal?: string;
  commands?: any[]; // PlaywrightCommand[] stored as JSONB
}

export interface Workspace {
  id: string;
  name: string;
  userId: string;
  platforms: string[];
  apiTesting: boolean;
  devBaseUrl?: string;
  prodBaseUrl?: string;
  settings: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceCreateRequest {
  name: string; // Will be populated from project_name in API
  platforms: string[];
  api_testing?: boolean;
  devBaseUrl: string;
  prodBaseUrl?: string;
}

export type BrowserTypeEnum = 'chrome' | 'firefox' | 'safari' | 'edge';

// Workspace onboarding role enum
export type WorkspaceRole =
  | 'qaEngineer'
  | 'developer'
  | 'productManager'
  | 'teamLead'
  | 'cto'
  | 'other';

// Workspace account type enum
export type WorkspaceAccountType = 'company' | 'individual';

export interface WorkspaceOnboardingRequest {
  name: string; // Project/Workspace name
  baseUrls: string[]; // Array of base URLs
  environments: {
    dev?: string;
    predprod?: string;
    prod?: string;
  };
  browserType: BrowserTypeEnum; // Default: 'chrome'
  // NEW FIELDS (all optional)
  role?: WorkspaceRole; // User's role (optional)
  position?: string; // User's position (optional, max 255 chars)
  accountType?: WorkspaceAccountType; // Account type (optional)
  companyName?: string; // Company name (required when accountType === 'company')
}

export interface WorkspaceOnboardingResponse {
  workspace_id?: string; // Workspace ID returned in response (only when completed)
  name?: string;
  baseUrls?: string[];
  environments?: {
    dev?: string;
    predprod?: string;
    prod?: string;
  };
  browserType?: BrowserTypeEnum;
  completed: boolean; // Whether onboarding was completed
  // NEW FIELDS
  role?: WorkspaceRole;
  position?: string;
  accountType?: WorkspaceAccountType;
  companyName?: string;
  logo_url?: string; // Workspace logo URL if present
}

// Logo upload response
export interface WorkspaceLogoUploadResponse {
  logo_url: string; // Public URL to uploaded logo
  file_name: string; // Generated filename
  file_size: number; // File size in bytes
  uploaded_at: string; // ISO timestamp
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  userId: string;
  workspaceId: string;
  settings: ProjectSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectCreateRequest {
  name: string;
  description?: string;
  workspace_id: string;
  settings?: Partial<ProjectSettings> & {
    main_url?: string;
    tested_pages?: string[];
    common_elements?: Record<string, string>;
    common_scope?: string;
    defaultBrowsers?: BrowserType[];
    /** Mobile app metadata (APK/IPA) — set via mobile upload API */
    mobileApp?: Record<string, unknown> | null;
    /** CI/CD API key metadata — set via CI key management API */
    ciApiKey?: { hash: string; prefix: string; createdAt: string } | null;
    /** Project-level runtime-permission policy for Android sessions. */
    mobilePermissionPolicy?: 'auto_allow' | 'auto_deny' | 'manual' | null;
  };
}

export interface ProjectSettings {
  defaultBrowsers: BrowserType[];
  defaultOptions: TestOptions;
  notifications: NotificationSettings;
  integrations: IntegrationSettings;
}

export interface NotificationSettings {
  email: boolean;
  slack: boolean;
  webhook?: string;
}

export interface IntegrationSettings {
  jira?: {
    enabled: boolean;
    projectKey: string;
    issueType: string;
  };
  slack?: {
    enabled: boolean;
    channel: string;
  };
}

// Queue types
export interface TestJobData {
  testId: string;
  url: string;
  browser: BrowserType;
  options?: TestOptions;
  projectId: string;
  userId?: string;
  retryCount?: number;
  commands?: PlaywrightCommand[]; // Playwright commands to execute
  intent?: string; // Original user intent for context
  intelligentMode?: boolean; // NEW: Enable intelligent/adaptive testing
  testGoal?: string; // NEW: Testing goal for intelligent mode
  mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
  chatSessionId?: string; // Chat session ID for WebSocket routing isolation
  prefilledSteps?: import('@/services/testing/resolver/resolver.types').PrefilledStep[]; // Smart Resolver prefilled steps
  /**
   * Test resources bound to this run (auth logins, environments, secrets, etc).
   * Resolved from `intent_test_cases.resource_bindings` + workspace defaults
   * before the job is enqueued. The runner hands this to ResourceApplier
   * which injects each resource into the browser context before step 1.
   * `required: true` bindings fail the run if the resource is broken.
   */
  resourceBindings?: Array<{
    kind: string;
    resource_id: string;
    required?: boolean;
  }>;
  /** Internal: retry attempt number (set by test-retry.ts). 0 = initial, 1+ = retry */
  _retryAttempt?: number;
}

export interface AgentResponse {
  success: boolean;
  testId: string;
  browser: BrowserType;
  result?: Partial<TestResult>;
  error?: string;
  timestamp: Date;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: Date;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    offset?: number;
    total: number;
    totalPages: number;
    has_more?: boolean;
  };
}

// User and Authentication types
export interface User {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  credits: number;
  subscription?: Subscription;
  createdAt: Date;
  updatedAt: Date;
}

export type UserRole = 'admin' | 'user' | 'ai';

export interface Subscription {
  id: string;
  plan: SubscriptionPlan;
  status: 'active' | 'cancelled' | 'past_due' | 'unpaid';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

export type SubscriptionPlan = 'free' | 'starter' | 'professional' | 'enterprise';

// Billing types (Future)
export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number;
  type: 'purchase' | 'usage' | 'refund' | 'bonus';
  description: string;
  testId?: string;
  createdAt: Date;
}

export interface BillingSettings {
  creditsPerTest: Record<BrowserType, number>;
  monthlyLimits: Record<SubscriptionPlan, number>;
  overageRate: number;
}

// Webhook types (Future)
export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  data: any;
  timestamp: Date;
  signature: string;
}

export type WebhookEventType =
  | 'test.completed'
  | 'test.failed'
  | 'test.cancelled'
  | 'billing.credit_low'
  | 'billing.payment_failed'
  | 'integration.jira_created'
  | 'integration.slack_notified';

// Error types
export class QAIError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = 'QAIError';
  }
}

export class ValidationError extends QAIError {
  constructor(message: string, details?: any) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown when a pre-flight credit check fails (balance < required).
 *
 * Carries a stable `code` (`INSUFFICIENT_CREDITS`) so the frontend can
 * flip the global "credits exhausted" banner instead of just showing a
 * generic "Validation error" toast, AND structured `details` so the UI
 * can render an exact "need X, have Y" breakdown when it wants.
 *
 * Extends ValidationError so existing `instanceof ValidationError` checks
 * keep routing these to 422 — we only override the machine-readable code.
 */
export class InsufficientCreditsError extends ValidationError {
  constructor(
    message: string,
    details?: { required?: number; available?: number; breakdown?: Record<string, number> },
  ) {
    super(message, details);
    this.name = 'InsufficientCreditsError';
    // QAIError ctor sets code='VALIDATION_ERROR'; override to the specific
    // sentinel the frontend keys off.
    (this as any).code = 'INSUFFICIENT_CREDITS';
  }
}

export class NotFoundError extends QAIError {
  constructor(resource: string, id: string) {
    super(`${resource} with id ${id} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends QAIError {
  constructor(message: string = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'UnauthorizedError';
  }
}

export class RateLimitError extends QAIError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 'RATE_LIMIT_EXCEEDED', 429);
    this.name = 'RateLimitError';
  }
}

// API Test types
export interface ApiTestRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  expectedStatus?: number;
  timeout?: number; // milliseconds, default 10000
  signal?: AbortSignal; // optional external abort signal (combined with timeout via AbortSignal.any)
}

export interface ApiTestResponse {
  success: boolean;
  status: number;
  statusText?: string;
  durationMs: number;
  responseHeaders: Record<string, string>;
  responseBody: any;
  error?: string;
  matchesExpected?: boolean; // true if status matches expectedStatus
}

// ═══════════════════════════════════════════════════════════════════════════
// API FUZZING TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type FuzzingScenarioType =
  | 'authentication'
  | 'authorization'
  | 'method_validation'
  | 'payload_validation'
  | 'security'
  | 'rate_limiting'
  | 'performance';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface FuzzingScenario {
  id: string;
  type: FuzzingScenarioType;
  description: string;
  request: ApiTestRequest;
  expectedStatus: number;
  expectedBehavior: string;
  riskIfFails: string;
}

export interface FuzzingScenarioResult {
  scenario: FuzzingScenario;
  result: ApiTestResponse;
  passed: boolean;
  issue?: SecurityIssue;
}

export interface SecurityIssue {
  severity: IssueSeverity;
  type: FuzzingScenarioType;
  title: string;
  description: string;
  evidence: string;
  risk: string;
  recommendation: string;
  cwe?: string; // Common Weakness Enumeration ID
}

export interface FuzzingReport {
  happyPathResult: ApiTestResponse;
  scenarios: FuzzingScenarioResult[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    duration: number;
  };
  issues: SecurityIssue[];
  securityScore: number; // 0-10
  recommendations: string[];
}

// Jira OAuth types
export interface JiraTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export interface JiraAccessibleResource {
  id: string; // cloud_id
  name: string;
  url: string;
  scopes: string[];
  avatarUrl?: string;
}

export interface JiraTokenData {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string | Date; // ISO string from DB or Date
  scope?: string;
  cloud_id?: string;
  site_url?: string;
  token_type?: string;
  created_at: string | Date; // ISO string from DB or Date
  updated_at: string | Date; // ISO string from DB or Date
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  simplified: boolean;
  style: string;
  isPrivate: boolean;
  properties?: Record<string, any>;
}

// Playwright test visualization types
export * from './playwright.types';

// Testing hierarchy types (Module, Flow, Schedule, Fixture, Plan, Execution)
export * from './testing.types';

// API Configuration types
export interface ApiEnvironment {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  base_url: string;
  description?: string;
  default_headers: Record<string, string>;
  auth_type: 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2';
  auth_config: Record<string, any>;
  variables: Record<string, any>;
  is_active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiEndpoint {
  id: string;
  environment_id: string;
  user_id: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  path: string;
  description?: string;
  headers: Record<string, string>;
  query_params: Record<string, any>;
  path_params: Record<string, any>;
  body_template?: any;
  expected_responses: Array<{
    status: number;
    description: string;
    schema?: any;
  }>;
  timeout_ms: number;
  retry_count: number;
  tags: string[];
  category?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiTestConfig {
  id: string;
  endpoint_id: string;
  user_id: string;
  name: string;
  description?: string;
  test_data: any;
  expected_status: number;
  expected_response?: any;
  setup_steps: any[];
  cleanup_steps: any[];
  dependencies: string[];
  validation_rules: any[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiTestExecution {
  id: string;
  user_id: string;
  environment_id?: string;
  endpoint_id?: string;
  test_config_id?: string;
  execution_type: 'manual' | 'chat' | 'scheduled' | 'ci_cd';
  request_data: any;
  response_data: any;
  status_code: number;
  duration_ms: number;
  success: boolean;
  validation_results: Record<string, any>;
  error_message?: string;
  chat_session_id?: string;
  user_agent: string;
  executed_at: string;
}

export interface ApiConfigurationRequest {
  environment?: Partial<ApiEnvironment>;
  endpoints?: Partial<ApiEndpoint>[];
  test_configs?: Partial<ApiTestConfig>[];
}

export interface ApiTestExecutionRequest {
  environment_id?: string;
  endpoint_id?: string;
  test_config_id?: string;
  custom_data?: any;
  execution_context?: {
    chat_session_id?: string;
    user_message?: string;
  };
}

// Playwright trace upload types
export type TraceFileStatus = 'uploaded' | 'parsing' | 'parsed' | 'failed';

export interface TraceFile {
  id: string;
  user_id: string;
  /** FK → tests(id). Set only for traces produced by the legacy `tests` runner. */
  test_id?: string;
  /**
   * FK → intent_test_cases(id). Set only for traces produced by preview/editor
   * runs of intent test cases. Added by the `trace-files-intent-test-case.sql`
   * migration — may be undefined on rows inserted before the migration ran.
   */
  intent_test_case_id?: string;
  file_name: string;
  storage_path: string;
  file_size?: number;
  browser?: string;
  status: TraceFileStatus;
  parsed_data?: any;
  public_url?: string;
  created_at: string;
  updated_at: string;
  parsed_at?: string;
}

/**
 * Request body for trace upload API.
 * NOTE: userId is NOT sent from client; it's extracted from JWT by the server.
 * Client sends only testId, browser, and optional metadata.
 */
export interface TraceUploadRequest {
  /** @deprecated Not used – userId extracted from auth token */
  userId?: string;
  testId?: string;
  browser?: string;
  metadata?: Record<string, any>;
}

export interface TraceUploadResponse {
  success: boolean;
  message: string;
  data?: {
    id: string;
    fileName: string;
    storagePath: string;
    publicUrl?: string;
    fileSize: number;
    uploadedAt: string;
    testId?: string;
    userId: string;
  };
  error?: string;
}

export interface TraceFileListItem {
  id: string;
  fileName: string;
  testId?: string;
  uploadedAt: string;
  size: number;
  status: TraceFileStatus;
  browser?: string;
  publicUrl?: string;
}

export interface TraceStep {
  stepId: number;
  type: string;
  selector?: string;
  text?: string;
  url?: string;
  timestamp?: number;
  screenshotUrl?: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface TraceStepsResponse {
  success: boolean;
  data?: {
    testId: string;
    userId: string;
    fileName: string;
    totalSteps: number;
    steps: TraceStep[];
    parsedAt: string;
  };
  error?: string;
  message?: string;
}

// Intent Parsing types
// Intent types are now fully dynamic - determined by available handlers
// No hardcoded list - intents are discovered from handler registry
export type IntentType = string; // Fully flexible - any intent that has a handler is valid

export type ElementType =
  | 'button'
  | 'input'
  | 'text'
  | 'link'
  | 'image'
  | 'form'
  | 'select'
  | 'checkbox'
  | 'radio'
  | string; // Allow custom element types

export type ViewportType = 'mobile' | 'desktop' | string;
export type ActionType =
  | 'click'
  | 'visible'
  | 'input'
  | 'submit'
  | 'check'
  | 'navigate'
  | string; // Allow custom actions

// ═══════════════════════════════════════════════════════════════════════════
// TESTING SCOPE CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valid testing scopes for platform_test
 * Used for validation and type safety across the codebase
 */
export const VALID_SCOPES = ['full', 'page', 'element', 'flow', 'form', 'auth', 'navigation'] as const;

export type TestScope = typeof VALID_SCOPES[number] | 'general' | null;

// ═══════════════════════════════════════════════════════════════════════════
// INTENT TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface IntentResult {
  intent: IntentType;
  intent_confidence?: number; // 0-1, how confident AI is about the intent

  // NEW: Scope and target for platform_test
  scope?: TestScope;
  target?: string | null; // What exactly to test (e.g., "registration form", "Buy button")

  // Legacy fields (for backward compatibility)
  elementType?: ElementType;
  elementLabel?: string;
  page?: string | null; // URL if present, NULL is OK - will ask user
  viewport?: ViewportType;
  action?: ActionType;
  value?: string; // For input actions
  confidence?: number; // 0-1, how confident the parser is (DEPRECATED: use intent_confidence)
  rawText?: string; // Original user message for reference
  metadata?: Record<string, any>; // Additional flexible data

  // API test specific fields
  apiMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
  apiUrl?: string; // Full URL OR relative path (/api/v1/users)
  apiBody?: any;
  apiHeaders?: Record<string, string>;
  expectedStatus?: number;
  isRelativePath?: boolean; // True if apiUrl is a relative path without base URL

  // Credentials extracted from user message (GPT-based, any language)
  credentials?: {
    login: string;          // Raw login value (email, phone, or username — as provided)
    loginType: 'email' | 'phone' | 'username' | 'id' | 'other' | (string & {});  // GPT-classified type (allow custom identifiers)
    password: string;
  } | null;

  // Optional fields (all intents)
  urgency?: 'high' | 'normal' | null; // Detect: "urgent", "ASAP", "critical", "quick"
  userLanguage?: 'en' | 'ru' | 'neutral'; // User's language for localization

  selector?: string; // For UI testing intents
  // Playwright commands generated from intent
  commands?: PlaywrightCommand[];

  // Clarification fields (for needs_clarification intent)
  clarificationQuestion?: string; // Question to ask user when intent is unclear
  possibleIntents?: IntentType[]; // List of possible intents AI is considering
  clarificationReason?: string; // Why clarification is needed (for debugging)

  // Regression test fields (for save_test, run_regression intents)
  sourceTestId?: string | null;        // For save_test: ID of test to save
  suggestedName?: string | null;       // For save_test: suggested name
  savedTestCaseId?: string | null;     // For run_regression: ID of saved test case

  // Smart Test Case Resolver context (for platform_test with matched existing cases)
  resolvedContext?: {
    prefilledSteps: import('@/services/testing/resolver/resolver.types').PrefilledStep[];
    sourceTestCases?: Array<{ id: string; name: string; matchScore: number }>;
    resolverStrategy: 'embedding' | 'hybrid' | 'name_only';
  };

  // Execution strategy for platform_test: 'standard' runs a single goal via LiteEngine,
  // 'exploration' runs autonomous BFS discovery + multi-flow execution via ExplorationEngine.
  executionStrategy?: 'standard' | 'exploration';

  // Pipeline optimization: does this general_chat message need tools to answer?
  // Set by Intent Parser LLM when intent=general_chat.
  // false → pipeline skips Router agent (~600ms saved), goes directly to Responder.
  // true/undefined → normal Router flow (backward compatible).
  needsTools?: boolean;
}

// Playwright Command types
//
// NOTE: This type defines ALL possible Playwright actions for type safety
// Some actions may not be implemented in command-executor.ts yet (marked below)
//
// IMPLEMENTED in command-executor.ts:
// - goto, click, fill, type, select (→ selectOption), check, uncheck, hover, press
// - wait (→ waitForTimeout), waitForSelector, waitForNavigation (→ waitForLoadState)
// - scroll, screenshot
// - assertVisible, assertText, assertValue, assertUrl, assertCount
// - extract, evaluate
//
// NOT YET IMPLEMENTED (types ready for future implementation):
// - goBack, goForward, reload (navigation)
// - dblclick, focus, blur (interactions)
// - dragAndDrop, swipe, tap (touch/mobile)
// - waitForTimeout, waitForLoadState, scrollIntoView (aliases/missing)
// - upload, download (file operations)
// - assertHidden, assertEnabled, assertDisabled (assertions)
// - selectOption (use 'select' which maps to it)
//
// Types are defined to prevent runtime errors and support future features
export type PlaywrightActionType =
  // Navigation
  | 'goto'              // Navigate to URL
  | 'goBack'            // Navigate back in history
  | 'goForward'         // Navigate forward in history
  | 'reload'            // Reload current page
  // Interactions
  | 'click'             // Click element
  | 'dblclick'          // Double-click element
  | 'fill'              // Fill input field (fast, no events)
  | 'type'              // Type text (slower, with keyboard events)
  | 'select'            // Select from dropdown (maps to selectOption)
  | 'selectOption'      // Select option from dropdown/select element
  | 'check'             // Check checkbox
  | 'uncheck'           // Uncheck checkbox
  | 'toggle'            // Toggle checkbox/switch (state-aware click)
  | 'open'              // Semantic click to open (with enabled guard)
  | 'close'             // Semantic click to close (with enabled guard)
  | 'hover'             // Hover over element
  | 'press'             // Press keyboard key
  | 'focus'             // Focus element
  | 'blur'              // Blur element
  // Touch/Mobile
  | 'dragAndDrop'       // Drag and drop element
  | 'swipe'             // Swipe gesture (mobile)
  | 'tap'               // Tap gesture (mobile)
  // Wait & Scroll
  | 'wait'              // Wait for timeout (ms)
  | 'waitForSelector'   // Wait for element to appear
  | 'waitForTimeout'    // Wait for specific timeout (alias for wait)
  | 'waitForLoadState'  // Wait for page load state
  | 'waitForNavigation' // Wait for page navigation
  | 'waitFor'        // Wait for URL to match (V5: SPA-safe, supports Momentic-like matchers)
  | 'scroll'            // Scroll page/element
  | 'scrollIntoView'    // Scroll element into view
  // File operations
  | 'upload'            // Upload file
  | 'download'          // Download file (read-only)
  | 'screenshot'        // Take screenshot
  // Assertions
  | 'assertVisible'     // Assert element is visible
  | 'assertHidden'      // Assert element is hidden
  | 'assertEnabled'     // Assert element is enabled
  | 'assertDisabled'    // Assert element is disabled
  | 'assertText'        // Assert element contains text
  | 'assertValue'       // Assert input has value
  | 'assertUrl'         // Assert current URL matches
  | 'assertCount'       // Assert number of elements
  | 'assert'            // Generic assert dispatcher (visible/text/value/count/url/etc.)
  // AI-powered
  | 'aiCheck'           // AI-based assertion using LLM
  // Data extraction & evaluation
  | 'extract'           // Extract data from element
  | 'evaluate'          // Execute JS in browser context
  | 'script'            // Execute custom script (alias for evaluate)
  // Fallback for custom/unknown actions
  | string;

/**
 * URL matcher configuration for waitFor action (V5)
 * Same shape as UrlMatcher in preview.types.ts for consistency
 */
export interface PlaywrightUrlMatcher {
  /** Match if URL contains this substring */
  substring?: string;
  /** Match using glob pattern (e.g., 'checkout' or 'products/*') */
  glob?: string;
  /** Match using regex pattern */
  regex?: string;
  /** Match if URL domain equals this value (strict host match) */
  domain?: string;
  /** Internal: wait until URL changes from this value (used by auto-insert) */
  changedFrom?: string;
  /** Case-sensitive matching (default: false) */
  caseSensitive?: boolean;
  /** Negate the match (wait until URL does NOT match) */
  negate?: boolean;
  /** Timeout in milliseconds (default: 15000) */
  timeoutMs?: number;
}

export interface PlaywrightCommand {
  action: PlaywrightActionType;
  selector?: string;        // CSS selector, text selector, or xpath
  value?: string | number | string[]; // Value for fill, type, select (supports array for multi-select)
  url?: string;             // For goto action
  timeout?: number;         // Timeout in ms (default: 30000)
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle'; // Wait strategy for goto
  description?: string;     // Human-readable description of what this does
  screenshot?: boolean;     // Take screenshot after this action
  continueOnError?: boolean; // Continue test even if this step fails
  awaitNavigation?: boolean; // Wait for navigation after click/submit actions
  /**
   * Lifecycle phase: 'setup' | 'main' | 'teardown'. Populated by
   * `stitchPhases()` in regression-run.service when a test case has
   * setup_steps / teardown_steps. Absent or 'main' = normal behaviour
   * (Playwright executor fails the test on error unless `continueOnError`).
   * Setup phase failure aborts main and still runs teardown.
   * Teardown phase failure is logged but doesn't flip the verdict.
   */
  phase?: 'setup' | 'main' | 'teardown';
  assertion?: {             // For assert actions
    type: 'visible' | 'hidden' | 'text' | 'value' | 'count' | 'url' | 'enabled' | 'disabled';
    expected: string | number | boolean;
    operator?: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'startsWith' | 'endsWith' | 'matches' | 'regex' | 'glob';
  };
  extract?: {               // For extract action
    name: string;           // Variable name to store extracted value
    attribute?: string;     // Attribute to extract (e.g., 'href', 'src')
    property?: 'text' | 'value' | 'innerHTML'; // Property to extract
    useAI?: boolean;        // Use AI extraction with schema validation
    schema?: any;           // JSON schema for AI extraction (JSONSchema type)
    mode?: 'html' | 'text' | 'auto'; // Extraction mode for AI
    instructions?: string;  // Additional instructions for AI
  };
  /** Configuration for upload action (V6: file upload to input[type="file"]) */
  upload?: {
    /** File source: URL to download, or storage path to a pre-uploaded file */
    fileUrl: string;
    /** Source type: 'url' (download from public URL) or 'storage' (pre-uploaded to platform storage) */
    sourceType: 'url' | 'storage';
    /** Optional filename override (e.g., 'invoice.pdf'). If omitted, derived from URL */
    filename?: string;
    /** Store the local file path in an environment variable */
    envVar?: string;
    /** Maximum file size in bytes (default: 50MB = 52428800) */
    maxSizeBytes?: number;
  };
  /** URL matcher for waitFor action (V5: SPA-safe URL waiting) */
  urlMatcher?: PlaywrightUrlMatcher;
  /** V13: Modifier keys held during click (for multi-select, range select, etc.) */
  modifiers?: { shift?: boolean; ctrl?: boolean; meta?: boolean; alt?: boolean };
  /** V13: Dialog handling options (for handleDialog action) */
  dialog?: {
    dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    action: 'accept' | 'dismiss';
    promptText?: string;
    message?: string;
  };
  /** V13: Download verification options (for verifyDownload action) */
  download?: {
    filename?: string;
    url?: string;
    timeoutMs?: number;
  };
  /** V14: Drop target selector for dragAndDrop action (element-based drag) */
  dropTarget?: string;
}

export interface PlaywrightTestPlan {
  url: string;              // Starting URL
  description: string;      // What this test does
  commands: PlaywrightCommand[];
  viewport?: ViewportType;
  expectedOutcome: string;  // What should happen if test passes
}

// ============================================================================
// FINAL REPORT & JIRA INTEGRATION TYPES
// ============================================================================

export interface FinalTestReport {
  testId: string;
  testUrl: string;
  status: TestStatus;
  executedAt: string;
  duration: number; // milliseconds

  // Generated Playwright code
  generatedCode: {
    language: 'typescript' | 'javascript' | 'python';
    framework: 'playwright' | 'puppeteer';
    code: string;
    steps: string[];
    commands: PlaywrightCommand[];
  };

  // Test artifacts
  artifacts: {
    video?: string; // URL
    trace?: string; // URL
    screenshots: string[]; // URLs or base64
    dom?: string;
    logs: string[];
    networkLogs: NetworkLog[];
  };

  // AI Analysis
  analysis: {
    bugs: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low';
      type: string;
      message: string;
      selector?: string;
      recommendation: string;
    }>;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'none';
    recommendations: string[];
    confidence: number; // 0-1
  };

  // Summary stats
  summary: {
    totalSteps: number;
    passedSteps: number;
    failedSteps: number;
    bugsFound: number;
    criticalBugs: number;
  };
}

export interface JiraIssueRequest {
  userId: string;
  projectKey: string;
  testReport: FinalTestReport;
  issueType?: 'Bug' | 'Task' | 'Story';
  priority?: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
}

export interface JiraIssue {
  id: string;
  key: string; // e.g., "PROJ-123"
  self: string; // URL
  fields: {
    summary: string;
    description: any;
    status: { name: string };
    priority: { name: string };
    created: string;
    updated: string;
  };
}

export interface JiraAttachment {
  filename: string;
  buffer: Buffer;
  mimeType: string;
}

/** Board item for GET /api/v1/jira/boards response */
export interface JiraBoard {
  id: number | string;
  name: string;
  type: string;
}

/** Issue item for GET /api/v1/jira/issues response */
export interface JiraIssueListItem {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  status: { id: string; name: string; statusCategory?: Record<string, unknown> };
  priority: { id: string; name: string } | null;
  issuetype: { id: string; name: string };
  reporter: { accountId: string; displayName: string; emailAddress?: string } | null;
  assignee: { accountId: string; displayName: string; emailAddress?: string } | null;
  created: string;
  updated: string;
  labels: string[];
  project: { id: string; key: string; name: string };
}

export interface JiraSearchResult {
  issues: JiraIssueListItem[];
  total: number;
}

// Message Feedback types
export type FeedbackType = 'like' | 'dislike';

export interface MessageFeedback {
  id: string;
  message_id: string;
  user_id: string;
  session_id: string;
  feedback_type: FeedbackType;
  intent_type?: string;
  context?: FeedbackContext;
  created_at: string;
}

export interface FeedbackContext {
  prompt_tokens?: number;
  response_tokens?: number;
  response_time_ms?: number;
  model?: string;
  temperature?: number;
  user_agent?: string;
  [key: string]: any;
}

export interface CreateFeedbackRequest {
  message_id: string;
  feedback_type: FeedbackType;
  intent_type?: string;
  context?: FeedbackContext;
}

export interface FeedbackAnalytics {
  intent_type: string;
  feedback_type: FeedbackType;
  count: number;
  date: string;
}

export interface FeedbackStatistics {
  total_feedback: number;
  likes: number;
  dislikes: number;
  satisfaction_rate: number;
  by_intent: Array<{
    intent_type: string;
    likes: number;
    dislikes: number;
    satisfaction_rate: number;
    total: number;
  }>;
  recent_feedback: MessageFeedback[];
}

export interface FeedbackInsights {
  summary: {
    overall_satisfaction: number;
    total_responses: number;
    feedback_rate: number; // % of messages with feedback
    trend: 'improving' | 'declining' | 'stable';
  };
  problem_areas: Array<{
    intent_type: string;
    issue: string;
    severity: 'high' | 'medium' | 'low';
    affected_messages: number;
    satisfaction_rate: number;
  }>;
  top_performers: Array<{
    intent_type: string;
    satisfaction_rate: number;
    total_feedback: number;
    why_successful: string;
  }>;
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    area: string;
    action: string;
    expected_improvement: string;
  }>;
  time_series: Array<{
    date: string;
    likes: number;
    dislikes: number;
    satisfaction_rate: number;
  }>;
}

export interface FeedbackComparison {
  current_period: FeedbackStatistics;
  previous_period: FeedbackStatistics;
  changes: {
    satisfaction_rate_change: number; // percentage points
    likes_change: number;
    dislikes_change: number;
    total_feedback_change: number;
  };
  improved_intents: string[];
  declined_intents: string[];
}

// ============================================================================
// USER REPORT TYPES
// ============================================================================

export type ReportCategory = 'bug' | 'ui' | 'feature' | 'other';
export type ReportStatus = 'pending' | 'in_progress' | 'resolved' | 'closed';

export interface UserReport {
  id: string;
  user_id: string;
  title: string;
  category: ReportCategory;
  details: string;
  workspace_name?: string | null;
  view?: string | null;
  status: ReportStatus;
  created_at: string;
  updated_at: string;
}

export interface CreateReportData {
  title: string;
  category: ReportCategory;
  details: string;
  workspace_name?: string;
  view?: string;
}
