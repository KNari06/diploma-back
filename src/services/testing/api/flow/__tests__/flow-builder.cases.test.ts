/**
 * FlowBuilderService.generateNodeCases / saveNodeCases — Case Matrix (Group 5).
 * Mocks the AI boundary + supabase; asserts validation, merge (keeps user cases),
 * placeholder preservation, and user-save shaping.
 */

jest.mock('@/services/ai/core/openai.service');
jest.mock('@/db/supabase', () => {
  const chain: any = {
    select: () => chain, update: () => chain,
    single: () => Promise.resolve({ data: null, error: null }),
  };
  chain.eq = () => Object.assign(Promise.resolve({ error: null }), chain);
  return { supabaseAdmin: { from: () => chain } };
});

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { FlowBuilderService } from '../flow-builder.service';
import type { ApiFlowSpec, DAGNode, NodeCase } from '../flow.types';

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

describe('FlowBuilderService.generateNodeCases', () => {
  test('normalizes AI cases, assigns ids, tags source:ai, appends to existing', async () => {
    const existing: NodeCase = { id: 'u1', name: 'my case', expectedStatusCodes: [200], source: 'user' };
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode({ cases: [existing] })));
    mockAi.mockResolvedValue({
      content: JSON.stringify({ cases: [
        { name: 'happy', expectedStatusCodes: [200], requestBody: { email: 'x@y.com', password: 'ok' } },
        { name: 'wrong password', expectedStatusCodes: [401], requestBody: { email: 'x@y.com', password: 'bad' } },
        { name: 'no codes', requestBody: {} }, // dropped: no expectedStatusCodes
      ] }),
      usage: {},
    });

    const cases = await FlowBuilderService.generateNodeCases('spec1', 'post_auth', undefined, 'u1');

    expect(cases).not.toBeNull();
    // existing user case kept + 2 valid AI cases (the no-codes one dropped)
    expect(cases!.map(c => c.name)).toEqual(['my case', 'happy', 'wrong password']);
    expect(cases!.find(c => c.name === 'wrong password')!.expectedStatusCodes).toEqual([401]);
    expect(cases!.filter(c => c.source === 'ai')).toHaveLength(2);
    expect(cases!.every(c => typeof c.id === 'string' && c.id)).toBe(true);
  });

  test('drops an AI case whose body removes an injected placeholder', async () => {
    const node = makeNode({
      sampleRequestBody: { token: '{{auth_token}}', email: 'a@b.com' },
      variableInjections: [{ variableName: 'auth_token', injectAs: 'body_field', targetKey: 'token' }],
    });
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(node));
    mockAi.mockResolvedValue({
      content: JSON.stringify({ cases: [
        { name: 'keeps token', expectedStatusCodes: [200], requestBody: { token: '{{auth_token}}', email: 'x@y.com' } },
        { name: 'drops token', expectedStatusCodes: [401], requestBody: { token: 'literal-secret', email: 'x@y.com' } },
      ] }),
      usage: {},
    });

    const cases = await FlowBuilderService.generateNodeCases('spec1', 'post_auth', undefined, 'u1');
    expect(cases!.map(c => c.name)).toEqual(['keeps token']); // the placeholder-dropping case removed
  });

  test('skips AI cases whose name duplicates an existing case (case-insensitive)', async () => {
    const existing: NodeCase = { id: 'u1', name: 'Wrong Password', expectedStatusCodes: [401], source: 'user' };
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode({ cases: [existing] })));
    mockAi.mockResolvedValue({
      content: JSON.stringify({ cases: [
        { name: 'wrong password', expectedStatusCodes: [401], requestBody: {} }, // dup of existing
        { name: 'happy', expectedStatusCodes: [200], requestBody: {} },
        { name: 'happy', expectedStatusCodes: [200], requestBody: {} },         // dup within batch
      ] }),
      usage: {},
    });

    const cases = await FlowBuilderService.generateNodeCases('spec1', 'post_auth', undefined, 'u1');
    expect(cases!.map(c => c.name)).toEqual(['Wrong Password', 'happy']);
  });

  test('caps the number of AI cases appended', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `case ${i}`, expectedStatusCodes: [200], requestBody: {},
    }));
    mockAi.mockResolvedValue({ content: JSON.stringify({ cases: many }), usage: {} });

    const cases = await FlowBuilderService.generateNodeCases('spec1', 'post_auth', undefined, 'u1');
    expect(cases!.filter(c => c.source === 'ai').length).toBe(12);
  });

  test('throws when AI returns no cases array', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    mockAi.mockResolvedValue({ content: 'not json', usage: {} });
    await expect(FlowBuilderService.generateNodeCases('spec1', 'post_auth', undefined, 'u1')).rejects.toThrow(/no usable/i);
  });

  test('returns null when node not found (no AI call)', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    const cases = await FlowBuilderService.generateNodeCases('spec1', 'missing', undefined, 'u1');
    expect(cases).toBeNull();
    expect(mockAi).not.toHaveBeenCalled();
  });
});

describe('FlowBuilderService.saveNodeCases', () => {
  test('shapes + replaces user cases (assigns ids, filters invalid)', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    const saved = await FlowBuilderService.saveNodeCases('spec1', 'post_auth', [
      { name: 'happy', expectedStatusCodes: [200] },
      { name: 'no codes' }, // dropped
      { name: '', expectedStatusCodes: [400] }, // dropped (empty name)
    ], 'u1');

    expect(saved!.map(c => c.name)).toEqual(['happy']);
    expect(saved![0].id).toBeTruthy();
    expect(saved![0].source).toBe('user');
  });

  test('throws when cases is not an array', async () => {
    jest.spyOn(FlowBuilderService, 'getById').mockResolvedValue(fakeSpec(makeNode()));
    await expect(FlowBuilderService.saveNodeCases('spec1', 'post_auth', { not: 'array' } as any, 'u1')).rejects.toThrow(/must be an array/i);
  });
});
