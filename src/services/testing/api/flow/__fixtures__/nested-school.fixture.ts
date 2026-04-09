/**
 * Nested-resource fixture — School API with Students and Grades.
 * Stress-test for autoWireCrudDependencies Rule 3 (nested resource → parent POST).
 *
 * Key case: POST /students/{studentId}/grades must depend on POST /students.
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
  tags: ['school'],
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

const node = (
  id: string,
  method: any,
  path: string,
  dependsOn: string[] = [],
  extractVar: string | null = null,
  injectVars: Array<{ name: string; targetKey: string }> = [],
) => ({
  id,
  method,
  path,
  operationId: id,
  summary: id,
  tags: ['school'],
  dependsOn,
  variableExtractions: extractVar
    ? [{ variableName: extractVar, jsonPath: '$.id' }]
    : [],
  variableInjections: injectVars.map(v => ({
    variableName: v.name,
    injectAs: 'path_param' as const,
    targetKey: v.targetKey,
  })),
  priority: dependsOn.length,
  isAuthEndpoint: false,
  isPagination: false,
  hasFileUpload: false,
  isUnsupported: false,
  canRunParallel: false,
  sampleRequestBody: null,
  expectedStatusCodes: [200, 201],
});

export const nestedSchoolFixture: ResolverFixture = {
  name: 'nested-school',
  description: 'Nested resources: students + grades under each student',
  spec: {
    title: 'School',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://school.example.com/api/v1',
    authSchemes: [],
    sourceType: 'openapi_url',
    unsupportedEndpoints: [],
    endpoints: [
      ep('createStudent', 'POST', '/students', [], true),
      ep('getStudent', 'GET', '/students/{studentId}', ['studentId']),
      ep('deleteStudent', 'DELETE', '/students/{studentId}', ['studentId']),
      ep('createGrade', 'POST', '/students/{studentId}/grades', ['studentId'], true),
      ep('getGrade', 'GET', '/students/{studentId}/grades/{gradeId}', ['studentId', 'gradeId']),
      ep('deleteGrade', 'DELETE', '/students/{studentId}/grades/{gradeId}', ['studentId', 'gradeId']),
    ],
  },

  idealAnalystOutput: {
    domain: { name: 'School', description: 'Students and grades' },
    entities: [
      { name: 'Student', createEndpoint: 'createStudent', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: [] },
      { name: 'Grade', createEndpoint: 'createGrade', idField: { fieldName: 'id', jsonPath: '$.id' }, dependsOnEntities: ['Student'] },
    ],
    authFlow: { type: 'none', steps: [] },
    dataFlows: [],
    publicEndpoints: [],
    executionPhases: [],
    edgeCases: [],
    questions: [],
    confidence: { overall: 0.9, auth: 1, dependencies: 0.9, dataFlow: 0.9 },
  },

  idealArchitectOutput: {
    nodes: [
      node('createStudent', 'POST', '/students', [], 'student_id'),
      node(
        'getStudent',
        'GET',
        '/students/{studentId}',
        ['createStudent'],
        null,
        [{ name: 'student_id', targetKey: 'studentId' }],
      ),
      node(
        'createGrade',
        'POST',
        '/students/{studentId}/grades',
        ['createStudent'],
        'grade_id',
        [{ name: 'student_id', targetKey: 'studentId' }],
      ),
      node(
        'getGrade',
        'GET',
        '/students/{studentId}/grades/{gradeId}',
        ['createStudent', 'createGrade'],
        null,
        [
          { name: 'student_id', targetKey: 'studentId' },
          { name: 'grade_id', targetKey: 'gradeId' },
        ],
      ),
      node(
        'deleteGrade',
        'DELETE',
        '/students/{studentId}/grades/{gradeId}',
        ['createGrade', 'getGrade'],
        null,
        [
          { name: 'student_id', targetKey: 'studentId' },
          { name: 'grade_id', targetKey: 'gradeId' },
        ],
      ),
      node(
        'deleteStudent',
        'DELETE',
        '/students/{studentId}',
        ['createStudent', 'getStudent', 'deleteGrade'],
        null,
        [{ name: 'student_id', targetKey: 'studentId' }],
      ),
    ],
    executionOrder: [
      'createStudent',
      'getStudent',
      'createGrade',
      'getGrade',
      'deleteGrade',
      'deleteStudent',
    ],
    summary: 'School nested CRUD',
    totalEndpoints: 6,
    unsupportedEndpoints: [],
  },

  orderingConstraints: [
    ['createStudent', 'getStudent'],
    ['createStudent', 'deleteStudent'],
    ['createStudent', 'createGrade'],
    ['createGrade', 'getGrade'],
    ['createGrade', 'deleteGrade'],
    ['getGrade', 'deleteGrade'],
    // grades must be deleted before their parent student
    ['deleteGrade', 'deleteStudent'],
  ],

  expectedNodeIds: [
    'createStudent',
    'getStudent',
    'createGrade',
    'getGrade',
    'deleteGrade',
    'deleteStudent',
  ],
};
