import { extractLinkedTestCaseIds, wouldCreateCycle, LinkGraphNode } from '../link-graph';

describe('extractLinkedTestCaseIds', () => {
  it('returns empty array for no steps', () => {
    expect(extractLinkedTestCaseIds(undefined)).toEqual([]);
    expect(extractLinkedTestCaseIds(null)).toEqual([]);
    expect(extractLinkedTestCaseIds([])).toEqual([]);
  });

  it('ignores non-link_test_case steps', () => {
    const steps = [{ type: 'click' }, { type: 'assert' }];
    expect(extractLinkedTestCaseIds(steps)).toEqual([]);
  });

  it('extracts linkedTestCaseId from link_test_case steps only', () => {
    const steps = [
      { type: 'click' },
      { type: 'link_test_case', options: { linkTestCase: { linkedTestCaseId: 'tc-1' } } },
      { type: 'assert' },
      { type: 'link_test_case', options: { linkTestCase: { linkedTestCaseId: 'tc-2' } } },
    ];
    expect(extractLinkedTestCaseIds(steps)).toEqual(['tc-1', 'tc-2']);
  });

  it('skips a link_test_case step missing its linkedTestCaseId', () => {
    const steps = [{ type: 'link_test_case', options: { linkTestCase: {} } }];
    expect(extractLinkedTestCaseIds(steps)).toEqual([]);
  });
});

describe('wouldCreateCycle', () => {
  const node = (id: string, dependsOn: string[] = [], linkedTestCaseIds: string[] = []): LinkGraphNode => ({
    id,
    dependsOn,
    linkedTestCaseIds,
  });

  it('returns false for an empty graph', () => {
    expect(wouldCreateCycle([], 'A', ['B'])).toBe(false);
  });

  it('returns false when the new edge does not close a loop', () => {
    // A -> B (dependsOn), adding A -> C is fine (C has no path back to A)
    const nodes = [node('A', ['B']), node('B'), node('C')];
    expect(wouldCreateCycle(nodes, 'A', ['C'])).toBe(false);
  });

  it('detects a direct cycle via dependsOn', () => {
    // B already depends on A; adding A -> B would close the loop
    const nodes = [node('A'), node('B', ['A'])];
    expect(wouldCreateCycle(nodes, 'A', ['B'])).toBe(true);
  });

  it('detects a direct cycle via link_test_case edges', () => {
    // B already links to A; adding A -> B (as a link) would close the loop
    const nodes = [node('A'), node('B', [], ['A'])];
    expect(wouldCreateCycle(nodes, 'A', ['B'])).toBe(true);
  });

  it('detects a cycle mixing dependsOn and link_test_case edges', () => {
    // A depends on B (precondition); C links to A. Adding B -> C (a link)
    // closes B -> C -> A -> B.
    const nodes = [node('A', ['B']), node('C', [], ['A'])];
    expect(wouldCreateCycle(nodes, 'B', ['C'])).toBe(true);
  });

  it('detects a transitive cycle through multiple hops', () => {
    // A -> B -> C -> D (all links). Adding D -> A closes the loop.
    const nodes = [
      node('A', [], ['B']),
      node('B', [], ['C']),
      node('C', [], ['D']),
      node('D'),
    ];
    expect(wouldCreateCycle(nodes, 'D', ['A'])).toBe(true);
  });

  it('does not flag a diamond (shared dependency, no cycle)', () => {
    // B and C both link to A; D links to both B and C. No cycle.
    const nodes = [node('A'), node('B', [], ['A']), node('C', [], ['A']), node('D')];
    expect(wouldCreateCycle(nodes, 'D', ['B', 'C'])).toBe(false);
  });
});
