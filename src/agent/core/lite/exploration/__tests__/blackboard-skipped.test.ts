/**
 * Skipped flows must stay 'skipped' through the blackboard, never collapse into
 * 'failed' — otherwise budget-exhausted flows inflate coverage and pollute the
 * Sentinel's failure/risk view. (Audit finding #1.)
 */

import { taskToFlowResult, getCategoriesCovered } from '../agents/blackboard';
import type { ExplorationBlackboard } from '../agents/agent-types';
import type { EntryPoint, FlowExplorationTask, FlowExplorationStatus, TestFlowCategory } from '../types';

function ep(id: string, category: TestFlowCategory): EntryPoint {
  return {
    id,
    name: `flow-${id}`,
    goal: `goal ${id}`,
    category,
    priority: 'medium',
    requiresAuth: false,
    estimatedComplexity: 'medium',
    relatedElements: [],
    sourceNodeId: 'n',
    sourcePageUrl: 'https://ex.com',
  };
}

function task(entryPoint: EntryPoint, status: FlowExplorationStatus, goalAchieved = false): FlowExplorationTask {
  return {
    entryPoint,
    status,
    discoveredSteps: [],
    branchPoints: [],
    errors: [],
    errorClassification: 'no_errors',
    durationMs: 0,
    goalAchieved,
    progressScore: 0,
    roundsUsed: 0,
  };
}

describe('blackboard — skipped flow handling (finding #1)', () => {
  it('maps a skipped task to status "skipped", not "failed"', () => {
    const result = taskToFlowResult(task(ep('a', 'search'), 'skipped'));
    expect(result.status).toBe('skipped');
  });

  it('still maps a genuinely failed task to "failed"', () => {
    const result = taskToFlowResult(task(ep('b', 'search'), 'failed'));
    expect(result.status).toBe('failed');
  });

  it('maps completed+goalAchieved to "passed", completed without goal to "failed"', () => {
    expect(taskToFlowResult(task(ep('c', 'search'), 'completed', true)).status).toBe('passed');
    expect(taskToFlowResult(task(ep('d', 'search'), 'completed', false)).status).toBe('failed');
  });

  it('does NOT count a skipped flow as covered category', () => {
    const bb = {
      completedFlows: [
        taskToFlowResult(task(ep('a', 'authentication'), 'completed', true)),
        taskToFlowResult(task(ep('b', 'search'), 'skipped')),
      ],
    } as unknown as ExplorationBlackboard;

    const covered = getCategoriesCovered(bb);
    expect(covered).toContain('authentication');
    expect(covered).not.toContain('search');
  });
});
