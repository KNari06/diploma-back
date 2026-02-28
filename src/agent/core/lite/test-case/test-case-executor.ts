/**
 * TestCaseExecutor
 * Executes structured test cases using LiteEngine
 */

import type { Page } from 'playwright';
import { LiteEngine } from '../lite-engine';
import { AssertionEngine } from './assertion-engine';
import type {
  Assertion,
  AssertionResult,
  StepResult,
  TestArtifacts,
  TestCase,
  TestCaseResult,
  TestData,
  TestError,
  TestExecutorConfig,
  TestMetadata,
  TestStep,
} from './types';

export class TestCaseExecutor {
  private assertionEngine: AssertionEngine;
  private stepResults: StepResult[] = [];
  private currentTestData: TestData = {};

  constructor(
    private page: Page,
    private config: TestExecutorConfig
  ) {
    this.assertionEngine = new AssertionEngine(page);
  }

  /**
   * Execute a complete test case
   *
   * @param testCase - Test case to execute
   * @returns Test case result with all step results
   */
  async execute(testCase: TestCase): Promise<TestCaseResult> {
    const startTime = Date.now();
    this.stepResults = [];

    try {
      // 1. Bind test data
      this.currentTestData = testCase.data || {};

      // 2. Run setup steps (if any)
      if (testCase.setup && testCase.setup.length > 0) {
        await this.executeSteps(testCase.setup, 'setup');
      }

      // 3. Run main test steps
      await this.executeSteps(testCase.steps, 'main');

      // 4. Run teardown steps (if any, always run even if test failed)
      if (testCase.teardown && testCase.teardown.length > 0) {
        try {
          await this.executeSteps(testCase.teardown, 'teardown');
        } catch (error) {
          // Log teardown error but don't fail the test
          // eslint-disable-next-line no-console
          console.warn('[TEST_EXECUTOR] Teardown failed:', error);
        }
      }

      const endTime = Date.now();
      const allPassed = this.stepResults.every((r) => r.status === 'passed' || r.step.optional);

      return {
        testCase,
        status: allPassed ? 'passed' : 'failed',
        duration: endTime - startTime,
        startTime,
        endTime,
        steps: this.stepResults,
        errors: this.collectErrors(),
        artifacts: await this.collectArtifacts(),
        metadata: this.buildMetadata(),
      };
    } catch (error) {
      return this.buildErrorResult(testCase, error, startTime);
    }
  }

  /**
   * Execute a list of steps (setup, main, or teardown)
   *
   * @param steps - Steps to execute
   * @param phase - Execution phase
   */
  private async executeSteps(steps: TestStep[], phase: 'setup' | 'main' | 'teardown'): Promise<void> {
    for (const step of steps) {
      const stepResult = await this.executeStep(step);
      this.stepResults.push(stepResult);

      // Stop on failure (unless optional or teardown phase)
      if (stepResult.status === 'failed' && !step.optional && phase !== 'teardown') {
        throw new Error(`Step "${step.description}" failed`);
      }
    }
  }

