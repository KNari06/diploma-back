/**
 * Flow executor — body_json_path variable injection (pre-existing bug fix).
 *
 * buildResolvedRequest previously applied only `body_field` injections; the
 * `body_json_path` member of the VariableInjection union was accepted by the
 * dependency-resolver but silently dropped at run time. These tests prove the
 * ctx value now lands at the nested JSON path in the resolved body.
 *
 * Mocked at the WS / storage / supabase boundaries (importing the module pulls
 * them in); the request builder under test is pure.
 */

jest.mock('@/websocket/core/websocket.service');
jest.mock('../../api-test-storage.service', () => ({
  ApiTestStorageService: { saveApiTestExecution: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/db/supabase', () => {
  const chain: any = {
    insert: () => chain,
    update: () => chain,
    select: () => chain,
    eq: () => Promise.resolve({ error: null }),
    single: () => Promise.resolve({ data: { id: 'run1' }, error: null }),
  };
  return { supabaseAdmin: { from: () => chain } };
});

import { __testables } from '../flow-executor.service';
import type { DAGNode, VariableContext, VariableInjection } from '../flow.types';

const { buildResolvedRequest, setByJsonPath } = __testables;

function node(injections: VariableInjection[], over: Partial<DAGNode> = {}): DAGNode {
  return {
    id: 'post_user',
    method: 'POST',
    path: '/users',
    operationId: 'post_user',
    tags: [],
    dependsOn: [],
    variableExtractions: [],
    variableInjections: injections,
    priority: 0,
    isAuthEndpoint: false,
    isPagination: false,
    hasFileUpload: false,
    isUnsupported: false,
    canRunParallel: false,
    expectedStatusCodes: [200],
    ...over,
  } as DAGNode;
}

describe('buildResolvedRequest — body_json_path injection', () => {
  it('lands the ctx value at the nested path in the resolved body', () => {
    const injections: VariableInjection[] = [
      { variableName: 'userId', injectAs: 'body_json_path', targetKey: '$.user.id' },
    ];
    const ctx: VariableContext = { userId: 'u-123' };
    const node1 = node(injections, { sampleRequestBody: { user: { name: 'Ada' } } });

    const { resolvedBody } = buildResolvedRequest(node1, 'https://api.test', ctx);

    expect(resolvedBody).toEqual({ user: { name: 'Ada', id: 'u-123' } });
  });

  it('creates intermediate objects when the path does not exist yet', () => {
    const injections: VariableInjection[] = [
      { variableName: 'token', injectAs: 'body_json_path', targetKey: '$.auth.session.token' },
    ];
    const ctx: VariableContext = { token: 'tok-xyz' };
    const node1 = node(injections, { sampleRequestBody: { user: 'Ada' } });

    const { resolvedBody, variablesInjected } = buildResolvedRequest(node1, 'https://api.test', ctx);

    expect(resolvedBody).toEqual({ user: 'Ada', auth: { session: { token: 'tok-xyz' } } });
    expect(variablesInjected).toContain('token');
  });

  it('accepts a plain dot-path (no leading $) and builds the body from scratch', () => {
    const injections: VariableInjection[] = [
      { variableName: 'orderId', injectAs: 'body_json_path', targetKey: 'data.order.id' },
    ];
    const ctx: VariableContext = { orderId: 42 };
    // No sampleRequestBody → executor must materialize a container.
    const node1 = node(injections);

    const { resolvedBody } = buildResolvedRequest(node1, 'https://api.test', ctx);

    expect(resolvedBody).toEqual({ data: { order: { id: 42 } } });
  });

  it('still applies body_field injections alongside body_json_path', () => {
    const injections: VariableInjection[] = [
      { variableName: 'flat', injectAs: 'body_field', targetKey: 'topLevel' },
      { variableName: 'nested', injectAs: 'body_json_path', targetKey: '$.meta.trace' },
    ];
    const ctx: VariableContext = { flat: 'F', nested: 'N' };
    const node1 = node(injections, { sampleRequestBody: {} });

    const { resolvedBody } = buildResolvedRequest(node1, 'https://api.test', ctx);

    expect(resolvedBody).toEqual({ topLevel: 'F', meta: { trace: 'N' } });
  });

  it('builds a real array (not a "0"-key object) for numeric path segments', () => {
    const injections: VariableInjection[] = [
      { variableName: 'firstId', injectAs: 'body_json_path', targetKey: '$.items[0].id' },
    ];
    const ctx: VariableContext = { firstId: 'x1' };
    const { resolvedBody } = buildResolvedRequest(node(injections), 'https://api.test', ctx);
    expect(resolvedBody).toEqual({ items: [{ id: 'x1' }] });
    expect(Array.isArray((resolvedBody as any).items)).toBe(true);
  });

  it('body_field injection materializes a container when the body is absent', () => {
    const injections: VariableInjection[] = [
      { variableName: 'token', injectAs: 'body_field', targetKey: 'authToken' },
    ];
    const { resolvedBody } = buildResolvedRequest(node(injections), 'https://api.test', { token: 'T' });
    expect(resolvedBody).toEqual({ authToken: 'T' });
  });

  it('preserves the ctx value TYPE for a whole-value {{placeholder}}', () => {
    const ctx: VariableContext = { count: 5, active: true };
    const node1 = node([], { sampleRequestBody: { count: '{{count}}', active: '{{active}}', label: 'n={{count}}' } });
    const { resolvedBody } = buildResolvedRequest(node1, 'https://api.test', ctx);
    // whole-value → number/boolean kept; embedded → string-interpolated
    expect(resolvedBody).toEqual({ count: 5, active: true, label: 'n=5' });
  });

  it('skips injection when the variable is absent from ctx', () => {
    const injections: VariableInjection[] = [
      { variableName: 'missing', injectAs: 'body_json_path', targetKey: '$.user.id' },
    ];
    const node1 = node(injections, { sampleRequestBody: { user: { name: 'Ada' } } });

    const { resolvedBody, variablesInjected } = buildResolvedRequest(node1, 'https://api.test', {});

    expect(resolvedBody).toEqual({ user: { name: 'Ada' } });
    expect(variablesInjected).not.toContain('missing');
  });
});

describe('setByJsonPath', () => {
  it('supports bracket segments', () => {
    const target: Record<string, any> = {};
    setByJsonPath(target, "$.items['first'].value", 7);
    expect(target).toEqual({ items: { first: { value: 7 } } });
  });
});
