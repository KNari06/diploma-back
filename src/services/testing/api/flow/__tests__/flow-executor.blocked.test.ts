/**
 * Flow executor — `blocked` steps.
 *
 * A blocked step is one we never validly asked: an unbound path param, or a
 * destructive call without consent. The contract these tests pin down is that we
 * do NOT send the request — sending it would earn a 404/500 that gets reported as
 * the endpoint's failure and hides our own gap.
 *
 * Mocked at the WS boundary + executeStep, same as flow-executor.states.test.ts.
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

import { webSocketService } from '@/websocket/core/websocket.service';
import { FlowExecutorService, isDestructiveMethod } from '../flow-executor.service';
import { FlowBuilderService } from '../flow-builder.service';
import type { ApiFlowSpec, DAGNode, ExecutionDAG, HttpMethod } from '../flow.types';

jest.spyOn(FlowBuilderService, 'markRunStatus').mockResolvedValue(undefined as any);

const ws = webSocketService as jest.Mocked<typeof webSocketService>;

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
    nodes, executionOrder: nodes.map(n => n.id), parallelGroups: nodes.map(n => [n.id]),
    summary: '', totalEndpoints: nodes.length, unsupportedEndpoints: [],
  };
  return {
    id: 'spec1', userId: 'u1', projectId: 'p1', name: 'test', sourceType: 'openapi_file',
    rawSpec: { servers: [{ url: 'https://api.test' }] }, executionDag: dag, variableChain: {},
    totalEndpoints: nodes.length, supportedEndpoints: nodes.length, unsupportedEndpoints: [],
    errorStrategy: 'continue_on_failure', createdAt: '', updatedAt: '',
  } as ApiFlowSpec;
}

const skippedCalls = () => (ws.emitApiFlowStepSkipped as jest.Mock).mock.calls.map(c => c[1]);

beforeEach(() => jest.clearAllMocks());

describe('unbound variables', () => {
  test('blocks a step whose path param has no value, and sends no request', async () => {
    const executeStep = jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({ status: 'passed' });
    const spec = makeSpec([
      node('getUser', {
        path: '/users/{id}',
        variableInjections: [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'id' }],
      }),
    ]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(skippedCalls()).toContainEqual(
      expect.objectContaining({ nodeId: 'getUser', reason: 'unbound_variable', status: 'blocked' }),
    );
    expect(executeStep).not.toHaveBeenCalled();
  });

  test('names the variable that is missing', async () => {
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({ status: 'passed' });
    const spec = makeSpec([
      node('getUser', {
        path: '/users/{id}',
        variableInjections: [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'id' }],
      }),
    ]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(skippedCalls()[0].message).toContain('user_id');
  });

  test('runs the step once the value is supplied at run time', async () => {
    const executeStep = jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1, requestHeaders: {},
    });
    const spec = makeSpec([
      node('getUser', {
        path: '/users/{id}',
        variableInjections: [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'id' }],
      }),
    ]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1', initialVariables: { user_id: 'u-42' } }, 'run1');

    expect(skippedCalls()).toEqual([]);
    expect(executeStep.mock.calls[0][1]).toBe('https://api.test/users/u-42'); // resolvedUrl — no brace left
  });

  test('a blocked step does not count as failed', async () => {
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({ status: 'passed' });
    const spec = makeSpec([
      node('getUser', {
        path: '/users/{id}',
        variableInjections: [{ variableName: 'user_id', injectAs: 'path_param', targetKey: 'id' }],
      }),
    ]);

    const summary = await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(summary.blocked).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.status).toBe('completed');
  });
});

describe('destructive consent', () => {
  test.each(['DELETE', 'PUT', 'PATCH'] as HttpMethod[])('blocks %s without consent, and sends no request', async method => {
    const executeStep = jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({ status: 'passed' });
    const spec = makeSpec([node('mutate', { method, path: '/users/x' })]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(skippedCalls()).toContainEqual(
      expect.objectContaining({ nodeId: 'mutate', reason: 'destructive_not_consented', status: 'blocked' }),
    );
    expect(executeStep).not.toHaveBeenCalled();
  });

  test('runs a destructive step once consented', async () => {
    const executeStep = jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 204, durationMs: 1, requestHeaders: {},
    });
    const spec = makeSpec([node('mutate', { method: 'DELETE', path: '/users/x', expectedStatusCodes: [204] })]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1', allowDestructive: true }, 'run1');

    expect(skippedCalls()).toEqual([]);
    expect(executeStep).toHaveBeenCalled();
  });

  test('never blocks the reads and creates a smoke run is built from', async () => {
    const executeStep = jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({
      status: 'passed', responseStatus: 200, durationMs: 1, requestHeaders: {},
    });
    const spec = makeSpec([node('list'), node('create', { method: 'POST', path: '/users' })]);

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(skippedCalls()).toEqual([]);
    expect(executeStep).toHaveBeenCalledTimes(2);
  });

  test('classifies methods by whether they can destroy data we did not create', () => {
    expect(['DELETE', 'PUT', 'PATCH'].map(isDestructiveMethod)).toEqual([true, true, true]);
    expect(['GET', 'POST', 'HEAD', 'OPTIONS'].map(isDestructiveMethod)).toEqual([false, false, false, false]);
  });
});