  /**
   * Execute a single test step
   *
   * @param step - Step to execute
   * @returns Step result with status and details
   */
  private async executeStep(step: TestStep): Promise<StepResult> {
    const startTime = Date.now();
    const aiSteps: string[] = [];

    try {
      // Handle verify-only steps (no LiteEngine execution)
      if (step.action === 'verify') {
        const assertionResults = await this.runAssertions(step.assertions || []);
        const allAssertionsPassed = assertionResults.every((a) => a.passed);

        return {
          step,
          status: allAssertionsPassed ? 'passed' : 'failed',
          duration: Date.now() - startTime,
          iterations: 0,
          assertions: assertionResults,
          screenshot: step.screenshot !== false ? await this.takeScreenshot(`step_${step.id}`) : undefined,
        };
      }

      // Convert TestStep to goal for LiteEngine
      const goal = this.stepToGoal(step);

      // Initialize LiteEngine for this step
      const liteEngine = new LiteEngine(this.page, {
        goal,
        testId: this.config.testId,
        url: this.page.url(), // Current URL
        browser: this.config.browser || 'chrome',
        userId: this.config.userId,
        chatSessionId: this.config.chatSessionId,
        credentials: this.config.credentials?.password ? {
          password: this.config.credentials.password,
          ...(this.config.credentials.username && { username: this.config.credentials.username }),
          ...(this.config.credentials.email && { email: this.config.credentials.email }),
          ...(this.config.credentials.phone && { phone: this.config.credentials.phone }),
        } : undefined,
      });

      // Execute step with LiteEngine
      const liteResult = await liteEngine.execute();

      // Collect AI steps from history
      if (liteResult.history) {
        aiSteps.push(...this.extractAISteps(liteResult.history));
      }

      // Take screenshot if requested
      let screenshot: string | undefined;
      if (step.screenshot !== false) {
        screenshot = await this.takeScreenshot(`step_${step.id}`);
      }

      // Run assertions
      const assertionResults = await this.runAssertions(step.assertions || []);

      const allAssertionsPassed = assertionResults.every((a) => a.passed);
      const status = liteResult.success && allAssertionsPassed ? 'passed' : 'failed';

      return {
        step,
        status,
        duration: Date.now() - startTime,
        iterations: liteResult.iterations,
        assertions: assertionResults,
        screenshot,
        aiSteps,
        error: !liteResult.success
          ? {
              type: 'execution',
              message: liteResult.reason || 'Step execution failed',
            }
          : undefined,
      };
    } catch (error) {
      return {
        step,
        status: 'failed',
        duration: Date.now() - startTime,
        iterations: 0,
        assertions: [],
        error: {
          type: 'execution',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        aiSteps,
      };
    }
  }

  /**
   * Convert TestStep to natural language goal for LiteEngine
   *
   * @param step - Test step
   * @returns Natural language goal string
   */
  private stepToGoal(step: TestStep): string {
    const value = this.interpolateData(step.value);
    const selector = step.selector || step.description;

    switch (step.action) {
      case 'navigate':
        return `Navigate to ${selector}`;

      case 'click':
        return `Click ${selector}`;

      case 'fill':
        return `Fill ${selector} with "${value}"`;

      case 'press':
        return `Press ${value || 'Enter'} key`;

      case 'select':
        return `Select "${value}" from ${selector}`;

      case 'hover':
        return `Hover over ${selector}`;

      case 'scroll':
        return step.value ? `Scroll to ${value}` : `Scroll down`;

      case 'wait':
        return `Wait for ${selector || value || 'page to load'}`;

      case 'toggle':
      case 'check':
      case 'uncheck':
        return `Toggle ${selector}`;

      case 'setRange':
        return `Set ${selector} to "${value}"`;

      case 'clear':
        return `Clear ${selector}`;

      case 'selectDate':
        return `Set date ${selector} to "${value}"`;

      case 'custom':
        return step.description; // Use description as goal for custom actions

      default:
        return `${step.action} ${selector}`;
    }
  }

  /**
   * Interpolate test data variables in value string
   * Replaces {{key}} with testData[key]
   *
   * @param value - Value string with potential variables
   * @returns Interpolated string
   */
  private interpolateData(value?: string): string {
    if (!value) return '';

    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const replacement = this.currentTestData[key];
      return replacement !== undefined ? String(replacement) : '';
    });
  }

  /**
   * Extract readable AI steps from LiteEngine history
   *
   * @param history - Formatted history string
   * @returns Array of human-readable AI steps
   */
  private extractAISteps(history: string): string[] {
    const lines = history.split('\n');
    return lines
      .filter((line) => line.match(/^\d+\./)) // Lines starting with "1. ", "2. ", etc.
      // eslint-disable-next-line no-misleading-character-class
      .map((line) => line.replace(/[✅❌⚠️➖]/g, '').trim()); // Remove emoji
  }

  /**
   * Run all assertions for a step
   *
   * @param assertions - Assertions to run
   * @returns Array of assertion results
   */
  private async runAssertions(assertions: Assertion[]): Promise<AssertionResult[]> {
    if (assertions.length === 0) return [];

    return await this.assertionEngine.assertAll(assertions);
  }

  /**
   * Take screenshot and upload to storage
   *
   * @param name - Screenshot name
   * @returns Screenshot URL
   */
  private async takeScreenshot(name: string): Promise<string> {
    try {
      await this.page.screenshot({ fullPage: false });
      // TODO: Upload to S3 and return URL
      // For now, return local path placeholder
      return `screenshots/${this.config.testId}/${name}.png`;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[TEST_EXECUTOR] Screenshot failed:', error);
      return '';
    }
  }

  /**
   * Collect all errors from step results
   *
   * @returns Array of test errors
   */
  private collectErrors(): TestError[] {
    return this.stepResults.filter((r) => r.error).map((r) => r.error!);
  }

  /**
   * Collect test artifacts (traces, screenshots, etc.)
   *
   * @returns Test artifacts
   */
  private async collectArtifacts(): Promise<TestArtifacts> {
    return {
      trace: `test_logs/${this.config.testId}.jsonl`,
      screenshots: this.stepResults.map((r) => r.screenshot).filter((s): s is string => !!s),
    };
  }

  /**
   * Build test execution metadata
   *
   * @returns Test metadata
   */
  private buildMetadata(): TestMetadata {
    return {
      browser: this.config.browser || 'chrome',
      viewport: { width: 1280, height: 720 },
      userAgent: '', // TODO: Get from page
      environment: process.env.NODE_ENV || 'production',
      testId: this.config.testId,
      runId: Date.now().toString(),
    };
  }

  /**
   * Build error result when test execution fails
   *
   * @param testCase - Test case
   * @param error - Error that occurred
   * @param startTime - Test start time
   * @returns Error result
   */
  private buildErrorResult(testCase: TestCase, error: unknown, startTime: number): TestCaseResult {
    return {
      testCase,
      status: 'error',
      duration: Date.now() - startTime,
      startTime,
      endTime: Date.now(),
      steps: this.stepResults,
      errors: [
        {
          type: 'execution',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      ],
      artifacts: { trace: '', screenshots: [] },
      metadata: this.buildMetadata(),
    };
  }
}
