/**
 * buildParallelGroups.getLevel must not overflow the stack when a cycle survives
 * cycle-breaking (regression for the RangeError crash: getLevel recursed over
 * dependsOn with no on-stack guard, and the flat-order fallback handed it cyclic
 * edges).
 */

jest.mock('@/services/ai/core/openai.service');

import { __testables } from '../dependency-resolver.service';
import type { DAGNode } from '../flow.types';

const { buildParallelGroups } = __testables;

function node(id: string, dependsOn: string[]): DAGNode {
  return {
    id, method: 'GET', path: `/${id}`, operationId: id, summary: '', tags: [],
    dependsOn, variableExtractions: [], variableInjections: [], priority: 0,
    isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false,
    canRunParallel: false, expectedStatusCodes: [200],
  } as unknown as DAGNode;
}

describe('buildParallelGroups — cycle safety', () => {
  it('does not overflow the stack on a direct 2-cycle', () => {
    const nodes = [node('a', ['b']), node('b', ['a'])];
    expect(() => buildParallelGroups(nodes, ['a', 'b'])).not.toThrow();
  });

  it('does not overflow the stack on a 3-node cycle', () => {
    const nodes = [node('a', ['c']), node('b', ['a']), node('c', ['b'])];
    let groups: string[][] = [];
    expect(() => { groups = buildParallelGroups(nodes, ['a', 'b', 'c']); }).not.toThrow();
    // every node is still placed in some level
    expect(groups.flat().sort()).toEqual(['a', 'b', 'c']);
  });

  it('still levels an acyclic graph correctly', () => {
    const nodes = [node('root', []), node('child', ['root']), node('grand', ['child'])];
    const groups = buildParallelGroups(nodes, ['root', 'child', 'grand']);
    expect(groups[0]).toEqual(['root']);
    expect(groups[1]).toEqual(['child']);
    expect(groups[2]).toEqual(['grand']);
  });
});
