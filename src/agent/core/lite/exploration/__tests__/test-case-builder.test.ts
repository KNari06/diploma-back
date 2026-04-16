/**
 * TestCaseBuilder — summary correctness, status mapping, negative generation,
 * edge cases, robustness against incomplete upstream data
 */

import { TestCaseBuilder } from '../test-case-builder';
import type {
  DiscoveredStep,
  EntryPoint,
  ExplorationConfig,
  FlowExplorationTask,
  FlowPriority,
  FlowComplexity,
  TestFlowCategory,
} from '../types';
import type { ExplorationTree } from '../exploration-tree';
import type { BudgetTracker } from '../budget-tracker';

function ep(overrides: Partial<EntryPoint> & { id: string; name: string; category?: TestFlowCategory }): EntryPoint {
  return {
    goal: overrides.goal ?? `goal for ${overrides.name}`,
    category: 'form_submission' as TestFlowCategory,
    priority: 'high' as FlowPriority,
    requiresAuth: false,
    estimatedComplexity: 'medium' as FlowComplexity,
    relatedElements: [],
    sourceNodeId: 'node-0',
    sourcePageUrl: 'https://ex.com',
    ...overrides,
  };
}

function task(overrides: Partial<FlowExplorationTask>): FlowExplorationTask {
  return {
    entryPoint: overrides.entryPoint ?? ep({ id: 'ep-1', name: 'T' }),
    status: 'completed',
    discoveredSteps: [],
    branchPoints: [],
    errors: [],
    errorClassification: 'no_errors',
    durationMs: 1000,
    goalAchieved: true,
    progressScore: 100,
    roundsUsed: 3,
    ...overrides,
  };
}

function mockTree(entryPoints: EntryPoint[]): ExplorationTree {
  return {
    getNodeCount: () => entryPoints.length,
    getAllEntryPoints: () => entryPoints,
    // Return realistic nodes — entryPoints populated, so summary does not crash
    getAllNodes: () =>
      entryPoints.map((e) => ({
        id: e.sourceNodeId,
        url: e.sourcePageUrl,
        title: '',
        pageType: 'page',
        entryPoints: [e],
        children: [],
        depth: 0,
        requiresAuth: false,
        contentHash: '',
        surveyedAt: Date.now(),
      })),
    toJSON: () => [],
  } as unknown as ExplorationTree;
}

function mockBudget(): BudgetTracker {
  return {
    getUsage: () => ({
      timeUsedMs: 60_000,
      timeRemainingMs: 840_000,
      flowsUsed: 5,
      flowsRemaining: 15,
      pipelineRoundsUsed: 30,
      pipelineRoundsRemaining: 70,
    }),
  } as unknown as BudgetTracker;
}

const cfg: ExplorationConfig = {
  entryUrl: 'https://ex.com',
  explorationId: 'expl-1',
  projectId: 'proj-1',
  budget: {
    totalTimeoutMs: 900_000,
    perFlowTimeoutMs: 180_000,
    maxSurveyPages: 10,
    maxFlows: 20,
    maxTotalPipelineRounds: 100,
  },
};

