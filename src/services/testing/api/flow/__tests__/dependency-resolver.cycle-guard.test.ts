/**
 * CYCLE GUARD MEASUREMENT — checks that Rule 5 and Rule 6 never introduce
 * a cycle when the AI (or another rule) has already wired the reverse edge.
 *
 * These are adversarial fixtures constructed specifically to tempt the
 * auto-wire rules into creating A→B→A cycles:
 *
 *   Test 1 — Rule 5 backwards pre-wiring:
 *     AI says nested-DELETE depends on parent-DELETE. Rule 5 would want
 *     to add parent→nested. Without the guard, we'd have a 2-cycle.
 *
 *   Test 2 — Rule 6 mutual body references:
 *     POST A has body {bId}, POST B has body {aId}. Rule 6 would want
 *     to wire both ways. Without the guard, we'd have a 2-cycle.
 *
 * Success criterion: final DAG has zero cycles (topologicalSort reports none)
 * AND all expected nodes survive.
 */

jest.mock('@/services/ai/core/openai.service');

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import { DependencyResolverService } from '../dependency-resolver.service';
import type { ParsedApiSpec } from '../flow.types';

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Rule 5 cycle guard
// ─────────────────────────────────────────────────────────────────────────────

const rule5CycleSpec: ParsedApiSpec = {
  title: 'Rule5CycleTest',
  version: '1.0',
  specVersion: '3.0.0',
  baseUrl: 'https://example.com',
  authSchemes: [],
  sourceType: 'openapi_url',
  unsupportedEndpoints: [],
  endpoints: [
    {
      operationId: 'createStudent',
      method: 'POST',
      path: '/students',
      summary: '',
      tags: [],
      parameters: [],
      requestBody: { contentType: 'application/json', required: true, schema: { type: 'object', properties: { name: { type: 'string' } } } },
      responses: { '200': { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
      security: [],
    },
    {
      operationId: 'createGrade',
      method: 'POST',
      path: '/students/{studentId}/grades',
      summary: '',
      tags: [],
      parameters: [{ name: 'studentId', in: 'path', required: true, schema: { type: 'integer' } }],
      requestBody: { contentType: 'application/json', required: true, schema: { type: 'object', properties: { score: { type: 'integer' } } } },
      responses: { '200': { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
      security: [],
    },
    {
      operationId: 'deleteStudent',
      method: 'DELETE',
      path: '/students/{studentId}',
      summary: '',
      tags: [],
      parameters: [{ name: 'studentId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { '204': { description: 'no content' } },
      security: [],
    },
    {
      operationId: 'deleteGrade',
      method: 'DELETE',
      path: '/students/{studentId}/grades/{gradeId}',
      summary: '',
      tags: [],
      parameters: [
        { name: 'studentId', in: 'path', required: true, schema: { type: 'integer' } },
        { name: 'gradeId', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      responses: { '204': { description: 'no content' } },
      security: [],
    },
  ],
};

// AI output: DeleteGrade pre-wired to depend on DeleteStudent (WRONG direction,
// but possible AI mistake). Without Rule 5 cycle guard, Rule 5 would then
// add DeleteStudent → DeleteGrade, creating a cycle.
const rule5CycleArchitect = {
  nodes: [
    {
      id: 'createStudent', method: 'POST', path: '/students', operationId: 'createStudent',
      summary: '', tags: [], dependsOn: [],
      variableExtractions: [{ variableName: 'student_id', jsonPath: '$.id' }],
      variableInjections: [],
      priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
    {
      id: 'createGrade', method: 'POST', path: '/students/{studentId}/grades', operationId: 'createGrade',
      summary: '', tags: [], dependsOn: ['createStudent'],
      variableExtractions: [{ variableName: 'grade_id', jsonPath: '$.id' }],
      variableInjections: [{ variableName: 'student_id', injectAs: 'path_param', targetKey: 'studentId' }],
      priority: 1, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
    {
      id: 'deleteStudent', method: 'DELETE', path: '/students/{studentId}', operationId: 'deleteStudent',
      summary: '', tags: [], dependsOn: ['createStudent'],
      variableExtractions: [], variableInjections: [{ variableName: 'student_id', injectAs: 'path_param', targetKey: 'studentId' }],
      priority: 2, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [204],
    },
    {
      // THE ADVERSARIAL BIT: AI said deleteGrade depends on deleteStudent.
      // That's topologically wrong (grade must be deleted BEFORE student),
      // but AI does make mistakes. Rule 5 would naively add the reverse edge.
      id: 'deleteGrade', method: 'DELETE', path: '/students/{studentId}/grades/{gradeId}', operationId: 'deleteGrade',
      summary: '', tags: [],
      dependsOn: ['deleteStudent', 'createGrade'],
      variableExtractions: [],
      variableInjections: [
        { variableName: 'student_id', injectAs: 'path_param', targetKey: 'studentId' },
        { variableName: 'grade_id', injectAs: 'path_param', targetKey: 'gradeId' },
      ],
      priority: 3, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [204],
    },
  ],
  executionOrder: ['createStudent', 'createGrade', 'deleteStudent', 'deleteGrade'],
  summary: '',
  totalEndpoints: 4,
  unsupportedEndpoints: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Rule 6 cycle guard (mutual body references)
// ─────────────────────────────────────────────────────────────────────────────

const rule6CycleSpec: ParsedApiSpec = {
  title: 'Rule6CycleTest',
  version: '1.0',
  specVersion: '3.0.0',
  baseUrl: 'https://example.com',
  authSchemes: [],
  sourceType: 'openapi_url',
  unsupportedEndpoints: [],
  endpoints: [
    {
      operationId: 'createUser',
      method: 'POST',
      path: '/users',
      summary: '',
      tags: [],
      parameters: [],
      // body references orderId → would try to wire createUser → createOrder
      requestBody: {
        contentType: 'application/json',
        required: true,
        schema: { type: 'object', properties: { name: { type: 'string' }, orderId: { type: 'integer' } } },
      },
      responses: { '200': { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
      security: [],
    },
    {
      operationId: 'createOrder',
      method: 'POST',
      path: '/orders',
      summary: '',
      tags: [],
      parameters: [],
      // body references userId → would try to wire createOrder → createUser
      requestBody: {
        contentType: 'application/json',
        required: true,
        schema: { type: 'object', properties: { total: { type: 'number' }, userId: { type: 'integer' } } },
      },
      responses: { '200': { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } } } } },
      security: [],
    },
  ],
};

// AI pre-wires createOrder → createUser. Rule 6 would then try to wire
// createUser → createOrder from the orderId body field. Without guard: cycle.
const rule6CycleArchitect = {
  nodes: [
    {
      id: 'createUser', method: 'POST', path: '/users', operationId: 'createUser',
      summary: '', tags: [], dependsOn: [], // no deps — Rule 6 will try to add one
      variableExtractions: [{ variableName: 'user_id', jsonPath: '$.id' }],
      variableInjections: [],
      priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
    {
      id: 'createOrder', method: 'POST', path: '/orders', operationId: 'createOrder',
      summary: '', tags: [],
      dependsOn: ['createUser'], // AI pre-wired this direction
      variableExtractions: [{ variableName: 'order_id', jsonPath: '$.id' }],
      variableInjections: [{ variableName: 'user_id', injectAs: 'body_field', targetKey: 'userId' }],
      priority: 1, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
      isUnsupported: false, canRunParallel: false, sampleRequestBody: null, expectedStatusCodes: [200],
    },
  ],
  executionOrder: ['createUser', 'createOrder'],
  summary: '',
  totalEndpoints: 2,
  unsupportedEndpoints: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Analyst output (reused)
// ─────────────────────────────────────────────────────────────────────────────

const analystGood = {
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
    if (i === 0) return { content: JSON.stringify(analystGood), usage: {} };
    if (i === 1) return { content: JSON.stringify(architect), usage: {} };
    return { content: JSON.stringify({ samples: {} }), usage: {} };
  });
}

/**
 * Verify a DAG has no cycles by running topological sort: if every node
 * appears in executionOrder with all its dependsOn predecessors strictly
 * earlier, there's no cycle.
 */
function hasNoCycles(dag: { nodes: any[]; executionOrder: string[] }): boolean {
  const pos = new Map(dag.executionOrder.map((id, i) => [id, i]));
  for (const node of dag.nodes) {
    const myPos = pos.get(node.id);
    if (myPos === undefined) return false;
    for (const dep of node.dependsOn) {
      const depPos = pos.get(dep);
      if (depPos === undefined) continue;
      if (depPos >= myPos) return false; // parent appears after child
    }
  }
  return true;
}

describe('cycle guard experiment', () => {
  beforeEach(() => {
    (logger.info as unknown as jest.Mock).mockClear();
    (logger.warn as unknown as jest.Mock).mockClear();
  });

  test('Rule 5 cycle guard: adversarial nested-delete pre-wire does not cycle', async () => {
    (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mockAi(rule5CycleArchitect));
    const result = await DependencyResolverService.resolve(rule5CycleSpec);
    expect(result.dag).toBeDefined();
    // All 4 nodes must still be present
    expect(result.dag!.nodes).toHaveLength(4);
    // No cycles
    expect(hasNoCycles(result.dag!)).toBe(true);
  }, 30_000);

  test('Rule 6 cycle guard: mutual body references do not cycle', async () => {
    (getChatCompletionWithMessages as unknown as jest.Mock).mockImplementation(mockAi(rule6CycleArchitect));
    const result = await DependencyResolverService.resolve(rule6CycleSpec);
    expect(result.dag).toBeDefined();
    expect(result.dag!.nodes).toHaveLength(2);
    expect(hasNoCycles(result.dag!)).toBe(true);
  }, 30_000);
});
