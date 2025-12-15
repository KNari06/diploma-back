// Main service file - exports all methods from modular files
import { ApiResponse, BrowserType, PaginatedResponse, Test, TestResult, TestRunRequest } from '@/types';
import {
  cancelTest,
  cancelAllRunningTestsForUser,
  cancelAllRunningTestsForChatSession,
  getRunningTestsForUser,
  getRunningTestsForChatSession,
} from './manual/test-cancellation';
import { calculateRequiredCredits, checkUserCredits, deductCredits } from './manual/test-credits';
import { getTest, getTestResults, getTestsByProject, getTestsByUser, getTestStats } from './manual/test-queries';
import { processTestResult } from './manual/test-result-processor';
import { retryTest } from './manual/test-retry';
import { runTest } from './manual/test-runner';

/**
 * ManualTestService - Main service class for manual UI testing
 *
 * This service orchestrates manual test execution, management, and result processing.
 * The implementation is split into modular files for better maintainability:
 *
 * - test-validator.ts: Request validation
 * - test-creator.ts: Test and project creation
 * - test-queries.ts: Database queries (get, list, stats)
 * - test-runner.ts: Test execution and queue management
 * - test-cancellation.ts: Test cancellation logic
 * - test-retry.ts: Test retry functionality
 * - test-credits.ts: Credit checking and deduction
 * - test-result-processor.ts: Result processing and completion handling
 */
export class ManualTestService {
  /**
   * Create and run a new test
   */
  static async runTest(testRequest: TestRunRequest): Promise<ApiResponse<Test>> {
    return runTest(testRequest);
  }

  /**
   * Get test by ID with results
   */
  static async getTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    return getTest(testId, userId);
  }

  /**
   * Get test results
   */
  static async getTestResults(testId: string, userId?: string): Promise<ApiResponse<TestResult[]>> {
    return getTestResults(testId, userId);
  }

  /**
   * Get all tests for user with pagination
   */
  static async getTestsByUser(
    userId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResponse<Test>> {
    return getTestsByUser(userId, page, limit);
  }

  /**
   * Get tests by project with pagination
   */
  static async getTestsByProject(
    projectId: string,
    userId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<PaginatedResponse<Test>> {
    return getTestsByProject(projectId, userId, page, limit);
  }

  /**
   * Cancel a running test
   */
  static async cancelTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    return cancelTest(testId, userId);
  }

  /**
   * Cancel all running tests for a user
   */
  static async cancelAllRunningTestsForUser(userId: string): Promise<{
    success: boolean;
    cancelledCount: number;
    errors: string[];
  }> {
    return cancelAllRunningTestsForUser(userId);
  }

  /**
   * Cancel all running tests for a chat session
   */
  static async cancelAllRunningTestsForChatSession(
    chatSessionId: string,
    userId?: string
  ): Promise<{
    success: boolean;
    cancelledCount: number;
    errors: string[];
  }> {
    return cancelAllRunningTestsForChatSession(chatSessionId, userId);
  }

  /**
   * Get all running tests for a user
   */
  static async getRunningTestsForUser(userId: string): Promise<Test[]> {
    return getRunningTestsForUser(userId);
  }

  /**
   * Get all running tests for a chat session
   */
  static async getRunningTestsForChatSession(chatSessionId: string): Promise<Test[]> {
    return getRunningTestsForChatSession(chatSessionId);
  }

  /**
   * Retry a failed test
   */
  static async retryTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
    return retryTest(testId, userId);
  }

  /**
   * Get test statistics
   */
  static async getTestStats(projectId: string, userId: string): Promise<ApiResponse<any>> {
    return getTestStats(projectId, userId);
  }

  /**
   * Process test result from agent
   */
  static async processTestResult(resultData: {
    testId: string;
    browser: BrowserType;
    status: string;
    screenshot?: string;
    dom?: string;
    logs: string[];
    networkLogs: any[];
    errors: any[];
    performance?: any;
  }): Promise<ApiResponse<TestResult>> {
    return processTestResult(resultData);
  }

  // Private methods exposed for internal use (used by retryTest)
  static async checkUserCredits(
    userId: string,
    browsers: BrowserType[],
    intelligentMode?: boolean,
    estimatedCost?: string
  ): Promise<void> {
    return checkUserCredits(userId, browsers, intelligentMode, estimatedCost);
  }

  static async deductCredits(
    userId: string,
    testId: string,
    browsers: BrowserType[],
    intelligentMode?: boolean,
    estimatedCost?: string
  ): Promise<void> {
    return deductCredits(userId, testId, browsers, intelligentMode, estimatedCost);
  }

  static calculateRequiredCredits(
    browsers: BrowserType[],
    intelligentMode?: boolean,
    estimatedCost?: string
  ): number {
    return calculateRequiredCredits(browsers, intelligentMode, estimatedCost);
  }
}
