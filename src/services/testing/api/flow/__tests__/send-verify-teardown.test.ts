/**
 * autoWireSendBeforeVerify + autoWireSessionTeardownLast — the two ordering
 * relationships a spec never encodes as a variable dependency:
 *   • a verify/confirm step runs AFTER the send that issued its code;
 *   • a logout/teardown runs AFTER every session consumer, all-devices last.
 *
 * Fixture mirrors the NestJS auth flow (email + phone OTP + registration-step +
 * logout + logout-all-devices) that surfaced both gaps.
 */

jest.mock('@/services/ai/core/openai.service');

import { __testables } from '../dependency-resolver.service';
import type { DAGNode, VariableExtraction } from '../flow.types';

const { autoWireSendBeforeVerify, autoWireSessionTeardownLast } = __testables;

function node(partial: Partial<DAGNode> & { id: string; path: string }): DAGNode {
  return {
    method: 'POST', operationId: partial.id, summary: '', tags: [],
    dependsOn: [], variableExtractions: [], variableInjections: [], priority: 0,
    isAuthEndpoint: false, isPagination: false, hasFileUpload: false, isUnsupported: false,
    canRunParallel: false, expectedStatusCodes: [200, 201], ...partial,
  } as unknown as DAGNode;
}

const sessionExt = (): VariableExtraction[] => [{ variableName: 'session_token', jsonPath: '$.session_token' }];

const deps = (nodes: DAGNode[], id: string): string[] => nodes.find(n => n.id === id)!.dependsOn;

describe('autoWireSendBeforeVerify', () => {
  it('orders a verify after the request sibling under the same resource prefix', () => {
    const input = [
      node({ id: 'verifyEmail', path: '/auth/email/otp/verify', variableExtractions: sessionExt(), isAuthEndpoint: true }),
      node({ id: 'requestEmail', path: '/auth/email/otp/request' }),
      node({ id: 'verifyPhone', path: '/auth/phone/otp/verify', variableExtractions: sessionExt(), isAuthEndpoint: true }),
      node({ id: 'requestPhone', path: '/auth/phone/otp/request' }),
    ];
    const out = autoWireSendBeforeVerify(input);

    expect(deps(out, 'verifyEmail')).toContain('requestEmail');
    expect(deps(out, 'verifyPhone')).toContain('requestPhone');
    // Cross-branch: email verify must NOT depend on the phone request.
    expect(deps(out, 'verifyEmail')).not.toContain('requestPhone');
    // The request nodes stay roots.
    expect(deps(out, 'requestEmail')).toHaveLength(0);
    expect(deps(out, 'requestPhone')).toHaveLength(0);
  });

  it('is a no-op when there is no verify step', () => {
    const input = [
      node({ id: 'list', method: 'GET', path: '/auth/otp/request' }),
      node({ id: 'other', method: 'GET', path: '/users' }),
    ];
    expect(autoWireSendBeforeVerify(input)).toEqual(input);
  });

  it('does not duplicate an edge the AI already wired', () => {
    const input = [
      node({ id: 'verify', path: '/auth/otp/verify', dependsOn: ['send'], variableExtractions: sessionExt() }),
      node({ id: 'send', path: '/auth/otp/request' }),
    ];
    expect(deps(autoWireSendBeforeVerify(input), 'verify')).toEqual(['send']);
  });

  it('never creates a cycle (send already depends on verify)', () => {
    const input = [
      node({ id: 'verify', path: '/auth/otp/verify', variableExtractions: sessionExt() }),
      node({ id: 'send', path: '/auth/otp/request', dependsOn: ['verify'] }),
    ];
    expect(deps(autoWireSendBeforeVerify(input), 'verify')).toHaveLength(0);
  });
});

describe('autoWireSessionTeardownLast', () => {
  // Post-auth-wiring shape: consumers + teardowns already depend on the producer.
  const build = () => [
    node({ id: 'verifyEmail', path: '/auth/email/otp/verify', variableExtractions: sessionExt(), isAuthEndpoint: true }),
    node({ id: 'regStep', method: 'GET', path: '/auth/registration-step', dependsOn: ['verifyEmail'] }),
    node({ id: 'logout', path: '/auth/logout', dependsOn: ['verifyEmail'] }),
    node({ id: 'logoutAll', path: '/auth/logout-all-devices', dependsOn: ['verifyEmail'] }),
  ];

  it('orders logout after every session consumer, and all-devices after logout', () => {
    const out = autoWireSessionTeardownLast(build());

    expect(deps(out, 'logout')).toEqual(expect.arrayContaining(['verifyEmail', 'regStep']));
    expect(deps(out, 'logoutAll')).toEqual(expect.arrayContaining(['verifyEmail', 'regStep', 'logout']));
    // A narrower logout must NOT depend on the broader all-devices.
    expect(deps(out, 'logout')).not.toContain('logoutAll');
    // Non-teardown consumers are untouched.
    expect(deps(out, 'regStep')).toEqual(['verifyEmail']);
  });

  it('scopes teardown ordering to its own auth realm (independent admin/user)', () => {
    const input = [
      node({ id: 'userLogin', path: '/auth/login', variableExtractions: sessionExt(), isAuthEndpoint: true }),
      node({ id: 'adminLogin', path: '/admin/auth/login', variableExtractions: sessionExt(), isAuthEndpoint: true }),
      node({ id: 'userMe', method: 'GET', path: '/auth/me', dependsOn: ['userLogin'] }),
      node({ id: 'adminStats', method: 'GET', path: '/admin/stats', dependsOn: ['adminLogin'] }),
      node({ id: 'userLogout', path: '/auth/logout', dependsOn: ['userLogin'] }),
    ];
    const out = autoWireSessionTeardownLast(input);

    // User logout waits for the user endpoint, NOT the admin one (different realm).
    expect(deps(out, 'userLogout')).toEqual(expect.arrayContaining(['userLogin', 'userMe']));
    expect(deps(out, 'userLogout')).not.toContain('adminStats');
  });

  it('is a no-op when there is no teardown endpoint', () => {
    const input = [
      node({ id: 'login', path: '/auth/login', variableExtractions: sessionExt(), isAuthEndpoint: true }),
      node({ id: 'me', method: 'GET', path: '/auth/me', dependsOn: ['login'] }),
    ];
    expect(autoWireSessionTeardownLast(input)).toEqual(input);
  });
});

describe('send→verify then teardown-last, composed (NestJS flow)', () => {
  it('produces requestEmail→verifyEmail→regStep→logout→logoutAll ordering', () => {
    const input = [
      node({ id: 'requestEmail', path: '/auth/email/otp/request' }),
      node({ id: 'verifyEmail', path: '/auth/email/otp/verify', variableExtractions: sessionExt(), isAuthEndpoint: true }),
      node({ id: 'regStep', method: 'GET', path: '/auth/registration-step', dependsOn: ['verifyEmail'] }),
      node({ id: 'logout', path: '/auth/logout', dependsOn: ['verifyEmail'] }),
      node({ id: 'logoutAll', path: '/auth/logout-all-devices', dependsOn: ['verifyEmail'] }),
    ];
    const out = autoWireSessionTeardownLast(autoWireSendBeforeVerify(input));

    expect(deps(out, 'verifyEmail')).toContain('requestEmail');
    expect(deps(out, 'logout')).toEqual(expect.arrayContaining(['regStep']));
    expect(deps(out, 'logoutAll')).toEqual(expect.arrayContaining(['logout', 'regStep']));
  });
});