describe('TestCaseBuilder — summary counters', () => {
  it('flowsPassed counts only goalAchieved tasks', () => {
    const e1 = ep({ id: '1', name: 'A' });
    const e2 = ep({ id: '2', name: 'B' });
    const tasks = [
      task({ entryPoint: e1, goalAchieved: true }),
      task({ entryPoint: e2, goalAchieved: false, status: 'completed' }),
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e1, e2]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    expect(r.summary.flowsPassed).toBe(1);
  });

  it('completed-but-goal-not-achieved counts as failed, not orphaned', () => {
    const e = ep({ id: '1', name: 'Goal Not Reached' });
    const tasks = [task({ entryPoint: e, goalAchieved: false, status: 'completed' })];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    // It's counted as explored + failed
    expect(r.summary.flowsPassed).toBe(0);
    expect(r.summary.flowsFailed).toBe(1);
    // Should NOT count as blocked or skipped
    expect(r.summary.flowsBlocked).toBe(0);
    expect(r.summary.flowsSkipped).toBe(0);
  });

  it('flowsBlocked counts blocked tasks', () => {
    const e = ep({ id: '1', name: 'Blocked Flow' });
    const tasks = [task({
      entryPoint: e,
      status: 'blocked',
      goalAchieved: false,
      blockedReason: 'CAPTCHA',
      blockerType: 'captcha',
      canUserHelp: true,
    })];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    expect(r.summary.flowsBlocked).toBe(1);
  });

  it('flowsSkipped does NOT double-count: in-task skipped + skippedEntryPoints of same ep', () => {
    const e = ep({ id: '1', name: 'Skip Me' });
    // Skipped at runner level (createSkippedTask) + same ep also appears in queue.remaining()
    const tasks = [task({ entryPoint: e, status: 'skipped', goalAchieved: false })];
    const skippedEps = [e];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, skippedEps);
    // Should count as 1 skip, not 2
    expect(r.summary.flowsSkipped).toBe(1);
  });

  it('entryPointsDiscovered = tree count + branches, not + skipped', () => {
    const e1 = ep({ id: '1', name: 'A' });
    const e2 = ep({ id: '2', name: 'B' });
    const e3 = ep({ id: '3', name: 'C' });
    const branch = ep({ id: 'br-1', name: 'Scout Branch' });
    const tasks = [task({ entryPoint: e1, branchPoints: [branch] })];
    const builder = new TestCaseBuilder();
    const r = builder.build(
      mockTree([e1, e2, e3]),
      tasks,
      mockBudget(),
      cfg,
      Date.now() - 100,
      [e2, e3], // skipped from same tree — NOT additional discoveries
    );
    // 3 tree + 1 branch = 4, not 6
    expect(r.summary.entryPointsDiscovered).toBe(4);
  });

  it('uniquePages aggregates tree nodes and step pageUrls', () => {
    const e = ep({ id: '1', name: 'A', sourcePageUrl: 'https://ex.com/a' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'nav', action: 'navigate', pageUrl: 'https://ex.com/b' },
      { stepNumber: 2, description: 'click', action: 'click', pageUrl: 'https://ex.com/c' },
    ];
    const tasks = [task({ entryPoint: e, discoveredSteps: steps })];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    expect(r.summary.uniquePages).toBeGreaterThanOrEqual(2);
  });
});

describe('TestCaseBuilder — status mapping', () => {
  it('maps timeout status so its steps are not hidden', () => {
    const e = ep({ id: '1', name: 'T', category: 'form_submission' });
    const partialSteps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'fill', action: 'fill', ref: 'f1', value: 'x', pageUrl: 'https://ex.com' },
    ];
    const tasks = [task({
      entryPoint: e,
      status: 'timeout',
      goalAchieved: false,
      discoveredSteps: partialSteps,
    })];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    const positive = r.testCases.find((tc) => tc.testType === 'positive' && tc.id === '1');
    expect(positive).toBeDefined();
    // Timeout flows have partial steps — they should be preserved, not discarded
    expect(positive!.steps.length).toBe(1);
  });

  it('positive case preserves partial steps from blocked flow', () => {
    const e = ep({ id: '1', name: 'B' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'navigate', action: 'navigate', pageUrl: 'https://ex.com' },
      { stepNumber: 2, description: 'fill', action: 'fill', ref: 'f', value: 'v', pageUrl: 'https://ex.com' },
    ];
    const tasks = [task({
      entryPoint: e,
      status: 'blocked',
      blockedReason: 'CAPTCHA',
      blockerType: 'captcha',
      canUserHelp: true,
      discoveredSteps: steps,
      goalAchieved: false,
    })];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    const positive = r.testCases.find((tc) => tc.testType === 'positive' && tc.id === '1');
    expect(positive!.status).toBe('blocked');
    expect(positive!.steps.length).toBe(2);
    expect(positive!.blocker?.type).toBe('captcha');
    expect(positive!.name).toContain('BLOCKED');
  });
});

