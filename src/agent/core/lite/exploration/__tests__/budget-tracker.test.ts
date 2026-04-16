/**
 * BudgetTracker tests — exhaustion checks, concurrent reservation, checkpoint
 */

import { BudgetTracker } from '../budget-tracker';
import type { ExplorationBudget } from '../types';

const defaultBudget: ExplorationBudget = {
  totalTimeoutMs: 15 * 60 * 1000,
  perFlowTimeoutMs: 3 * 60 * 1000,
  maxSurveyPages: 10,
  maxFlows: 20,
  maxTotalPipelineRounds: 100,
};

describe('BudgetTracker — exhaustion', () => {
  it('reports not-exhausted when fresh', () => {
    const b = new BudgetTracker(defaultBudget);
    expect(b.isExhausted()).toBe(false);
    expect(b.canExploreMoreFlows()).toBe(true);
    expect(b.canSurveyMorePages()).toBe(true);
  });

  it('reports exhausted when flows max reached', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 2 });
    await b.reserveFlowSlot();
    await b.reserveFlowSlot();
    expect(b.isExhausted()).toBe(true);
    expect(b.canExploreMoreFlows()).toBe(false);
  });

  it('reports exhausted when pipeline rounds max reached', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxTotalPipelineRounds: 10 });
    await b.recordFlowRounds(10);
    expect(b.isExhausted()).toBe(true);
  });

  it('reportsTimedOut based on totalTimeoutMs elapsed', () => {
    const b = new BudgetTracker({ ...defaultBudget, totalTimeoutMs: 1 });
    // Wait past timeout
    const spin = Date.now();
    while (Date.now() - spin < 5) { /* spin */ }
    expect(b.isTimedOut()).toBe(true);
  });
});

describe('BudgetTracker — remaining', () => {
  it('reports remaining flows correctly', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 5 });
    expect(b.remainingFlows()).toBe(5);
    await b.reserveFlowSlot();
    expect(b.remainingFlows()).toBe(4);
  });

  it('remainingFlows clamps at 0 (never negative)', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 1 });
    await b.reserveFlowSlot();
    // Even if somehow called again
    await b.recordFlowRounds(0);
    expect(b.remainingFlows()).toBeGreaterThanOrEqual(0);
  });

  it('roundsPerFlow divides evenly with floor, min 5, max 10', () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 10, maxTotalPipelineRounds: 30 });
    // 30 / 10 = 3, but min is 5
    expect(b.roundsPerFlow()).toBe(5);
  });

  it('roundsPerFlow caps at 10', () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 2, maxTotalPipelineRounds: 100 });
    // 100 / 2 = 50, but max is 10
    expect(b.roundsPerFlow()).toBe(10);
  });

  it('roundsPerFlow returns at least 1 when no flows remaining', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 1 });
    await b.reserveFlowSlot();
    // Now remaining = 0; method should still return something sensible
    expect(b.roundsPerFlow()).toBeGreaterThanOrEqual(1);
  });

  it('effectiveFlowTimeoutMs returns min of perFlow and remainingTime', () => {
    const b = new BudgetTracker({
      ...defaultBudget,
      perFlowTimeoutMs: 3 * 60 * 1000,
      totalTimeoutMs: 30_000, // tiny total
    });
    expect(b.effectiveFlowTimeoutMs()).toBeLessThanOrEqual(30_000);
  });
});

describe('BudgetTracker — reserveFlowSlot concurrency', () => {
  it('does not over-reserve when called concurrently', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 3 });
    const results = await Promise.all([
      b.reserveFlowSlot(),
      b.reserveFlowSlot(),
      b.reserveFlowSlot(),
      b.reserveFlowSlot(),
      b.reserveFlowSlot(),
    ]);
    const reserved = results.filter(Boolean).length;
    expect(reserved).toBe(3);
  });

  it('rejects reservation when timed out', async () => {
    const b = new BudgetTracker({ ...defaultBudget, totalTimeoutMs: 1 });
    const spin = Date.now();
    while (Date.now() - spin < 5) { /* spin */ }
    const reserved = await b.reserveFlowSlot();
    expect(reserved).toBe(false);
  });
});

describe('BudgetTracker — usage report', () => {
  it('reports accurate usage after operations', async () => {
    const b = new BudgetTracker({ ...defaultBudget, maxFlows: 10, maxTotalPipelineRounds: 50 });
    await b.reserveFlowSlot();
    await b.recordFlowRounds(5);
    const u = b.getUsage();
    expect(u.flowsUsed).toBe(1);
    expect(u.flowsRemaining).toBe(9);
    expect(u.pipelineRoundsUsed).toBe(5);
    expect(u.pipelineRoundsRemaining).toBe(45);
    expect(u.timeUsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('BudgetTracker — checkpoint roundtrip', () => {
  it('preserves completed flows and rounds', async () => {
    const b = new BudgetTracker(defaultBudget);
    await b.reserveFlowSlot();
    await b.reserveFlowSlot();
    await b.recordFlowRounds(12);
    await b.recordPageSurvey();

    const cp = b.toCheckpoint();
    const restored = BudgetTracker.fromCheckpoint(defaultBudget, cp);

    const u = restored.getUsage();
    expect(u.flowsUsed).toBe(2);
    expect(u.pipelineRoundsUsed).toBe(12);
  });

  it('preserves elapsed time across checkpoint (via startTime)', async () => {
    const b = new BudgetTracker({ ...defaultBudget, totalTimeoutMs: 60_000 });
    const cp = b.toCheckpoint();
    // Simulate some time passing
    await new Promise((r) => setTimeout(r, 10));
    const restored = BudgetTracker.fromCheckpoint({ ...defaultBudget, totalTimeoutMs: 60_000 }, cp);
    // Restored has the original startTime, so remainingTime should reflect elapsed
    expect(restored.remainingTimeMs()).toBeLessThan(60_000);
  });
});

describe('BudgetTracker — degradation', () => {
  it('tracks degraded targets independently', async () => {
    const b = new BudgetTracker(defaultBudget);
    expect(b.isTargetDegraded('openai')).toBe(false);
    await b.markDegraded('openai');
    expect(b.isTargetDegraded('openai')).toBe(true);
    expect(b.isTargetDegraded('target_site')).toBe(false);
  });
});
