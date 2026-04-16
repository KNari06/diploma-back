/**
 * FlowQueue tests — priority ordering, dedup, dependencies, checkpoints
 *
 * Covers:
 *   - Priority ordering (auth first → critical → high → medium → low)
 *   - Complexity tie-break (simple before complex)
 *   - Exact name dedup
 *   - Name similarity dedup (Jaccard ≥ 0.6)
 *   - Goal similarity dedup (Jaccard ≥ 0.5)
 *   - Dependency resolution (skip until dep complete)
 *   - Deadlock avoidance (dequeue fallback)
 *   - Strategy output ordering (AI priority)
 *   - Checkpoint roundtrip
 *   - Reorder after re-evaluation
 */

import { FlowQueue } from '../flow-queue';
import type { EntryPoint, FlowPriority, FlowComplexity, TestFlowCategory } from '../types';
import type { StrategistOutput } from '../agents/agent-types';

/**
 * Build a distinct entry point. Uses the id as a unique token in goal text
 * so each fixture has dissimilar vocabulary (avoids false-positive Jaccard dedup).
 */
function ep(overrides: Partial<EntryPoint> & { id: string; name: string }): EntryPoint {
  return {
    goal: overrides.goal ?? `unique-task-${overrides.id}-${Math.random().toString(36).slice(2, 8)} distinctive-verb-${overrides.id} random-target-${overrides.id}`,
    category: 'other' as TestFlowCategory,
    priority: 'medium' as FlowPriority,
    requiresAuth: false,
    estimatedComplexity: 'medium' as FlowComplexity,
    relatedElements: [],
    sourceNodeId: 'node-0',
    sourcePageUrl: 'https://ex.com',
    ...overrides,
  };
}