describe('TestCaseBuilder — negative case generation', () => {
  it('generates empty-submit case for form_submission with fill + click', () => {
    const e = ep({ id: '1', name: 'Signup', category: 'form_submission' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'fill email', action: 'fill', ref: 'email', value: 'a@b.com', pageUrl: 'https://ex.com' },
      { stepNumber: 2, description: 'fill pw', action: 'fill', ref: 'pw', value: 'x', pageUrl: 'https://ex.com', isSensitive: true },
      { stepNumber: 3, description: 'submit', action: 'click', ref: 'submit-btn', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const negative = r.testCases.find((tc) => tc.testType === 'negative' && tc.id === '1-negative-empty');
    expect(negative).toBeDefined();
    expect(negative!.steps).toHaveLength(3);
    expect(negative!.steps[1].ref).toBe('submit-btn');
    expect(negative!.tags).toContain('negative');
    expect(negative!.tags).toContain('validation');
  });

  it('skips negative case generation when no fill/select steps exist', () => {
    const e = ep({ id: '1', name: 'NoForm', category: 'navigation' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'click link', action: 'click', ref: 'link', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const negatives = r.testCases.filter((tc) => tc.testType === 'negative');
    expect(negatives).toHaveLength(0);
  });

  it('skips negative case for non-form categories even with fill steps', () => {
    const e = ep({ id: '1', name: 'Search', category: 'search' }); // search is NOT a form category
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'fill', action: 'fill', ref: 'q', value: 'x', pageUrl: 'https://ex.com' },
      { stepNumber: 2, description: 'submit', action: 'click', ref: 'go', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const negatives = r.testCases.filter((tc) => tc.testType === 'negative');
    expect(negatives).toHaveLength(0);
  });
});

describe('TestCaseBuilder — unexplored stubs', () => {
  it('creates not_explored cases for skipped entry points', () => {
    const e = ep({ id: '1', name: 'Skipped' });
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [], mockBudget(), cfg, Date.now() - 100, [e]);
    const stub = r.testCases.find((tc) => tc.id === '1' && tc.status === 'not_explored');
    expect(stub).toBeDefined();
    expect(stub!.explored).toBe(false);
    expect(stub!.tags).toContain('not-explored');
  });
});

describe('TestCaseBuilder — preconditions', () => {
  it('includes "User must be logged in" when requiresAuth', () => {
    const e = ep({ id: '1', name: 'A', requiresAuth: true });
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e })], mockBudget(), cfg, Date.now() - 100, []);
    const positive = r.testCases.find((tc) => tc.id === '1');
    expect(positive!.preconditions).toContain('User must be logged in');
  });

  it('includes source page URL in preconditions', () => {
    const e = ep({ id: '1', name: 'A', sourcePageUrl: 'https://ex.com/form' });
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e })], mockBudget(), cfg, Date.now() - 100, []);
    const positive = r.testCases.find((tc) => tc.id === '1');
    expect(positive!.preconditions?.some((p) => p.includes('https://ex.com/form'))).toBe(true);
  });
});

describe('TestCaseBuilder — network assertions', () => {
  it('aggregates step-level network calls into test-case assertions', () => {
    const e = ep({ id: 'login', name: 'LoginFlow', category: 'authentication' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'fill email', action: 'fill', ref: 'e', value: 'a@b', pageUrl: 'https://ex.com' },
      {
        stepNumber: 2, description: 'submit', action: 'click', ref: 'go', pageUrl: 'https://ex.com',
        networkCalls: [
          { method: 'POST', urlPattern: 'https://api.ex.com/v1/auth', status: 200, timestampMs: 100 },
        ],
      },
      {
        stepNumber: 3, description: 'verify', action: 'verify', pageUrl: 'https://ex.com',
        expectedOutcome: 'logged in',
        networkCalls: [
          { method: 'GET', urlPattern: 'https://api.ex.com/v1/profile', status: 200, timestampMs: 200 },
        ],
      },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const positive = r.testCases.find((tc) => tc.id === 'login');
    expect(positive?.assertions).toBeDefined();
    expect(positive!.assertions!).toHaveLength(2);
    expect(positive!.assertions![0]).toMatchObject({
      type: 'network',
      expect: 'POST https://api.ex.com/v1/auth returns 2xx',
    });
  });

  it('omits assertions field when no network calls were captured', () => {
    const e = ep({ id: '1', name: 'SilentFlow' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'click', action: 'click', ref: 'b', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const positive = r.testCases.find((tc) => tc.id === '1');
    expect(positive?.assertions).toBeUndefined();
  });

  it('does not emit assertions for skipped flows with no steps', () => {
    const e = ep({ id: '1', name: 'Skipper' });
    const builder = new TestCaseBuilder();
    const r = builder.build(
      mockTree([e]),
      [task({ entryPoint: e, status: 'skipped', goalAchieved: false, discoveredSteps: [] })],
      mockBudget(),
      cfg,
      Date.now() - 100,
      [],
    );
    const positive = r.testCases.find((tc) => tc.id === '1');
    expect(positive?.assertions).toBeUndefined();
  });
});

describe('TestCaseBuilder — robustness against incomplete node data', () => {
  it('does not crash when getAllNodes() returns nodes without entryPoints', () => {
    // Simulates a malformed tree (e.g., from stale checkpoint or incomplete mock)
    const brokenTree = {
      getNodeCount: () => 1,
      getAllEntryPoints: () => [],
      getAllNodes: () => [{ id: 'x', url: 'https://ex.com', title: 'T', pageType: 'p', depth: 0 }],
      toJSON: () => [],
    } as unknown as ExplorationTree;

    const builder = new TestCaseBuilder();
    expect(() =>
      builder.build(brokenTree, [], mockBudget(), cfg, Date.now() - 100, []),
    ).not.toThrow();
  });
});
