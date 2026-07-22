import { __testables } from '../dependency-resolver.service';
import type { DAGNode } from '../flow.types';

const { validateVariableChain } = __testables;

const node = (partial: Partial<DAGNode> & Pick<DAGNode, 'id' | 'method' | 'path'>): DAGNode => ({
  operationId: partial.id, tags: [], dependsOn: [], variableExtractions: [], variableInjections: [],
  priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false,
  canRunParallel: false, expectedStatusCodes: [200], ...partial,
});

describe('validateVariableChain (repair, not warn-only)', () => {
  it('keeps an injection whose producer runs before the consumer', () => {
    const nodes = [
      node({ id: 'p', method: 'POST', path: '/p', variableExtractions: [{ variableName: 'order_id', jsonPath: '$.id' }] }),
      node({ id: 'c', method: 'GET', path: '/c/{id}', variableInjections: [{ variableName: 'order_id', injectAs: 'path_param', targetKey: 'id' }] }),
    ];
    const out = validateVariableChain(nodes, ['p', 'c']);
    expect(out.find(n => n.id === 'c')!.variableInjections).toHaveLength(1);
  });

  it('drops an orphan injection (no producer, not user-provided)', () => {
    const nodes = [
      node({ id: 'c', method: 'GET', path: '/c', variableInjections: [{ variableName: 'mystery_id', injectAs: 'query_param', targetKey: 'id' }] }),
    ];
    const out = validateVariableChain(nodes, ['c']);
    expect(out[0].variableInjections).toHaveLength(0);
  });

  it('keeps an orphan injection when it matches a user-provided pattern', () => {
    const nodes = [
      node({ id: 'c', method: 'GET', path: '/c', variableInjections: [{ variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' }] }),
    ];
    const out = validateVariableChain(nodes, ['c']);
    expect(out[0].variableInjections).toHaveLength(1); // user supplies auth_token at run time
  });

  it('drops an injection whose producer runs AFTER the consumer (residual cycle)', () => {
    const nodes = [
      node({ id: 'c', method: 'GET', path: '/c/{id}', variableInjections: [{ variableName: 'order_id', injectAs: 'path_param', targetKey: 'id' }] }),
      node({ id: 'p', method: 'POST', path: '/p', variableExtractions: [{ variableName: 'order_id', jsonPath: '$.id' }] }),
    ];
    const out = validateVariableChain(nodes, ['c', 'p']); // consumer before producer
    expect(out.find(n => n.id === 'c')!.variableInjections).toHaveLength(0);
  });

  it('grades a bound injection on ITS producer, keeping it when the same name has a later producer too', () => {
    // Two producers of `tok`: p_early (before c) and p_late (after c). The
    // injection is bound to p_early → satisfiable → kept, even though the flat
    // name-map might pick a different one.
    const nodes = [
      node({ id: 'p_early', method: 'POST', path: '/pe', variableExtractions: [{ variableName: 'tok', jsonPath: '$.t' }] }),
      node({ id: 'c', method: 'GET', path: '/c', variableInjections: [{ variableName: 'tok', injectAs: 'header', targetKey: 'X', sourceNodeId: 'p_early' }] }),
      node({ id: 'p_late', method: 'POST', path: '/pl', variableExtractions: [{ variableName: 'tok', jsonPath: '$.t' }] }),
    ];
    const out = validateVariableChain(nodes, ['p_early', 'c', 'p_late']);
    expect(out.find(n => n.id === 'c')!.variableInjections).toHaveLength(1);
  });

  it('drops a bound injection when ITS producer runs after, despite an earlier same-name producer', () => {
    // p_early (before c) also produces `tok`, but the injection is bound to
    // p_late (after c) → unsatisfiable for THAT binding → dropped.
    const nodes = [
      node({ id: 'p_early', method: 'POST', path: '/pe', variableExtractions: [{ variableName: 'tok', jsonPath: '$.t' }] }),
      node({ id: 'c', method: 'GET', path: '/c', variableInjections: [{ variableName: 'tok', injectAs: 'header', targetKey: 'X', sourceNodeId: 'p_late' }] }),
      node({ id: 'p_late', method: 'POST', path: '/pl', variableExtractions: [{ variableName: 'tok', jsonPath: '$.t' }] }),
    ];
    const out = validateVariableChain(nodes, ['p_early', 'c', 'p_late']);
    expect(out.find(n => n.id === 'c')!.variableInjections).toHaveLength(0);
  });
});
