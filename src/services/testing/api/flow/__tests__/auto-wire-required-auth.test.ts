/**
 * autoWireRequiredAuth — deterministic auth-coverage safety net.
 *
 * Regression guard for the "authed endpoints fire before login → 401" defect:
 * the Architect left protected endpoints with no auth wiring and scheduled them
 * first. This pass wires every spec-declared auth-required endpoint to the auth
 * producer (ordering), and per mode adds a Bearer injection or strips a bogus
 * Bearer-of-cookie.
 */

jest.mock('@/services/ai/core/openai.service');

import { __testables } from '../dependency-resolver.service';
import type { DAGNode, ParsedApiSpec, ParsedEndpoint, VariableExtraction, VariableInjection } from '../flow.types';

const { autoWireRequiredAuth } = __testables;

function node(partial: Partial<DAGNode> & { id: string; method: string; path: string }): DAGNode {
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
  } as unknown as DAGNode;
}

function spec(endpoints: Array<{ method: string; path: string; security: string[] }>): ParsedApiSpec {
  return {
    title: 'T',
    version: '1',
    specVersion: '3.0.0',
    baseUrl: 'https://api.test',
    authSchemes: [],
    unsupportedEndpoints: [],
    sourceType: 'openapi' as any,
    endpoints: endpoints.map(e => ({
      operationId: `${e.method}_${e.path}`,
      method: e.method,
      path: e.path,
      summary: '',
      tags: [],
      parameters: [],
      responses: {},
      security: e.security,
    })) as ParsedEndpoint[],
  } as ParsedApiSpec;
}

const cookieExtraction: VariableExtraction = { variableName: 'auth_token', headerSource: 'Set-Cookie' };
const bodyExtraction: VariableExtraction = { variableName: 'auth_token', jsonPath: '$.accessToken' };
const bearerInjection: VariableInjection = {
  variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ',
};

describe('autoWireRequiredAuth — cookie/session mode', () => {
  const login = node({ id: 'login', method: 'POST', path: '/login', isAuthEndpoint: true, variableExtractions: [cookieExtraction] });

  it('orders a protected endpoint after login without adding a Bearer injection', () => {
    const users = node({ id: 'users', method: 'GET', path: '/users' });
    const result = autoWireRequiredAuth(
      [login, users],
      spec([{ method: 'POST', path: '/login', security: [] }, { method: 'GET', path: '/users', security: ['bearerAuth'] }]),
    );
    const wired = result.find(n => n.id === 'users')!;
    expect(wired.dependsOn).toContain('login');
    expect(wired.variableInjections).toHaveLength(0);
  });

  it('strips a bogus Authorization:Bearer-of-cookie injection the architect added', () => {
    const users = node({ id: 'users', method: 'GET', path: '/users', variableInjections: [bearerInjection] });
    const result = autoWireRequiredAuth(
      [login, users],
      spec([{ method: 'POST', path: '/login', security: [] }, { method: 'GET', path: '/users', security: ['bearerAuth'] }]),
    );
    const wired = result.find(n => n.id === 'users')!;
    expect(wired.variableInjections).toHaveLength(0);
    expect(wired.dependsOn).toContain('login');
  });
});

