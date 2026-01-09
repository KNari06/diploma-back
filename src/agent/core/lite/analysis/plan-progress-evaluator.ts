/**
 * PlanProgressEvaluator
 * Evaluates progress through the task plan using cascading checks.
 *
 * Weights:
 * - URL Match: 0.5 (most reliable)
 * - Element Match: 0.3 (success_elements visible)
 * - Text Match: 0.2 (required_text found)
 *
 * Threshold: ProgressScore > 0.7 = step completed
 */

import { logger } from '@/utils/core/logger';
import type { LiteSnapshot } from '../lite-types';
import type { TaskPlan, TaskPlanStep } from './task-plan-builder';

/**
 * Result of evaluating a single step
 */
export interface StepEvaluationResult {
  /** Step ID */
  stepId: string;
  /** Whether step is completed */
  completed: boolean;
  /** Progress score (0-1) */
  progressScore: number;
  /** Individual scores */
  scores: {
    url: number;
    elements: number;
    text: number;
  };
  /** Whether fail signals were detected */
  hasFailSignals: boolean;
  /** Detected fail signals */
  failSignals: string[];
  /** Details for debugging */
  details: string[];
}

/**
 * Result of evaluating plan progress
 */
export interface PlanProgressResult {
  /** Current step index */
  currentStepIndex: number;
  /** Whether current step is completed */
  stepCompleted: boolean;
  /** Progress score for current step */
  progressScore: number;
  /** Overall plan progress (0-1) */
  overallProgress: number;
  /** Whether plan is fully completed */
  planCompleted: boolean;
  /** Fail signals detected (if any) */
  failSignals: string[];
  /** Type of error if fail signals detected */
  errorType?: 'system' | 'validation';
  /** Current step evaluation */
  currentStepEval: StepEvaluationResult;
}

/**
 * Transient state detection result
 */
export interface TransientStateResult {
  /** Whether page is in transient state (loading) */
  isTransient: boolean;
  /** Type of transient indicator */
  type?: 'progressbar' | 'aria-busy' | 'aria-live' | 'loading-text' | 'spinner';
  /** Element ref of transient indicator */
  ref?: string;
}

/**
 * PlanProgressEvaluator
 */
export class PlanProgressEvaluator {
  private testId: string;
  private plan: TaskPlan;
  private currentStepIndex: number = 0;
  private lastKnownGoodUrl: string = '';

  /** Weights for progress calculation */
  private static readonly WEIGHTS = {
    url: 0.5,
    elements: 0.3,
    text: 0.2,
  };

  /** Threshold for step completion */
  private static readonly COMPLETION_THRESHOLD = 0.7;

  /** System error keywords (stop test) */
  private static readonly SYSTEM_ERROR_KEYWORDS = [
    '500', '502', '503', '504',
    'internal server error', 'server error',
    'crash', 'fatal', 'critical error',
    'service unavailable',
  ];

  /** Loading indicators for transient state detection */
  private static readonly LOADING_INDICATORS = [
    'loading', 'загрузка', 'please wait', 'подождите',
    'spinner', 'processing', 'обработка',
  ];

  constructor(testId: string, plan: TaskPlan) {
    this.testId = testId;
    this.plan = plan;
  }

  /**
   * Evaluate progress through the plan
   *
   * @param snapshot - Current page snapshot
   * @returns Progress evaluation result
   */
  evaluate(snapshot: LiteSnapshot): PlanProgressResult {
    // Store last known good URL
    if (snapshot.url && !snapshot.url.includes('error') && !snapshot.url.includes('404')) {
      this.lastKnownGoodUrl = snapshot.url;
    }

    const currentStep = this.plan.steps[this.currentStepIndex];
    if (!currentStep) {
      return this.buildCompletedResult();
    }

    // Evaluate current step
    const stepEval = this.evaluateStep(currentStep, snapshot);

    // Check for fail signals
    const { failSignals, errorType } = this.classifyFailSignals(stepEval.failSignals, snapshot);

    // Check if step is completed
    if (stepEval.completed && !stepEval.hasFailSignals) {
      // Advance to next step
      this.currentStepIndex++;
      logger.info('[PLAN_PROGRESS] Step completed, advancing', {
        testId: this.testId,
        completedStep: currentStep.id,
        newStepIndex: this.currentStepIndex,
        progressScore: stepEval.progressScore,
      });

      // Check if plan is completed
      if (this.currentStepIndex >= this.plan.steps.length) {
        return this.buildCompletedResult();
      }
    }

    return {
      currentStepIndex: this.currentStepIndex,
      stepCompleted: stepEval.completed,
      progressScore: stepEval.progressScore,
      overallProgress: this.calculateOverallProgress(),
      planCompleted: false,
      failSignals,
      errorType,
      currentStepEval: stepEval,
    };
  }

