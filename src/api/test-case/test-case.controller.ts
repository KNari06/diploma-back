/**
 * Test Case Controller
 * Handles structured test case execution requests
 */

import { v4 as uuidv4 } from 'uuid';
import type { Request, Response } from 'express';
import type { Page } from 'playwright';
import { TestCaseExecutor } from '@/agent/core/lite/test-case/test-case-executor';
import type { TestCase, TestCaseResult } from '@/agent/core/lite/test-case/types';
import { logger } from '@/utils/core/logger';

/**
 * Execute a structured test case
 * POST /api/v1/test-case/execute
 */
export async function executeTestCase(req: Request, res: Response): Promise<void> {
  try {
    const { testCase, credentials } = req.body as {
      testCase: TestCase;
      credentials?: { username?: string; password?: string };
    };

    // Validate test case
    const validation = validateTestCase(testCase);
    if (!validation.valid) {
      res.status(400).json({ error: 'Invalid test case', details: validation.errors });
      return;
    }

    // Generate test ID
    const testId = testCase.id || uuidv4();

    logger.info('[TEST_CASE_CONTROLLER] Starting test case execution', {
      testId,
      testName: testCase.name,
      stepCount: testCase.steps.length,
      userId: req.user?.id,
    });

    // Get or create browser page
    // TODO: Integrate with existing browser pool/session management
    const page: Page = await getBrowserPage();

    // Execute test case
    const executor = new TestCaseExecutor(page, {
      testId,
      browser: 'chrome',
      userId: req.user?.id,
      chatSessionId: req.body.chatSessionId,
      credentials,
    });

    const result: TestCaseResult = await executor.execute(testCase);

    logger.info('[TEST_CASE_CONTROLLER] Test case execution completed', {
      testId,
      status: result.status,
      duration: result.duration,
      stepsPassed: result.steps.filter((s) => s.status === 'passed').length,
      stepsFailed: result.steps.filter((s) => s.status === 'failed').length,
    });

    // TODO: Save result to database
    // await saveTestResult(result);

    res.json(result);
  } catch (error) {
    logger.error('[TEST_CASE_CONTROLLER] Test case execution failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      error: 'Test case execution failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Validate test case structure
 *
 * @param testCase - Test case to validate
 * @returns Validation result
 */
function validateTestCase(testCase: TestCase): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!testCase) {
    errors.push('Test case is required');
    return { valid: false, errors };
  }

  if (!testCase.name || testCase.name.trim().length === 0) {
    errors.push('Test case name is required');
  }

  if (!testCase.steps || testCase.steps.length === 0) {
    errors.push('Test case must have at least one step');
  }

  // Validate steps
  if (testCase.steps) {
    testCase.steps.forEach((step, index) => {
      if (!step.description) {
        errors.push(`Step ${index + 1}: description is required`);
      }

      if (!step.action) {
        errors.push(`Step ${index + 1}: action is required`);
      }

      // Validate action-specific requirements
      if (step.action === 'navigate' && !step.selector) {
        errors.push(`Step ${index + 1}: selector (URL) is required for navigate action`);
      }

      if (step.action === 'fill' && !step.value) {
        errors.push(`Step ${index + 1}: value is required for fill action`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get browser page for test execution
 * TODO: Integrate with existing browser pool
 *
 * @returns Playwright page
 */
async function getBrowserPage(): Promise<Page> {
  // TODO: Get from existing browser pool/session management
  // For now, throw error - this needs integration
  throw new Error('Browser page integration pending - connect to existing browser pool');
}
