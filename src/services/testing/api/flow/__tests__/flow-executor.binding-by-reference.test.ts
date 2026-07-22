/**
 * Flow executor — binding-by-reference injection resolution (BUG 2 fix).
 *
 * An injection may name the SPECIFIC producer node it draws from (`sourceNodeId`).
 * When set, the executor reads that producer's own extracted output rather than
 * the flat, name-keyed run context — so two producers sharing a variable name
 * (user-realm + admin-realm logins both extracting `auth_token`) no longer clobber
 * each other, and each consumer gets its intended realm's value regardless of which
 * login wrote the shared slot last.
 *
 * Mocked at the WS / storage / supabase boundaries; the request builder is pure.
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

const { buildResolvedRequest } = __testables;

function node(injections: VariableInjection[], over: Partial<DAGNode> = {}): DAGNode {
  return {
    id: 'get_admin_thing',
    method: 'GET',
    path: '/admin/things',
    operationId: 'get_admin_thing',
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

const authInjection = (sourceNodeId?: string): VariableInjection => ({
  variableName: 'auth_token',
  injectAs: 'header',
  targetKey: 'Authorization',
  prefix: 'Bearer ',
  sourceNodeId,
});

describe('buildResolvedRequest — binding-by-reference', () => {
  it('reads the bound producer\'s token, not whoever wrote the shared name last', () => {
    // The user login won the shared `auth_token` slot in the flat context...
    const ctx: VariableContext = { auth_token: 'USER_TOKEN' };
    // ...but this admin endpoint is bound to the admin login's own output.
    const nodeOutputs = new Map<string, Record<string, any>>([
      ['admin_login', { auth_token: 'ADMIN_TOKEN' }],
      ['user_login', { auth_token: 'USER_TOKEN' }],
    ]);
    const n = node([authInjection('admin_login')]);

    const { resolvedHeaders } = buildResolvedRequest(n, 'https://api.test', ctx, undefined, nodeOutputs);

    expect(resolvedHeaders.Authorization).toBe('Bearer ADMIN_TOKEN');
  });

  it('falls back to the name-keyed ctx when the injection has no sourceNodeId', () => {
    const ctx: VariableContext = { auth_token: 'USER_TOKEN' };
    const nodeOutputs = new Map<string, Record<string, any>>([['admin_login', { auth_token: 'ADMIN_TOKEN' }]]);
    const n = node([authInjection(undefined)]);

    const { resolvedHeaders } = buildResolvedRequest(n, 'https://api.test', ctx, undefined, nodeOutputs);

    expect(resolvedHeaders.Authorization).toBe('Bearer USER_TOKEN');
  });

  it('falls back to ctx when the bound producer has not emitted the name yet', () => {
    const ctx: VariableContext = { auth_token: 'USER_TOKEN' };
    const nodeOutputs = new Map<string, Record<string, any>>(); // admin_login produced nothing
    const n = node([authInjection('admin_login')]);

    const { resolvedHeaders } = buildResolvedRequest(n, 'https://api.test', ctx, undefined, nodeOutputs);

    expect(resolvedHeaders.Authorization).toBe('Bearer USER_TOKEN');
  });

  it('binds a non-auth reference id to its specific producer (name-coincidence)', () => {
    // Two endpoints both produce `user_id`; the DELETE is bound to the one that
    // CREATED the user this run, not the pre-existing list value in ctx.
    const ctx: VariableContext = { user_id: 'pre-existing-42' };
    const nodeOutputs = new Map<string, Record<string, any>>([['post_users', { user_id: 'created-99' }]]);
    const n = node(
      [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'id', sourceNodeId: 'post_users' }],
      { method: 'DELETE', path: '/users/{id}' },
    );

    const { resolvedUrl } = buildResolvedRequest(n, 'https://api.test', ctx, undefined, nodeOutputs);

    expect(resolvedUrl).toBe('https://api.test/users/created-99');
  });

  it('works without a nodeOutputs argument at all (legacy call sites)', () => {
    const ctx: VariableContext = { auth_token: 'T' };
    const n = node([authInjection('admin_login')]);
    const { resolvedHeaders } = buildResolvedRequest(n, 'https://api.test', ctx);
    expect(resolvedHeaders.Authorization).toBe('Bearer T');
  });
});
