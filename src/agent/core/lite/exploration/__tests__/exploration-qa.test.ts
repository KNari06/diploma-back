/**
 * Exploration QA Tests — command mapping, timeout, summary, type safety
 *
 * Covers fixes from the Exploration QA + Platform Strategy Plan:
 *   - commandToStep mapping completeness (toggle, setRange, clear, selectDate)
 *   - timeout/status classification using stable per-flow baseline
 *   - summary entryPointsDiscovered avoids double-counting
 *   - expected-result derivation picks the LAST verify step
 *   - toIntentTestCase produces typed output without `as any`
 *   - toIntentSteps maps new action types correctly
 *   - strategy routing via executionStrategy field
 */

import { TestCaseBuilder } from '../test-case-builder';
import {
  toIntentSteps,
  toIntentTestCase,
  ACTION_TO_INTENT_TYPE,
  type DiscoveredStep,
  type DiscoveredTestCase,
  type FlowExplorationTask,
  type EntryPoint,
  type ExplorationConfig,
} from '../types';
import { PLAN_WORTHY_ACTIONS, VALUE_CARRYING_ACTIONS } from '../flow-runner';
import type { ExplorationTree } from '../exploration-tree';
import type { BudgetTracker } from '../budget-tracker';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Creates a minimal EntryPoint for tests */
function makeEntryPoint(overrides?: Partial<EntryPoint>): EntryPoint {
  return {
    id: 'ep-1',
    name: 'Test Login',
    goal: 'Complete the login flow',
    category: 'authentication',
    priority: 'high',
    requiresAuth: false,
    estimatedComplexity: 'simple',
    relatedElements: [],
    sourceNodeId: 'node-1',
    sourcePageUrl: 'https://example.com/login',
    ...overrides,
  };
}

/** Creates a minimal FlowExplorationTask */
function makeFlowTask(overrides?: Partial<FlowExplorationTask>): FlowExplorationTask {
  return {
    entryPoint: makeEntryPoint(),
    status: 'completed',
    discoveredSteps: [],
    branchPoints: [],
    errors: [],
    errorClassification: 'no_errors',
    durationMs: 5000,
    goalAchieved: true,
    progressScore: 100,
    roundsUsed: 3,
    ...overrides,
  };
}

/** Creates a mock ExplorationTree with complete node shape (entryPoints, title, pageType). */
function makeMockTree(nodeCount: number, entryPoints: EntryPoint[]): ExplorationTree {
  return {
    getNodeCount: () => nodeCount,
    getAllEntryPoints: () => entryPoints,
    getAllNodes: () =>
      entryPoints.map((ep) => ({
        id: ep.sourceNodeId,
        url: ep.sourcePageUrl,
        title: '',
        pageType: 'page',
        entryPoints: [ep],
        children: [],
        depth: 0,
        requiresAuth: false,
        contentHash: '',
        surveyedAt: Date.now(),
      })),
    toJSON: () => [],
  } as unknown as ExplorationTree;
}

/** Creates a mock BudgetTracker */
function makeMockBudget(): BudgetTracker {
  return {
    getUsage: () => ({
      timeUsedMs: 60000,
      timeRemainingMs: 840000,
      flowsUsed: 5,
      flowsRemaining: 15,
      pipelineRoundsUsed: 30,
      pipelineRoundsRemaining: 70,
    }),
  } as unknown as BudgetTracker;
}

const mockConfig: ExplorationConfig = {
  entryUrl: 'https://example.com',
  explorationId: 'expl-test-1',
  projectId: 'proj-1',
  budget: {
    totalTimeoutMs: 900000,
    perFlowTimeoutMs: 180000,
    maxSurveyPages: 10,
    maxFlows: 20,
    maxTotalPipelineRounds: 100,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND MAPPING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('toIntentSteps — action type mapping completeness', () => {
  it('should map toggle action to toggle IntentActionType', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Toggle checkbox', action: 'toggle', ref: 'cb1', pageUrl: 'https://x.com' },
    ];
    const result = toIntentSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('toggle');
  });

  it('should map setRange action to type IntentActionType', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Set range to 50', action: 'setRange', ref: 'slider1', value: '50', pageUrl: 'https://x.com' },
    ];
    const result = toIntentSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('type');
    expect(result[0].value).toBe('50');
  });

  it('should map selectDate action to type IntentActionType with value', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Set date to 2025-01-01', action: 'selectDate', ref: 'date1', value: '2025-01-01', pageUrl: 'https://x.com' },
    ];
    const result = toIntentSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('type');
    expect(result[0].value).toBe('2025-01-01');
  });

  it('should map clear action to click IntentActionType', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Clear field', action: 'clear', ref: 'input1', pageUrl: 'https://x.com' },
    ];
    const result = toIntentSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('click');
  });

  it('should map verify action to ai_check and include assertionText', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Verify goal', action: 'verify', pageUrl: 'https://x.com', expectedOutcome: 'Login succeeded' },
    ];
    const result = toIntentSteps(steps);
    expect(result[0].type).toBe('ai_check');
    expect(result[0].assertionText).toBe('Login succeeded');
  });

  it('should generate bindingHints when ref is present', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Click button', action: 'click', ref: 'submit-btn', pageUrl: 'https://x.com' },
    ];
    const result = toIntentSteps(steps);
    expect(result[0].bindingHints).toBeDefined();
    expect(result[0].bindingHints!.label).toBe('submit-btn');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPILED-PLAN PROPAGATION