describe('FlowQueue — priority ordering', () => {
  it('orders: authentication > critical > high > medium > low', () => {
    const entries = [
      ep({ id: 'a', name: 'Alpha', priority: 'low' }),
      ep({ id: 'b', name: 'Beta', priority: 'critical' }),
      ep({ id: 'c', name: 'Gamma', category: 'authentication', priority: 'medium' }),
      ep({ id: 'd', name: 'Delta', priority: 'high' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    const order = q.remaining().map((e) => e.id);
    expect(order[0]).toBe('c'); // auth always first
    expect(order[1]).toBe('b'); // critical
    expect(order[2]).toBe('d'); // high
    expect(order[3]).toBe('a'); // low
  });

  it('tie-breaks within same priority by complexity (simple first)', () => {
    const entries = [
      ep({ id: 'a', name: 'Omega', priority: 'high', estimatedComplexity: 'complex' }),
      ep({ id: 'b', name: 'Sigma', priority: 'high', estimatedComplexity: 'simple' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    expect(q.remaining().map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('dependents score lower than independents at same priority', () => {
    const entries = [
      ep({ id: 'a', name: 'Psi', priority: 'high', dependsOn: 'x' }),
      ep({ id: 'b', name: 'Phi', priority: 'high' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    expect(q.remaining().map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('FlowQueue — deduplication', () => {
  it('dedupes exact name match (case-insensitive)', async () => {
    const q = new FlowQueue();
    await q.enqueue(ep({ id: '1', name: 'User Login' }));
    const added = await q.enqueue(ep({ id: '2', name: 'user login' }));
    expect(added).toBe(false);
    expect(q.size()).toBe(1);
  });

  it('dedupes by name similarity (Jaccard ≥ 0.6)', async () => {
    const q = new FlowQueue();
    await q.enqueue(ep({ id: '1', name: 'Submit Contact Form' }));
    const added = await q.enqueue(ep({ id: '2', name: 'Submit Contact Form Button' }));
    expect(added).toBe(false);
  });

  it('dedupes by goal similarity (Jaccard ≥ 0.5)', async () => {
    const q = new FlowQueue();
    await q.enqueue(
      ep({ id: '1', name: 'Alpha Flow', goal: 'login with email and password then verify dashboard shown' }),
    );
    // Very similar goal but different name
    const added = await q.enqueue(
      ep({ id: '2', name: 'Gamma Task', goal: 'login with email and password then verify dashboard shown' }),
    );
    expect(added).toBe(false);
  });

  it('allows distinct flows with dissimilar names and goals', async () => {
    const q = new FlowQueue();
    await q.enqueue(ep({ id: '1', name: 'User Login', goal: 'authenticate user' }));
    const added = await q.enqueue(
      ep({ id: '2', name: 'Product Search', goal: 'type query and view results' }),
    );
    expect(added).toBe(true);
    expect(q.size()).toBe(2);
  });

  it('dedup is persistent across dequeue (prevents re-enqueue of completed names)', async () => {
    const q = new FlowQueue();
    await q.enqueue(ep({ id: '1', name: 'Login' }));
    const first = q.dequeue();
    expect(first?.id).toBe('1');
    q.markCompleted('1');
    const added = await q.enqueue(ep({ id: '2', name: 'Login' }));
    expect(added).toBe(false);
  });

  it('reports dedup reason via trace callback', async () => {
    const q = new FlowQueue();
    const trace: any[] = [];
    q.setDedupTrace((d) => trace.push(d));
    await q.enqueue(ep({ id: '1', name: 'Login' }));
    await q.enqueue(ep({ id: '2', name: 'Login' }));
    expect(trace).toHaveLength(1);
    expect(trace[0].reason).toBe('exact_name');
  });
});

describe('FlowQueue — dependencies', () => {
  it('defers entries with unmet dependencies', () => {
    const entries = [
      ep({ id: 'a', name: 'First', priority: 'high' }),
      ep({ id: 'b', name: 'Second', priority: 'critical', dependsOn: 'a' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    // b is critical, should be first by score — but dependency deferral
    const first = q.dequeue();
    expect(first?.id).toBe('a');
  });

  it('unblocks dependent once dependency is marked completed', () => {
    const entries = [
      ep({ id: 'a', name: 'Anchor' }),
      ep({ id: 'b', name: 'Rider', dependsOn: 'a' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    const first = q.dequeue();
    expect(first?.id).toBe('a');
    q.markCompleted('a');
    const second = q.dequeue();
    expect(second?.id).toBe('b');
  });

  it('avoids deadlock: returns first entry if ALL have unmet deps', () => {
    const entries = [
      ep({ id: 'a', name: 'Orphan', dependsOn: 'missing-x' }),
      ep({ id: 'b', name: 'Dangling', dependsOn: 'missing-y' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    // Should not return null — that would deadlock the runner
    const first = q.dequeue();
    expect(first).not.toBeNull();
  });

  it('dequeue returns null only when queue is truly empty', () => {
    const q = new FlowQueue();
    expect(q.dequeue()).toBeNull();
    expect(q.isEmpty()).toBe(true);
  });
});

describe('FlowQueue — Strategist-driven ordering', () => {
  const strategy = (plan: Array<{ id: string; priority: number; dependsOn?: string }>): StrategistOutput => ({
    plan: plan.map((p) => ({
      entryPointId: p.id,
      name: '',
      priority: p.priority,
      reason: '',
      dependsOn: p.dependsOn,
    })),
    authPlan: { loginFirst: false, authGatedFlows: [] },
    continueSurvey: false,
    skipFlows: [],
    focusAreas: [],
    strategyReasoning: '',
  });

  it('respects Strategist priority order over default score', () => {
    const entries = [
      ep({ id: 'a', name: 'Zeta', priority: 'critical' }),
      ep({ id: 'b', name: 'Iota', priority: 'low' }),
    ];
    // Strategist says b first, a second
    const q = FlowQueue.fromStrategyOutput(
      entries,
      strategy([{ id: 'b', priority: 1 }, { id: 'a', priority: 2 }]),
    );
    expect(q.remaining().map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('excludes flows marked as skip by Strategist', () => {
    const entries = [ep({ id: 'a', name: 'Kappa' }), ep({ id: 'b', name: 'Lambda' })];
    const out: StrategistOutput = {
      plan: [{ entryPointId: 'a', name: '', priority: 1, reason: '' }],
      authPlan: { loginFirst: false, authGatedFlows: [] },
      continueSurvey: false,
      skipFlows: [{ id: 'b', reason: 'redundant' }],
      focusAreas: [],
      strategyReasoning: '',
    };
    const q = FlowQueue.fromStrategyOutput(entries, out);
    expect(q.remaining().map((e) => e.id)).toEqual(['a']);
  });

  it('appends unplanned entries after planned ones', () => {
    const entries = [
      ep({ id: 'a', name: 'Xi' }),
      ep({ id: 'b', name: 'Mu' }),
      ep({ id: 'c', name: 'Nu' }),
    ];
    const q = FlowQueue.fromStrategyOutput(
      entries,
      strategy([{ id: 'c', priority: 1 }]),
    );
    const order = q.remaining().map((e) => e.id);
    expect(order[0]).toBe('c');
    expect(order.slice(1).sort()).toEqual(['a', 'b']);
  });

  it('applies Strategist-specified dependsOn overrides', () => {
    const entries = [ep({ id: 'a', name: 'Rho' }), ep({ id: 'b', name: 'Tau' })];
    const q = FlowQueue.fromStrategyOutput(
      entries,
      strategy([
        { id: 'a', priority: 1 },
        { id: 'b', priority: 2, dependsOn: 'a' },
      ]),
    );
    // b should defer until a completes
    expect(q.dequeue()?.id).toBe('a');
  });
});

describe('FlowQueue — reorder', () => {
  it('moves planned entries to front in Strategist order', () => {
    const q = FlowQueue.fromEntryPoints([
      ep({ id: 'a', name: 'Upsilon' }),
      ep({ id: 'b', name: 'Chi' }),
      ep({ id: 'c', name: 'Omicron' }),
    ]);
    q.reorder(
      [{ entryPointId: 'c', name: '', priority: 1, reason: '' }, { entryPointId: 'a', name: '', priority: 2, reason: '' }],
    );
    const ids = q.remaining().map((e) => e.id);
    expect(ids[0]).toBe('c');
    expect(ids[1]).toBe('a');
  });

  it('removes skipped entries during reorder', () => {
    const q = FlowQueue.fromEntryPoints([
      ep({ id: 'a', name: 'Eta' }),
      ep({ id: 'b', name: 'Theta' }),
    ]);
    q.reorder([{ entryPointId: 'a', name: '', priority: 1, reason: '' }], ['b']);
    expect(q.remaining().map((e) => e.id)).toEqual(['a']);
  });
});

describe('FlowQueue — checkpoint', () => {
  it('roundtrips queue state', async () => {
    const q = new FlowQueue();
    await q.enqueue(ep({ id: '1', name: 'CheckpointAlpha' }));
    await q.enqueue(ep({ id: '2', name: 'CheckpointBeta' }));
    q.dequeue();
    q.markCompleted('1');

    const cp = q.toCheckpoint();
    const restored = FlowQueue.fromCheckpoint(cp);

    expect(restored.isCompleted('1')).toBe(true);
    expect(restored.size()).toBe(1);
    // Dedup state preserved — re-adding "CheckpointAlpha" should fail
    const added = await restored.enqueue(ep({ id: '3', name: 'CheckpointAlpha' }));
    expect(added).toBe(false);
  });

  it('handles legacy checkpoint without allNames field', () => {
    const cp = {
      queue: [ep({ id: '1', name: 'X' })],
      completed: [],
      allGoals: [['1', 'goal for X']] as Array<[string, string]>,
      // allNames intentionally omitted to test backward compat
    };
    const q = FlowQueue.fromCheckpoint(cp as any);
    expect(q.size()).toBe(1);
  });
});

describe('FlowQueue — concurrent enqueue', () => {
  it('serializes concurrent enqueues without corrupting state', async () => {
    const q = new FlowQueue();
    // Use single-token distinct names so name-similarity dedup doesn't reject them
    const uniqueNames = [
      'Archer', 'Baker', 'Cabinet', 'Dolphin', 'Emerald', 'Falcon', 'Garnet', 'Hurricane',
      'Iris', 'Jaguar', 'Kestrel', 'Lantern', 'Mosaic', 'Nebula', 'Orchid', 'Panther',
      'Quantum', 'Raven', 'Saffron', 'Turbine',
    ];
    const batch = uniqueNames.map((name, i) =>
      q.enqueue(ep({ id: `e-${i}`, name })),
    );
    const results = await Promise.all(batch);
    expect(results.every((r) => r === true)).toBe(true);
    expect(q.size()).toBe(uniqueNames.length);
  });

  it('dedups even under concurrent enqueue', async () => {
    const q = new FlowQueue();
    const batch = Array.from({ length: 10 }, (_, i) =>
      q.enqueue(ep({ id: `id-${i}`, name: 'DuplicateName' })),
    );
    const results = await Promise.all(batch);
    const accepted = results.filter(Boolean).length;
    expect(accepted).toBe(1);
    expect(q.size()).toBe(1);
  });
});
