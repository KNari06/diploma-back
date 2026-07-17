/**
 * autoWireVariableDependencies — general "consumer runs after producer" wiring.
 *
 * Regression guard for the "extracted response value not used downstream" bug:
 * a node injects a variable (e.g. file_id) that another node extracts, but the
 * Architect left no dependsOn edge, so the consumer runs first and the
 * placeholder resolves to nothing.
 */

jest.mock('@/services/ai/core/openai.service');

import { __testables } from '../dependency-resolver.service';
import type { DAGNode, VariableExtraction, VariableInjection } from '../flow.types';

const { autoWireVariableDependencies } = __testables;

function node(partial: Partial<DAGNode> & { id: string }): DAGNode {
  return {
    method: 'GET', path: `/${partial.id}`, operationId: partial.id, summary: '', tags: [],
    dependsOn: [], variableExtractions: [], variableInjections: [], priority: 0,
    isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false,
    canRunParallel: false, expectedStatusCodes: [200], ...partial,
  } as unknown as DAGNode;
}

const ext = (variableName: string): VariableExtraction => ({ variableName, jsonPath: '$.id' });
const inj = (variableName: string): VariableInjection => ({ variableName, injectAs: 'path_param', targetKey: 'id' });

describe('autoWireVariableDependencies', () => {
  it('wires a consumer of an extracted var to its producer', () => {
    const upload = node({ id: 'upload', variableExtractions: [ext('file_id')] });
    const del = node({ id: 'del', variableInjections: [inj('file_id')] });
    const result = autoWireVariableDependencies([del, upload]);
    expect(result.find(n => n.id === 'del')!.dependsOn).toContain('upload');
  });

  it('leaves auth variables to the auth passes (does not wire them here)', () => {
    const login = node({ id: 'login', variableExtractions: [ext('auth_token')] });
    const call = node({ id: 'call', variableInjections: [{ variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' }] });
    const result = autoWireVariableDependencies([call, login]);
    expect(result.find(n => n.id === 'call')!.dependsOn).toHaveLength(0);
  });

  it('does not add a dependency a node already has', () => {
    const upload = node({ id: 'upload', variableExtractions: [ext('file_id')] });
    const del = node({ id: 'del', dependsOn: ['upload'], variableInjections: [inj('file_id')] });
    const input = [del, upload];
    const result = autoWireVariableDependencies(input);
    expect(result.find(n => n.id === 'del')!.dependsOn).toEqual(['upload']);
  });

  it('avoids creating a direct 2-cycle', () => {
    // producer already depends on the consumer → do not add the reverse edge.
    const producer = node({ id: 'producer', dependsOn: ['consumer'], variableExtractions: [ext('x')] });
    const consumer = node({ id: 'consumer', variableInjections: [inj('x')] });
    const result = autoWireVariableDependencies([producer, consumer]);
    expect(result.find(n => n.id === 'consumer')!.dependsOn).toHaveLength(0);
  });

  it('does not create a transitive 3-node cycle (A→B→C→A)', () => {
    // a injects x (produced by b), b injects y (by c), c injects z (by a).
    // Wiring all three would form a cycle; the last edge must be dropped.
    const a = node({ id: 'a', variableExtractions: [ext('z')], variableInjections: [inj('x')] });
    const b = node({ id: 'b', variableExtractions: [ext('x')], variableInjections: [inj('y')] });
    const c = node({ id: 'c', variableExtractions: [ext('y')], variableInjections: [inj('z')] });
    const result = autoWireVariableDependencies([a, b, c]);
    expect(result.find(n => n.id === 'a')!.dependsOn).toEqual(['b']);
    expect(result.find(n => n.id === 'b')!.dependsOn).toEqual(['c']);
    expect(result.find(n => n.id === 'c')!.dependsOn).toEqual([]); // cycle-closing edge dropped
  });

  it('is a no-op when the injected var has no producer', () => {
    const del = node({ id: 'del', variableInjections: [inj('orphan_id')] });
    const result = autoWireVariableDependencies([del]);
    expect(result.find(n => n.id === 'del')!.dependsOn).toHaveLength(0);
  });

  it('does not wire a node to itself when it both extracts and injects the same var', () => {
    const self = node({ id: 'self', variableExtractions: [ext('x')], variableInjections: [inj('x')] });
    const result = autoWireVariableDependencies([self]);
    expect(result.find(n => n.id === 'self')!.dependsOn).toHaveLength(0);
  });
});
