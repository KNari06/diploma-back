/**
 * Preset gate — the single source for preset-gated behaviour.
 *
 * Phase 0 (product analysis) is `full`-only by product decision: `quick` is 2 min
 * TOTAL and is the self-serve onboarding path, so a phase that eats 30s before
 * Phase 1 starts is worse than no phase at all.
 *
 * The default direction is the subtle part. `preset` is `undefined` for BOTH chat
 * producers (they pass no budget and receive `DEFAULT_EXPLORATION_BUDGET`, which IS
 * the full preset), so `undefined` must read as NOT-quick. Defaulting the other way
 * would silently disable Phase 0 on every chat-initiated exploration — the most
 * common path — and nothing would fail loudly.
 */

import { isQuickPreset, EXPLORATION_PRESETS, DEFAULT_EXPLORATION_BUDGET } from '../types';

describe('isQuickPreset', () => {
  it('is true only for the quick preset', () => {
    expect(isQuickPreset('quick')).toBe(true);
  });

  it('is false for full', () => {
    expect(isQuickPreset('full')).toBe(false);
  });

  it('is false when absent — chat producers pass no preset and run on full defaults', () => {
    expect(isQuickPreset(undefined)).toBe(false);
    expect(isQuickPreset()).toBe(false);
  });
});

describe('preset budgets back the gate', () => {
  it('quick really is short enough that an extra phase would hurt', () => {
    // The whole justification for gating: 2 min total.
    expect(EXPLORATION_PRESETS.quick.totalTimeoutMs).toBe(2 * 60 * 1000);
  });

  it('full is the default budget, which is why an absent preset means full', () => {
    expect(EXPLORATION_PRESETS.full).toEqual(DEFAULT_EXPLORATION_BUDGET);
  });

  it('quick is materially smaller than full on every axis the gate cares about', () => {
    const q = EXPLORATION_PRESETS.quick;
    expect(q.totalTimeoutMs!).toBeLessThan(DEFAULT_EXPLORATION_BUDGET.totalTimeoutMs);
    expect(q.maxSurveyPages!).toBeLessThan(DEFAULT_EXPLORATION_BUDGET.maxSurveyPages);
    expect(q.maxFlows!).toBeLessThan(DEFAULT_EXPLORATION_BUDGET.maxFlows);
  });

  it('does not let a caller mutate DEFAULT_EXPLORATION_BUDGET through the preset map', () => {
    const before = DEFAULT_EXPLORATION_BUDGET.maxFlows;
    (EXPLORATION_PRESETS.full as { maxFlows?: number }).maxFlows = 999;
    expect(DEFAULT_EXPLORATION_BUDGET.maxFlows).toBe(before);
    // Restore so suite order can't leak.
    (EXPLORATION_PRESETS.full as { maxFlows?: number }).maxFlows = before;
  });
});
