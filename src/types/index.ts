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

export interface Project {
  id: string;
  name: string;
  description?: string;
  userId: string;
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

// Intent Parsing types
export type IntentType =
  | 'check_element'
  | 'fill_form'
  | 'login_flow'
  | 'assert_ui'
  | 'navigate'
  | 'api_test'
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
}