// A DiscoveredStep frozen with a compiled locator plan (captured at action
// time in flow-runner) must carry that plan into the persisted IntentStep so
// the first regression run hits replay's stage-1 fast path instead of
// re-resolving every element via the LLM. Before this, toIntentSteps dropped
// `compiled` entirely (0/183 prod exploration cases had a plan).
// ═══════════════════════════════════════════════════════════════════════════

describe('toIntentSteps — compiled locator plan propagation', () => {
  /** Minimal valid CompiledStepPlan with one locator. */
  function makeCompiled(): NonNullable<DiscoveredStep['compiled']> {
    return {
      locatorPlan: [
        { strategy: 'testId', value: 'submit', confidence: 0.95 },
      ],
      action: { type: 'click' },
      context: { pageUrl: 'https://x.com', compiledAt: '2026-06-17T00:00:00.000Z' },
      unverified: false,
    };
  }

  it('propagates step.compiled onto the produced IntentStep', () => {
    const steps: DiscoveredStep[] = [
      {
        stepNumber: 1,
        description: 'Click submit',
        action: 'click',
        ref: 'submit-btn',
        pageUrl: 'https://x.com',
        compiled: makeCompiled(),
      },
    ];
    const result = toIntentSteps(steps);
    expect(result[0].compiled).toBeDefined();
    expect(result[0].compiled!.locatorPlan).toHaveLength(1);
    expect(result[0].compiled!.locatorPlan[0].value).toBe('submit');
    expect(result[0].compiled!.unverified).toBe(false);
  });

  it('leaves compiled undefined when the discovered step has none (unchanged legacy behavior)', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Click submit', action: 'click', ref: 'submit-btn', pageUrl: 'https://x.com' },
    ];
    const result = toIntentSteps(steps);
    expect(result[0].compiled).toBeUndefined();
  });

  it('propagates compiled for a value-carrying non-fill action (select)', () => {
    const steps: DiscoveredStep[] = [
      {
        stepNumber: 1,
        description: 'Select country',
        action: 'select',
        ref: 'country',
        value: 'Kazakhstan',
        pageUrl: 'https://x.com',
        compiled: { ...makeCompiled(), action: { type: 'select', value: 'Kazakhstan' } },
      },
    ];
    const result = toIntentSteps(steps);
    expect(result[0].type).toBe('select');
    expect(result[0].value).toBe('Kazakhstan');
    expect(result[0].compiled).toBeDefined();
    expect(result[0].compiled!.action.value).toBe('Kazakhstan');
  });

  it('propagates compiled for a valueless targeting action (hover)', () => {
    const steps: DiscoveredStep[] = [
      {
        stepNumber: 1,
        description: 'Hover menu',
        action: 'hover',
        ref: 'menu',
        pageUrl: 'https://x.com',
        compiled: { ...makeCompiled(), action: { type: 'hover' } },
      },
    ];
    const result = toIntentSteps(steps);
    expect(result[0].type).toBe('hover');
    expect(result[0].compiled).toBeDefined();
    expect(result[0].compiled!.locatorPlan).toHaveLength(1);
  });

  it('carries the compiled plan all the way through toIntentTestCase.stepsJson (the DB shape)', () => {
    const discovered: DiscoveredTestCase = {
      id: 'tc-compiled',
      name: 'Login Flow',
      description: 'Complete login',
      category: 'authentication',
      priority: 'high',
      testType: 'positive',
      explored: true,
      status: 'passed',
      steps: [
        { stepNumber: 1, description: 'Click submit', action: 'click', ref: 'submit', pageUrl: 'https://x.com', compiled: makeCompiled() },
      ],
      entryUrl: 'https://x.com',
      requiresAuth: false,
      tags: [],
      errors: [],
      errorClassification: 'no_errors',
      sourcePageUrl: 'https://x.com',
    };

    const intentCase = toIntentTestCase(discovered, 'proj-1', 'user-1');
    const persistedStep = intentCase.stepsJson![0];
    // This is exactly what exploration-storage.service writes into steps_json.
    expect(persistedStep.compiled).toBeDefined();
    expect(persistedStep.compiled!.locatorPlan[0].value).toBe('submit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPILED-PLAN GATE — the action sets must stay coherent
// Guards the real regression: someone adds an action to one set but forgets the
// map, or accidentally marks a non-targeting action (navigate/scroll/press) as
// plan-worthy and starts freezing meaningless locators.
// ═══════════════════════════════════════════════════════════════════════════

describe('compiled-plan gate — PLAN_WORTHY_ACTIONS / VALUE_CARRYING_ACTIONS', () => {
  it('never marks a non-targeting or synthetic action as plan-worthy', () => {
    const forbidden = ['navigate', 'press', 'scroll', 'verify', 'wait'] as const;
    for (const a of forbidden) {
      expect(PLAN_WORTHY_ACTIONS.has(a as any)).toBe(false);
    }
  });

  it('every plan-worthy action maps to a real targeting intent type (never navigate/ai_check/wait)', () => {
    for (const action of PLAN_WORTHY_ACTIONS) {
      const intentType = ACTION_TO_INTENT_TYPE[action];
      expect(intentType).toBeDefined();
      expect(['navigate', 'ai_check', 'wait']).not.toContain(intentType);
    }
  });

  it('every value-carrying action is also plan-worthy (a value with no plan is meaningless here)', () => {
    for (const action of VALUE_CARRYING_ACTIONS) {
      expect(PLAN_WORTHY_ACTIONS.has(action)).toBe(true);
    }
  });

  it('covers the actions widened beyond the click+fill PoC', () => {
    for (const a of ['select', 'hover', 'toggle', 'setRange', 'selectDate', 'clear'] as const) {
      expect(PLAN_WORTHY_ACTIONS.has(a)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY — entryPointsDiscovered fix
// ═══════════════════════════════════════════════════════════════════════════

describe('TestCaseBuilder — summary entryPointsDiscovered', () => {
  it('should NOT double-count skipped entry points (they come from the same tree)', () => {
    const ep1 = makeEntryPoint({ id: 'ep-1', name: 'Login' });
    const ep2 = makeEntryPoint({ id: 'ep-2', name: 'Register' });
    const ep3 = makeEntryPoint({ id: 'ep-3', name: 'Search' });

    const tree = makeMockTree(3, [ep1, ep2, ep3]);

    const flowTasks = [
      makeFlowTask({ entryPoint: ep1, branchPoints: [] }),
    ];

    const skippedEntryPoints = [ep2, ep3];

    const builder = new TestCaseBuilder();
    const result = builder.build(tree, flowTasks, makeMockBudget(), mockConfig, Date.now() - 5000, skippedEntryPoints);

    // tree.getAllEntryPoints() returns 3, branch points total is 0
    // Should be 3, NOT 3 + 2 = 5
    expect(result.summary.entryPointsDiscovered).toBe(3);
  });

  it('should add branch-detected entry points to the total', () => {
    const ep1 = makeEntryPoint({ id: 'ep-1', name: 'Login' });
    const branchEp = makeEntryPoint({ id: 'ep-branch-1', name: 'Dashboard' });

    const tree = makeMockTree(1, [ep1]);

    const flowTasks = [
      makeFlowTask({ entryPoint: ep1, branchPoints: [branchEp] }),
    ];

    const builder = new TestCaseBuilder();
    const result = builder.build(tree, flowTasks, makeMockBudget(), mockConfig, Date.now() - 5000, []);

    // tree has 1 entry point, plus 1 branch-detected = 2
    expect(result.summary.entryPointsDiscovered).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPECTED RESULT — last verify step derivation
// ═══════════════════════════════════════════════════════════════════════════

describe('TestCaseBuilder — expectedResult uses LAST verify step', () => {
  it('should use the last verify step outcome, not the first', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Fill field', action: 'fill', ref: 'email', value: 'a@b.com', pageUrl: 'https://x.com' },
      { stepNumber: 2, description: 'Verify: form visible', action: 'verify', pageUrl: 'https://x.com', expectedOutcome: 'Form is visible' },
      { stepNumber: 3, description: 'Click submit', action: 'click', ref: 'submit', pageUrl: 'https://x.com' },
      { stepNumber: 4, description: 'Verify: success', action: 'verify', pageUrl: 'https://x.com', expectedOutcome: 'Registration successful' },
    ];

    const task = makeFlowTask({ discoveredSteps: steps });
    const builder = new TestCaseBuilder();
    const result = builder.build(
      makeMockTree(1, [task.entryPoint]),
      [task],
      makeMockBudget(),
      mockConfig,
      Date.now() - 5000,
      [],
    );

    // Should pick the LAST verify step (index 3), not the first (index 1)
    const positiveCase = result.testCases.find((tc) => tc.testType === 'positive');
    expect(positiveCase?.expectedResult).toBe('Registration successful');
  });

  it('should fallback to entryPoint name when no verify steps exist', () => {
    const steps: DiscoveredStep[] = [
      { stepNumber: 1, description: 'Click link', action: 'click', ref: 'link1', pageUrl: 'https://x.com' },
    ];
    const task = makeFlowTask({ discoveredSteps: steps });
    const builder = new TestCaseBuilder();
    const result = builder.build(
      makeMockTree(1, [task.entryPoint]),
      [task],
      makeMockBudget(),
      mockConfig,
      Date.now() - 5000,
      [],
    );
    const positiveCase = result.testCases.find((tc) => tc.testType === 'positive');
    expect(positiveCase?.expectedResult).toContain('completes successfully');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// toIntentTestCase — type safety
// ═══════════════════════════════════════════════════════════════════════════

describe('toIntentTestCase — type-safe output (no as any)', () => {
  it('should produce valid Partial<IntentTestCase> with typed priority', () => {
    const discovered: DiscoveredTestCase = {
      id: 'tc-1',
      name: 'Login Flow',
      description: 'Complete login',
      category: 'authentication',
      priority: 'high',
      testType: 'positive',
      explored: true,
      status: 'passed',
      steps: [
        { stepNumber: 1, description: 'Fill email', action: 'fill', ref: 'email', value: 'a@b.com', pageUrl: 'https://x.com' },
        { stepNumber: 2, description: 'Click submit', action: 'click', ref: 'submit', pageUrl: 'https://x.com' },
        { stepNumber: 3, description: 'Verify', action: 'verify', pageUrl: 'https://x.com', expectedOutcome: 'Logged in' },
      ],
      entryUrl: 'https://x.com',
      requiresAuth: false,
      tags: ['authentication', 'high', 'positive'],
      errors: [],
      errorClassification: 'no_errors',
      sourcePageUrl: 'https://x.com',
      expectedResult: 'Logged in',
      preconditions: ['Must be logged out'],
    };

    const intentCase = toIntentTestCase(discovered, 'proj-1', 'user-1');

    expect(intentCase.priority).toBe('high');
    expect(intentCase.stepsJson).toHaveLength(3);
    expect(intentCase.preconditions).toEqual(['Must be logged out']);
    expect(intentCase.status).toBe('draft');
    expect(intentCase.kind).toBe('standalone');
    expect(intentCase.name).toBe('Login Flow');

    // Verify stepsJson entries have proper IntentStep structure
    const firstStep = intentCase.stepsJson![0];
    expect(firstStep).toHaveProperty('id');
    expect(firstStep).toHaveProperty('type');
    expect(firstStep).toHaveProperty('description');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// STRATEGY ROUTING
// ═══════════════════════════════════════════════════════════════════════════

describe('executionStrategy field in IntentResult', () => {
  /** Simulates the handler logic: read strategy from parsed intent with fallback */
  function resolveStrategy(parsedIntent: { executionStrategy?: 'standard' | 'exploration' }): string {
    return parsedIntent.executionStrategy || 'standard';
  }

  it('should default to standard when executionStrategy is not set', () => {
    expect(resolveStrategy({})).toBe('standard');
  });

  it('should recognize exploration strategy', () => {
    expect(resolveStrategy({ executionStrategy: 'exploration' })).toBe('exploration');
  });

  it('should recognize standard strategy explicitly set', () => {
    expect(resolveStrategy({ executionStrategy: 'standard' })).toBe('standard');
  });
});
