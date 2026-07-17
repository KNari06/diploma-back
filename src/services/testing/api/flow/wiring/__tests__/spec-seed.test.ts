import type { HttpMethod, ParsedApiSpec, ParsedEndpoint } from '../../flow.types';
import { seedNodesFromSpec, refVarName } from '../spec-seed';

function ep(partial: Partial<ParsedEndpoint> & Pick<ParsedEndpoint, 'method' | 'path'>): ParsedEndpoint {
  return {
    operationId: partial.operationId || `${partial.method}_${partial.path}`,
    method: partial.method as HttpMethod,
    path: partial.path,
    summary: '',
    tags: [],
    parameters: partial.parameters || [],
    requestBody: partial.requestBody,
    responses: partial.responses || { '200': { description: 'ok' } },
    security: partial.security || [],
  };
}

function spec(endpoints: ParsedEndpoint[]): ParsedApiSpec {
  return {
    title: 't', version: '1', specVersion: '3.0.0', baseUrl: 'https://x', authSchemes: [],
    endpoints, unsupportedEndpoints: [], sourceType: 'openapi_url',
  };
}

const byId = (nodes: ReturnType<typeof seedNodesFromSpec>, id: string) => nodes.find(n => n.id === id)!;

describe('seedNodesFromSpec', () => {
  it('refVarName canonicalizes to <name>_id', () => {
    expect(refVarName('cityId')).toBe('city_id');
    expect(refVarName('newsId')).toBe('news_id');
    expect(refVarName('city_id')).toBe('city_id');
  });

  it('seeds a Bearer auth producer when the 2xx body has a token field', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'POST', path: '/auth/login', operationId: 'login',
           responses: { '200': { description: 'ok', schema: { type: 'object', properties: { accessToken: {}, userId: {} } } } } }),
    ]));
    const n = byId(nodes, 'login');
    expect(n.isAuthEndpoint).toBe(true);
    expect(n.variableExtractions).toEqual([{ variableName: 'auth_token', jsonPath: '$.accessToken' }]);
  });

  it('seeds a cookie auth producer (Set-Cookie) when no token field is present', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'POST', path: '/admin/auth/login', operationId: 'adminLogin',
           responses: { '200': { description: 'ok', schema: { type: 'object', properties: { role: {}, userId: {} } } } } }),
    ]));
    const n = byId(nodes, 'adminLogin');
    expect(n.isAuthEndpoint).toBe(true);
    expect(n.variableExtractions).toEqual([{ variableName: 'session_token', headerSource: 'Set-Cookie' }]);
  });

  it('does NOT treat a GET under /auth as a producer', () => {
    const nodes = seedNodesFromSpec(spec([ep({ method: 'GET', path: '/auth/me', operationId: 'me' })]));
    expect(byId(nodes, 'me').isAuthEndpoint).toBe(false);
    expect(byId(nodes, 'me').variableExtractions).toEqual([]);
  });

  it('does NOT treat /auth/logout or /auth/otp/send as producers (under /auth but establish nothing)', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'POST', path: '/auth/logout', operationId: 'logout' }),
      ep({ method: 'POST', path: '/auth/otp/send', operationId: 'otpSend' }),
      ep({ method: 'POST', path: '/auth/otp/verify', operationId: 'otpVerify',
           responses: { '200': { description: 'ok', schema: { type: 'object', properties: { accessToken: {} } } } } }),
    ]));
    expect(byId(nodes, 'logout').isAuthEndpoint).toBe(false);
    expect(byId(nodes, 'otpSend').isAuthEndpoint).toBe(false);
    expect(byId(nodes, 'otpVerify').isAuthEndpoint).toBe(true); // verify DOES establish
  });

  it('detects a token-issuing endpoint on a NON-auth path (body token is ground truth)', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'POST', path: '/student/proctoring/jwt', operationId: 'proctorJwt',
           responses: { '200': { description: 'ok', schema: { type: 'object', properties: { token: {}, expiresIn: {} } } } } }),
    ]));
    const n = byId(nodes, 'proctorJwt');
    expect(n.isAuthEndpoint).toBe(true);
    expect(n.variableExtractions).toEqual([{ variableName: 'auth_token', jsonPath: '$.token' }]);
  });

  it('seeds a create producer with $.id and a list producer with $[0].id', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'POST', path: '/cities', operationId: 'createCity',
           responses: { '201': { description: 'created', schema: { type: 'object', properties: { id: {}, name: {} } } } } }),
      ep({ method: 'GET', path: '/cities', operationId: 'listCities',
           responses: { '200': { description: 'ok', schema: { type: 'array', items: { properties: { id: {}, name: {} } } } } } }),
    ]));
    expect(byId(nodes, 'createCity').variableExtractions).toEqual([{ variableName: 'city_id', jsonPath: '$.id' }]);
    expect(byId(nodes, 'listCities').variableExtractions).toEqual([{ variableName: 'city_id', jsonPath: '$[0].id' }]);
  });

  it('seeds path-param and body reference-id injections', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'GET', path: '/news/{newsId}', operationId: 'getNews',
           parameters: [{ name: 'newsId', in: 'path', required: true }] }),
      ep({ method: 'PATCH', path: '/users/me', operationId: 'updateMe',
           requestBody: { contentType: 'application/json', required: true,
             schema: { type: 'object', properties: { cityId: {}, firstName: {} } } } }),
    ]));
    expect(byId(nodes, 'getNews').variableInjections).toEqual([
      { variableName: 'news_id', injectAs: 'path_param', targetKey: 'newsId' },
    ]);
    expect(byId(nodes, 'updateMe').variableInjections).toEqual([
      { variableName: 'city_id', injectAs: 'body_field', targetKey: 'cityId' },
    ]);
  });

  it('only seeds REQUIRED reference-id query params, and ignores non-id fields', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'GET', path: '/search', operationId: 'search',
           parameters: [
             { name: 'cityId', in: 'query', required: true },
             { name: 'countryId', in: 'query', required: false },
             { name: 'q', in: 'query', required: true },
           ] }),
    ]));
    expect(byId(nodes, 'search').variableInjections).toEqual([
      { variableName: 'city_id', injectAs: 'query_param', targetKey: 'cityId' },
    ]);
  });

  it('one node per endpoint, with 2xx status codes captured', () => {
    const nodes = seedNodesFromSpec(spec([
      ep({ method: 'POST', path: '/x', operationId: 'x', responses: { '201': { description: 'c' }, '400': { description: 'b' } } }),
    ]));
    expect(nodes).toHaveLength(1);
    expect(byId(nodes, 'x').expectedStatusCodes).toEqual([201]);
  });
});
