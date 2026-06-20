import {
  buildTreeSummary,
  buildFlowSummaries,
  buildBlockedFlowSummaries,
  buildBudgetSummary,
  getCategoriesCovered,
  taskToFlowResult,
  getPageInsightsArray,
} from '../blackboard';

const flow = (over: Record<string, unknown> = {}) =>
  ({
    entryPointId: 'ep1',
    name: 'Login flow',
    category: 'auth',
    status: 'passed',
    goalAchieved: true,
    stepsCount: 3,
    errors: [],
    durationMs: 1000,
    ...over,
  }) as any;

describe('buildTreeSummary', () => {
  it('returns an empty summary for a null tree', () => {
    expect(buildTreeSummary(null)).toEqual({ pages: [], totalPages: 0, totalEntryPoints: 0 });
  });

  it('maps tree nodes and counts pages + entry points', () => {
    const tree = {
      getAllNodes: () => [
        { id: 'n1', url: 'https://x/a', pageType: 'list', entryPoints: [{}, {}], requiresAuth: false, depth: 0 },
        { id: 'n2', url: 'https://x/b', pageType: 'detail', entryPoints: [{}], requiresAuth: true, depth: 1 },
      ],
      getAllEntryPoints: () => [{}, {}, {}],
    } as any;
    const summary = buildTreeSummary(tree);
    expect(summary.totalPages).toBe(2);
    expect(summary.totalEntryPoints).toBe(3);
    expect(summary.pages[0]).toEqual({
      id: 'n1',
      url: 'https://x/a',
      pageType: 'list',
      entryPointCount: 2,
      requiresAuth: false,
      depth: 0,
    });
  });
});

describe('buildFlowSummaries', () => {
  it('condenses flows, deriving errorsCount from the errors array', () => {
    const summaries = buildFlowSummaries([flow({ errors: ['e1', 'e2'] })]);
    expect(summaries[0]).toMatchObject({ entryPointId: 'ep1', name: 'Login flow', errorsCount: 2 });
  });
});

describe('buildBlockedFlowSummaries', () => {
  it('keeps only blocked flows that carry a blocker type', () => {
    const result = buildBlockedFlowSummaries([
      flow({ status: 'passed' }),
      flow({ status: 'blocked', blockerType: 'captcha', blockedReason: 'hCaptcha', canUserHelp: true }),
      flow({ status: 'blocked' }), // no blockerType → excluded
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      entryPointId: 'ep1',
      name: 'Login flow',
      blockerType: 'captcha',
      reason: 'hCaptcha',
      canUserHelp: true,
    });
  });

  it('defaults reason and canUserHelp when missing', () => {
    const [r] = buildBlockedFlowSummaries([flow({ status: 'blocked', blockerType: 'login' })]);
    expect(r.reason).toBe('Unknown blocker');
    expect(r.canUserHelp).toBe(false);
  });
});

describe('buildBudgetSummary', () => {
  it('reads remaining values from the budget tracker', () => {
    const budget = {
      remainingTimeMs: () => 5000,
      remainingFlows: () => 3,
      remainingPipelineRounds: () => 2,
    } as any;
    expect(buildBudgetSummary(budget)).toEqual({
      timeRemainingMs: 5000,
      flowsRemaining: 3,
      roundsRemaining: 2,
    });
  });
});

describe('getCategoriesCovered', () => {
  it('collects unique categories but excludes skipped flows', () => {
    const bb = {
      completedFlows: [
        flow({ category: 'auth', status: 'passed' }),
        flow({ category: 'auth', status: 'failed' }),
        flow({ category: 'checkout', status: 'passed' }),
        flow({ category: 'search', status: 'skipped' }), // excluded
      ],
    } as any;
    expect(getCategoriesCovered(bb).sort()).toEqual(['auth', 'checkout']);
  });
});

describe('getPageInsightsArray', () => {
  it('returns the page insight map values as an array', () => {
    const bb = { pageInsights: new Map([['p1', { a: 1 }], ['p2', { a: 2 }]]) } as any;
    expect(getPageInsightsArray(bb)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('taskToFlowResult — status mapping', () => {
  const task = (over: Record<string, unknown> = {}) =>
    ({
      entryPoint: { id: 'ep1', name: 'Flow', category: 'auth', sourcePageUrl: 'https://x/src' },
      status: 'completed',
      goalAchieved: true,
      discoveredSteps: [{}, {}],
      durationMs: 500,
      errors: [],
      ...over,
    }) as any;

  it('maps completed + goalAchieved to passed', () => {
    expect(taskToFlowResult(task({ status: 'completed', goalAchieved: true })).status).toBe('passed');
  });

  it('maps completed without goal to failed', () => {
    expect(taskToFlowResult(task({ status: 'completed', goalAchieved: false })).status).toBe('failed');
  });

  it('preserves blocked, timeout, and skipped statuses', () => {
    expect(taskToFlowResult(task({ status: 'blocked' })).status).toBe('blocked');
    expect(taskToFlowResult(task({ status: 'timeout' })).status).toBe('timeout');
    expect(taskToFlowResult(task({ status: 'skipped' })).status).toBe('skipped');
  });

  it('maps any other status to failed', () => {
    expect(taskToFlowResult(task({ status: 'infra_error' })).status).toBe('failed');
  });

  it('derives stepsCount and falls back finalUrl to the source page', () => {
    const r = taskToFlowResult(task({ finalUrl: undefined }));
    expect(r.stepsCount).toBe(2);
    expect(r.finalUrl).toBe('https://x/src');
  });

  it('uses the captured finalUrl when present', () => {
    expect(taskToFlowResult(task({ finalUrl: 'https://x/done' })).finalUrl).toBe('https://x/done');
  });
});
