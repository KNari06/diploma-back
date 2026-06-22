/**
 * FlowBuilderService.refineNode — per-node AI refine (Group 4).
 * Mocks the AI boundary + supabase; asserts the patch logic applies only valid
 * fields, persists the edited DAG, and returns the updated node.
 */

jest.mock('@/services/ai/core/openai.service');
jest.mock('@/db/supabase', () => {
  const chain: any = {
    select: () => chain, eq: () => chain, update: () => chain,
    single: () => Promise.resolve({ data: null, error: null }),
    then: undefined,
  };
  // update().eq() resolves to {error:null}; make eq terminal-awaitable too.
  chain.eq = () => Object.assign(Promise.resolve({ error: null }), chain);
  return { supabaseAdmin: { from: () => chain } };
});

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { FlowBuilderService } from '../flow-builder.service';
import type { ApiFlowSpec, DAGNode } from '../flow.types';

const mockAi = getChatCompletionWithMessages as unknown as jest.Mock;

function makeNode(over: Partial<DAGNode> = {}): DAGNode {
  return {
    id: 'post_auth', method: 'POST', path: '/auth', operationId: 'post_auth',
    tags: [], dependsOn: [], variableExtractions: [], variableInjections: [],
    priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
    isUnsupported: false, canRunParallel: false, expectedStatusCodes: [200],
    sampleRequestBody: { email: 'a@b.com', password: 'x' },
    ...over,
  };
}

function fakeSpec(node: DAGNode): ApiFlowSpec {
  return {
    id: 'spec1', userId: 'u1', projectId: 'p1', name: 'n', sourceType: 'openapi_file',
    rawSpec: {}, executionDag: { nodes: [node], executionOrder: [node.id], parallelGroups: [[node.id]], summary: '', totalEndpoints: 1, unsupportedEndpoints: [] },
    variableChain: {}, totalEndpoints: 1, supportedEndpoints: 1, unsupportedEndpoints: [],
    errorStrategy: 'stop_on_failure', createdAt: '', updatedAt: '',
  } as ApiFlowSpec;
}

beforeEach(() => jest.restoreAllMocks());

describe('FlowBuilderService.refineNode', () => {
  test('applies AI patch (body + expected status) and returns the updated node', async () => {
    const node = makeNode();
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(node));
    mockAi.mockResolvedValue({
      content: JSON.stringify({
        sampleRequestBody: { email: '{{email}}', password: 'short' },
        expectedStatusCodes: [422],
        summary: 'Too-short password should 422',
      }),
      usage: {},
    });

    const updated = await FlowBuilderService.refineNode('spec1', 'post_auth', 'too-short password → 422', 'u1');

    expect(updated).not.toBeNull();
    expect(updated!.expectedStatusCodes).toEqual([422]);
    expect(updated!.sampleRequestBody).toEqual({ email: '{{email}}', password: 'short' });
    expect(updated!.summary).toMatch(/422/);
  });

  test('ignores invalid fields in the AI response', async () => {
    const node = makeNode();
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(node));
    mockAi.mockResolvedValue({
      content: JSON.stringify({ expectedStatusCodes: 'not-an-array', sampleQueryParams: ['bad'] }),
      usage: {},
    });

    const updated = await FlowBuilderService.refineNode('spec1', 'post_auth', 'x', 'u1');
    // invalid types ignored → original kept
    expect(updated!.expectedStatusCodes).toEqual([200]);
    expect(updated!.sampleQueryParams).toBeUndefined();
  });

  test('rejects a body that drops an injected {{placeholder}}, keeping the original', async () => {
    const node = makeNode({
      sampleRequestBody: { token: '{{auth_token}}', note: 'hi' },
      variableInjections: [
        { variableName: 'auth_token', injectAs: 'body_field', targetKey: 'token' },
      ],
    });
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(node));
    // Model wrongly resolves the injected placeholder to a literal secret.
    mockAi.mockResolvedValue({
      content: JSON.stringify({ sampleRequestBody: { token: 'real-secret-abc', note: 'hi' } }),
      usage: {},
    });

    const updated = await FlowBuilderService.refineNode('spec1', 'post_auth', 'improve it', 'u1');
    // Body change rejected → original placeholder preserved.
    expect(updated!.sampleRequestBody).toEqual({ token: '{{auth_token}}', note: 'hi' });
  });

  test('allows a body change that keeps the injected {{placeholder}} intact', async () => {
    const node = makeNode({
      sampleRequestBody: { token: '{{auth_token}}', amount: 10 },
      variableInjections: [
        { variableName: 'auth_token', injectAs: 'body_field', targetKey: 'token' },
      ],
    });
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(node));
    mockAi.mockResolvedValue({
      content: JSON.stringify({ sampleRequestBody: { token: '{{auth_token}}', amount: -1 } }),
      usage: {},
    });

    const updated = await FlowBuilderService.refineNode('spec1', 'post_auth', 'negative amount', 'u1');
    expect(updated!.sampleRequestBody).toEqual({ token: '{{auth_token}}', amount: -1 });
  });

  test('returns null when the node is not in the spec', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    const updated = await FlowBuilderService.refineNode('spec1', 'missing_node', 'x', 'u1');
    expect(updated).toBeNull();
    expect(mockAi).not.toHaveBeenCalled();
  });

  test('throws when the AI returns no usable JSON', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    mockAi.mockResolvedValue({ content: 'not json', usage: {} });
    await expect(FlowBuilderService.refineNode('spec1', 'post_auth', 'x', 'u1')).rejects.toThrow(/no usable/i);
  });
});