describe('autoWireRequiredAuth — cookie mode implicit session ordering', () => {
  // Regression guard: a cookie/session API yields EMPTY `security` on every
  // endpoint (captured HAR/curl set it only from a Bearer header), and a refresh
  // endpoint is seeded as a producer (its path matches an establish segment).
  // Both used to leave endpoints running before/alongside login → 401.
  const adminLogin = node({
    id: 'adminLogin', method: 'POST', path: '/api/v1/admin/auth/login',
    isAuthEndpoint: true, variableExtractions: [cookieExtraction],
  });

  it('orders a refresh endpoint AFTER login (does not treat it as a co-equal producer)', () => {
    const refresh = node({
      id: 'refresh', method: 'POST', path: '/api/v1/admin/auth/refresh',
      isAuthEndpoint: true, variableExtractions: [cookieExtraction],
    });
    const result = autoWireRequiredAuth(
      [adminLogin, refresh],
      spec([
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'POST', path: '/api/v1/admin/auth/refresh', security: [] },
      ]),
    );
    expect(result.find(n => n.id === 'refresh')!.dependsOn).toEqual(['adminLogin']);
    expect(result.find(n => n.id === 'adminLogin')!.dependsOn).toHaveLength(0);
  });

  it('orders a realm member with EMPTY security after login (cookie session is implicit)', () => {
    const companies = node({ id: 'companies', method: 'GET', path: '/api/v1/admin/companies' });
    const result = autoWireRequiredAuth(
      [adminLogin, companies],
      spec([
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'GET', path: '/api/v1/admin/companies', security: [] },
      ]),
    );
    expect(result.find(n => n.id === 'companies')!.dependsOn).toContain('adminLogin');
  });

  it('does NOT order an endpoint outside the realm prefix (no over-chaining)', () => {
    const health = node({ id: 'health', method: 'GET', path: '/api/v1/public/health' });
    const result = autoWireRequiredAuth(
      [adminLogin, health],
      spec([
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'GET', path: '/api/v1/public/health', security: [] },
      ]),
    );
    expect(result.find(n => n.id === 'health')!.dependsOn).toHaveLength(0);
  });

  it('never makes a refresh-only realm producer depend on itself', () => {
    const refreshOnly = node({
      id: 'refreshOnly', method: 'POST', path: '/auth/refresh',
      isAuthEndpoint: true, variableExtractions: [cookieExtraction],
    });
    const result = autoWireRequiredAuth(
      [refreshOnly],
      spec([{ method: 'POST', path: '/auth/refresh', security: [] }]),
    );
    expect(result.find(n => n.id === 'refreshOnly')!.dependsOn).toHaveLength(0);
  });

  it('trusts declared security in cookie mode: a public endpoint stays free while a protected one is ordered', () => {
    // Annotated cookie OpenAPI — security IS declared somewhere, so we do NOT
    // blindly chain every realm member. `health` (security: []) stays free.
    const companies = node({ id: 'companies', method: 'GET', path: '/api/v1/admin/companies' });
    const health = node({ id: 'health', method: 'GET', path: '/api/v1/admin/health' });
    const result = autoWireRequiredAuth(
      [adminLogin, companies, health],
      spec([
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'GET', path: '/api/v1/admin/companies', security: ['cookieAuth'] },
        { method: 'GET', path: '/api/v1/admin/health', security: [] },
      ]),
    );
    expect(result.find(n => n.id === 'companies')!.dependsOn).toContain('adminLogin');
    expect(result.find(n => n.id === 'health')!.dependsOn).toHaveLength(0);
  });

  it('prefers a bearer (body-token) producer over a guessed cookie producer in the same realm', () => {
    // A /register that returns no body token is seeded as a Set-Cookie producer;
    // /login returns a real body token. In one realm the realm producer must be
    // login (bearer) — else the realm flips to cookie mode and protected endpoints
    // get NO Authorization token and run unauthenticated.
    const register = node({
      id: 'register', method: 'POST', path: '/auth/register',
      isAuthEndpoint: true, variableExtractions: [{ variableName: 'session_token', headerSource: 'Set-Cookie' }],
    });
    const login = node({
      id: 'login', method: 'POST', path: '/auth/login',
      isAuthEndpoint: true, variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.token' }],
    });
    const authors = node({ id: 'authors', method: 'GET', path: '/authors' });
    const result = autoWireRequiredAuth(
      [register, login, authors],
      spec([
        { method: 'POST', path: '/auth/register', security: [] },
        { method: 'POST', path: '/auth/login', security: [] },
        { method: 'GET', path: '/authors', security: ['bearerAuth'] },
      ]),
    );
    const a = result.find(n => n.id === 'authors')!;
    expect(a.dependsOn).toContain('login');
    expect(a.dependsOn).not.toContain('register');
    expect(a.variableInjections).toEqual([
      { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ', sourceNodeId: 'login' },
    ]);
  });

  it('still orders refresh after login even when the spec declares security elsewhere', () => {
    // refresh ordering is semantic, not `security`-gated: it must run after login
    // regardless of annotations.
    const refresh = node({
      id: 'refresh', method: 'POST', path: '/api/v1/admin/auth/refresh',
      isAuthEndpoint: true, variableExtractions: [cookieExtraction],
    });
    const companies = node({ id: 'companies', method: 'GET', path: '/api/v1/admin/companies' });
    const result = autoWireRequiredAuth(
      [adminLogin, refresh, companies],
      spec([
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'POST', path: '/api/v1/admin/auth/refresh', security: [] },
        { method: 'GET', path: '/api/v1/admin/companies', security: ['cookieAuth'] },
      ]),
    );
    expect(result.find(n => n.id === 'refresh')!.dependsOn).toEqual(['adminLogin']);
  });
});

