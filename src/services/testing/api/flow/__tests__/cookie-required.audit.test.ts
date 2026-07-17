/**
 * Audit test cases for the cookie jar and required-inputs pass (July 2026).
 *
 *   ✅ CORRECT — desired behavior.
 *   🐛 PINS CURRENT BEHAVIOR — confirmed defect; assertion matches today's
 *      (buggy) output with a comment on what correct behavior would be.
 */
import { CookieJar } from '../cookie-jar';
import { detectRequiredInputs } from '../required-inputs';

function node(p: any): any {
  return {
    id: p.id, method: p.method || 'POST', path: p.path || '/', operationId: p.id,
    tags: [], dependsOn: [], variableExtractions: p.variableExtractions || [],
    variableInjections: [], priority: 0, isAuthEndpoint: false, isPagination: false,
    hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    sampleRequestBody: p.sampleRequestBody, sampleQueryParams: p.sampleQueryParams,
    expectedStatusCodes: [200],
  };
}

describe('CookieJar — folded Set-Cookie splitting', () => {
  it('✅ the primary array path (getSetCookie) is never split and stays intact', () => {
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://api.x.com/a', ['msg=hello, world; Path=/']);
    // Whole value preserved when passed as a discrete array entry.
    expect(jar.cookieHeaderFor('https://api.x.com/b')).toBe('msg=hello, world');
  });

  it('🐛 a folded value containing ", word=" is wrongly split into a bogus second cookie', () => {
    // Fallback splitter regex /,(?=\s*[^=;,\s]+=)/ cannot tell a value comma from
    // a cookie boundary. "pref=a, b=c" → cookies {pref:"a", b:"c"}. CORRECT: the
    // value "a, b=c" should stay whole. Only affects the folded-string fallback;
    // the getSetCookie() array path (above) is safe.
    const jar = new CookieJar();
    jar.storeFromSetCookie('https://api.x.com/a', 'pref=a, b=c; Path=/');
    const header = jar.cookieHeaderFor('https://api.x.com/b');
    expect(header).toBe('pref=a; b=c'); // bogus `b` cookie fabricated
  });
});

describe('detectRequiredInputs — OTP context matching', () => {
  it('✅ an OTP code field on an /otp/ path becomes a required {{otp_code}}', () => {
    const v = node({ id: 'v', path: '/auth/otp/verify', sampleRequestBody: { code: '123456' } });
    const { nodes, requiredVars } = detectRequiredInputs([v]);
    expect(nodes[0].sampleRequestBody.code).toBe('{{otp_code}}');
    expect(requiredVars).toHaveProperty('otp_code');
  });

  it('✅ a bare `code` on a non-OTP /verify path is NOT hijacked', () => {
    // Guards the tightened OTP_CONTEXT: /shipping/verify must not turn a courier
    // `code` into a required OTP input.
    const v = node({ id: 'v', path: '/shipping/verify', sampleRequestBody: { code: 'TRACK-9' } });
    const { nodes, requiredVars } = detectRequiredInputs([v]);
    expect(nodes[0].sampleRequestBody.code).toBe('TRACK-9');
    expect(requiredVars).toEqual({});
  });

  it('🐛 a knowable `email` on an /otp/ path is hijacked into a required {{otp_target}}', () => {
    // On /auth/otp/send the delivery email is often a fixed, knowable address,
    // but any email/phone/to field on an OTP path is forced to a required var —
    // prompting the user for something enrichment could have supplied.
    const send = node({ id: 'sendOtp', path: '/auth/otp/send', sampleRequestBody: { email: 'ops@known.com' } });
    const { nodes, requiredVars } = detectRequiredInputs([send]);
    expect(nodes[0].sampleRequestBody.email).toBe('{{otp_target}}');
    expect(requiredVars).toHaveProperty('otp_target');
  });

  it('🐛 a 2FA/MFA code on /2fa or /mfa paths is NOT detected (fake data sails through)', () => {
    // OTP_CONTEXT only matches the literal "otp" token. A fabricated code on
    // /auth/2fa/verify or /mfa/challenge stays fake → OTP_INVALID at run time,
    // the exact failure this pass exists to prevent. CORRECT: also match
    // 2fa/mfa/twoFactor/one-time-code path segments.
    const twofa = node({ id: 'x', path: '/auth/2fa/verify', sampleRequestBody: { code: '000000' } });
    const mfa = node({ id: 'y', path: '/mfa/challenge', sampleRequestBody: { code: '000000' } });
    const { nodes, requiredVars } = detectRequiredInputs([twofa, mfa]);
    expect(nodes[0].sampleRequestBody.code).toBe('000000'); // not rewritten
    expect(nodes[1].sampleRequestBody.code).toBe('000000');
    expect(requiredVars).toEqual({});
  });

  it('🐛 query-param OTP detection has no dedicated coverage — verify it at least fires', () => {
    // The sampleQueryParams branch was previously untested. Confirm an OTP code
    // in a query string IS rewritten (documents the branch works today).
    const q = node({ id: 'q', method: 'GET', path: '/otp/check', sampleQueryParams: { otp: '999' } });
    const { nodes, requiredVars } = detectRequiredInputs([q]);
    expect(nodes[0].sampleQueryParams!.otp).toBe('{{otp_code}}');
    expect(requiredVars).toHaveProperty('otp_code');
  });
});
