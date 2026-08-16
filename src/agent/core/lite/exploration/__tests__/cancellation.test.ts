/**
 * Cooperative cancellation — the stop signal folds into BudgetTracker so every
 * phase loop honours it without a second condition to keep in sync.
 */

import { BudgetTracker } from '../budget-tracker';
import type { ExplorationBudget } from '../types';

const budget = (o: Partial<ExplorationBudget> = {}): ExplorationBudget => ({
  totalTimeoutMs: 900_000,
  perFlowTimeoutMs: 180_000,
  maxSurveyPages: 10,
  maxFlows: 20,
  maxTotalPipelineRounds: 100,
  ...o,
});

describe('BudgetTracker — cancellation', () => {
  it('is not cancelled by default, and a healthy budget is not exhausted', () => {
    const b = new BudgetTracker(budget());
    expect(b.isCancelled()).toBe(false);
    expect(b.isExhausted()).toBe(false);
    expect(b.canExploreMoreFlows()).toBe(true);
    expect(b.canSurveyMorePages()).toBe(true);
  });

  it('cancel() exhausts the budget so every phase loop stops', () => {
    // The flow loops gate on isExhausted(); folding cancellation in is what
    // makes one signal stop the survey, the queue and the extra round.
    const b = new BudgetTracker(budget());
    b.cancel();
    expect(b.isCancelled()).toBe(true);
    expect(b.isExhausted()).toBe(true);
    expect(b.canExploreMoreFlows()).toBe(false);
  });

  it('cancel() also stops the survey BFS, which checks canSurveyMorePages', () => {
    // Regression: canSurveyMorePages() gated only on isTimedOut(), so a cancel
    // during Phase 1 would have crawled to the page cap before stopping.
    const b = new BudgetTracker(budget());
    expect(b.canSurveyMorePages()).toBe(true);
    b.cancel();
    expect(b.canSurveyMorePages()).toBe(false);
  });

  it('does NOT report a time-out — a cancelled run is not a timed-out run', () => {
    // The two are distinct outcomes; conflating them would mislabel the run.
    const b = new BudgetTracker(budget());
    b.cancel();
    expect(b.isTimedOut()).toBe(false);
  });

  it('is one-way and idempotent', () => {
    const b = new BudgetTracker(budget());
    b.cancel();
    b.cancel();
    expect(b.isCancelled()).toBe(true);
    expect(b.isExhausted()).toBe(true);
  });

  it('leaves remaining-budget accounting intact for the partial result', () => {
    // A cancelled run still builds and persists its partial result, so the
    // usage numbers it reports must stay truthful rather than zeroed.
    const b = new BudgetTracker(budget({ maxFlows: 20 }));
    b.cancel();
    expect(b.remainingFlows()).toBe(20);
    expect(b.remainingTimeMs()).toBeGreaterThan(0);
  });
});