describe('autoWireRequiredAuth — bearer mode', () => {
  const login = node({ id: 'login', method: 'POST', path: '/login', isAuthEndpoint: true, variableExtractions: [bodyExtraction] });

  it('orders after login AND adds a missing Authorization:Bearer injection', () => {
    const users = node({ id: 'users', method: 'GET', path: '/users' });
    const result = autoWireRequiredAuth(
      [login, users],
      spec([{ method: 'POST', path: '/login', security: [] }, { method: 'GET', path: '/users', security: ['bearerAuth'] }]),
    );
    const wired = result.find(n => n.id === 'users')!;
    expect(wired.dependsOn).toContain('login');
    expect(wired.variableInjections).toEqual([
      { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ', sourceNodeId: 'login' },
    ]);
  });

  it('does not duplicate an injection the architect already set', () => {
    const users = node({ id: 'users', method: 'GET', path: '/users', variableInjections: [bearerInjection] });
    const result = autoWireRequiredAuth(
      [login, users],
      spec([{ method: 'POST', path: '/login', security: [] }, { method: 'GET', path: '/users', security: ['bearerAuth'] }]),
    );
    expect(result.find(n => n.id === 'users')!.variableInjections).toHaveLength(1);
  });
});

describe('autoWireRequiredAuth — invariants', () => {
  const login = node({ id: 'login', method: 'POST', path: '/login', isAuthEndpoint: true, variableExtractions: [bodyExtraction] });

  it('leaves public (no-security) endpoints untouched', () => {
    const health = node({ id: 'health', method: 'GET', path: '/health' });
    const result = autoWireRequiredAuth(
      [login, health],
      spec([{ method: 'POST', path: '/login', security: [] }, { method: 'GET', path: '/health', security: [] }]),
    );
    const h = result.find(n => n.id === 'health')!;
    expect(h.dependsOn).toHaveLength(0);
    expect(h.variableInjections).toHaveLength(0);
  });

  it('never makes an auth producer depend on itself', () => {
    const result = autoWireRequiredAuth(
      [login],
      spec([{ method: 'POST', path: '/login', security: ['bearerAuth'] }]),
    );
    expect(result.find(n => n.id === 'login')!.dependsOn).toHaveLength(0);
  });

  it('is a no-op when there is no auth producer', () => {
    const users = node({ id: 'users', method: 'GET', path: '/users' });
    const input = [users];
    const result = autoWireRequiredAuth(
      input,
      spec([{ method: 'GET', path: '/users', security: ['bearerAuth'] }]),
    );
    expect(result).toBe(input);
  });

  it('wires protected endpoints to the TERMINAL auth producer (session establisher), not the first', () => {
    // verifyOtp only yields a registration token for a new account; register is
    // the step that establishes the session. Protected endpoints must depend on
    // register, not verifyOtp.
    const verifyOtp = node({ id: 'verifyOtp', method: 'POST', path: '/auth/otp/verify', isAuthEndpoint: true, variableExtractions: [bodyExtraction] });
    const register = node({ id: 'register', method: 'POST', path: '/auth/register', isAuthEndpoint: true, dependsOn: ['verifyOtp'], variableExtractions: [bodyExtraction] });
    const refresh = node({ id: 'refresh', method: 'POST', path: '/auth/refresh', isAuthEndpoint: true, dependsOn: ['register'], variableExtractions: [bodyExtraction] });
    const users = node({ id: 'users', method: 'GET', path: '/users' });
    const result = autoWireRequiredAuth(
      [verifyOtp, register, refresh, users],
      spec([
        { method: 'POST', path: '/auth/otp/verify', security: [] },
        { method: 'POST', path: '/auth/register', security: [] },
        { method: 'POST', path: '/auth/refresh', security: [] },
        { method: 'GET', path: '/users', security: ['bearerAuth'] },
      ]),
    );
    const u = result.find(n => n.id === 'users')!;
    expect(u.dependsOn).toContain('register');
    expect(u.dependsOn).not.toContain('verifyOtp');
    expect(u.dependsOn).not.toContain('refresh'); // refresh endpoints are excluded
  });

  it('wires each protected endpoint to its OWN realm auth producer (multi-realm)', () => {
    const adminLogin = node({ id: 'adminLogin', method: 'POST', path: '/api/v1/admin/auth/login', isAuthEndpoint: true, variableExtractions: [bodyExtraction] });
    const register = node({ id: 'register', method: 'POST', path: '/api/v1/auth/register', isAuthEndpoint: true, variableExtractions: [bodyExtraction] });
    const adminUsers = node({ id: 'adminUsers', method: 'GET', path: '/api/v1/admin/users' });
    const creators = node({ id: 'creators', method: 'GET', path: '/api/v1/creators/me' });
    const result = autoWireRequiredAuth(
      [adminLogin, register, adminUsers, creators],
      spec([
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'POST', path: '/api/v1/auth/register', security: [] },
        { method: 'GET', path: '/api/v1/admin/users', security: ['bearerAuth'] },
        { method: 'GET', path: '/api/v1/creators/me', security: ['bearerAuth'] },
      ]),
    );
    // /admin/* → admin login; user-realm endpoint → register (NOT crossed over)
    expect(result.find(n => n.id === 'adminUsers')!.dependsOn).toEqual(['adminLogin']);
    expect(result.find(n => n.id === 'creators')!.dependsOn).toEqual(['register']);
  });

  it('does not inject auth into a bootstrap endpoint that precedes the token producer', () => {
    // verifyOtp produces the token but depends on sendOtp — sendOtp runs BEFORE
    // any token exists, so it must not get an Authorization injection.
    const sendOtp = node({ id: 'sendOtp', method: 'POST', path: '/otp/send' });
    const verifyOtp = node({
      id: 'verifyOtp', method: 'POST', path: '/otp/verify',
      isAuthEndpoint: true, dependsOn: ['sendOtp'], variableExtractions: [bodyExtraction],
    });
    const result = autoWireRequiredAuth(
      [sendOtp, verifyOtp],
      spec([
        { method: 'POST', path: '/otp/send', security: ['bearerAuth'] },
        { method: 'POST', path: '/otp/verify', security: ['bearerAuth'] },
      ]),
    );
    const s = result.find(n => n.id === 'sendOtp')!;
    expect(s.variableInjections).toHaveLength(0);
    expect(s.dependsOn).toHaveLength(0);
  });
});

