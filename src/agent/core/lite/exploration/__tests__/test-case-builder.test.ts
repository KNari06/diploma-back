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
    // A flow that actually ran records at least one step in production; the
    // summary/persistence rule keys off steps.length > 0. Default to one real
    // step so a plain `task({...})` represents a runnable flow. Tests that need
    // an empty flow (zero-step timeout, unexplored stub) override this to [].
    discoveredSteps: [
      { stepNumber: 1, description: 'click', action: 'click', ref: 'btn', pageUrl: 'https://ex.com' },
    ],
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

  it('outcome counts match the rendered flows list (no header-vs-tabs divergence)', () => {
    // The results panel counts summary.flows; the header/card count these fields.
    // They MUST agree — passed + failed + blocked === flows.length === flowsExplored.
    const e1 = ep({ id: '1', name: 'Pass' });
    const e2 = ep({ id: '2', name: 'Fail' });
    const e3 = ep({ id: '3', name: 'Block' });
    const tasks = [
      task({ entryPoint: e1, goalAchieved: true, status: 'completed' }),
      task({ entryPoint: e2, goalAchieved: false, status: 'failed' }),
      task({
        entryPoint: e3,
        status: 'blocked',
        goalAchieved: false,
        blockedReason: 'CAPTCHA',
        blockerType: 'captcha',
      }),
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e1, e2, e3]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    const s = r.summary;
    const renderedCount = s.flows!.length;
    expect(s.flowsPassed + s.flowsFailed + s.flowsBlocked).toBe(renderedCount);
    expect(s.flowsExplored).toBe(renderedCount);
    expect(s.runnableTestCases).toBe(renderedCount);
    expect(s.flowsPassed).toBe(1);
    expect(s.flowsFailed).toBe(1);
    expect(s.flowsBlocked).toBe(1);
  });

  it('a zero-step timeout is NOT counted as failed and does not inflate the total', () => {
    // The reported bug: a timeout with no steps maps to not_explored, is dropped
    // from the rendered flows, yet the old task-based flowsFailed still counted it
    // — so header "Failed" exceeded the tab, and the card total exceeded "All (N)".
    const passing = ep({ id: '1', name: 'Pass' });
    const emptyTimeout = ep({ id: '2', name: 'Timed Out Empty' });
    const tasks = [
      task({ entryPoint: passing, goalAchieved: true, status: 'completed' }),
      task({ entryPoint: emptyTimeout, status: 'timeout', goalAchieved: false, discoveredSteps: [] }),
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([passing, emptyTimeout]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    const s = r.summary;
    // Only the passing flow is runnable/rendered.
    expect(s.flows!.length).toBe(1);
    expect(s.runnableTestCases).toBe(1);
    expect(s.flowsPassed).toBe(1);
    // The empty timeout is NOT a failure — it never produced a test.
    expect(s.flowsFailed).toBe(0);
    expect(s.flowsNotExplored).toBe(1);
    // Invariant: rendered total == sum of outcome buckets.
    expect(s.flowsPassed + s.flowsFailed + s.flowsBlocked).toBe(s.flows!.length);
  });

  it('a timeout WITH partial steps still counts as a rendered failed flow', () => {
    // Salvageable timeout — has steps, maps to failed, stays in flows.
    const e = ep({ id: '1', name: 'Partial Timeout', category: 'form_submission' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'fill', action: 'fill', ref: 'f1', value: 'x', pageUrl: 'https://ex.com' },
    ];
    const tasks = [task({ entryPoint: e, status: 'timeout', goalAchieved: false, discoveredSteps: steps })];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), tasks, mockBudget(), cfg, Date.now() - 100, []);
    const s = r.summary;
    expect(s.flows!.length).toBe(1);
    expect(s.flowsFailed).toBe(1);
    expect(s.flowsNotExplored).toBe(0);
    expect(s.runnableTestCases).toBe(1);
  });

  it('runnableTestCases excludes not_explored placeholders (panel total)', () => {
    // testCases.length includes one placeholder per unexplored entry point;
    // runnableTestCases must not — it is what the results panel's flow list
    // shows. (The history CARD reads persistedTestCases, which also counts the
    // generated negatives — see the persistence-parity block below.)
    const explored = ep({ id: '1', name: 'Explored' });
    const skipped1 = ep({ id: '2', name: 'Skipped A' });
    const skipped2 = ep({ id: '3', name: 'Skipped B' });
    const tasks = [task({ entryPoint: explored, goalAchieved: true, status: 'completed' })];
    const builder = new TestCaseBuilder();
    const r = builder.build(
      mockTree([explored, skipped1, skipped2]),
      tasks,
      mockBudget(),
      cfg,
      Date.now() - 100,
      [skipped1, skipped2],
    );
    // Raw array carries the 2 placeholders...
    expect(r.testCases.length).toBeGreaterThan(r.summary.runnableTestCases);
    // ...but the user-facing count is the single rendered flow.
    expect(r.summary.runnableTestCases).toBe(1);
    expect(r.summary.flows!.length).toBe(1);
    expect(r.summary.flowsNotExplored).toBe(2);
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

  it('summary.pages includes flow-visited URLs the survey never nodified', () => {
    // The reported bug: survey nodified only /login, but flows ran through
    // /signup, /verify-email, /forgot-password — counter showed "1 page".
    const login = ep({ id: '1', name: 'Sign in', sourcePageUrl: 'https://ex.com/login' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'nav', action: 'navigate', pageUrl: 'https://ex.com/login' },
      { stepNumber: 2, description: 'go signup', action: 'click', pageUrl: 'https://ex.com/signup' },
      { stepNumber: 3, description: 'verify', action: 'click', pageUrl: 'https://ex.com/verify-email' },
      { stepNumber: 4, description: 'forgot', action: 'click', pageUrl: 'https://ex.com/forgot-password' },
    ];
    const builder = new TestCaseBuilder();
    // Tree surveyed ONE page (/login); flows visited three more.
    const r = builder.build(mockTree([login]), [task({ entryPoint: login, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const urls = (r.summary.pages || []).map((p) => p.url);
    expect(urls).toContain('https://ex.com/login');
    expect(urls).toContain('https://ex.com/signup');
    expect(urls).toContain('https://ex.com/verify-email');
    expect(urls).toContain('https://ex.com/forgot-password');
    expect(r.summary.pages!.length).toBe(4);
    // Flow-visited pages carry the 'visited' marker; the surveyed one keeps its type.
    const signup = r.summary.pages!.find((p) => p.url.endsWith('/signup'));
    expect(signup!.pageType).toBe('visited');
  });

  it('page counting dedups query/hash and the surveyed page is not double-added', () => {
    const login = ep({ id: '1', name: 'Sign in', sourcePageUrl: 'https://ex.com/login' });
    const steps: DiscoveredStep[] = [
      // Same page as the survey node, with query + hash + trailing slash — must NOT add a row.
      { stepNumber: 1, description: 'nav', action: 'navigate', pageUrl: 'https://ex.com/login/?next=/app#form' },
      // Two variants of the same new page — must collapse to one.
      { stepNumber: 2, description: 'a', action: 'click', pageUrl: 'https://ex.com/signup?ref=a' },
      { stepNumber: 3, description: 'b', action: 'click', pageUrl: 'https://ex.com/signup?ref=b' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([login]), [task({ entryPoint: login, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    // /login (surveyed) + /signup (collapsed) = 2, not 4.
    expect(r.summary.pages!.length).toBe(2);
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

describe('TestCaseBuilder — persistence parity (reported == written)', () => {
  /**
   * Mirrors `ExplorationStorageService.saveTestCases`' gate EXACTLY: a case is
   * written iff it carries at least one step. Duplicated here on purpose — the
   * real function needs Supabase, and the whole point of these tests is to
   * catch the two rules drifting apart.
   */
  const wouldPersist = (tcs: Array<{ steps: unknown[] }>) =>
    tcs.filter((tc) => Array.isArray(tc.steps) && tc.steps.length > 0);

  it('persistedTestCases equals the number of rows saveTestCases would write', () => {
    // A form flow generates an extra negative case. It is `explored:false` so it
    // is absent from `flows`, but it HAS steps, so it persists — the divergence
    // that made the history card under-report what the project received.
    const e = ep({ id: '1', name: 'Signup', category: 'form_submission' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Filled "Email" (textbox)', action: 'fill', ref: 'email', value: 'a@b.com', pageUrl: 'https://ex.com' },
      { stepNumber: 2, description: 'Clicked "Sign up" (button)', action: 'click', ref: 'submit', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);

    expect(r.summary.negativeTestCases).toBe(1);
    expect(r.summary.runnableTestCases).toBe(1);
    // The contract: what we report written == what actually gets written.
    expect(r.summary.persistedTestCases).toBe(wouldPersist(r.testCases).length);
    expect(r.summary.persistedTestCases).toBe(2);
  });

  it('keeps negatives OUT of the explored/outcome counts — they never ran', () => {
    const e = ep({ id: '1', name: 'Login', category: 'authentication' });
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Filled "Email" (textbox)', action: 'fill', ref: 'email', value: 'a@b.com', pageUrl: 'https://ex.com' },
      { stepNumber: 2, description: 'Clicked "Log in" (button)', action: 'click', ref: 'submit', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(mockTree([e]), [task({ entryPoint: e, discoveredSteps: steps })], mockBudget(), cfg, Date.now() - 100, []);
    const s = r.summary;
    // A generated template must never be presented as a flow we verified.
    expect(s.flows!.length).toBe(1);
    expect(s.flowsExplored).toBe(1);
    expect(s.flowsPassed + s.flowsFailed + s.flowsBlocked).toBe(s.flows!.length);
    // ...nor inflate the not-explored bucket, which is about un-run FLOWS.
    expect(s.flowsNotExplored).toBe(0);
  });

  it('reports zero persisted rows when nothing runnable was produced', () => {
    // Billing and the "you were not charged" copy both gate on
    // runnableTestCases; persistedTestCases must agree that nothing was written.
    const e = ep({ id: '1', name: 'Dead', category: 'form_submission' });
    const builder = new TestCaseBuilder();
    const r = builder.build(
      mockTree([e]),
      [task({ entryPoint: e, status: 'timeout', goalAchieved: false, discoveredSteps: [] })],
      mockBudget(), cfg, Date.now() - 100, [],
    );
    expect(r.summary.runnableTestCases).toBe(0);
    expect(r.summary.negativeTestCases).toBe(0);
    expect(r.summary.persistedTestCases).toBe(0);
    expect(wouldPersist(r.testCases)).toHaveLength(0);
  });

  it('persistence parity holds across a mixed run (flows + negatives + placeholders)', () => {
    const form = ep({ id: '1', name: 'Checkout', category: 'e_commerce' });
    const nav = ep({ id: '2', name: 'Browse', category: 'navigation' });
    const unexplored = ep({ id: '3', name: 'Never Ran' });
    const formSteps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Filled "Card" (textbox)', action: 'fill', ref: 'card', value: '4242', pageUrl: 'https://ex.com' },
      { stepNumber: 2, description: 'Clicked "Pay" (button)', action: 'click', ref: 'pay', pageUrl: 'https://ex.com' },
    ];
    const builder = new TestCaseBuilder();
    const r = builder.build(
      mockTree([form, nav, unexplored]),
      [
        task({ entryPoint: form, discoveredSteps: formSteps }),
        task({ entryPoint: nav, discoveredSteps: [{ stepNumber: 1, description: 'Clicked "Home" (link)', action: 'click', ref: 'home', pageUrl: 'https://ex.com' }] }),
      ],
      mockBudget(), cfg, Date.now() - 100, [unexplored],
    );
    const s = r.summary;
    expect(s.runnableTestCases).toBe(2);   // two explored flows
    expect(s.negativeTestCases).toBe(1);   // only the e_commerce form yields one
    expect(s.persistedTestCases).toBe(3);
    expect(s.persistedTestCases).toBe(wouldPersist(r.testCases).length);
    // The placeholder is still excluded from everything that persists.
    expect(r.testCases.length).toBeGreaterThan(s.persistedTestCases);
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
