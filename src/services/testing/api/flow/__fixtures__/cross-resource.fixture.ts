/**
 * Cross-resource fixture — tests autoWireCrudDependencies Rule 4.
 *
 * The crux: the path parameter name does NOT match the collection segment.
 * This is where naive plural matching is actually exercised.
 *
 * Example:
 *   POST /people                            (creates Person, collection = "people")
 *   GET  /events/{personId}/attendances     (uses personId, unrelated collection)
 *
 * For Rule 4 to wire this, it must:
 *   1. Parse {personId} → resourceGuess = "person"
 *   2. Find POST collection where last segment matches "person" or plural form
 *   3. Match "people" ↔ "person" — requires irregular plural handling
 *
 * We also include a snake_case + camelCase mix to probe naming normalization.
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
  tags: ['cross'],
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
  tags: ['cross'],
  dependsOn: [], // empty on purpose — Rule 4 should fill this
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

export const crossResourceFixture: ResolverFixture = {
  name: 'cross-resource',
  description: 'Path params reference unrelated collections with irregular plurals',
  spec: {
    title: 'Cross',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://example.com',
    authSchemes: [],
    sourceType: 'openapi_url',
    unsupportedEndpoints: [],
    endpoints: [
      // Irregular plural: /people + {personId}
      ep('createPerson', 'POST', '/people', [], true),
      ep('personAttendance', 'GET', '/events/{personId}/attendance', ['personId']),
      // Simple -ies plural: /categories + {categoryId}
      ep('createCategory', 'POST', '/categories', [], true),
      ep('productCategory', 'GET', '/products/{categoryId}/list', ['categoryId']),
      // snake_case param
      ep('createOrder', 'POST', '/orders', [], true),
      ep('orderInvoice', 'GET', '/invoices/{order_id}', ['order_id']),
    ],
  },

  idealAnalystOutput: {
    domain: { name: 'Cross', description: '' },
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
      flatNode('personAttendance', 'GET', '/events/{personId}/attendance'),
      flatNode('createCategory', 'POST', '/categories'),
      flatNode('productCategory', 'GET', '/products/{categoryId}/list'),
      flatNode('createOrder', 'POST', '/orders'),
      flatNode('orderInvoice', 'GET', '/invoices/{order_id}'),
    ],
    executionOrder: [
      'createPerson',
      'personAttendance',
      'createCategory',
      'productCategory',
      'createOrder',
      'orderInvoice',
    ],
    summary: 'Cross-resource stress test',
    totalEndpoints: 6,
    unsupportedEndpoints: [],
  },

  orderingConstraints: [
    ['createPerson', 'personAttendance'],     // people ↔ person (irregular)
    ['createCategory', 'productCategory'],    // categories ↔ category (-ies rule)
    ['createOrder', 'orderInvoice'],          // orders ↔ order_id (snake_case)
  ],

  expectedNodeIds: [
    'createPerson',
    'personAttendance',
    'createCategory',
    'productCategory',
    'createOrder',
    'orderInvoice',
  ],
};
