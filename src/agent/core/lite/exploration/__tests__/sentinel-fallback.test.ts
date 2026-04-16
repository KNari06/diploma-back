/**
 * Sentinel fallback behavior — when AI fails, fallback uses deterministic scoring
 * and must clamp to valid range + detect uncovered categories.
 */

import { ExplorationSentinel } from '../agents/sentinel';
import type { ExplorationBlackboard, FlowExecutionResult } from '../agents/agent-types';
import type { EntryPoint, TestFlowCategory } from '../types';

function ep(id: string, name: string, category: TestFlowCategory = 'other'): EntryPoint {
  return {
    id,
    name,
    goal: `goal ${name}`,
    category,
    priority: 'medium',
    requiresAuth: false,
    estimatedComplexity: 'medium',
    relatedElements: [],
    sourceNodeId: 'n',
    sourcePageUrl: 'https://ex.com',
  };
}

function flowResult(name: string, category: TestFlowCategory, goalAchieved: boolean): FlowExecutionResult {
  return {
    entryPointId: `id-${name}`,
    name,
    category,
    status: goalAchieved ? 'passed' : 'failed',
    goalAchieved,
    steps: [],
    stepsCount: 0,
    durationMs: 100,
    errors: [],
    errorClassification: 'no_errors',
    progressScore: goalAchieved ? 100 : 30,
    roundsUsed: 3,
    finalUrl: 'https://ex.com',
    rawTask: {} as any,
  };
}

function makeBlackboard(opts: {
  completedFlows?: FlowExecutionResult[];
  entryPoints?: EntryPoint[];
  budgetExhausted?: boolean;
}): ExplorationBlackboard {
  const { completedFlows = [], entryPoints = [], budgetExhausted = false } = opts;
  return {
    config: { entryUrl: 'https://ex.com', explorationId: 'e', projectId: 'p' } as any,
    explorationId: 'e',
    entryUrl: 'https://ex.com',
    scopeHint: undefined,
    hasCredentials: false,
    tree: {
      getNodeCount: () => entryPoints.length,
      getAllEntryPoints: () => entryPoints,
      getAllNodes: () => [],
    } as any,
    pageInsights: new Map(),
    queue: {
      remaining: () => [],
    } as any,
    completedFlows,
    activeFlows: new Map(),
    discoveredBranches: [],
    auth: { loginCompleted: false, loginAttempted: false, detectedLoginPages: [] },
    workingMemory: {
      visitedPages: {},
      accomplishments: [],
      categoriesExplored: new Set(),
    },
    userDirectives: [],
    budget: {
      isExhausted: () => budgetExhausted,
      remainingTimeMs: () => 60_000,
      remainingFlows: () => (budgetExhausted ? 0 : 10),
      remainingPipelineRounds: () => 50,
      getUsage: () => ({
        timeUsedMs: 0,
        timeRemainingMs: 60_000,
        flowsUsed: 0,
        flowsRemaining: 10,
        pipelineRoundsUsed: 0,
        pipelineRoundsRemaining: 50,
      }),
    } as any,
    rateLimiter: {
      acquireSlot: jest.fn().mockResolvedValue(true),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn().mockResolvedValue({ shouldRetry: false }),
      isDegraded: () => false,
    } as any,
    trace: {
      writeSentinelPrompt: jest.fn(),
      writeSentinelResponse: jest.fn(),
      writeSentinelFallback: jest.fn(),
    } as any,
    emitProgress: jest.fn(),
  } as ExplorationBlackboard;
}

// Mock the AI call to always throw — triggering the fallback path
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn().mockRejectedValue(new Error('AI unavailable')),
}));

describe('ExplorationSentinel — fallback when AI fails', () => {
  it('computes score from completed/total ratio', async () => {
    const eps = [ep('1', 'A'), ep('2', 'B'), ep('3', 'C'), ep('4', 'D')];
    const flows = [flowResult('A', 'other', true)];
    const bb = makeBlackboard({ entryPoints: eps, completedFlows: flows });
    const sentinel = new ExplorationSentinel(bb);
    const result = await sentinel.evaluate();
    // 1/4 = 25%
    expect(result.coverageScore).toBe(25);
  });

  it('clamps score to [0, 100] even when completed > total', async () => {
    // Scout-discovered branches can cause completedFlows to exceed initial tree entry points
    const eps = [ep('1', 'A')]; // only 1 in tree
    const flows = [
      flowResult('A', 'other', true),
      flowResult('Scout Branch 1', 'other', true),
      flowResult('Scout Branch 2', 'other', true),
    ];
    const bb = makeBlackboard({ entryPoints: eps, completedFlows: flows });
    const sentinel = new ExplorationSentinel(bb);
    const result = await sentinel.evaluate();
    expect(result.coverageScore).toBeLessThanOrEqual(100);
    expect(result.coverageScore).toBeGreaterThanOrEqual(0);
  });

  it('handles empty tree (score 0, no crash)', async () => {
    const bb = makeBlackboard({ entryPoints: [], completedFlows: [] });
    const sentinel = new ExplorationSentinel(bb);
    const result = await sentinel.evaluate();
    expect(result.coverageScore).toBe(0);
    expect(result.continueExploring).toBe(false);
  });

  it('does NOT recommend continuing when budget is exhausted', async () => {
    const eps = Array.from({ length: 10 }, (_, i) => ep(`${i}`, `F${i}`));
    const flows = [flowResult('F0', 'other', true)];
    const bb = makeBlackboard({ entryPoints: eps, completedFlows: flows, budgetExhausted: true });
    const sentinel = new ExplorationSentinel(bb);
    const result = await sentinel.evaluate();
    expect(result.continueExploring).toBe(false);
  });

  it('recommends continuing when score < 75 and budget allows', async () => {
    const eps = Array.from({ length: 10 }, (_, i) => ep(`${i}`, `F${i}`, 'other'));
    const flows = [flowResult('F0', 'other', true)];
    const bb = makeBlackboard({ entryPoints: eps, completedFlows: flows });
    const sentinel = new ExplorationSentinel(bb);
    const result = await sentinel.evaluate();
    expect(result.continueExploring).toBe(true);
    // Score is 10%
    expect(result.coverageScore).toBeLessThan(75);
  });

  it('identifies uncovered categories for focusNext', async () => {
    const eps = [
      ep('1', 'Login', 'authentication'),
      ep('2', 'Search', 'search'),
      ep('3', 'Checkout', 'e_commerce'),
    ];
    const flows = [flowResult('Login', 'authentication', true)];
    const bb = makeBlackboard({ entryPoints: eps, completedFlows: flows });
    const sentinel = new ExplorationSentinel(bb);
    const result = await sentinel.evaluate();
    expect(result.focusNext).toEqual(expect.arrayContaining(['search', 'e_commerce']));
    expect(result.focusNext).not.toContain('authentication');
  });
});