  /**
   * Evaluate a single step against snapshot
   */
  private evaluateStep(step: TaskPlanStep, snapshot: LiteSnapshot): StepEvaluationResult {
    const details: string[] = [];

    // 1. URL Match (weight 0.5)
    const urlScore = this.evaluateUrlMatch(step.expected_state.url_regex, snapshot.url);
    details.push(`URL: ${urlScore.toFixed(2)} (pattern: ${step.expected_state.url_regex})`);

    // 2. Element Match (weight 0.3) - with visibility check
    const elementScore = this.evaluateElementMatch(
      step.expected_state.success_elements,
      snapshot
    );
    details.push(`Elements: ${elementScore.toFixed(2)} (${step.expected_state.success_elements.length} selectors)`);

    // 3. Text Match (weight 0.2)
    const textScore = this.evaluateTextMatch(step.expected_state.required_text, snapshot);
    details.push(`Text: ${textScore.toFixed(2)} (${step.expected_state.required_text.length} required)`);

    // Calculate weighted score
    const progressScore =
      urlScore * PlanProgressEvaluator.WEIGHTS.url +
      elementScore * PlanProgressEvaluator.WEIGHTS.elements +
      textScore * PlanProgressEvaluator.WEIGHTS.text;

    // Check fail signals
    const detectedFailSignals = this.detectFailSignals(step.fail_signals, snapshot);
    const hasFailSignals = detectedFailSignals.length > 0;

    if (hasFailSignals) {
      details.push(`FAIL SIGNALS: ${detectedFailSignals.join(', ')}`);
    }

    const completed = progressScore >= PlanProgressEvaluator.COMPLETION_THRESHOLD && !hasFailSignals;

    logger.debug('[PLAN_PROGRESS] Step evaluation', {
      testId: this.testId,
      stepId: step.id,
      scores: { url: urlScore, elements: elementScore, text: textScore },
      progressScore,
      completed,
      hasFailSignals,
    });

    return {
      stepId: step.id,
      completed,
      progressScore,
      scores: {
        url: urlScore,
        elements: elementScore,
        text: textScore,
      },
      hasFailSignals,
      failSignals: detectedFailSignals,
      details,
    };
  }

  /**
   * Evaluate URL match against regex pattern
   */
  private evaluateUrlMatch(urlRegex: string, currentUrl: string): number {
    if (!urlRegex || urlRegex === '.*') {
      return 0.5; // Neutral score for wildcard
    }

    try {
      const regex = new RegExp(urlRegex, 'i');
      return regex.test(currentUrl) ? 1.0 : 0.0;
    } catch {
      // Fallback to simple contains check
      return currentUrl.toLowerCase().includes(urlRegex.toLowerCase()) ? 1.0 : 0.0;
    }
  }

