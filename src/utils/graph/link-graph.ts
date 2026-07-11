/**
 * Cycle detection over the combined `dependsOn` + `link_test_case` graph.
 *
 * `dependsOn` (precondition, always runs first) and `link_test_case` (a step
 * that runs another test case at its own position, same or cross-platform)
 * are two different edge *sources* but the same edge *semantics* for cycle
 * purposes: "X requires Y to run first/as part of it". A cycle through
 * either — or a mix of both — deadlocks a run the same way, so they're
 * checked together, not as two separate graphs.
 *
 * Pure function, no DB access — mirrors the shape of `topological-sort.ts`
 * (which is also pure). Callers fetch the project's nodes and pass them in.
 */

export interface LinkGraphNode {
  id: string;
  dependsOn: string[];
  linkedTestCaseIds: string[];
}

interface StepLike {
  type?: string;
  options?: {
    linkTestCase?: {
      linkedTestCaseId?: string;
    };
  };
}

/** Scans a step array for `link_test_case` steps and returns the referenced test case IDs. */
export function extractLinkedTestCaseIds(steps: StepLike[] | null | undefined): string[] {
  const ids: string[] = [];
  for (const step of steps || []) {
    const linkedId = step?.type === 'link_test_case' ? step.options?.linkTestCase?.linkedTestCaseId : undefined;
    if (linkedId) ids.push(linkedId);
  }
  return ids;
}

/**
 * Given every node in the project (each already carrying its combined
 * dependsOn + link_test_case edges), would adding edges from `targetId` to
 * each of `newEdgeTargetIds` create a cycle?
 *
 * Same DFS-reachability shape as the existing `dependsOn`-only cycle check
 * in `saved-test-cases.controller.ts`: an edge target→dep is safe unless dep
 * can already reach target, in which case adding it closes a loop.
 */
export function wouldCreateCycle(
  nodes: LinkGraphNode[],
  targetId: string,
  newEdgeTargetIds: string[],
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, [...node.dependsOn, ...node.linkedTestCaseIds]);
  }

  const canReach = (startId: string, destId: string): boolean => {
    const stack = [startId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === destId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    return false;
  };

  return newEdgeTargetIds.some((depId) => canReach(depId, targetId));
}
