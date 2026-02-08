/**
 * ReportGenerator
 * Generates comprehensive test reports from test case results
 */

import type {
  StepResult,
  TestCaseResult,
  TestError,
} from '../test-case/types';

export interface TestReport {
  summary: ReportSummary;
  steps: StepReport[];
  timeline: TimelineEntry[];
  errors: CategorizedErrors;
  performance: PerformanceMetrics;
}

export interface ReportSummary {
  testName: string;
  status: string;
  duration: number;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  passRate: number;
}

export interface StepReport {
  stepNumber: number;
  description: string;
  status: string;
  duration: number;
  iterations: number;
  aiSteps: string[];
  assertions: AssertionReport[];
  screenshot?: string;
  error?: TestError;
}

export interface AssertionReport {
  type: string;
  passed: boolean;
  expected: any;
  actual?: any;
  message?: string;
}

export interface TimelineEntry {
  timestamp: number;
  event: 'step_start' | 'step_passed' | 'step_failed';
  description: string;
  duration?: number;
}

export interface CategorizedErrors {
  setup: TestError[];
  execution: TestError[];
  assertion: TestError[];
  timeout: TestError[];
  crash: TestError[];
}

export interface PerformanceMetrics {
  averageStepDuration: number;
  slowestStep: StepResult;
  totalIterations: number;
  iterationsPerStep: number;
}

export class ReportGenerator {
  /**
   * Generate a comprehensive test report
   *
   * @param result - Test case result
   * @returns Complete test report
   */
  async generate(result: TestCaseResult): Promise<TestReport> {
    return {
      summary: this.buildSummary(result),
      steps: this.buildStepReport(result.steps),
      timeline: this.buildTimeline(result),
      errors: this.categorizeErrors(result.errors),
      performance: this.analyzePerformance(result),
    };
  }

  /**
   * Build test summary
   *
   * @param result - Test case result
   * @returns Summary with pass/fail statistics
   */
  private buildSummary(result: TestCaseResult): ReportSummary {
    const totalSteps = result.steps.length;
    const passedSteps = result.steps.filter((s) => s.status === 'passed').length;
    const failedSteps = result.steps.filter((s) => s.status === 'failed').length;
    const skippedSteps = result.steps.filter((s) => s.status === 'skipped').length;

    return {
      testName: result.testCase.name,
      status: result.status,
      duration: result.duration,
      totalSteps,
      passedSteps,
      failedSteps,
      skippedSteps,
      passRate: totalSteps > 0 ? (passedSteps / totalSteps) * 100 : 0,
    };
  }

  /**
   * Build detailed step reports
   *
   * @param steps - Step results
   * @returns Array of step reports
   */
  private buildStepReport(steps: StepResult[]): StepReport[] {
    return steps.map((step, index) => ({
      stepNumber: index + 1,
      description: step.step.description,
      status: step.status,
      duration: step.duration,
      iterations: step.iterations,
      aiSteps: step.aiSteps || [],
      assertions: step.assertions.map((a) => ({
        type: a.assertion.type,
        passed: a.passed,
        expected: a.assertion.expected,
        actual: a.actual,
        message: a.message,
      })),
      screenshot: step.screenshot,
      error: step.error,
    }));
  }

  /**
   * Build chronological timeline
   *
   * @param result - Test case result
   * @returns Timeline of events
   */
  private buildTimeline(result: TestCaseResult): TimelineEntry[] {
    const timeline: TimelineEntry[] = [];
    let cumulativeTime = 0;

    for (const step of result.steps) {
      timeline.push({
        timestamp: result.startTime + cumulativeTime,
        event: 'step_start',
        description: step.step.description,
      });

      cumulativeTime += step.duration;

      timeline.push({
        timestamp: result.startTime + cumulativeTime,
        event: step.status === 'passed' ? 'step_passed' : 'step_failed',
        description: step.step.description,
        duration: step.duration,
      });
    }

    return timeline;
  }

  /**
   * Categorize errors by type
   *
   * @param errors - All test errors
   * @returns Errors grouped by category
   */
  private categorizeErrors(errors: TestError[]): CategorizedErrors {
    return {
      setup: errors.filter((e) => e.type === 'setup'),
      execution: errors.filter((e) => e.type === 'execution'),
      assertion: errors.filter((e) => e.type === 'assertion'),
      timeout: errors.filter((e) => e.type === 'timeout'),
      crash: errors.filter((e) => e.type === 'crash'),
    };
  }

  /**
   * Analyze performance metrics
   *
   * @param result - Test case result
   * @returns Performance statistics
   */
  private analyzePerformance(result: TestCaseResult): PerformanceMetrics {
    const steps = result.steps;

    if (steps.length === 0) {
      return {
        averageStepDuration: 0,
        slowestStep: {} as StepResult,
        totalIterations: 0,
        iterationsPerStep: 0,
      };
    }

    const totalDuration = steps.reduce((acc, s) => acc + s.duration, 0);
    const totalIterations = steps.reduce((acc, s) => acc + s.iterations, 0);

    return {
      averageStepDuration: totalDuration / steps.length,
      slowestStep: steps.reduce((a, b) => (a.duration > b.duration ? a : b)),
      totalIterations,
      iterationsPerStep: totalIterations / steps.length,
    };
  }
}
