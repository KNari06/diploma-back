// Auth types
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: string;
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
}

export type BrowserType = 'chrome' | 'firefox' | 'safari' | 'edge' | 'mobile-chrome' | 'mobile-safari';

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

export interface AISummary {
  summary: string;
  bugs: BugReport[];
  recommendations: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number; // 0-100
  generatedAt: Date;
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
    total: number;
    totalPages: number;
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
  test_id?: string;
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

export interface TraceUploadRequest {
  userId: string;
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
export type IntentType =
  | 'check_element'
  | 'fill_form'
  | 'login_flow'
  | 'assert_ui'
  | 'navigate'
  | 'api_test'
  | 'api_test_comprehensive'
  | 'general_chat'
  | string; // Allow custom intents for flexibility

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

export interface IntentResult {
  intent: IntentType;
  elementType?: ElementType;
  elementLabel?: string;
  page?: string;
  viewport?: ViewportType;
  action?: ActionType;
  value?: string; // For input actions
  confidence?: number; // 0-1, how confident the parser is
  rawText?: string; // Original user message for reference
  metadata?: Record<string, any>; // Additional flexible data
  // API test specific fields
  apiMethod?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
  apiUrl?: string;
  apiBody?: any;
  apiHeaders?: Record<string, string>;
  expectedStatus?: number;
  isRelativePath?: boolean; // True if apiUrl is a relative path without base URL
  selector?: string; // For UI testing intents
  // Playwright commands generated from intent
  commands?: PlaywrightCommand[];
}

// Playwright Command types
export type PlaywrightActionType =
  | 'goto'          // Navigate to URL
  | 'click'         // Click element
  | 'fill'          // Fill input field
  | 'type'          // Type text (slower, with events)
  | 'select'        // Select from dropdown
  | 'check'         // Check checkbox
  | 'uncheck'       // Uncheck checkbox
  | 'hover'         // Hover over element
  | 'wait'          // Wait for condition
  | 'waitForSelector' // Wait for element
  | 'waitForNavigation' // Wait for page navigation
  | 'screenshot'    // Take screenshot
  | 'scroll'        // Scroll page/element
  | 'press'         // Press keyboard key
  | 'assertVisible' // Assert element is visible
  | 'assertText'    // Assert element contains text
  | 'assertValue'   // Assert input has value
  | 'assertUrl'     // Assert current URL
  | 'assertCount'   // Assert number of elements
  | 'extract'       // Extract data from element
  | 'evaluate'      // Execute JS in browser
  | string;

export interface PlaywrightCommand {
  action: PlaywrightActionType;
  selector?: string;        // CSS selector, text selector, or xpath
  value?: string | number;  // Value for fill, type, select, etc.
  url?: string;             // For goto action
  timeout?: number;         // Timeout in ms (default: 30000)
  waitFor?: 'load' | 'domcontentloaded' | 'networkidle'; // Wait strategy for goto
  description?: string;     // Human-readable description of what this does
  screenshot?: boolean;     // Take screenshot after this action
  continueOnError?: boolean; // Continue test even if this step fails
  assertion?: {             // For assert actions
    type: 'visible' | 'hidden' | 'text' | 'value' | 'count' | 'url' | 'enabled' | 'disabled';
    expected: string | number | boolean;
    operator?: '=' | '!=' | '>' | '<' | 'contains' | 'startsWith' | 'endsWith';
  };
  extract?: {               // For extract action
    name: string;           // Variable name to store extracted value
    attribute?: string;     // Attribute to extract (e.g., 'href', 'src')
    property?: 'text' | 'value' | 'innerHTML'; // Property to extract
  };
}

export interface PlaywrightTestPlan {
  url: string;              // Starting URL
  description: string;      // What this test does
  commands: PlaywrightCommand[];
  viewport?: ViewportType;
  expectedOutcome: string;  // What should happen if test passes
}
