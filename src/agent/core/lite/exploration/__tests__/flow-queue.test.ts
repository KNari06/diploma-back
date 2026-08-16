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
import { PerPageBudget } from '../per-page-budget';
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

  describe('unplanned budget cap', () => {
    // Regression: a "registration"-scoped run on automationexercise.com
    // discovered 181 entry points against maxFlows 30. Every unplanned one was
    // enqueued after the planned ones, so the tail crowded out the flows the
    // Strategist had actually chosen and the run produced brand-browsing tests.
    const many = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ep({ id: `${prefix}${i}`, name: `${prefix} flow ${i}` }));

    it('caps the unplanned tail at a share of maxFlows, keeping every planned flow', () => {
      const planned = many(5, 'p');
      const unplanned = many(176, 'u');
      const q = FlowQueue.fromStrategyOutput(
        [...planned, ...unplanned],
        strategy(planned.map((e, i) => ({ id: e.id, priority: i + 1 }))),
        { maxFlows: 30 },
      );
      const ids = q.remaining().map((e) => e.id);
      // All 5 planned survive, in Strategist order, at the front.
      expect(ids.slice(0, 5)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
      // Tail is trimmed to ceil(30 * 0.3) = 9, not 176.
      expect(ids.length).toBe(5 + 9);
      expect(q.unplannedDropped).toBe(176 - 9);
    });

    it('does NOT cap when the Strategist produced no plan', () => {
      // With an empty plan every entry point is "unplanned" — capping there
      // would discard the whole run rather than a discretionary tail.
      const entries = many(50, 'u');
      const q = FlowQueue.fromStrategyOutput(entries, strategy([]), { maxFlows: 30 });
      expect(q.remaining()).toHaveLength(50);
      expect(q.unplannedDropped).toBe(0);
    });

    it('keeps the old enqueue-everything behaviour when maxFlows is omitted', () => {
      const planned = many(2, 'p');
      const unplanned = many(40, 'u');
      const q = FlowQueue.fromStrategyOutput(
        [...planned, ...unplanned],
        strategy(planned.map((e, i) => ({ id: e.id, priority: i + 1 }))),
      );
      expect(q.remaining()).toHaveLength(42);
      expect(q.unplannedDropped).toBe(0);
    });

    it('does not trim when the tail already fits the share', () => {
      const planned = many(3, 'p');
      const unplanned = many(4, 'u');
      const q = FlowQueue.fromStrategyOutput(
        [...planned, ...unplanned],
        strategy(planned.map((e, i) => ({ id: e.id, priority: i + 1 }))),
        { maxFlows: 30 },
      );
      expect(q.remaining()).toHaveLength(7);
      expect(q.unplannedDropped).toBe(0);
    });
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

describe('FlowQueue — Phase 2.5 rebuild dedup (finding #5)', () => {
  const plainStrategy = (): StrategistOutput => ({
    plan: [],
    authPlan: { loginFirst: false, authGatedFlows: [] },
    continueSurvey: false,
    skipFlows: [],
    focusAreas: [],
    strategyReasoning: '',
  });

  it('excludes already-executed entry points via excludeIds', () => {
    const entries = [ep({ id: 'a', name: 'Alpha' }), ep({ id: 'b', name: 'Beta' })];
    const q = FlowQueue.fromStrategyOutput(entries, plainStrategy(), {
      excludeIds: ['a'],
    });
    expect(q.remaining().map((e) => e.id)).toEqual(['b']);
  });

  it('rejects a name-duplicate of an already-seen flow via seedDedup', () => {
    // 'a' was executed in Phase 2; a new near-identical entry should be dropped.
    const entries = [ep({ id: 'new', name: 'User Login Form' })];
    const q = FlowQueue.fromStrategyOutput(entries, plainStrategy(), {
      seedDedup: { names: ['User Login'] },
    });
    // "User Login" vs "User Login Form" → Jaccard ≥ 0.6 → rejected
    expect(q.remaining()).toHaveLength(0);
  });

  it('rejects a goal-duplicate of an already-seen flow via seedDedup', () => {
    const seenGoal = 'search the catalog for a product and verify results appear';
    const entries = [ep({ id: 'new', name: 'Catalog Search', goal: seenGoal })];
    const q = FlowQueue.fromStrategyOutput(entries, plainStrategy(), {
      seedDedup: { goals: [seenGoal] },
    });
    expect(q.remaining()).toHaveLength(0);
  });

  it('keeps genuinely new flows when seeds do not match', () => {
    const entries = [ep({ id: 'fresh', name: 'Wishlist Management' })];
    const q = FlowQueue.fromStrategyOutput(entries, plainStrategy(), {
      excludeIds: ['old'],
      seedDedup: { names: ['User Login'], goals: ['login with credentials'] },
    });
    expect(q.remaining().map((e) => e.id)).toEqual(['fresh']);
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

describe('FlowQueue — per-page fairness cap', () => {
  function drainQueue(q: FlowQueue): EntryPoint[] {
    const out: EntryPoint[] = [];
    while (true) {
      const e = q.dequeue();
      if (!e) break;
      out.push(e);
    }
    return out;
  }

  it('prefers under-cap entries even when saturated page has higher priority', () => {
    // Two page patterns: /products/:id saturated with 3 critical entries,
    // and /search (low priority) with 1 entry. With a cap of 2 per page,
    // the third /products/:id entry gets deferred in favor of /search.
    const entries = [
      ep({ id: 'p1', name: 'ProdAlpha', priority: 'critical', sourcePageUrl: 'https://shop.com/products/1' }),
      ep({ id: 'p2', name: 'ProdBeta',  priority: 'critical', sourcePageUrl: 'https://shop.com/products/2' }),
      ep({ id: 'p3', name: 'ProdGamma', priority: 'critical', sourcePageUrl: 'https://shop.com/products/3' }),
      ep({ id: 's1', name: 'SearchSigma',  priority: 'low',      sourcePageUrl: 'https://shop.com/search' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    q.setPerPageBudget(new PerPageBudget(2));

    const out = drainQueue(q);
    // First two: any two /products/:id entries (critical priority wins).
    expect(out.slice(0, 2).every((e) => e.sourcePageUrl.includes('/products/'))).toBe(true);
    // Third: /search — the saturated /products bucket was bypassed.
    expect(out[2].id).toBe('s1');
    // Fourth: the remaining /products/:id entry (dep-satisfied, saturated
    // fallback path). Saturated trace fires here.
    expect(out[3].sourcePageUrl).toContain('/products/');
  });

  it('dequeue does not deadlock when every remaining entry is saturated', () => {
    // All three entries on the same page, cap = 1.
    const entries = [
      ep({ id: 'a', name: 'FirstOnPage',  sourcePageUrl: 'https://app.com/one' }),
      ep({ id: 'b', name: 'SecondOnPage', sourcePageUrl: 'https://app.com/one' }),
      ep({ id: 'c', name: 'ThirdOnPage',  sourcePageUrl: 'https://app.com/one' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    q.setPerPageBudget(new PerPageBudget(1));

    // Saturation must not block progress entirely — we'd rather let extras
    // through than stall the whole run.
    const out = drainQueue(q);
    expect(out).toHaveLength(3);
  });

  it('emits saturation trace when a page cap is exceeded', () => {
    const events: any[] = [];
    const entries = [
      ep({ id: 'a', name: 'PageAlpha',   sourcePageUrl: 'https://app.com/x' }),
      ep({ id: 'b', name: 'PageBeta',    sourcePageUrl: 'https://app.com/x' }),
      ep({ id: 'c', name: 'OtherDelta',  sourcePageUrl: 'https://app.com/y' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    q.setPerPageBudget(new PerPageBudget(1));
    q.setSaturationTrace((data) => events.push(data));

    drainQueue(q);
    // One saturation event for whichever entry ended up being the deferred second on /x.
    expect(events).toHaveLength(1);
    expect(events[0].pageUrl).toBe('https://app.com/x');
    expect(events[0].pageFlowCount).toBeGreaterThanOrEqual(1);
  });

  it('collapses multiple numeric-id pages on the same route into one bucket', () => {
    // Both /products/123 and /products/456 normalize to /products/:id, so
    // the second one must wait until the lower-priority /category flow runs.
    const entries = [
      ep({ id: 'a', name: 'AlphaItem',  sourcePageUrl: 'https://shop.com/products/123' }),
      ep({ id: 'b', name: 'BetaItem',   sourcePageUrl: 'https://shop.com/products/456' }),
      ep({ id: 'c', name: 'CategoryNu', sourcePageUrl: 'https://shop.com/category' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    expect(q.size()).toBe(3);
    q.setPerPageBudget(new PerPageBudget(1));

    const out = drainQueue(q);
    expect(out).toHaveLength(3);

    const categoryIdx = out.findIndex((e) => e.sourcePageUrl.includes('/category'));
    const productIdxs = out
      .map((e, i) => (e.sourcePageUrl.includes('/products/') ? i : -1))
      .filter((i) => i >= 0);
    expect(productIdxs).toHaveLength(2);
    expect(productIdxs[0]).toBeLessThan(categoryIdx);
    expect(productIdxs[1]).toBeGreaterThan(categoryIdx);
  });

  it('separates :id vs :uuid route shapes into distinct buckets', () => {
    // The pattern extractor classifies numeric vs UUID tokens differently
    // (/products/:id vs /products/:uuid), so a numeric-id page and a
    // UUID-id page do NOT share a per-page cap. This is intentional —
    // /posts/:slug and /posts/:id can be semantically different routes.
    const entries = [
      ep({ id: 'a', name: 'NumericItem', sourcePageUrl: 'https://shop.com/products/123' }),
      ep({ id: 'b', name: 'UuidItem',    sourcePageUrl: 'https://shop.com/products/550e8400-e29b-41d4-a716-446655440000' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    q.setPerPageBudget(new PerPageBudget(1));

    // Both should dequeue under the cap (separate buckets).
    const first = q.dequeue();
    const second = q.dequeue();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  });

  it('no gate installed → old behavior preserved (all entries flow out in priority order)', () => {
    const entries = [
      ep({ id: 'a', name: 'FlowOneCritical',    priority: 'critical', sourcePageUrl: 'https://app.com/x' }),
      ep({ id: 'b', name: 'FlowTwoCritical',    priority: 'critical', sourcePageUrl: 'https://app.com/x' }),
      ep({ id: 'c', name: 'FlowThreeCritical',  priority: 'critical', sourcePageUrl: 'https://app.com/x' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    // No setPerPageBudget — gate disabled.
    expect(drainQueue(q)).toHaveLength(3);
  });

  it('dependency-unmet entries take precedence over saturation fallback', () => {
    // Entry b depends on "never-completes", entry a shares page with c (cap=1).
    // After a runs, c is saturated. b is dep-unsat. Dequeue should prefer c
    // (dep-ok saturated) over b (dep-unsat).
    const entries = [
      ep({ id: 'a', name: 'RootFlow',  sourcePageUrl: 'https://app.com/x' }),
      ep({ id: 'b', name: 'BlockedByDep', dependsOn: 'never-completes', sourcePageUrl: 'https://app.com/y' }),
      ep({ id: 'c', name: 'SameAsA',  sourcePageUrl: 'https://app.com/x' }),
    ];
    const q = FlowQueue.fromEntryPoints(entries);
    q.setPerPageBudget(new PerPageBudget(1));

    const first = q.dequeue();
    const second = q.dequeue();
    const third = q.dequeue();
    // First: either a or c (dep-ok, under cap) — pick whichever is highest.
    expect(['a', 'c']).toContain(first?.id);
    // Second: the other /x entry (dep-ok, saturated fallback) before b (dep-unsat).
    expect(['a', 'c']).toContain(second?.id);
    // Last: b (dep-unsat fallback).
    expect(third?.id).toBe('b');
  });
});
