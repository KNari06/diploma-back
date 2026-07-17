import { detectRequiredInputs } from '../required-inputs';
import type { DAGNode } from '../flow.types';

function node(partial: Partial<DAGNode> & { id: string; path: string }): DAGNode {
  return {
    method: 'POST', operationId: partial.id, summary: '', tags: [], dependsOn: [],
    variableExtractions: [], variableInjections: [], priority: 0, isAuthEndpoint: false,
    isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    expectedStatusCodes: [200], ...partial,
  } as unknown as DAGNode;
}

describe('detectRequiredInputs', () => {
  it('turns a fabricated OTP code into a required {{otp_code}} placeholder', () => {
    const verify = node({
      id: 'verifyOtp', path: '/api/v1/auth/otp/verify',
      sampleRequestBody: { otp: '123456', role: 'CREATOR' },
    });
    const { nodes, requiredVars } = detectRequiredInputs([verify]);
    expect(nodes[0].sampleRequestBody).toEqual({ otp: '{{otp_code}}', role: 'CREATOR' });
    expect(requiredVars).toHaveProperty('otp_code', '');
  });

  it('turns the OTP delivery target into {{otp_target}} (only in OTP context)', () => {
    const send = node({
      id: 'sendOtp', path: '/api/v1/auth/otp/send',
      sampleRequestBody: { target: 'testuser@example.com', otpDeliveryMethod: 'EMAIL' },
    });
    const { nodes, requiredVars } = detectRequiredInputs([send]);
    expect((nodes[0].sampleRequestBody as any).target).toBe('{{otp_target}}');
    expect(requiredVars).toHaveProperty('otp_target', '');
  });

  it('does NOT touch an email field outside an OTP/verify context', () => {
    const createUser = node({
      id: 'createUser', path: '/api/v1/users',
      sampleRequestBody: { email: 'john@example.com', name: 'John' },
    });
    const { nodes, requiredVars } = detectRequiredInputs([createUser]);
    expect((nodes[0].sampleRequestBody as any).email).toBe('john@example.com');
    expect(Object.keys(requiredVars)).toHaveLength(0);
  });

  it('treats a bare "code" field as an OTP code only when the path is OTP-specific', () => {
    const verify = node({ id: 'verify', path: '/api/v1/auth/otp/verify', sampleRequestBody: { code: '000000' } });
    const other = node({ id: 'country', path: '/api/v1/countries', sampleRequestBody: { code: 'KZ' } });
    const { nodes } = detectRequiredInputs([verify, other]);
    expect((nodes[0].sampleRequestBody as any).code).toBe('{{otp_code}}');
    expect((nodes[1].sampleRequestBody as any).code).toBe('KZ');
  });

  it('does NOT hijack a generic code/email in a merely "verify"/"confirm" path (no otp)', () => {
    const shipping = node({ id: 'ship', path: '/api/v1/shipping/verify', sampleRequestBody: { code: 'DHL' } });
    const confirm = node({ id: 'conf', path: '/api/v1/account/confirm-email', sampleRequestBody: { email: 'a@b.co', token: 'x' } });
    const { nodes, requiredVars } = detectRequiredInputs([shipping, confirm]);
    expect((nodes[0].sampleRequestBody as any).code).toBe('DHL');
    expect((nodes[1].sampleRequestBody as any).email).toBe('a@b.co');
    expect(Object.keys(requiredVars)).toHaveLength(0);
  });

  it('flags an external api key with no producer', () => {
    const call = node({ id: 'call', path: '/api/v1/things', sampleRequestBody: { apiKey: 'sk_test_abc', name: 'x' } });
    const { nodes, requiredVars } = detectRequiredInputs([call]);
    expect((nodes[0].sampleRequestBody as any).apiKey).toBe('{{api_key}}');
    expect(requiredVars).toHaveProperty('api_key', '');
  });

  it('does not flag a field that a prior step produces', () => {
    const login = node({ id: 'login', path: '/login', variableExtractions: [{ variableName: 'access_code', jsonPath: '$.code' } as any] });
    const use = node({ id: 'use', path: '/thing', sampleRequestBody: { access_code: 'zzz' } });
    const { nodes, requiredVars } = detectRequiredInputs([login, use]);
    // access_code is produced → left as-is, not a required input
    expect((nodes[1].sampleRequestBody as any).access_code).toBe('zzz');
    expect(requiredVars).not.toHaveProperty('access_code');
  });

  it('leaves an already-templated placeholder alone', () => {
    const verify = node({ id: 'verify', path: '/otp/verify', sampleRequestBody: { otp: '{{otp_code}}' } });
    const input = [verify];
    const { nodes, requiredVars } = detectRequiredInputs(input);
    expect(nodes[0]).toBe(input[0]); // unchanged reference
    expect(Object.keys(requiredVars)).toHaveLength(0);
  });

  it('rewrites nested body fields', () => {
    const n = node({ id: 'n', path: '/otp/verify', sampleRequestBody: { auth: { otpCode: '111111' }, meta: { x: 1 } } });
    const { nodes } = detectRequiredInputs([n]);
    expect((nodes[0].sampleRequestBody as any).auth.otpCode).toBe('{{otp_code}}');
  });
});