describe('autoWireRequiredAuth — binding-by-reference (multi-realm)', () => {
  it('binds each protected endpoint to ITS realm producer via sourceNodeId', () => {
    const userLogin = node({
      id: 'user_login', method: 'POST', path: '/api/v1/auth/login',
      isAuthEndpoint: true, variableExtractions: [bodyExtraction],
    });
    const adminLogin = node({
      id: 'admin_login', method: 'POST', path: '/api/v1/admin/auth/login',
      isAuthEndpoint: true, variableExtractions: [bodyExtraction],
    });
    const userThing = node({ id: 'user_thing', method: 'GET', path: '/api/v1/things' });
    const adminThing = node({ id: 'admin_thing', method: 'GET', path: '/api/v1/admin/things' });

    const result = autoWireRequiredAuth(
      [userLogin, adminLogin, userThing, adminThing],
      spec([
        { method: 'POST', path: '/api/v1/auth/login', security: [] },
        { method: 'POST', path: '/api/v1/admin/auth/login', security: [] },
        { method: 'GET', path: '/api/v1/things', security: ['bearerAuth'] },
        { method: 'GET', path: '/api/v1/admin/things', security: ['bearerAuth'] },
      ]),
    );

    const ut = result.find(n => n.id === 'user_thing')!;
    const at = result.find(n => n.id === 'admin_thing')!;
    // Admin endpoint binds to the admin login; user endpoint to the user login —
    // so the flat `auth_token` slot last-write-wins can no longer cross realms.
    expect(at.variableInjections[0]).toMatchObject({ targetKey: 'Authorization', sourceNodeId: 'admin_login' });
    expect(at.dependsOn).toContain('admin_login');
    expect(ut.variableInjections[0]).toMatchObject({ targetKey: 'Authorization', sourceNodeId: 'user_login' });
    expect(ut.dependsOn).toContain('user_login');
  });
});
