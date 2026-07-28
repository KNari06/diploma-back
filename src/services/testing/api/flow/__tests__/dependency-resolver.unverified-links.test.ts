/**
 * UNVERIFIED VARIABLE LINKS — the resolver now RETURNS the structural links it
 * could not verify (previously these were only logged, so a flow that looked
 * connected failed silently at run time). `computeUnverifiedLinks` runs AFTER the
 * variable-chain repair, so it reports the injections that SURVIVE the repair yet
 * still have no producer (auth_token with no login, api_key, base_url…) — the
 * ones the user can satisfy at run time.
 *
 * Unit-tested against the pure helper (via __testables). The prior version drove
 * the full `resolve()` through a mock of the since-removed "Architect" LLM; the
 * deterministic pipeline no longer takes that path, so those slow, handle-leaking
 * integration cases tested dead architecture.
 */

import { __testables } from '../dependency-resolver.service';
import type { DAGNode } from '../flow.types';

const { computeUnverifiedLinks } = __testables;

function node(partial: Partial<DAGNode> & { id: string; path: string }): DAGNode {
  return {
    method: 'GET', operationId: partial.id, summary: '', tags: [], dependsOn: [],
    variableExtractions: [], variableInjections: [], priority: 0, isAuthEndpoint: false,
    isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    expectedStatusCodes: [200], ...partial,
  } as unknown as DAGNode;
}

describe('computeUnverifiedLinks', () => {
  it('surfaces a no_producer link for an injected variable no call produces', () => {
    const listItems = node({
      id: 'listItems', method: 'GET', path: '/items',
      variableInjections: [{ variableName: 'api_key', injectAs: 'header', targetKey: 'X-API-Key' }],
    });
    const links = computeUnverifiedLinks([listItems]);
    const noProducer = links.filter(l => l.kind === 'no_producer');
    expect(noProducer.map(l => l.variableName)).toContain('api_key');
    expect(noProducer[0]).toMatchObject({ consumerNodeId: 'listItems', injectAs: 'header', targetKey: 'X-API-Key' });
  });

  it('reports nothing for a fully connected flow (every injection has a producer)', () => {
    const login = node({ id: 'login', method: 'POST', path: '/login', isAuthEndpoint: true, variableExtractions: [{ variableName: 'session_token', jsonPath: '$.token' }] });
    const getMe = node({
      id: 'getMe', method: 'GET', path: '/me', dependsOn: ['login'],
      variableInjections: [{ variableName: 'session_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' }],
    });
    expect(computeUnverifiedLinks([login, getMe])).toHaveLength(0);
  });

  it('does not flag an intentional multi-producer auth realm as a collision', () => {
    // register / login / refresh all extract auth_token — binding-by-reference keeps
    // them apart, so this must NOT emit name_collision noise.
    const register = node({ id: 'register', method: 'POST', path: '/auth/register', variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.accessToken' }] });
    const login = node({ id: 'login', method: 'POST', path: '/auth/login', variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.accessToken' }] });
    const me = node({ id: 'me', method: 'GET', path: '/me', variableInjections: [{ variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ', sourceNodeId: 'login' }] });
    expect(computeUnverifiedLinks([register, login, me])).toHaveLength(0);
  });

  it('de-dupes multiple producerless injections of the same var on one node', () => {
    const n = node({
      id: 'n', method: 'GET', path: '/x',
      variableInjections: [
        { variableName: 'api_key', injectAs: 'header', targetKey: 'X-API-Key' },
        { variableName: 'api_key', injectAs: 'query_param', targetKey: 'apiKey' },
      ],
    });
    // First occurrence per (var,node) wins — one link, not two.
    expect(computeUnverifiedLinks([n]).filter(l => l.variableName === 'api_key')).toHaveLength(1);
  });
});
