/**
 * Nested body schemas fixture — exercises Rule 6's recursive schema walker.
 *
 * This was missing from the batching fixture. batching-ecommerce has only
 * flat bodies like { productId }. Real-world APIs (Stripe, GitHub, Shopify)
 * commonly use:
 *   - Nested objects:   { customer: { customerId } }
 *   - Arrays of items:  { items: [{ productId, qty }] }
 *   - Deep nesting:     { order: { items: [{ productId }] } }
 *
 * If Rule 6's schema walker has a depth-limit bug, these will fail.
 *
 * AI is given ZERO dependsOn so the only way the graph gets wired is through
 * Rule 6 finding IDs in nested schemas.
 */

import type { ResolverFixture } from './types';
import type { ParsedEndpoint } from '../flow.types';

// Producer endpoints
const createCustomer: ParsedEndpoint = {
  operationId: 'createCustomer',
  method: 'POST',
  path: '/customers',
  summary: 'Create customer',
  tags: ['customers'],
  parameters: [],
  requestBody: {
    contentType: 'application/json',
    required: true,
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  },
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
};

const createProduct: ParsedEndpoint = {
  operationId: 'createProduct',
  method: 'POST',
  path: '/products',
  summary: 'Create product',
  tags: ['products'],
  parameters: [],
  requestBody: {
    contentType: 'application/json',
    required: true,
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, price: { type: 'number' } },
    },
  },
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
};

// Consumer endpoints with different nested body shapes:

// 1. Nested object:  { customer: { customerId: integer } }
const createSubscription: ParsedEndpoint = {
  operationId: 'createSubscription',
  method: 'POST',
  path: '/subscriptions',
  summary: 'Create subscription (nested customer ref)',
  tags: ['subscriptions'],
  parameters: [],
  requestBody: {
    contentType: 'application/json',
    required: true,
    schema: {
      type: 'object',
      properties: {
        plan: { type: 'string' },
        customer: {
          type: 'object',
          properties: {
            customerId: { type: 'integer' },
          },
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
};

// 2. Array of objects:  { items: [{ productId }] }
const createBulkOrder: ParsedEndpoint = {
  operationId: 'createBulkOrder',
  method: 'POST',
  path: '/bulk-orders',
  summary: 'Create bulk order (array of product refs)',
  tags: ['orders'],
  parameters: [],
  requestBody: {
    contentType: 'application/json',
    required: true,
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'integer' },
              quantity: { type: 'integer' },
            },
          },
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
};

// 3. Deep nesting: { order: { items: [{ productId }] } }
const createGiftOrder: ParsedEndpoint = {
  operationId: 'createGiftOrder',
  method: 'POST',
  path: '/gift-orders',
  summary: 'Create gift order (deeply nested product refs)',
  tags: ['orders'],
  parameters: [],
  requestBody: {
    contentType: 'application/json',
    required: true,
    schema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        order: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  productId: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  },
  responses: {
    '200': {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } } },
    },
  },
  security: [],
};

const nodeFlat = (id: string, method: any, path: string) => ({
  id,
  method,
  path,
  operationId: id,
  summary: id,
  tags: [],
  dependsOn: [], // deliberately empty — Rule 6 must find these
  variableExtractions: [],
  variableInjections: [],
  priority: 0,
  isAuthEndpoint: false,
  isPagination: false,
  hasFileUpload: false,
  isUnsupported: false,
  canRunParallel: false,
  sampleRequestBody: null,
  expectedStatusCodes: [200, 201],
});

export const nestedBodySchemasFixture: ResolverFixture = {
  name: 'nested-body-schemas',
  description: 'Rule 6 must find IDs in nested objects, arrays-of-objects, and deep paths',
  spec: {
    title: 'Nested schemas',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://example.com',
    authSchemes: [],
    sourceType: 'openapi_url',
    unsupportedEndpoints: [],
    endpoints: [
      createCustomer,
      createProduct,
      createSubscription,
      createBulkOrder,
      createGiftOrder,
    ],
  },

  idealAnalystOutput: {
    domain: { name: 'Nested schemas', description: '' },
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
      nodeFlat('createCustomer', 'POST', '/customers'),
      nodeFlat('createProduct', 'POST', '/products'),
      nodeFlat('createSubscription', 'POST', '/subscriptions'),
      nodeFlat('createBulkOrder', 'POST', '/bulk-orders'),
      nodeFlat('createGiftOrder', 'POST', '/gift-orders'),
    ],
    executionOrder: [
      'createCustomer',
      'createProduct',
      'createSubscription',
      'createBulkOrder',
      'createGiftOrder',
    ],
    summary: 'Nested schema stress test',
    totalEndpoints: 5,
    unsupportedEndpoints: [],
  },

  orderingConstraints: [
    ['createCustomer', 'createSubscription'],  // nested object: customer.customerId
    ['createProduct', 'createBulkOrder'],      // array of objects: items[].productId
    ['createProduct', 'createGiftOrder'],      // deep: order.items[].productId
  ],

  expectedNodeIds: [
    'createCustomer',
    'createProduct',
    'createSubscription',
    'createBulkOrder',
    'createGiftOrder',
  ],
};