  /**
   * Evaluate element match (success_elements)
   * Important: Only count VISIBLE elements
   */
  private evaluateElementMatch(selectors: string[], snapshot: LiteSnapshot): number {
    if (selectors.length === 0) {
      return 0.5; // Neutral score if no selectors specified
    }

    let matchCount = 0;

    for (const selector of selectors) {
      // Check if any visible element matches the selector pattern
      const hasMatch = snapshot.elements.some(el => {
        if (!el.visible) return false; // Must be visible

        // Check by various attributes
        const selectorLower = selector.toLowerCase();

        // Check data-testid
        if (selectorLower.includes('data-testid')) {
          const testId = selector.match(/data-testid=['"](.*?)['"]/)?.[1];
          if (testId && (el.name?.includes(testId) || el.context?.includes(testId))) {
            return true;
          }
        }

        // Check by tag and class (simplified)
        if (el.tag && selectorLower.includes(el.tag.toLowerCase())) {
          return true;
        }

        // Check by role
        if (el.role && selectorLower.includes(el.role.toLowerCase())) {
          return true;
        }

        return false;
      });

      if (hasMatch) matchCount++;
    }

    return matchCount / selectors.length;
  }

  /**
   * Evaluate text match (required_text)
   * Searches in element names, placeholders, and values
   */
  private evaluateTextMatch(requiredTexts: string[], snapshot: LiteSnapshot): number {
    if (requiredTexts.length === 0) {
      return 0.5; // Neutral score if no text specified
    }

    // Collect all visible text from snapshot
    const pageTexts = snapshot.elements
      .filter(el => el.visible)
      .flatMap(el => [el.name, el.placeholder, el.value, el.context].filter(Boolean))
      .join(' ')
      .toLowerCase();

    // Also include title
    const fullText = `${snapshot.title} ${pageTexts}`.toLowerCase();

    let matchCount = 0;
    for (const text of requiredTexts) {
      if (fullText.includes(text.toLowerCase())) {
        matchCount++;
      }
    }

    return matchCount / requiredTexts.length;
  }

  /**
   * Detect fail signals in snapshot
   */
  private detectFailSignals(failSignals: string[], snapshot: LiteSnapshot): string[] {
    const detected: string[] = [];

    // Collect all text
    const pageTexts = snapshot.elements
      .flatMap(el => [el.name, el.placeholder, el.value].filter(Boolean))
      .join(' ')
      .toLowerCase();

    const fullText = `${snapshot.title} ${snapshot.url} ${pageTexts}`.toLowerCase();

    for (const signal of failSignals) {
      if (fullText.includes(signal.toLowerCase())) {
        detected.push(signal);
      }
    }

    return detected;
  }

  /**
   * Classify fail signals as system error or validation error
   */
  private classifyFailSignals(
    failSignals: string[],
    snapshot: LiteSnapshot
  ): { failSignals: string[]; errorType?: 'system' | 'validation' } {
    if (failSignals.length === 0) {
      return { failSignals: [] };
    }

    // Check for system errors
    const pageText = snapshot.elements
      .flatMap(el => [el.name, el.value].filter(Boolean))
      .join(' ')
      .toLowerCase();

    const fullText = `${snapshot.title} ${pageText}`.toLowerCase();

    const hasSystemError = PlanProgressEvaluator.SYSTEM_ERROR_KEYWORDS.some(
      kw => fullText.includes(kw.toLowerCase())
    );

    return {
      failSignals,
      errorType: hasSystemError ? 'system' : 'validation',
    };
  }

  /**
   * Detect transient state (loading indicators)
   */
  detectTransientState(snapshot: LiteSnapshot): TransientStateResult {
    // Check for progressbar role
    const progressbar = snapshot.elements.find(el =>
      el.role === 'progressbar' && el.visible
    );
    if (progressbar) {
      return { isTransient: true, type: 'progressbar', ref: progressbar.ref };
    }

    // Check for loading text in element names
    for (const el of snapshot.elements) {
      if (!el.visible) continue;

      const text = `${el.name || ''} ${el.value || ''}`.toLowerCase();

      for (const indicator of PlanProgressEvaluator.LOADING_INDICATORS) {
        if (text.includes(indicator)) {
          return { isTransient: true, type: 'loading-text', ref: el.ref };
        }
      }
    }

    return { isTransient: false };
  }

  /**
   * Calculate overall plan progress
   */
  private calculateOverallProgress(): number {
    if (this.plan.steps.length === 0) return 1.0;
    return this.currentStepIndex / this.plan.steps.length;
  }

  /**
   * Build result for completed plan
   */
  private buildCompletedResult(): PlanProgressResult {
    return {
      currentStepIndex: this.plan.steps.length - 1,
      stepCompleted: true,
      progressScore: 1.0,
      overallProgress: 1.0,
      planCompleted: true,
      failSignals: [],
      currentStepEval: {
        stepId: this.plan.steps[this.plan.steps.length - 1]?.id || 'final',
        completed: true,
        progressScore: 1.0,
        scores: { url: 1, elements: 1, text: 1 },
        hasFailSignals: false,
        failSignals: [],
        details: ['Plan completed'],
      },
    };
  }

  /**
   * Get current step index
   */
  getCurrentStepIndex(): number {
    return this.currentStepIndex;
  }

  /**
   * Set current step index (for rollback)
   */
  setCurrentStepIndex(index: number): void {
    if (index >= 0 && index < this.plan.steps.length) {
      this.currentStepIndex = index;
    }
  }

  /**
   * Get last known good URL
   */
  getLastKnownGoodUrl(): string {
    return this.lastKnownGoodUrl;
  }

  /**
   * Get current step
   */
  getCurrentStep(): TaskPlanStep | null {
    return this.plan.steps[this.currentStepIndex] || null;
  }

  /**
   * Get next step
   */
  getNextStep(): TaskPlanStep | null {
    return this.plan.steps[this.currentStepIndex + 1] || null;
  }
}
