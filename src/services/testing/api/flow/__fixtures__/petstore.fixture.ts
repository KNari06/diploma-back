/**
 * Petstore fixture — the canonical example used in both RESTler (ICSE'19)
 * and Morest (ICSE'22) papers. Minimal Pet/Order CRUD with cross-schema
 * reference (Order.petId refers to Pet.id).
 *
 * This fixture exercises:
 *   - Same-resource CRUD ordering (POST /pet before GET/PUT/DELETE /pet/{id})
 *   - Cross-schema reference (placeOrder produces Order, which references Pet.id)
 *   - Read-only endpoint (findPetsByStatus) without a POST producer
 */

import type { ResolverFixture } from './types';

export const petstoreFixture: ResolverFixture = {
  name: 'petstore',
  description: 'Classic Pet/Order CRUD API from Morest/RESTler papers',

  spec: {
    title: 'Petstore',
    version: '1.0.0',
    specVersion: '3.0.0',
    baseUrl: 'https://petstore.swagger.io/v2',
    authSchemes: [],
    sourceType: 'openapi_url',
    unsupportedEndpoints: [],
    endpoints: [
      {
        operationId: 'addPet',
        method: 'POST',
        path: '/pet',
        summary: 'Add a new pet to the store',
        tags: ['pet'],
        parameters: [],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: {
            type: 'object',
            properties: { name: { type: 'string' }, status: { type: 'string' } },
          },
        },
        responses: {
          '200': {
            description: 'created',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
        security: [],
      },
      {
        operationId: 'getPetById',
        method: 'GET',
        path: '/pet/{petId}',
        summary: 'Find pet by ID',
        tags: ['pet'],
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
        security: [],
      },
      {
        operationId: 'updatePet',
        method: 'PUT',
        path: '/pet/{petId}',
        summary: 'Update pet',
        tags: ['pet'],
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
        responses: { '200': { description: 'ok' } },
        security: [],
      },
      {
        operationId: 'deletePet',
        method: 'DELETE',
        path: '/pet/{petId}',
        summary: 'Delete pet',
        tags: ['pet'],
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '204': { description: 'no content' } },
        security: [],
      },
      {
        operationId: 'findPetsByStatus',
        method: 'GET',
        path: '/pet/findByStatus',
        summary: 'Find pets by status',
        tags: ['pet'],
        parameters: [
          { name: 'status', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
        security: [],
      },
      {
        operationId: 'placeOrder',
        method: 'POST',
        path: '/store/order',
        summary: 'Place an order for a pet',
        tags: ['store'],
        parameters: [],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: {
            type: 'object',
            properties: {
              petId: { type: 'integer' },
              status: { type: 'string' },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            schema: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                petId: { type: 'integer' },
              },
            },
          },
        },
        security: [],
      },
      {
        operationId: 'getOrderById',
        method: 'GET',
        path: '/store/order/{orderId}',
        summary: 'Find order by ID',
        tags: ['store'],
        parameters: [
          { name: 'orderId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok' } },
        security: [],
      },
    ],
  },

  // Ideal analyst output — terse, but enough structure to pass Analyst's
  // valid-JSON check in dependency-resolver.service.ts:280
  idealAnalystOutput: {
    domain: { name: 'Pet store', description: 'Sells pets and takes orders' },
    entities: [
      {
        name: 'Pet',
        createEndpoint: 'addPet',
        idField: { fieldName: 'id', jsonPath: '$.id' },
        dependsOnEntities: [],
      },
      {
        name: 'Order',
        createEndpoint: 'placeOrder',
        idField: { fieldName: 'id', jsonPath: '$.id' },
        dependsOnEntities: ['Pet'],
      },
    ],
    authFlow: { type: 'none', steps: [], tokenExtraction: null },
    dataFlows: [
      {
        producer: 'addPet',
        field: 'id',
        jsonPath: '$.id',
        variableName: 'pet_id',
        consumers: [
          { endpoint: 'getPetById', injectionType: 'path_param', targetField: 'petId' },
          { endpoint: 'updatePet', injectionType: 'path_param', targetField: 'petId' },
          { endpoint: 'deletePet', injectionType: 'path_param', targetField: 'petId' },
          { endpoint: 'placeOrder', injectionType: 'body_field', targetField: 'petId' },
        ],
      },
      {
        producer: 'placeOrder',
        field: 'id',
        jsonPath: '$.id',
        variableName: 'order_id',
        consumers: [
          { endpoint: 'getOrderById', injectionType: 'path_param', targetField: 'orderId' },
        ],
      },
    ],
    publicEndpoints: [],
    executionPhases: [
      { phase: 1, name: 'Create', endpoints: ['addPet'], parallelizable: false },
      { phase: 2, name: 'Pet ops', endpoints: ['getPetById', 'updatePet', 'findPetsByStatus'], parallelizable: true },
      { phase: 3, name: 'Order ops', endpoints: ['placeOrder', 'getOrderById'], parallelizable: false },
      { phase: 4, name: 'Cleanup', endpoints: ['deletePet'], parallelizable: false },
    ],
    edgeCases: [],
    questions: [],
    confidence: { overall: 0.95, auth: 1, dependencies: 0.9, dataFlow: 0.9 },
  },

  idealArchitectOutput: {
    nodes: [
      {
        id: 'addPet',
        method: 'POST',
        path: '/pet',
        operationId: 'addPet',
        summary: 'Create a pet',
        tags: ['pet'],
        dependsOn: [],
        variableExtractions: [{ variableName: 'pet_id', jsonPath: '$.id' }],
        variableInjections: [],
        priority: 0,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: false,
        sampleRequestBody: null,
        expectedStatusCodes: [200, 201],
      },
      {
        id: 'getPetById',
        method: 'GET',
        path: '/pet/{petId}',
        operationId: 'getPetById',
        summary: 'Read pet',
        tags: ['pet'],
        dependsOn: ['addPet'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'pet_id', injectAs: 'path_param', targetKey: 'petId' },
        ],
        priority: 1,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: true,
        sampleRequestBody: null,
        expectedStatusCodes: [200],
      },
      {
        id: 'updatePet',
        method: 'PUT',
        path: '/pet/{petId}',
        operationId: 'updatePet',
        summary: 'Update pet',
        tags: ['pet'],
        dependsOn: ['addPet'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'pet_id', injectAs: 'path_param', targetKey: 'petId' },
        ],
        priority: 1,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: true,
        sampleRequestBody: null,
        expectedStatusCodes: [200],
      },
      {
        id: 'findPetsByStatus',
        method: 'GET',
        path: '/pet/findByStatus',
        operationId: 'findPetsByStatus',
        summary: 'List pets by status',
        tags: ['pet'],
        dependsOn: [],
        variableExtractions: [],
        variableInjections: [],
        priority: 0,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: true,
        sampleRequestBody: null,
        sampleQueryParams: { status: 'available' },
        expectedStatusCodes: [200],
      },
      {
        id: 'placeOrder',
        method: 'POST',
        path: '/store/order',
        operationId: 'placeOrder',
        summary: 'Place order',
        tags: ['store'],
        dependsOn: ['addPet'],
        variableExtractions: [{ variableName: 'order_id', jsonPath: '$.id' }],
        variableInjections: [
          { variableName: 'pet_id', injectAs: 'body_field', targetKey: 'petId' },
        ],
        priority: 1,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: false,
        sampleRequestBody: null,
        expectedStatusCodes: [200],
      },
      {
        id: 'getOrderById',
        method: 'GET',
        path: '/store/order/{orderId}',
        operationId: 'getOrderById',
        summary: 'Read order',
        tags: ['store'],
        dependsOn: ['placeOrder'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'order_id', injectAs: 'path_param', targetKey: 'orderId' },
        ],
        priority: 2,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: false,
        sampleRequestBody: null,
        expectedStatusCodes: [200],
      },
      {
        id: 'deletePet',
        method: 'DELETE',
        path: '/pet/{petId}',
        operationId: 'deletePet',
        summary: 'Delete pet',
        tags: ['pet'],
        dependsOn: ['addPet', 'getPetById', 'updatePet'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'pet_id', injectAs: 'path_param', targetKey: 'petId' },
        ],
        priority: 3,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: false,
        sampleRequestBody: null,
        expectedStatusCodes: [204],
      },
    ],
    executionOrder: [
      'addPet',
      'findPetsByStatus',
      'getPetById',
      'updatePet',
      'placeOrder',
      'getOrderById',
      'deletePet',
    ],
    summary: 'Pet store CRUD flow',
    totalEndpoints: 7,
    unsupportedEndpoints: [],
  },

  orderingConstraints: [
    // same-resource CRUD
    ['addPet', 'getPetById'],
    ['addPet', 'updatePet'],
    ['addPet', 'deletePet'],
    ['updatePet', 'deletePet'],
    ['getPetById', 'deletePet'],
    // cross-resource: Order depends on Pet existing
    ['addPet', 'placeOrder'],
    ['placeOrder', 'getOrderById'],
  ],

  expectedNodeIds: [
    'addPet',
    'getPetById',
    'updatePet',
    'deletePet',
    'findPetsByStatus',
    'placeOrder',
    'getOrderById',
  ],
};
