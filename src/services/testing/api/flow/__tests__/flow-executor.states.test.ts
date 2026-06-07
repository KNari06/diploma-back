/**
 * Flow executor — run-state emissions (Group 1 fixes).
 *
 * Verifies the executor now tells the frontend about every node outcome:
 *  - unsupported / dependency-failed → api:flow:step-skipped (status 'skipped')
 *  - user cancel → api:flow:step-skipped (status 'cancelled') for remaining nodes
 *  - 429 retry → api:flow:step-retrying
 *
 * We mock at the WS boundary (spy on emit methods) and stub executeStep so the
 * HTTP layer and DB are never touched.
 */

jest.mock('@/websocket/core/websocket.service');
jest.mock('../../api-test-storage.service', () => ({
  ApiTestStorageService: { saveApiTestExecution: jest.fn().mockResolvedValue(undefined) },
}));
// Chainable supabase stub — updateFlowRun() does .from().update().eq() and
// createFlowRun() does .from().insert().select().single(); all resolve to no error.
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
import { FlowExecutorService, cancelFlowRun } from '../flow-executor.service';
import { FlowBuilderService } from '../flow-builder.service';
import type { ApiFlowSpec, DAGNode, ExecutionDAG } from '../flow.types';

// Stub the run-record + spec writes (module-internal createFlowRun/updateFlowRun
// hit supabase; FlowBuilderService.markRunStatus is on the imported class).
jest.spyOn(FlowBuilderService, 'markRunStatus').mockResolvedValue(undefined as any);

const ws = webSocketService as jest.Mocked<typeof webSocketService>;

function node(id: string, over: Partial<DAGNode> = {}): DAGNode {
  return {
    id,
    method: 'GET',
    path: `/${id}`,
    operationId: id,
    tags: [],
    dependsOn: [],
    variableExtractions: [],
    variableInjections: [],
    priority: 0,
    isAuthEndpoint: false,
    isPagination: false,
    hasFileUpload: false,
    isUnsupported: false,
    canRunParallel: false,
    expectedStatusCodes: [200],
    ...over,
  };
}

function makeSpec(nodes: DAGNode[], parallelGroups?: string[][]): ApiFlowSpec {
  const dag: ExecutionDAG = {
    nodes,
    executionOrder: nodes.map(n => n.id),
    parallelGroups: parallelGroups ?? nodes.map(n => [n.id]),
    summary: '',
    totalEndpoints: nodes.length,
    unsupportedEndpoints: [],
  };
  return {
    id: 'spec1',
    userId: 'u1',
    projectId: 'p1',
    name: 'test',
    sourceType: 'openapi_file',
    rawSpec: { servers: [{ url: 'https://api.test' }] },
    executionDag: dag,
    variableChain: {},
    totalEndpoints: nodes.length,
    supportedEndpoints: nodes.length,
    unsupportedEndpoints: [],
    errorStrategy: 'stop_on_failure',
    createdAt: '',
    updatedAt: '',
  } as ApiFlowSpec;
}

function skippedCalls() {
  return (ws.emitApiFlowStepSkipped as jest.Mock).mock.calls.map(c => c[1]);
}

beforeEach(() => jest.clearAllMocks());

describe('flow executor — skipped emissions', () => {
  test('emits step-skipped for an unsupported node', async () => {
    const spec = makeSpec([node('a', { isUnsupported: true, unsupportedReason: 'websocket' })]);
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockResolvedValue({ status: 'passed' });

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    const skips = skippedCalls();
    expect(skips).toContainEqual(expect.objectContaining({ nodeId: 'a', reason: 'unsupported', status: 'skipped' }));
  });

  test('emits dependency_failed skip for a dependent under retry_then_skip', async () => {
    // retry_then_skip continues the run but skips dependents of a failed node.
    const spec = makeSpec([node('a'), node('b', { dependsOn: ['a'] })]);
    spec.errorStrategy = 'retry_then_skip';
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async (n: any) => ({
      status: n.id === 'a' ? 'failed' : 'passed',
      nodeId: n.id, stepIndex: n.id === 'a' ? 0 : 1,
      responseStatus: n.id === 'a' ? 500 : 200, durationMs: 1, requestHeaders: {},
    }));

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(skippedCalls()).toContainEqual(
      expect.objectContaining({ nodeId: 'b', reason: 'dependency_failed', status: 'skipped' }),
    );
  });

  test('stop_on_failure cancels the downstream group after a failure', async () => {
    const spec = makeSpec([node('a'), node('b', { dependsOn: ['a'] })]);
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async (n: any) => ({
      status: n.id === 'a' ? 'failed' : 'passed',
      nodeId: n.id, stepIndex: n.id === 'a' ? 0 : 1,
      responseStatus: n.id === 'a' ? 500 : 200, durationMs: 1, requestHeaders: {},
    }));

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    // Run halted → 'b' is cancelled (not merely skipped).
    expect(skippedCalls()).toContainEqual(
      expect.objectContaining({ nodeId: 'b', reason: 'cancelled', status: 'cancelled' }),
    );
  });
});

