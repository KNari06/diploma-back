/**
 * Test Case Types
 * Type definitions for structured test case execution
 */

/**
 * Complete test case definition with steps, data, and configuration
 */
export interface TestCase {
  id: string;
  name: string;
  description?: string;
  steps: TestStep[];
  setup?: TestStep[];
  teardown?: TestStep[];
  data?: TestData;
  timeout?: number; // milliseconds
  retry?: RetryConfig;
}

/**
 * Single test step within a test case
 */
export interface TestStep {
  id: string;
  description: string;
  action: TestAction;
  selector?: string; // CSS selector or AI-friendly description
  value?: string; // For fill actions (supports {{variable}} interpolation)
  assertions?: Assertion[];
  timeout?: number;
  optional?: boolean; // If true, test continues even if step fails
  screenshot?: boolean; // Take screenshot after step (default: true)
}

/**
 * Available test actions
 */
export type TestAction =
  | 'navigate' // Navigate to URL
  | 'click' // Click element
  | 'fill' // Fill input field
  | 'press' // Press keyboard key
  | 'select' // Select dropdown option
  | 'hover' // Hover over element
  | 'scroll' // Scroll page
  | 'wait' // Wait for condition
  | 'verify' // Run assertions only (no action)
  | 'custom'; // AI-driven "do X" action

/**
 * Assertion to validate expected state
 */
export interface Assertion {
  type: AssertionType;
  selector?: string; // Element selector (for element assertions)
  expected: any; // Expected value
  message?: string; // Custom error message
}

/**
 * Available assertion types
 */
export type AssertionType =
  | 'element_exists' // Element exists in DOM
  | 'element_visible' // Element is visible
  | 'element_not_exists' // Element does not exist
  | 'url_matches' // URL matches regex
  | 'url_contains' // URL contains string
  | 'text_visible' // Text is visible on page
  | 'text_contains' // Page contains text
  | 'value_equals' // Input value equals
  | 'count_equals' // Element count equals
  | 'custom'; // Custom assertion

/**
 * Test data for parameterized tests
 * Supports variable interpolation in step values via {{key}}
 */
export interface TestData {
  [key: string]: string | number | boolean;
}

/**
 * Retry configuration for flaky tests
 */
export interface RetryConfig {
  maxAttempts: number;
  retryOn?: ('timeout' | 'assertion_failed' | 'error')[];
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Complete test case execution result
 */
export interface TestCaseResult {
  testCase: TestCase;
  status: TestStatus;
  duration: number;
  startTime: number;
  endTime: number;
  steps: StepResult[];
  errors: TestError[];
  artifacts: TestArtifacts;
  metadata: TestMetadata;
}

/**
 * Test execution status
 */
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

/**
 * Single step execution result
 */
export interface StepResult {
  step: TestStep;
  status: StepStatus;
  duration: number;
  iterations: number; // AI iterations used for this step
  assertions: AssertionResult[];
  screenshot?: string; // Screenshot URL
  error?: TestError;
  aiSteps?: string[]; // Real actions AI took (human-readable)
}

/**
 * Step execution status
 */
export type StepStatus = 'passed' | 'failed' | 'skipped';

/**
 * Assertion execution result
 */
export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  actual?: any; // Actual value found
  message?: string; // Result message
}

/**
 * Test error details
 */
export interface TestError {
  type: TestErrorType;
  message: string;
  step?: string; // Step ID where error occurred
  stack?: string;
  screenshot?: string;
}

/**
 * Test error categories
 */
export type TestErrorType =
  | 'setup' // Error during setup
  | 'execution' // Error during step execution
  | 'assertion' // Assertion failure
  | 'timeout' // Timeout exceeded
  | 'crash'; // Page crash or critical error

/**
 * Test artifacts (traces, screenshots, videos)
 */
export interface TestArtifacts {
  trace: string; // JSONL trace file URL
  video?: string; // Video recording URL
  har?: string; // Network HAR file URL
  screenshots: string[]; // All screenshot URLs
}

/**
 * Test execution metadata
 */
export interface TestMetadata {
  browser: string;
  viewport: { width: number; height: number };
  userAgent: string;
  environment: string; // dev, staging, production
  testId: string;
  runId: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTOR TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for test case executor
 */
export interface TestExecutorConfig {
  testId: string;
  browser?: string;
  userId?: string;
  chatSessionId?: string;
  credentials?: {
    email?: string;
    username?: string;
    phone?: string;
    password?: string;
  };
}

/**
 * Parameterized test execution result
 */
export interface ParameterizedResult {
  testCase: TestCase;
  dataSet: TestData[];
  results: TestCaseResult[];
  summary: ParameterizedSummary;
}

/**
 * Summary of parameterized test execution
 */
export interface ParameterizedSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
}
