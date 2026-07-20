jest.mock('@/services/ai/core/openai.service');

import { __testables } from '../dependency-resolver.service';
import { countUnresolvedInjections } from '../eval/metrics';
import type { DAGNode } from '../flow.types';

const { runtimeProvidedVars } = __testables;

const node = (partial: Partial<DAGNode> & Pick<DAGNode, 'id' | 'method' | 'path'>): DAGNode => ({
  operationId: partial.id, tags: [], dependsOn: [], variableExtractions: [], variableInjections: [],
  priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false,
  canRunParallel: false, expectedStatusCodes: [200], ...partial,
});

describe('runtimeProvidedVars — what the user actually supplies', () => {
  it('counts vars we decided to ask for', () => {
    expect(runtimeProvidedVars([], { otp_code: '', bootstrap_city_id: '' })).toEqual(
      expect.arrayContaining(['otp_code', 'bootstrap_city_id']),
    );
  });

  it('counts run-time credential vars injected by a node', () => {
    const nodes = [
      node({ id: 'c', method: 'GET', path: '/c',
             variableInjections: [{ variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization' }] }),
    ];
    expect(runtimeProvidedVars(nodes, {})).toEqual(['auth_token']);
  });

  it('does NOT count an unproduced reference id as provided', () => {
    // The regression that made the gate unfailable: treating every injection with
    // no producer as "user-provided" makes providedVars == the unresolved set.
    const nodes = [
      node({ id: 'c', method: 'GET', path: '/c/{id}',
             variableInjections: [{ variableName: 'mystery_id', injectAs: 'path_param', targetKey: 'id' }] }),
    ];
    expect(runtimeProvidedVars(nodes, {})).toEqual([]);
  });

  it('leaves an unproduced reference id visible to the scorer', () => {
    const nodes = [
      node({ id: 'c', method: 'GET', path: '/c/{id}',
             variableInjections: [{ variableName: 'mystery_id', injectAs: 'path_param', targetKey: 'id' }] }),
    ];
    expect(countUnresolvedInjections(nodes, runtimeProvidedVars(nodes, {}))).toBe(1);
  });

  it('resolves an injection once a node produces it', () => {
    const nodes = [
      node({ id: 'p', method: 'POST', path: '/orders', variableExtractions: [{ variableName: 'order_id', jsonPath: '$.id' }] }),
      node({ id: 'c', method: 'GET', path: '/orders/{id}',
             variableInjections: [{ variableName: 'order_id', injectAs: 'path_param', targetKey: 'id' }] }),
    ];
    expect(countUnresolvedInjections(nodes, runtimeProvidedVars(nodes, {}))).toBe(0);
  });
});