describe('flow executor — cancellation', () => {
  test('on cancel, remaining not-started nodes emit step-skipped with status cancelled', async () => {
    const spec = makeSpec([node('a'), node('b'), node('c')]);
    // 'a' runs, then aborts the run; 'b' and 'c' should be cancelled (not stuck).
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async (n: any) => {
      if (n.id === 'a') cancelFlowRun('run1');
      return { status: 'passed', nodeId: n.id, responseStatus: 200, durationMs: 1, requestHeaders: {} };
    });

    const summary = await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    const cancelled = skippedCalls().filter(s => s.status === 'cancelled').map(s => s.nodeId);
    expect(cancelled).toEqual(expect.arrayContaining(['b', 'c']));
    expect(summary.status).toBe('cancelled');
  });
});

describe('flow executor — retrying emission', () => {
  test('emits step-retrying on a 429 then succeeds', async () => {
    const spec = makeSpec([node('a')]);
    let call = 0;
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async () => {
      call++;
      return call === 1
        ? { status: 'failed', nodeId: 'a', responseStatus: 429, responseHeaders: {}, durationMs: 1, requestHeaders: {} }
        : { status: 'passed', nodeId: 'a', responseStatus: 200, durationMs: 1, requestHeaders: {} };
    });

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect((ws.emitApiFlowStepRetrying as jest.Mock).mock.calls.map(c => c[1])).toContainEqual(
      expect.objectContaining({ nodeId: 'a', reason: 'rate_limited', attempt: 1 }),
    );
  });
});

describe('flow executor — real parallelism (Group 3)', () => {
  test('nodes in the same parallel group run concurrently', async () => {
    // [A,B] is one group, [C] the next. A & B must overlap; C runs after both.
    const spec = makeSpec(
      [node('a'), node('b'), node('c', { dependsOn: ['a', 'b'] })],
      [['a', 'b'], ['c']],
    );

    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    let releaseAB: (() => void) | null = null;
    const gate = new Promise<void>((res) => { releaseAB = res; });

    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async (n: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold A and B open until BOTH have started, proving real overlap.
      if (n.id === 'a' || n.id === 'b') {
        if (inFlight >= 2 && releaseAB) releaseAB();
        await gate;
      }
      order.push(n.id);
      inFlight--;
      return { status: 'passed', nodeId: n.id, responseStatus: 200, durationMs: 1, requestHeaders: {} };
    });

    await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(maxInFlight).toBeGreaterThanOrEqual(2); // A & B were in flight together
    expect(order.indexOf('c')).toBe(2); // C ran only after the first group settled
  });

  test('stop_on_failure halts later groups when a group member fails', async () => {
    const spec = makeSpec(
      [node('a'), node('b'), node('c', { dependsOn: ['a'] })],
      [['a', 'b'], ['c']],
    );
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async (n: any) => ({
      status: n.id === 'a' ? 'failed' : 'passed',
      nodeId: n.id,
      responseStatus: n.id === 'a' ? 500 : 200,
      durationMs: 1,
      requestHeaders: {},
    }));

    const summary = await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    // 'b' (same group as 'a') still ran; 'c' (next group) is cancelled, not executed.
    const cId = summary.stepResults.find(r => r.nodeId === 'c');
    expect(cId?.status).toBe('cancelled');
    expect(summary.status).toBe('failed');
    // Report stays ordered by stepIndex (ascending, no gaps) despite out-of-order completion.
    const indices = summary.stepResults.map(r => r.stepIndex);
    expect(indices).toEqual([...indices].sort((x, y) => x - y));
    expect(indices.every(i => typeof i === 'number')).toBe(true);
  });

  test('coverage guard: a node in executionOrder but missing from parallelGroups still runs', async () => {
    // Malformed/edited DAG: 'b' exists in executionOrder but parallelGroups omits it.
    // The old sequential loop ran every executionOrder node — so must the new one.
    const spec = makeSpec([node('a'), node('b')], [['a']]); // groups omit 'b'
    const ran: string[] = [];
    jest.spyOn(FlowExecutorService as any, 'executeStep').mockImplementation(async (n: any) => {
      ran.push(n.id);
      return { status: 'passed', nodeId: n.id, responseStatus: 200, durationMs: 1, requestHeaders: {} };
    });

    const summary = await FlowExecutorService.execute(spec, 'u1', { chatSessionId: 'chat1' }, 'run1');

    expect(ran).toContain('b'); // not silently dropped
    expect(summary.stepResults.find(r => r.nodeId === 'b')?.status).toBe('passed');
  });
});
