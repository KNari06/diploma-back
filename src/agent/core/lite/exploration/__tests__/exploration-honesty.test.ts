/**
 * Honesty contracts: the run must not report success it did not achieve, and an
 * outcome must survive to the row the user sees.
 *
 * Each block locks down a confirmed bug from the Aug-2026 exploration audit.
 */

import { ExplorationSentinel } from '../agents/sentinel';
import { TestCaseBuilder } from '../test-case-builder';
import type { ExplorationBlackboard } from '../agents/agent-types';
import type { EntryPoint, FlowExplorationTask } from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// Sentinel fallback score
// ═══════════════════════════════════════════════════════════════════════════

/** Reach the private fallback the AI-failure path uses. */
const fallback = (bb: Partial<ExplorationBlackboard>) =>
  (new ExplorationSentinel(bb as ExplorationBlackboard) as unknown as {
    fallbackAssessment(): { coverageScore: number; qualitySummary: string; gaps: string[]; recommendations: string[] };
  }).fallbackAssessment();

const entryPoints = (n: number): EntryPoint[] =>
  Array.from({ length: n }, (_, i) => ({ id: `ep-${i}`, category: 'other' }) as EntryPoint);

const bbWith = (discovered: number, explored: number): Partial<ExplorationBlackboard> => ({
  tree: { getAllEntryPoints: () => entryPoints(discovered) } as any,
  completedFlows: Array.from({ length: explored }, (_, i) => ({
    status: 'passed',
    category: 'other',
    entryPointId: `ep-${i}`,
  })) as any,
  budget: { isExhausted: () => false } as any,
});

describe('Sentinel fallback coverage score', () => {
  it('does NOT report 100% when discovery collapsed to a couple of entry points', () => {
    // The bug: the denominator is what we DISCOVERED, so a Cartographer parse
    // failure that yielded 2 entry points instead of 40 scored 2/2 = 100 — a
    // near-total discovery failure displayed as perfect coverage.
    const result = fallback(bbWith(2, 2));

    expect(result.coverageScore).toBeLessThanOrEqual(40);
    expect(result.coverageScore).not.toBe(100);
  });

  it('says the number is untrustworthy instead of printing a confident percentage', () => {
    const result = fallback(bbWith(2, 2));

    expect(result.qualitySummary).toMatch(/cannot be assessed reliably/i);
    expect(result.gaps.join(' ')).toMatch(/only 2 testable flow/i);
    expect(result.recommendations.join(' ')).toMatch(/entry URL|credentials/i);
  });

  it('still reports a real ratio once discovery was substantial', () => {
    const result = fallback(bbWith(10, 5));

    expect(result.coverageScore).toBe(50);
    expect(result.qualitySummary).toMatch(/Explored 5 of 10/);
  });

  it('reports 0 with an honest summary when nothing was discovered', () => {
    const result = fallback(bbWith(0, 0));

    expect(result.coverageScore).toBe(0);
    expect(result.qualitySummary).toMatch(/No entry points discovered/i);
  });

  it('never exceeds 100 when Scout pushes explored past the initial count', () => {
    const result = fallback(bbWith(6, 20));
    expect(result.coverageScore).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Outcome survives to the persisted row
// ═══════════════════════════════════════════════════════════════════════════

const task = (over: Partial<FlowExplorationTask> = {}): FlowExplorationTask =>
  ({
    entryPoint: {
      id: 'ep-1',
      name: 'Login',
      goal: 'Log in with valid credentials',
      category: 'authentication',
      priority: 'critical',
      requiresAuth: false,
      sourcePageUrl: 'https://acme.com/login',
      estimatedComplexity: 'simple',
      relatedElements: [],
    },
    status: 'completed',
    goalAchieved: true,
    discoveredSteps: [
      { stepNumber: 1, action: 'navigate', description: 'Open login', value: 'https://acme.com/login' },
    ],
    branchPoints: [],
    errors: [],
    errorClassification: 'no_errors',
    durationMs: 1000,
    progressScore: 100,
    roundsUsed: 2,
    finalUrl: 'https://acme.com/dashboard',
    ...over,
  }) as unknown as FlowExplorationTask;

/**
 * Drive `taskToTestCase` directly rather than `build()`. `build()` also needs a
 * full ExplorationTree (getAllNodes / toJSON / …), and stubbing all of it tests
 * the fake, not the mapping under examination.
 */
const buildOne = (t: FlowExplorationTask) =>
  (new TestCaseBuilder() as unknown as {
    taskToTestCase(task: FlowExplorationTask): { id: string; tags: string[] };
  }).taskToTestCase(t);

describe('exploration outcome reaches the saved row', () => {
  it('tags a passed flow so it is distinguishable after persist', () => {
    // `intent_test_cases.status` is a LIFECYCLE column (draft|published|archived),
    // so the outcome cannot live there — without an explicit tag, a passed and a
    // failed flow produced byte-identical rows.
    expect(buildOne(task()).tags).toContain('explored-passed');
  });

  it('tags a failed flow differently from a passed one', () => {
    const failed = buildOne(task({ status: 'completed', goalAchieved: false }));

    expect(failed.tags).toContain('explored-failed');
    expect(failed.tags).not.toContain('explored-passed');
  });

  it('tags a blocked flow as blocked', () => {
    const blocked = buildOne(
      task({ status: 'blocked', goalAchieved: false, blockerType: 'captcha', blockedReason: 'captcha' } as any),
    );

    expect(blocked.tags).toContain('explored-blocked');
  });
});
