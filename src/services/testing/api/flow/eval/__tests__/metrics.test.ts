import { scoreDag, securityMapFromSpec, countOrderingViolations, hasDependencyCycle } from '../metrics';
import { FIXTURES } from '../fixtures';

describe('api-flow eval metrics', () => {
  describe('fixtures score to their pinned verdict', () => {
    for (const fx of FIXTURES) {
      it(`${fx.name}`, () => {
        const score = scoreDag({
          name: fx.name,
          nodes: fx.nodes,
          executionOrder: fx.executionOrder,
          securityByEndpoint: securityMapFromSpec(fx.spec),
          providedVars: fx.providedVars,
        });
        const e = fx.expect;
        if (e.passed !== undefined) expect(score.passed).toBe(e.passed);
        if (e.orderingViolations !== undefined) expect(score.orderingViolations).toBe(e.orderingViolations);
        if (e.unresolvedInjections !== undefined) expect(score.unresolvedInjections).toBe(e.unresolvedInjections);
        if (e.hasCycle !== undefined) expect(score.hasCycle).toBe(e.hasCycle);
        if (e.fabricatedReferenceIds !== undefined) expect(score.fabricatedReferenceIds).toBe(e.fabricatedReferenceIds);
        if (e.authCoveragePct !== undefined) expect(score.authCoverage.pct).toBe(e.authCoveragePct);
      });
    }
  });

  describe('countOrderingViolations', () => {
    it('counts one violation per consumer that runs at or before its producer', () => {
      const nodes = [
        { id: 'p', method: 'POST' as const, path: '/p', operationId: 'p', tags: [], dependsOn: [], priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false, expectedStatusCodes: [200], variableExtractions: [{ variableName: 'x' }], variableInjections: [] },
        { id: 'c', method: 'GET' as const, path: '/c', operationId: 'c', tags: [], dependsOn: [], priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false, expectedStatusCodes: [200], variableExtractions: [], variableInjections: [{ variableName: 'x', injectAs: 'query_param' as const, targetKey: 'x' }] },
      ];
      expect(countOrderingViolations(nodes, ['p', 'c'])).toBe(0); // producer first — ok
      expect(countOrderingViolations(nodes, ['c', 'p'])).toBe(1); // consumer first — violation
      expect(countOrderingViolations(nodes, ['c', 'p'], ['x'])).toBe(0); // 'x' provided — exempt
    });
  });

  describe('hasDependencyCycle', () => {
    it('is false for a DAG and true for a self-loop', () => {
      const base = { method: 'GET' as const, tags: [], variableExtractions: [], variableInjections: [], priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false, expectedStatusCodes: [200] };
      expect(hasDependencyCycle([{ ...base, id: 'a', path: '/a', operationId: 'a', dependsOn: [] }])).toBe(false);
      expect(hasDependencyCycle([{ ...base, id: 'a', path: '/a', operationId: 'a', dependsOn: ['a'] }])).toBe(true);
    });
  });
});
