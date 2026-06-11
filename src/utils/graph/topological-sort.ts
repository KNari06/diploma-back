import type { ExecutableTestCase, TopologicalSortResult } from '@/types/testing.types';

/**
 * Topological sort using Kahn's algorithm.
 *
 * Returns test cases grouped by execution level:
 *   Level 0 = tests with no dependencies (run first)
 *   Level 1 = tests whose dependencies are all in level 0
 *   etc.
 *
 * Dependencies pointing to test case IDs **not present** in the input array
 * are treated as external / already-satisfied and ignored.
 *
 * If the graph contains cycles, `hasCycle` is true and `cycleNodes` lists
 * the IDs that could not be ordered. The acyclic portion is still returned
 * in `sorted` and `levels`.
 */
export function topologicalSort(testCases: ExecutableTestCase[]): TopologicalSortResult {
  if (testCases.length === 0) {
    return { sorted: [], levels: [], hasCycle: false };
  }

  // Build lookup structures
  const idSet = new Set(testCases.map((tc) => tc.testCaseId));
  const tcMap = new Map<string, ExecutableTestCase>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // node → who depends on it

  for (const tc of testCases) {
    tcMap.set(tc.testCaseId, tc);
    inDegree.set(tc.testCaseId, 0);
    dependents.set(tc.testCaseId, []);
  }

  // Compute in-degrees (only for deps within the current run set)
  for (const tc of testCases) {
    const relevantDeps = (tc.dependsOn || []).filter((d) => idSet.has(d));
    inDegree.set(tc.testCaseId, relevantDeps.length);
    for (const dep of relevantDeps) {
      dependents.get(dep)!.push(tc.testCaseId);
    }
  }

  // Kahn's algorithm with level tracking
  const levels: ExecutableTestCase[][] = [];
  const sorted: ExecutableTestCase[] = [];

  // Seed: all nodes with in-degree 0
  let currentLevel = testCases.filter((tc) => inDegree.get(tc.testCaseId) === 0);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    sorted.push(...currentLevel);

    const nextLevel: ExecutableTestCase[] = [];
    for (const tc of currentLevel) {
      for (const depId of dependents.get(tc.testCaseId) || []) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) {
          nextLevel.push(tcMap.get(depId)!);
        }
      }
    }
    currentLevel = nextLevel;
  }

  // Any node with remaining in-degree > 0 is either ON a cycle or
  // (transitively) depends on one. Separate the two: a node that no
  // unordered node depends on cannot be on a cycle, so iteratively
  // peeling such "leaf" nodes leaves exactly the cycle members.
  const hasCycle = sorted.length < testCases.length;
  let cycleNodes: string[] | undefined;
  let blockedByCycleNodes: string[] | undefined;

  if (hasCycle) {
    const sortedIds = new Set(sorted.map((s) => s.testCaseId));
    const unordered = new Set(
      testCases.filter((tc) => !sortedIds.has(tc.testCaseId)).map((tc) => tc.testCaseId),
    );
    const blocked: string[] = [];

    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of unordered) {
        const hasUnorderedDependent = (dependents.get(id) || []).some((d) => unordered.has(d));
        if (!hasUnorderedDependent) {
          unordered.delete(id);
          blocked.push(id);
          peeled = true;
        }
      }
    }

    cycleNodes = [...unordered];
    blockedByCycleNodes = blocked;
  }

  return { sorted, levels, hasCycle, cycleNodes, blockedByCycleNodes };
}
