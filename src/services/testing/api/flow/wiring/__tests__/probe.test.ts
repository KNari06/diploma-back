import { isSafeToProbe, findValuePath, correctExtraction } from '../probe';
import type { DAGNode, VariableExtraction } from '../../flow.types';

const node = (partial: Partial<DAGNode> & Pick<DAGNode, 'method' | 'path'>): DAGNode => ({
  id: partial.path, operationId: partial.path, tags: [], dependsOn: [], variableExtractions: [], variableInjections: [],
  priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false,
  canRunParallel: false, expectedStatusCodes: [200], ...partial,
});

describe('isSafeToProbe', () => {
  it('allows GET reads', () => {
    expect(isSafeToProbe(node({ method: 'GET', path: '/orders' }))).toBe(true);
  });
  it('allows a login auth endpoint', () => {
    expect(isSafeToProbe(node({ method: 'POST', path: '/auth/login', isAuthEndpoint: true }))).toBe(true);
  });
  it('refuses register/otp (state-changing auth) and generic mutations', () => {
    expect(isSafeToProbe(node({ method: 'POST', path: '/auth/register', isAuthEndpoint: true }))).toBe(false);
    expect(isSafeToProbe(node({ method: 'POST', path: '/auth/otp/verify', isAuthEndpoint: true }))).toBe(false);
    expect(isSafeToProbe(node({ method: 'POST', path: '/orders' }))).toBe(false);
    expect(isSafeToProbe(node({ method: 'DELETE', path: '/orders/{id}' }))).toBe(false);
  });
});

describe('findValuePath', () => {
  it('finds a nested field path', () => {
    expect(findValuePath({ data: { access_token: 'x' } }, k => k === 'access_token')).toBe('$.data.access_token');
  });
  it('finds a field inside the first array element', () => {
    expect(findValuePath([{ id: 1 }], k => k === 'id')).toBe('$[0].id');
  });
  it('returns null when absent', () => {
    expect(findValuePath({ a: 1 }, k => k === 'zzz')).toBeNull();
  });
});

describe('correctExtraction', () => {
  it('rewrites an auth-token path when the token is nested elsewhere', () => {
    const ext: VariableExtraction = { variableName: 'auth_token', jsonPath: '$.accessToken' };
    const res = correctExtraction({ data: { accessToken: 'tok' } }, ext);
    expect(res?.extraction.jsonPath).toBe('$.data.accessToken');
    expect(res?.correction).toEqual({ variableName: 'auth_token', from: '$.accessToken', to: '$.data.accessToken' });
  });

  it('rewrites a list id path from $[0].id to the real wrapper', () => {
    const ext: VariableExtraction = { variableName: 'city_id', jsonPath: '$[0].id' };
    const res = correctExtraction({ items: [{ id: 42 }] }, ext);
    expect(res?.extraction.jsonPath).toBe('$.items[0].id');
  });

  it('returns null when the seeded path already resolves', () => {
    const ext: VariableExtraction = { variableName: 'auth_token', jsonPath: '$.accessToken' };
    expect(correctExtraction({ accessToken: 'tok' }, ext)).toBeNull();
  });

  it('leaves header/cookie extractions untouched', () => {
    const ext: VariableExtraction = { variableName: 'session_token', headerSource: 'Set-Cookie' };
    expect(correctExtraction({ whatever: 1 }, ext)).toBeNull();
  });

  it('returns null when the value cannot be found at all', () => {
    const ext: VariableExtraction = { variableName: 'auth_token', jsonPath: '$.accessToken' };
    expect(correctExtraction({ unrelated: 'x' }, ext)).toBeNull();
  });
});
