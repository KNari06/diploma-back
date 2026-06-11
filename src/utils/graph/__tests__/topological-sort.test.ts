import { topologicalSort } from '../topological-sort';
import type { ExecutableTestCase } from '@/types/testing.types';

// Helper to build minimal ExecutableTestCase fixtures
const tc = (testCaseId: string, dependsOn: string[] = []): ExecutableTestCase => ({
  testCaseId,
  testType: 'ui',
  dependsOn,
});

describe('topologicalSort', () => {
  it('returns empty result for empty input', () => {
    const result = topologicalSort([]);
    expect(result.sorted).toHaveLength(0);
    expect(result.levels).toHaveLength(0);
    expect(result.hasCycle).toBe(false);
  });

  it('handles a single test with no dependencies', () => {
    const result = topologicalSort([tc('A')]);
    expect(result.sorted.map((t) => t.testCaseId)).toEqual(['A']);
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0].map((t) => t.testCaseId)).toEqual(['A']);
    expect(result.hasCycle).toBe(false);
  });

  it('orders a linear chain A → B → C correctly', () => {
    // A must run before B which must run before C
    const result = topologicalSort([tc('C', ['B']), tc('B', ['A']), tc('A')]);
    expect(result.sorted.map((t) => t.testCaseId)).toEqual(['A', 'B', 'C']);
    expect(result.levels).toHaveLength(3);
  });

  it('groups independent tests in the same level', () => {
    // A and B have no deps; C depends on both
    const result = topologicalSort([tc('A'), tc('B'), tc('C', ['A', 'B'])]);
    expect(result.hasCycle).toBe(false);
    // Level 0 must contain A and B (order within level is not guaranteed)
    const level0Ids = result.levels[0].map((t) => t.testCaseId).sort();
    expect(level0Ids).toEqual(['A', 'B']);
    // Level 1 must contain C
    expect(result.levels[1].map((t) => t.testCaseId)).toEqual(['C']);
  });

  it('ignores external dependencies not present in the input', () => {
    // D is not in the input — treated as already satisfied
    const result = topologicalSort([tc('A', ['D']), tc('B')]);
    expect(result.hasCycle).toBe(false);
    expect(result.sorted).toHaveLength(2);
  });

  it('detects a cycle and reports hasCycle=true', () => {
    // A → B → A
    const result = topologicalSort([tc('A', ['B']), tc('B', ['A'])]);
    expect(result.hasCycle).toBe(true);
    expect(result.cycleNodes).toBeDefined();
    expect(result.cycleNodes).toContain('A');
    expect(result.cycleNodes).toContain('B');
  });

  it('returns the acyclic portion even when a cycle is detected', () => {
    // C is independent; A and B form a cycle
    const result = topologicalSort([tc('C'), tc('A', ['B']), tc('B', ['A'])]);
    expect(result.hasCycle).toBe(true);
    // C should appear in sorted since it's acyclic
    expect(result.sorted.some((t) => t.testCaseId === 'C')).toBe(true);
  });

  it('separates cycle members from nodes merely blocked by the cycle', () => {
    // A ↔ B cycle; C depends on B; D depends on C (transitive chain off the cycle)
    const result = topologicalSort([
      tc('A', ['B']),
      tc('B', ['A']),
      tc('C', ['B']),
      tc('D', ['C']),
    ]);
    expect(result.hasCycle).toBe(true);
    expect(result.cycleNodes!.sort()).toEqual(['A', 'B']);
    expect(result.blockedByCycleNodes!.sort()).toEqual(['C', 'D']);
  });

  it('reports a self-dependency as a cycle, not as blocked', () => {
    const result = topologicalSort([tc('A', ['A']), tc('B')]);
    expect(result.hasCycle).toBe(true);
    expect(result.cycleNodes).toEqual(['A']);
    expect(result.blockedByCycleNodes).toEqual([]);
  });

  it('handles two independent cycles each with their own blocked dependents', () => {
    const result = topologicalSort([
      tc('A', ['B']),
      tc('B', ['A']),
      tc('C', ['D']),
      tc('D', ['C']),
      tc('E', ['A']),
      tc('F', ['D']),
      tc('G'),
    ]);
    expect(result.hasCycle).toBe(true);
    expect(result.cycleNodes!.sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(result.blockedByCycleNodes!.sort()).toEqual(['E', 'F']);
    // the healthy node still executes
    expect(result.sorted.map((t) => t.testCaseId)).toEqual(['G']);
  });

  it('keeps a node with one healthy and one cyclic dependency in blocked, not in cycle', () => {
    // E depends on both the cycle (A) and a healthy node (G)
    const result = topologicalSort([
      tc('A', ['B']),
      tc('B', ['A']),
      tc('G'),
      tc('E', ['A', 'G']),
    ]);
    expect(result.cycleNodes!.sort()).toEqual(['A', 'B']);
    expect(result.blockedByCycleNodes).toEqual(['E']);
    expect(result.sorted.map((t) => t.testCaseId)).toEqual(['G']);
  });

  it('handles a diamond dependency graph (A → B, A → C, B → D, C → D)', () => {
    const result = topologicalSort([
      tc('A'),
      tc('B', ['A']),
      tc('C', ['A']),
      tc('D', ['B', 'C']),
    ]);
    expect(result.hasCycle).toBe(false);
    expect(result.sorted).toHaveLength(4);
    // A must come first
    expect(result.sorted[0].testCaseId).toBe('A');
    // D must come last
    expect(result.sorted[result.sorted.length - 1].testCaseId).toBe('D');
    // Level 0 = A, Level 1 = {B, C}, Level 2 = D
    expect(result.levels).toHaveLength(3);
    expect(result.levels[0].map((t) => t.testCaseId)).toEqual(['A']);
    expect(result.levels[2].map((t) => t.testCaseId)).toEqual(['D']);
  });
});
