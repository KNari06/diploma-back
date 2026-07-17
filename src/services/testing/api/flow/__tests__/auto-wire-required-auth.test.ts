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
      { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' },
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
