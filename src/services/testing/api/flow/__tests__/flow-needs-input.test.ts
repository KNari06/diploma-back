/**
 * computeGroupNeedsInput — decide which values a paused run must ask the user for.
 *
 * Guards the core promise: the platform pauses and asks ONLY for values it
 * genuinely cannot obtain itself (OTP just sent, a secret, an auth token whose
 * login failed, a variable nothing produces) — never for values a producer is
 * still expected to supply.
 */

import { computeGroupNeedsInput, collectReferencedVars, buildProducersByVar } from '../flow-needs-input';
import type { DAGNode, VariableContext } from '../flow.types';

function node(partial: Partial<DAGNode> & { id: string; path: string }): DAGNode {
  return {
    method: 'POST', operationId: partial.id, summary: '', tags: [], dependsOn: [],
    variableExtractions: [], variableInjections: [], priority: 0, isAuthEndpoint: false,
    isPagination: false, hasFileUpload: false, isUnsupported: false, canRunParallel: false,
    expectedStatusCodes: [200], ...partial,
  } as unknown as DAGNode;
}

const authInj = { variableName: 'auth_token', injectAs: 'header' as const, targetKey: 'Authorization', prefix: 'Bearer ' };

const params = (over: Partial<Parameters<typeof computeGroupNeedsInput>[1]> & { nodes?: DAGNode[] } = {}) => {
  const { nodes = [], ...rest } = over;
  return {
    ctx: {} as VariableContext,
    producersByVar: buildProducersByVar(nodes),
    isFailedOrSkipped: () => false,
    alreadyAsked: new Set<string>(),
    ...rest,
  };
};

describe('collectReferencedVars', () => {
  it('collects injection names and {{placeholders}} from body and query (not single-brace path params)', () => {
    const n = node({
      id: 'verify', path: '/otp/verify/{tenant}', // single-brace path param → resolved via injection, not a {{var}}
      variableInjections: [authInj],
      sampleRequestBody: { code: '{{otp_code}}', nested: { to: '{{otp_target}}' } },
      sampleQueryParams: { q: '{{filter}}' },
    });
    const refs = collectReferencedVars(n);
    expect(refs).toEqual(new Set(['auth_token', 'otp_code', 'otp_target', 'filter']));
  });
});

describe('computeGroupNeedsInput', () => {
  it('asks for an OTP fresh at run time even when a stale value is already in ctx', () => {
    const verify = node({ id: 'verify', path: '/auth/otp/verify', sampleRequestBody: { code: '{{otp_code}}' } });
    const qs = computeGroupNeedsInput([verify], params({ ctx: { otp_code: '000000' } }));
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ name: 'otp_code', kind: 'otp' });
  });

  it('asks for the auth token when its producer already failed', () => {
    const login = node({ id: 'login', path: '/auth/login', variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.accessToken' }] });
    const protectedNode = node({ id: 'me', method: 'GET', path: '/me', variableInjections: [authInj] });
    const qs = computeGroupNeedsInput([protectedNode], params({
      nodes: [login, protectedNode],
      isFailedOrSkipped: (id) => id === 'login',
    }));
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ name: 'auth_token', kind: 'auth_token', secret: true });
  });

  it('does NOT ask for the auth token while its producer may still succeed', () => {
    const login = node({ id: 'login', path: '/auth/login', variableExtractions: [{ variableName: 'auth_token', jsonPath: '$.accessToken' }] });
    const protectedNode = node({ id: 'me', method: 'GET', path: '/me', variableInjections: [authInj] });
    const qs = computeGroupNeedsInput([protectedNode], params({ nodes: [login, protectedNode] }));
    expect(qs).toHaveLength(0);
  });

  it('accepts an auth token already present in ctx (does not ask)', () => {
    const protectedNode = node({ id: 'me', method: 'GET', path: '/me', variableInjections: [authInj] });
    const qs = computeGroupNeedsInput([protectedNode], params({ ctx: { auth_token: 'abc' } }));
    expect(qs).toHaveLength(0);
  });

  it('does NOT interrupt for an ordinary producerless value (left to blocked/unbound)', () => {
    // base_url has no producer, but it is not OTP/secret/auth — pausing for every
    // arbitrary value would be noise. It stays a blocked/unbound step instead.
    const n = node({ id: 'call', path: '/x', sampleRequestBody: { url: '{{base_url}}' } });
    expect(computeGroupNeedsInput([n], params({ nodes: [n] }))).toHaveLength(0);
  });

  it('does NOT ask for an ordinary id that a producer supplies (even if empty now)', () => {
    const producer = node({ id: 'list', method: 'GET', path: '/projects', variableExtractions: [{ variableName: 'project_id', jsonPath: '$[0].id' }] });
    const consumer = node({ id: 'use', path: '/projects/{project_id}/x', variableInjections: [{ variableName: 'project_id', injectAs: 'path_param', targetKey: 'project_id' }] });
    const qs = computeGroupNeedsInput([consumer], params({ nodes: [producer, consumer] }));
    expect(qs).toHaveLength(0);
  });

  it('never asks twice for a var already asked this run', () => {
    const verify = node({ id: 'verify', path: '/auth/otp/verify', sampleRequestBody: { code: '{{otp_code}}' } });
    const qs = computeGroupNeedsInput([verify], params({ alreadyAsked: new Set(['otp_code']) }));
    expect(qs).toHaveLength(0);
  });

  it('de-dupes a var referenced by multiple nodes in the group', () => {
    const a = node({ id: 'a', path: '/a', variableInjections: [authInj] });
    const b = node({ id: 'b', path: '/b', variableInjections: [authInj] });
    const qs = computeGroupNeedsInput([a, b], params({ nodes: [a, b] })); // no producer → asked once
    expect(qs.filter((q) => q.name === 'auth_token')).toHaveLength(1);
  });

  // #6 — the classifier must recognise real-world naming, not one exact string.
  it.each(['otpCode', 'otp_code', 'sms_code', 'verification_code', 'mfa_code', 'totp', 'one_time_code'])(
    'treats %s as a fresh one-time code',
    (name) => {
      const n = node({ id: 'v', path: '/verify', sampleRequestBody: { c: `{{${name}}}` } });
      const qs = computeGroupNeedsInput([n], params({ ctx: { [name]: 'stale' } }));
      expect(qs).toEqual([expect.objectContaining({ name, kind: 'otp' })]);
    },
  );

  it('classifies an OTP delivery target as a target, not a code', () => {
    const n = node({ id: 's', path: '/send', sampleRequestBody: { to: '{{otp_target}}' } });
    expect(computeGroupNeedsInput([n], params())).toEqual([expect.objectContaining({ name: 'otp_target', kind: 'otp_target' })]);
  });

  it.each(['api_key', 'x_api_key', 'subscription_key', 'client_secret', 'webhook_secret'])(
    'asks for %s as a secret (provisioned out of band)',
    (name) => {
      const n = node({ id: 'c', path: '/x', sampleRequestBody: { k: `{{${name}}}` } });
      const qs = computeGroupNeedsInput([n], params());
      expect(qs).toEqual([expect.objectContaining({ name, kind: 'secret', secret: true })]);
    },
  );
});
