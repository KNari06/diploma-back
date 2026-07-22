/**
 * UNVERIFIED VARIABLE LINKS — the resolver statically checks which values flow
 * between calls and now RETURNS the links it could not verify (previously these
 * were only logged, so a flow that looked connected failed silently at run time).
 *
 * Two cases covered:
 *   Test 1 — no_producer: a node injects `api_key`, which no call in the flow
 *     produces. The repair pass keeps it (user-provided pattern), so it survives
 *     to validateVariableChain and must surface as an unverified link the user
 *     is told to provide before running.
 *   Test 2 — clean flow: every injected variable has a producer, so
 *     unverifiedLinks is empty.
 */

jest.mock('@/services/ai/core/openai.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { DependencyResolverService } from '../dependency-resolver.service';
import type { ParsedApiSpec } from '../flow.types';

const analyst = {
  domain: { name: 'Test', description: '' },
  entities: [],
  authFlow: { type: 'none', steps: [] },
  dataFlows: [],
  publicEndpoints: [],
  executionPhases: [],
  edgeCases: [],
  questions: [],
  confidence: { overall: 0.9, auth: 1, dependencies: 0.9, dataFlow: 0.9 },
};

function mockAi(architect: any) {
  let callIdx = 0;
  return jest.fn().mockImplementation(async () => {
    const i = callIdx++;
    if (i === 0) return { content: JSON.stringify(analyst), usage: {} };
    if (i === 1) return { content: JSON.stringify(architect), usage: {} };
    return { content: JSON.stringify({ samples: {} }), usage: {} };
  });
}

const spec: ParsedApiSpec = {
  title: 'UnverifiedTest',
  version: '1.0',
  specVersion: '3.0.0',
  baseUrl: 'https://example.com',
  authSchemes: [],
  sourceType: 'python',
  unsupportedEndpoints: [],
  endpoints: [
    {
      operationId: 'listItems', method: 'GET', path: '/items',
      summary: '', tags: [], parameters: [],
      responses: { '200': { description: 'ok' } }, security: [],
    },
  ],
};

// Architect injects `api_key` (a user-provided pattern) that NO node extracts.
// The repair pass keeps it; validateVariableChain must flag it no_producer.
const architectNoProducer = {
  nodes: [
    {
      id: 'listItems', method: 'GET', path: '/items', operationId: 'listItems',
      summary: '', tags: [], dependsOn: [],
      variableExtractions: [],
      variableInjections: [{ variableName: 'api_key', injectAs: 'header', targetKey: 'X-API-Key' }],
      priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
  ],
  executionOrder: ['listItems'],
  summary: '', totalEndpoints: 1, unsupportedEndpoints: [],
};

const cleanSpec: ParsedApiSpec = {
  ...spec,
  title: 'CleanTest',
  endpoints: [
    {
      operationId: 'login', method: 'POST', path: '/login',
      summary: '', tags: [], parameters: [],
      requestBody: { contentType: 'application/json', required: true, schema: { type: 'object' } },
      responses: { '200': { description: 'ok' } }, security: [],
    },
    {
      operationId: 'getMe', method: 'GET', path: '/me',
      summary: '', tags: [], parameters: [],
      responses: { '200': { description: 'ok' } }, security: [],
    },
  ],
};

// login extracts token → getMe injects it. Fully connected, nothing unverified.
const architectClean = {
  nodes: [
    {
      id: 'login', method: 'POST', path: '/login', operationId: 'login',
      summary: '', tags: [], dependsOn: [],
      variableExtractions: [{ variableName: 'session_token', jsonPath: '$.token' }],
      variableInjections: [],
      priority: 0, isAuthEndpoint: true, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
    {
      id: 'getMe', method: 'GET', path: '/me', operationId: 'getMe',
      summary: '', tags: [], dependsOn: ['login'],
      variableExtractions: [],
      variableInjections: [{ variableName: 'session_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' }],
      priority: 1, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
  ],
  executionOrder: ['login', 'getMe'],
  summary: '', totalEndpoints: 2, unsupportedEndpoints: [],
};

describe('unverified variable links', () => {
  beforeEach(() => {
    (logger.info as unknown as jest.Mock).mockClear();
    (logger.warn as unknown as jest.Mock).mockClear();
  });

  test('surfaces a no_producer link for a variable no call produces', async () => {
    (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mockAi(architectNoProducer));
    const result = await DependencyResolverService.resolve(spec);
    expect(result.dag).toBeDefined();
    const links = result.dag!.unverifiedLinks || [];
    const noProducer = links.filter(l => l.kind === 'no_producer');
    expect(noProducer.map(l => l.variableName)).toContain('api_key');
  }, 30_000);

  test('a fully connected flow reports no unverified links', async () => {
    (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mockAi(architectClean));
    const result = await DependencyResolverService.resolve(cleanSpec);
    expect(result.dag).toBeDefined();
    expect(result.dag!.unverifiedLinks || []).toHaveLength(0);
  }, 30_000);
});
