/**
 * Auth-first fixture — blog with bearer auth.
 * Exercises autoWireAuthDependencies: all authenticated endpoints must
 * depend on the login endpoint (auth_token producer).
 *
 * Key case: ensure login runs first, and GET /posts / POST /posts
 * depend on it even if AI forgets to wire them.
 */

import type { ResolverFixture } from './types';

export const authFirstFixture: ResolverFixture = {
  name: 'auth-first',
  description: 'Blog with Bearer auth (login → authenticated endpoints)',

  spec: {
    title: 'Blog',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://blog.example.com',
    sourceType: 'openapi_url',
    authSchemes: [
      { name: 'bearerAuth', type: 'bearer', in: 'header', headerName: 'Authorization' },
    ],
    unsupportedEndpoints: [],
    endpoints: [
      {
        operationId: 'login',
        method: 'POST',
        path: '/auth/login',
        summary: 'Login',
        tags: ['auth'],
        parameters: [],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: {
            type: 'object',
            properties: { email: { type: 'string' }, password: { type: 'string' } },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            schema: {
              type: 'object',
              properties: { access_token: { type: 'string' } },
            },
          },
        },
        security: [],
      },
      {
        operationId: 'getProfile',
        method: 'GET',
        path: '/profile',
        summary: 'Get my profile',
        tags: ['user'],
        parameters: [],
        responses: { '200': { description: 'ok' } },
        security: ['bearerAuth'],
      },
      {
        operationId: 'createPost',
        method: 'POST',
        path: '/posts',
        summary: 'Create blog post',
        tags: ['posts'],
        parameters: [],
        requestBody: {
          contentType: 'application/json',
          required: true,
          schema: { type: 'object', properties: { title: { type: 'string' } } },
        },
        responses: {
          '201': {
            description: 'created',
            schema: { type: 'object', properties: { id: { type: 'integer' } } },
          },
        },
        security: ['bearerAuth'],
      },
      {
        operationId: 'getPost',
        method: 'GET',
        path: '/posts/{postId}',
        summary: 'Read post',
        tags: ['posts'],
        parameters: [
          { name: 'postId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok' } },
        security: ['bearerAuth'],
      },
      {
        operationId: 'deletePost',
        method: 'DELETE',
        path: '/posts/{postId}',
        summary: 'Delete post',
        tags: ['posts'],
        parameters: [
          { name: 'postId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { '204': { description: 'no content' } },
        security: ['bearerAuth'],
      },
    ],
  },

  idealAnalystOutput: {
    domain: { name: 'Blog', description: 'Blog with bearer auth' },
    entities: [
      { name: 'Post', createEndpoint: 'createPost', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: [] },
    ],
    authFlow: {
      type: 'simple_login',
      steps: ['login with email/password', 'use access_token as Bearer on all endpoints'],
      tokenExtraction: {
        endpoint: 'login',
        responsePath: '$.access_token',
        variableName: 'auth_token',
      },
    },
    dataFlows: [],
    publicEndpoints: ['login'],
    executionPhases: [],
    edgeCases: [],
    questions: [],
    confidence: { overall: 0.95, auth: 1, dependencies: 0.9, dataFlow: 0.9 },
  },

  idealArchitectOutput: {
    nodes: [
      {
        id: 'login',
        method: 'POST',
        path: '/auth/login',
        operationId: 'login',
        summary: 'Login',
        tags: ['auth'],
        dependsOn: [],
        variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.access_token' }],
        variableInjections: [],
        priority: 0,
        isAuthEndpoint: true,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: false,
        sampleRequestBody: null,
        expectedStatusCodes: [200],
      },
      {
        id: 'getProfile',
        method: 'GET',
        path: '/profile',
        operationId: 'getProfile',
        summary: 'Get profile',
        tags: ['user'],
        dependsOn: ['login'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
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
        id: 'createPost',
        method: 'POST',
        path: '/posts',
        operationId: 'createPost',
        summary: 'Create post',
        tags: ['posts'],
        dependsOn: ['login'],
        variableExtractions: [{ variableName: 'post_id', jsonPath: '$.id' }],
        variableInjections: [
          { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
        ],
        priority: 1,
        isAuthEndpoint: false,
        isPagination: false,
        hasFileUpload: false,
        isUnsupported: false,
        canRunParallel: false,
        sampleRequestBody: null,
        expectedStatusCodes: [201],
      },
      {
        id: 'getPost',
        method: 'GET',
        path: '/posts/{postId}',
        operationId: 'getPost',
        summary: 'Read post',
        tags: ['posts'],
        dependsOn: ['login', 'createPost'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
          { variableName: 'post_id', injectAs: 'path_param', targetKey: 'postId' },
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
        id: 'deletePost',
        method: 'DELETE',
        path: '/posts/{postId}',
        operationId: 'deletePost',
        summary: 'Delete post',
        tags: ['posts'],
        dependsOn: ['login', 'createPost', 'getPost'],
        variableExtractions: [],
        variableInjections: [
          { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
          { variableName: 'post_id', injectAs: 'path_param', targetKey: 'postId' },
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
    executionOrder: ['login', 'getProfile', 'createPost', 'getPost', 'deletePost'],
    summary: 'Auth-first blog flow',
    totalEndpoints: 5,
    unsupportedEndpoints: [],
  },

  orderingConstraints: [
    ['login', 'getProfile'],
    ['login', 'createPost'],
    ['login', 'getPost'],
    ['login', 'deletePost'],
    ['createPost', 'getPost'],
    ['createPost', 'deletePost'],
    ['getPost', 'deletePost'],
  ],

  expectedNodeIds: ['login', 'getProfile', 'createPost', 'getPost', 'deletePost'],
};
