/**
 * Eval-harness fixtures — hand-authored `{ spec, dag }` pairs that exercise the
 * scorer in metrics.ts against the shapes the current pipeline actually emits.
 *
 * Each fixture pins a KNOWN structural verdict (via `expect`) so the metrics
 * tests double as a regression suite for the scorer itself: "good" DAGs must
 * pass every hard invariant, "bad" DAGs must trip exactly the invariant they
 * were built to break. When we later swap the pipeline, feeding its real output
 * through the same scorer tells us whether quality moved — without trusting the
 * pipeline to grade its own homework.
 */

import type { DAGNode, HttpMethod, ParsedApiSpec, ParsedEndpoint } from '../flow.types';
import type { EvalScore } from './metrics';

// ── tiny builders (keep fixtures readable) ────────────────────────────────────

function ep(method: HttpMethod, path: string, security: string[] = []): ParsedEndpoint {
  return {
    operationId: `${method}_${path}`,
    method,
    path,
    summary: `${method} ${path}`,
    tags: [],
    parameters: [],
    responses: { '200': { description: 'ok' } },
    security,
  };
}

function mkSpec(endpoints: ParsedEndpoint[]): ParsedApiSpec {
  return {
    title: 'fixture',
    version: '1.0',
    specVersion: '3.0.0',
    baseUrl: 'https://api.example.com',
    authSchemes: [{ name: 'bearerAuth', type: 'bearer' }],
    endpoints,
    unsupportedEndpoints: [],
    sourceType: 'openapi_url',
  };
}

function node(partial: Partial<DAGNode> & Pick<DAGNode, 'id' | 'method' | 'path'>): DAGNode {
  return {
    operationId: partial.id,
    summary: '',
    tags: [],
    dependsOn: [],
    variableExtractions: [],
    variableInjections: [],
    priority: 0,
    isAuthEndpoint: false,
    isPagination: false,
    hasFileUpload: false,
    isUnsupported: false,
    canRunParallel: false,
    expectedStatusCodes: [200],
    ...partial,
  };
}

