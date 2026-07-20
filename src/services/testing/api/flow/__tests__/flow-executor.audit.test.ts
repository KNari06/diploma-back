/**
 * Audit test cases for the flow executor's request-building logic.
 *
 * These exercise `buildResolvedRequest` / `setByJsonPath` (the pure, testable
 * core of a node's HTTP request) on edge cases surfaced by a July 2026 audit.
 *
 * Tests are split into two groups:
 *   ✅ CORRECT — behavior we want; a regression here is a real break.
 *   🐛 PINS CURRENT BEHAVIOR — documents a confirmed defect. The assertion
 *      matches what the code does TODAY (buggy), with a comment stating what
 *      correct behavior would be. When the bug is fixed, flip the assertion.
 */
import { __testables } from '../flow-executor.service';

const { buildResolvedRequest, setByJsonPath } = __testables;

function node(p: any): any {
  return {
    id: p.id || 'n', method: p.method || 'GET', path: p.path || '/', operationId: p.id || 'n',
    tags: [], dependsOn: [], variableExtractions: [], variableInjections: p.variableInjections || [],
    priority: 0, isAuthEndpoint: false, isPagination: false, hasFileUpload: false,
    isUnsupported: false, canRunParallel: false,
    sampleRequestBody: p.sampleRequestBody, sampleQueryParams: p.sampleQueryParams,
    expectedStatusCodes: [200],
  };
}
const BASE = 'https://api.example.com';

describe('buildResolvedRequest — variable interpolation', () => {
  it('✅ interpolates a resolved {{var}} into the body', () => {
    const n = node({ path: '/x', method: 'POST', sampleRequestBody: { name: '{{user_name}}' } });
    const r = buildResolvedRequest(n, BASE, { user_name: 'Alice' });
    expect(r.resolvedBody).toEqual({ name: 'Alice' });
  });

  it('🐛 an UNRESOLVED {{var}} is left literal and sent verbatim to the API', () => {
    // CORRECT would be to fail the step (or drop the field) rather than POST the
    // literal string "{{never_set}}". Today it silently ships the placeholder,
    // producing a confusing downstream 4xx instead of a clear "unresolved var".
    const n = node({ path: '/x', method: 'POST', sampleRequestBody: { token: '{{never_set}}' } });
    const r = buildResolvedRequest(n, BASE, {});
    expect(r.resolvedBody).toEqual({ token: '{{never_set}}' });
  });

  it('🐛 an empty-string ctx value resolves {{var}} to "" (unfilled required input is sent as blank)', () => {
    // A required input the user left blank ('' in ctx) resolves to an empty
    // string in the body. CORRECT would leave {{otp_code}} visibly unresolved
    // (the executor's ctx-seeding skips '' for exactly this reason — but a value
    // that reaches interpolation as '' still collapses here).
    const n = node({ path: '/otp/verify', method: 'POST', sampleRequestBody: { code: '{{otp_code}}' } });
    const r = buildResolvedRequest(n, BASE, { otp_code: '' });
    expect(r.resolvedBody).toEqual({ code: '' });
  });

  it('✅ a whole-value {{var}} preserves numeric 0 / boolean false types', () => {
    // A field that IS exactly "{{c}}" substitutes the ctx value with its original
    // type, so 0 stays 0 and false stays false — a JSON body the API won't reject
    // on a type mismatch.
    const n = node({ path: '/x', method: 'POST', sampleRequestBody: { count: '{{c}}', flag: '{{f}}' } });
    const r = buildResolvedRequest(n, BASE, { c: 0 as any, f: false as any });
    expect(r.resolvedBody).toEqual({ count: 0, flag: false });
  });
});

describe('buildResolvedRequest — variable injection', () => {
  it('✅ header injection with a prefix builds "Bearer <token>"', () => {
    const n = node({ path: '/me', variableInjections: [
      { variableName: 'auth_token', injectAs: 'header', targetKey: 'Authorization', prefix: 'Bearer ' }] });
    const r = buildResolvedRequest(n, BASE, { auth_token: 'T1' });
    expect(r.resolvedHeaders.Authorization).toBe('Bearer T1');
  });

  it('✅ body_field injection on an ARRAY body materializes an object so the field is not silently dropped', () => {
    // A named prop on an array is present in JS but dropped by JSON.stringify. To
    // avoid that silent loss, a non-plain-object body is replaced by an object
    // container the field lands on. Injecting a scalar field into an array body is
    // itself ill-formed; the array payload yields to the visible field.
    const n = node({ path: '/x', method: 'POST', sampleRequestBody: [{ a: 1 }],
      variableInjections: [{ variableName: 'uid', injectAs: 'body_field', targetKey: 'userId' }] });
    const r = buildResolvedRequest(n, BASE, { uid: 'U1' });
    expect(r.resolvedBody).toEqual({ userId: 'U1' });
    expect(JSON.stringify(r.resolvedBody)).toContain('userId');
  });

  it('✅ body_field injection materializes a container when there is NO body', () => {
    // Like body_json_path, body_field now creates an object container for an absent
    // body, so an injection meant to BE the body lands instead of being lost.
    const n = node({ path: '/x', method: 'POST',
      variableInjections: [{ variableName: 'uid', injectAs: 'body_field', targetKey: 'userId' }] });
    const r = buildResolvedRequest(n, BASE, { uid: 'U1' });
    expect(r.resolvedBody).toEqual({ userId: 'U1' });
  });

  it('🐛 a path_param whose {token} is absent from the path silently no-ops but is still reported injected', () => {
    // targetKey 'id' but path has no {id}: URL is unchanged, yet variablesInjected
    // still lists 'uid' — over-reporting a substitution that never happened.
    const n = node({ path: '/users', method: 'GET',
      variableInjections: [{ variableName: 'uid', injectAs: 'path_param', targetKey: 'id' }] });
    const r = buildResolvedRequest(n, BASE, { uid: 'U1' });
    expect(r.resolvedUrl).toBe(`${BASE}/users`);
    expect(r.variablesInjected).toContain('uid');
  });

  it('🐛 path_param replaces only the FIRST occurrence of a repeated {token}', () => {
    const n = node({ path: '/a/{id}/b/{id}', method: 'GET',
      variableInjections: [{ variableName: 'x', injectAs: 'path_param', targetKey: 'id' }] });
    const r = buildResolvedRequest(n, BASE, { x: '7' });
    // Second {id} survives literally.
    expect(r.resolvedUrl).toBe(`${BASE}/a/7/b/{id}`);
  });
});

describe('setByJsonPath', () => {
  it('✅ sets a nested object path, creating intermediate objects', () => {
    const t: any = {};
    setByJsonPath(t, '$.user.profile.id', 'X');
    expect(t).toEqual({ user: { profile: { id: 'X' } } });
  });

  it('✅ an array-index segment becomes an array element, not an object key', () => {
    // items[0] → { items: [ {...} ] }: a numeric next-segment makes the level an
    // array, so an API expecting a JSON array receives one.
    const t: any = {};
    setByJsonPath(t, '$.items[0].id', 'X');
    expect(t).toEqual({ items: [{ id: 'X' }] });
    expect(Array.isArray(t.items)).toBe(true);
  });

  it('🐛 an intermediate primitive is clobbered into an object', () => {
    // body already has user:"bob"; path user.id replaces the string with {}.
    const t: any = { user: 'bob' };
    setByJsonPath(t, 'user.id', '9');
    expect(t).toEqual({ user: { id: '9' } });
  });
});
