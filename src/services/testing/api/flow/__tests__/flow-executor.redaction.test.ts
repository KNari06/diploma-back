/**
 * Flow executor — secret redaction at the persistence boundary (Hard invariant #10).
 *
 * A run carries live credentials in four places at once: the `Authorization`
 * header, the login request body, the login response that minted the token, and
 * `variablesExtracted[].value`. All four are persisted to `api_flow_runs.summary`
 * and `api_test_executions`. These tests pin down that none of them ships the
 * plaintext.
 */

jest.mock('@/websocket/core/websocket.service');
const saveApiTestExecution = jest.fn().mockResolvedValue(undefined);
jest.mock('../../api-test-storage.service', () => ({
  ApiTestStorageService: { saveApiTestExecution: (...a: any[]) => saveApiTestExecution(...a) },
}));
const flowRunUpdates: any[] = [];
jest.mock('@/db/supabase', () => {
  const chain: any = {
    insert: () => chain,
    update: (payload: any) => { flowRunUpdates.push(payload); return chain; },
    select: () => chain,
    eq: () => Promise.resolve({ error: null }),
    single: () => Promise.resolve({ data: { id: 'run1' }, error: null }),
  };
  return { supabaseAdmin: { from: () => chain } };
});

import { FlowExecutorService } from '../flow-executor.service';
import { FlowBuilderService } from '../flow-builder.service';
import type { ApiFlowSpec, DAGNode, ExecutionDAG } from '../flow.types';

jest.spyOn(FlowBuilderService, 'markRunStatus').mockResolvedValue(undefined as any);

const JWT = 'eyJhbGciOiJIUzI1NiJ9.super-secret-token-value.sig';

function node(id: string, over: Partial<DAGNode> = {}): DAGNode {
  return {
    id, method: 'GET', path: `/${id}`, operationId: id, tags: [], dependsOn: [],
    variableExtractions: [], variableInjections: [], priority: 0, isAuthEndpoint: false,
    isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    expectedStatusCodes: [200], ...over,
  };
}

function makeSpec(nodes: DAGNode[]): ApiFlowSpec {
  const dag: ExecutionDAG = {
    nodes, executionOrder: nodes.map(n => n.id), parallelGroups: [nodes.map(n => n.id)],
    summary: '', totalEndpoints: nodes.length, unsupportedEndpoints: [],
  };
  return {
    id: 'spec1', userId: 'u1', projectId: 'p1', name: 'test', sourceType: 'openapi_file',
    rawSpec: { servers: [{ url: 'https://api.test' }] }, executionDag: dag, variableChain: {},
    totalEndpoints: nodes.length, supportedEndpoints: nodes.length, unsupportedEndpoints: [],
    errorStrategy: 'continue_on_failure', createdAt: '', updatedAt: '',
  } as ApiFlowSpec;
}

beforeEach(() => {
  jest.clearAllMocks();
  flowRunUpdates.length = 0;
});

describe('secret redaction on persistence', () => {
  /** A protected GET that injects a user-supplied auth_token as a Bearer header. */
  const protectedFlow = () => makeSpec([
    node('getUsers', {
      variableInjections: [{ variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' }],
    }),
  ]);

  const runWithToken = () => FlowExecutorService.execute(
    protectedFlow(), 'u1', { chatSessionId: 'chat1', initialVariables: { auth_token: JWT } }, 'run1',
  );

  test('keeps the real token on the wire', async () => {
    const executeStep = jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1, requestHeaders: { Authorization: `Bearer ${JWT}` },
    });

    await runWithToken();

    // The point of redaction is that it applies to sinks, NOT to the request.
    expect((executeStep.mock.calls[0][2] as any).Authorization).toBe(`Bearer ${JWT}`);
  });

  test('does not persist the token in the run summary', async () => {
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1,
      requestHeaders: { Authorization: `Bearer ${JWT}` },
    });

    await runWithToken();

    const persisted = flowRunUpdates.find(u => u.summary);
    expect(JSON.stringify(persisted.summary)).not.toContain(JWT);
    expect(persisted.summary.stepResults[0].requestHeaders.Authorization).toBe('Bearer ***');
  });

  test('does not persist the token to api_test_executions', async () => {
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1,
      requestHeaders: { Authorization: `Bearer ${JWT}` },
    });

    await runWithToken();

    expect(JSON.stringify(saveApiTestExecution.mock.calls[0][0])).not.toContain(JWT);
  });

  test('does not persist a token echoed back in a response body', async () => {
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1, requestHeaders: {},
      responseBody: { user: { name: 'kim' }, session: { accessToken: JWT } },
    });

    await runWithToken();

    const persisted = flowRunUpdates.find(u => u.summary);
    expect(JSON.stringify(persisted.summary)).not.toContain(JWT);
    expect(persisted.summary.stepResults[0].responseBody.user.name).toBe('kim'); // non-secrets survive
  });

  test('does not persist a freshly extracted token', async () => {
    // The token is minted mid-run, so it is never in initialVariables.
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1, requestHeaders: {},
      responseBody: { accessToken: JWT },
    });
    const spec = makeSpec([
      node('login', { method: 'POST', path: '/login', isAuthEndpoint: true, expectedStatusCodes: [200],
                      variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.accessToken' }] }),
    ]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    const persisted = flowRunUpdates.find(u => u.summary);
    expect(JSON.stringify(persisted.summary)).not.toContain(JWT);
    expect(persisted.summary.stepResults[0].variablesExtracted[0].value).not.toContain('super-secret');
  });

  test('leaves a run with no secrets untouched', async () => {
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1, requestHeaders: {},
      responseBody: { items: [{ id: 'city-1', name: 'Almaty' }] },
    });

    await FlowExecutorService.execute(makeSpec([node('listCities')]), 'u1', { chatSessionId: 'chat1' }, 'run1');

    const persisted = flowRunUpdates.find(u => u.summary);
    expect(persisted.summary.stepResults[0].responseBody).toEqual({ items: [{ id: 'city-1', name: 'Almaty' }] });
  });
});
