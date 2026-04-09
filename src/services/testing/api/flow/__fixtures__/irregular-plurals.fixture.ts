/**
 * Irregular plurals fixture — tests whether autoWireCrudDependencies'
 * naive +s/+es plural matching copes with real English plurals.
 *
 * Key cases:
 *   - /people + {personId}        (people → person, not +s)
 *   - /children + {childId}       (children → child, not +s)
 *   - /categories + {categoryId}  (categories → category, -ies rule)
 *
 * If auto-wire's plural logic is broken, we'll see POST come AFTER
 * GET/{id}/DELETE/{id} because the wiring rule silently does nothing.
 *
 * Note: we deliberately set AI-given dependsOn to EMPTY here. This fixture
 * measures "can auto-wire save us when AI misses deps on irregular plurals?"
 */

import type { ResolverFixture } from './types';
import type { ParsedEndpoint } from '../flow.types';

const ep = (
  id: string,
  method: ParsedEndpoint['method'],
  path: string,
  pathParams: string[] = [],
  hasBody = false,
): ParsedEndpoint => ({
  operationId: id,
  method,
  path,
  summary: id,
  tags: ['irregular'],
  parameters: pathParams.map(name => ({
    name,
    in: 'path' as const,
    required: true,
    schema: { type: 'integer' },
  })),
  requestBody: hasBody
    ? {
        contentType: 'application/json',
        required: true,
        schema: { type: 'object', properties: { name: { type: 'string' } } },
      }
    : undefined,
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
});

const flatNode = (id: string, method: any, path: string) => ({
  id,
  method,
  path,
  operationId: id,
  summary: id,
  tags: ['irregular'],
  dependsOn: [], // <-- deliberately empty — stress test for auto-wire
  variableExtractions: [],
  variableInjections: [],
  priority: 0,
  isAuthEndpoint: false,
  isPagination: false,
  hasFileUpload: false,
  isUnsupported: false,
  canRunParallel: false,
  sampleRequestBody: null,
  expectedStatusCodes: [200, 201, 204],
});

export const irregularPluralsFixture: ResolverFixture = {
  name: 'irregular-plurals',
  description: 'Irregular English plurals: people/person, children/child, categories/category',
  spec: {
    title: 'Irregular',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://example.com',
    authSchemes: [],
    sourceType: 'openapi_url',
    unsupportedEndpoints: [],
    endpoints: [
      ep('createPerson', 'POST', '/people', [], true),
      ep('getPerson', 'GET', '/people/{personId}', ['personId']),
      ep('deletePerson', 'DELETE', '/people/{personId}', ['personId']),
      ep('createChild', 'POST', '/children', [], true),
      ep('getChild', 'GET', '/children/{childId}', ['childId']),
      ep('deleteChild', 'DELETE', '/children/{childId}', ['childId']),
      ep('createCategory', 'POST', '/categories', [], true),
      ep('getCategory', 'GET', '/categories/{categoryId}', ['categoryId']),
    ],
  },

  idealAnalystOutput: {
    domain: { name: 'Irregular', description: '' },
    entities: [],
    authFlow: { type: 'none', steps: [] },
    dataFlows: [],
    publicEndpoints: [],
    executionPhases: [],
    edgeCases: [],
    questions: [],
    confidence: { overall: 0.9, auth: 1, dependencies: 0.5, dataFlow: 0.5 },
  },

  idealArchitectOutput: {
    nodes: [
      flatNode('createPerson', 'POST', '/people'),
      flatNode('getPerson', 'GET', '/people/{personId}'),
      flatNode('deletePerson', 'DELETE', '/people/{personId}'),
      flatNode('createChild', 'POST', '/children'),
      flatNode('getChild', 'GET', '/children/{childId}'),
      flatNode('deleteChild', 'DELETE', '/children/{childId}'),
      flatNode('createCategory', 'POST', '/categories'),
      flatNode('getCategory', 'GET', '/categories/{categoryId}'),
    ],
    executionOrder: [
      'createPerson',
      'getPerson',
      'deletePerson',
      'createChild',
      'getChild',
      'deleteChild',
      'createCategory',
      'getCategory',
    ],
    summary: 'Irregular plurals stress test',
    totalEndpoints: 8,
    unsupportedEndpoints: [],
  },

  orderingConstraints: [
    ['createPerson', 'getPerson'],
    ['createPerson', 'deletePerson'],
    ['getPerson', 'deletePerson'],
    ['createChild', 'getChild'],
    ['createChild', 'deleteChild'],
    ['getChild', 'deleteChild'],
    ['createCategory', 'getCategory'],
  ],

  expectedNodeIds: [
    'createPerson',
    'getPerson',
    'deletePerson',
    'createChild',
    'getChild',
    'deleteChild',
    'createCategory',
    'getCategory',
  ],
};