export interface Fixture {
  name: string;
  spec: ParsedApiSpec;
  nodes: DAGNode[];
  executionOrder: string[];
  providedVars?: string[];
  /** Expected verdict on the metrics that this fixture is designed to exercise. */
  expect: Partial<Pick<EvalScore, 'passed' | 'orderingViolations' | 'unresolvedInjections' | 'hasCycle' | 'fabricatedReferenceIds'>> & {
    authCoveragePct?: number;
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const login = () =>
  node({
    id: 'login',
    method: 'POST',
    path: '/auth/login',
    isAuthEndpoint: true,
    variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.data.access_token' }],
  });

const bearerGet = (id: string, path: string) =>
  node({
    id,
    method: 'GET',
    path,
    dependsOn: ['login'],
    variableInjections: [
      { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
    ],
  });

export const FIXTURES: Fixture[] = [
  // 1. Textbook bearer flow — everything wired correctly.
  {
    name: 'simple-bearer-good',
    spec: mkSpec([ep('POST', '/auth/login'), ep('GET', '/users', ['bearerAuth']), ep('GET', '/orders', ['bearerAuth'])]),
    nodes: [login(), bearerGet('getUsers', '/users'), bearerGet('getOrders', '/orders')],
    executionOrder: ['login', 'getUsers', 'getOrders'],
    expect: { passed: true, orderingViolations: 0, unresolvedInjections: 0, hasCycle: false, authCoveragePct: 100 },
  },

  // 2. Consumer scheduled before its producer — ordering violation.
  {
    name: 'bad-ordering',
    spec: mkSpec([ep('POST', '/auth/login'), ep('GET', '/users', ['bearerAuth'])]),
    nodes: [login(), bearerGet('getUsers', '/users')],
    executionOrder: ['getUsers', 'login'], // consumer first — wrong
    expect: { passed: false, orderingViolations: 1 },
  },

  // 3. Auth-required endpoint that doesn't depend on the auth producer.
  {
    name: 'missing-auth-wiring',
    spec: mkSpec([ep('POST', '/auth/login'), ep('GET', '/users', ['bearerAuth'])]),
    nodes: [
      login(),
      node({ id: 'getUsers', method: 'GET', path: '/users' }), // no dependsOn, no injection
    ],
    executionOrder: ['login', 'getUsers'],
    expect: { passed: false, authCoveragePct: 0 },
  },

  // 4. Cookie-session auth (token extracted from Set-Cookie header, not a JSON body).
  {
    name: 'cookie-session-good',
    spec: mkSpec([ep('POST', '/auth/login'), ep('GET', '/profile', ['cookieAuth'])]),
    nodes: [
      node({
        id: 'login',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
        variableExtractions: [{ variableName: 'session_token', headerSource: 'Set-Cookie' }],
      }),
      node({
        id: 'getProfile',
        method: 'GET',
        path: '/profile',
        dependsOn: ['login'],
        variableInjections: [{ variableName: 'session_token', injectAs: 'header', targetKey: 'Cookie' }],
      }),
    ],
    executionOrder: ['login', 'getProfile'],
    expect: { passed: true, authCoveragePct: 100, unresolvedInjections: 0 },
  },

  // 5. Injects a variable nobody produces and the run doesn't provide.
  {
    name: 'unresolved-injection',
    spec: mkSpec([ep('GET', '/reports')]),
    nodes: [
      node({
        id: 'getReport',
        method: 'GET',
        path: '/reports',
        variableInjections: [{ variableName: 'report_id', injectAs: 'query_param', targetKey: 'id' }],
      }),
    ],
    executionOrder: ['getReport'],
    expect: { passed: false, unresolvedInjections: 1 },
  },

  // 6. Same injection, but the run PROVIDES the value (variableChain / initialVariables).
  {
    name: 'provided-var-resolves',
    spec: mkSpec([ep('GET', '/reports')]),
    nodes: [
      node({
        id: 'getReport',
        method: 'GET',
        path: '/reports',
        variableInjections: [{ variableName: 'report_id', injectAs: 'query_param', targetKey: 'id' }],
      }),
    ],
    executionOrder: ['getReport'],
    providedVars: ['report_id'],
    expect: { passed: true, unresolvedInjections: 0 },
  },

  // 7. Dependency cycle — A ⇄ B.
  {
    name: 'dependency-cycle',
    spec: mkSpec([ep('GET', '/a'), ep('GET', '/b')]),
    nodes: [
      node({ id: 'a', method: 'GET', path: '/a', dependsOn: ['b'] }),
      node({ id: 'b', method: 'GET', path: '/b', dependsOn: ['a'] }),
    ],
    executionOrder: ['a', 'b'],
    expect: { passed: false, hasCycle: true },
  },

  // 8. Fabricated reference id — a *Id body field left as an invented literal.
  {
    name: 'fabricated-reference-id',
    spec: mkSpec([ep('POST', '/auth/login'), ep('POST', '/orders', ['bearerAuth'])]),
    nodes: [
      login(),
      node({
        id: 'createOrder',
        method: 'POST',
        path: '/orders',
        dependsOn: ['login'],
        variableInjections: [
          { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
        ],
        sampleRequestBody: { customerId: '12345', item: { productId: 'abc-999' }, note: 'test' },
      }),
    ],
    executionOrder: ['login', 'createOrder'],
    // Auth is wired, so it PASSES hard invariants; fabricated ids are a soft signal only.
    expect: { passed: true, fabricatedReferenceIds: 2 },
  },

  // 9. Multi-realm auth — admin realm and user realm, each covered by its own producer.
  {
    name: 'multi-realm-good',
    spec: mkSpec([
      ep('POST', '/admin/auth/login'),
      ep('POST', '/auth/login'),
      ep('GET', '/admin/users', ['adminAuth']),
      ep('GET', '/me', ['bearerAuth']),
    ]),
    nodes: [
      node({
        id: 'adminLogin',
        method: 'POST',
        path: '/admin/auth/login',
        isAuthEndpoint: true,
        variableExtractions: [{ variableName: 'admin_token', jsonPath: '$.token' }],
      }),
      node({
        id: 'userLogin',
        method: 'POST',
        path: '/auth/login',
        isAuthEndpoint: true,
        variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.token' }],
      }),
      node({
        id: 'adminUsers',
        method: 'GET',
        path: '/admin/users',
        dependsOn: ['adminLogin'],
        variableInjections: [
          { variableName: 'admin_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
        ],
      }),
      node({
        id: 'me',
        method: 'GET',
        path: '/me',
        dependsOn: ['userLogin'],
        variableInjections: [
          { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
        ],
      }),
    ],
    executionOrder: ['adminLogin', 'userLogin', 'adminUsers', 'me'],
    expect: { passed: true, authCoveragePct: 100 },
  },
];
