/**
 * Decide, for a group of nodes about to run, which values the platform must
 * pause and ask the user for — because it genuinely cannot obtain them itself.
 *
 * Three categories qualify — the values genuinely knowable only mid-run, or that
 * signal auth couldn't be established. Everything else (an ordinary id nothing
 * produces) is deliberately LEFT to the existing `blocked`/unbound reporting and
 * the pre-run variables dialog — interrupting a run to ask for every arbitrary
 * path id would be noise, and those already have a home:
 *   1. OTP — a one-time code / its delivery target. Time-sensitive and single
 *      use, so it is asked FRESH at run time (after the send step), never taken
 *      from a pre-run value which is necessarily stale.
 *   2. Secret — an api key / client secret provisioned outside the API.
 *   3. Auth token — an auth-realm token (`auth_token`/`session_token`/…) that is
 *      still empty AND whose producer(s) already failed or don't exist, so no
 *      retry will fill it. Without this, every protected request 401s.
 *
 * Pure and dependency-free so it can be unit-tested without the executor.
 */

import type { DAGNode, VariableContext, FlowInputQuestion } from './flow.types';
import { toSnakeCase } from './wiring/wiring-policy';

// Local (non-global) matcher so callers never trip over a shared lastIndex.
const PLACEHOLDER = /\{\{([\w.-]+)\}\}/g;

// All matchers run on the snake-cased var name (via toSnakeCase), so `otpCode`,
// `otp-code`, `OTP_CODE` all normalise to `otp_code` and match the same rules —
// the old exact-string Sets missed every real-world variant.

// A one-time / verification code asked FRESH at run time. Matches otp_code,
// sms_code, verification_code, mfa_code, 2fa_code, one_time_code, totp, bare otp…
const OTP_CODE_VAR = /(^|_)(otp|totp|one_?time|sms|verification|confirmation|mfa|2fa)_?(code|pin)($|_)|^(otp|totp)$/;
// Where the code is delivered (checked BEFORE code so `otp_target` isn't a code).
const OTP_TARGET_VAR = /(^|_)(otp|verification|confirmation|sms|code)_(target|recipient|destination)($|_)|^otp_target$/;
const AUTH_TOKEN_VAR = /^(auth_token|session_token|access_?token|bearer_?token|id_?token)$/;
// A secret provisioned out of band: api_key, x_api_key, subscription_key,
// client_secret, *_secret, private_key, signing_key…
const SECRET_VAR =
  /(^|_)(api|subscription|access|client|app|private|signing|encryption|webhook)_?(key|secret)($|_)|(^|_)(secret|passphrase|passcode)($|_)|_secret$/;

/** All variable names a node references — via injections and `{{placeholders}}`. */
export function collectReferencedVars(node: DAGNode): Set<string> {
  const refs = new Set<string>();
  for (const inj of node.variableInjections || []) refs.add(inj.variableName);
  const scan = (s: string): void => {
    let m: RegExpExecArray | null;
    PLACEHOLDER.lastIndex = 0;
    while ((m = PLACEHOLDER.exec(s)) !== null) refs.add(m[1]);
  };
  scan(node.path || '');
  if (node.sampleRequestBody != null) scan(JSON.stringify(node.sampleRequestBody));
  if (node.sampleQueryParams != null) scan(JSON.stringify(node.sampleQueryParams));
  return refs;
}

/** varName → nodes that extract it (its producers). */
export function buildProducersByVar(nodes: DAGNode[]): Map<string, DAGNode[]> {
  const map = new Map<string, DAGNode[]>();
  for (const n of nodes) {
    for (const e of n.variableExtractions || []) {
      const arr = map.get(e.variableName) || [];
      arr.push(n);
      map.set(e.variableName, arr);
    }
  }
  return map;
}

const hasValue = (ctx: VariableContext, name: string): boolean => {
  const v = ctx[name];
  return v !== undefined && v !== null && String(v) !== '';
};

export interface NeedsInputParams {
  ctx: VariableContext;
  producersByVar: Map<string, DAGNode[]>;
  /** True if a producer node has already failed or been skipped this run. */
  isFailedOrSkipped: (nodeId: string) => boolean;
  /** Vars already asked this run — never ask twice (avoids a re-ask loop). */
  alreadyAsked: ReadonlySet<string>;
}

/**
 * One referenced, still-unresolved variable → a question, or null if the
 * platform should keep trying to resolve it itself (producer may still run).
 */
function classify(varName: string, p: NeedsInputParams): FlowInputQuestion | null {
  const snake = toSnakeCase(varName);

  // Delivery target is matched BEFORE the code pattern (otp_target isn't a code).
  if (OTP_TARGET_VAR.test(snake)) {
    return {
      name: varName,
      label: 'Code delivery target (phone / email)',
      reason: 'Where the one-time code should be delivered.',
      kind: 'otp_target',
      secret: false,
    };
  }
  // OTP is asked fresh every run — pre-run values are stale by definition.
  if (OTP_CODE_VAR.test(snake)) {
    return {
      name: varName,
      label: 'One-time code',
      reason: 'The API sends this code out of band (SMS/email) when the flow runs. Enter the code you received to continue.',
      kind: 'otp',
      secret: false,
    };
  }

  // Below this point a value already present in ctx is accepted as-is.
  if (hasValue(p.ctx, varName)) return null;

  if (AUTH_TOKEN_VAR.test(snake)) {
    const producers = p.producersByVar.get(varName) || [];
    const unobtainable = producers.length === 0 || producers.every(n => p.isFailedOrSkipped(n.id));
    if (!unobtainable) return null; // a login is still expected to produce it
    return {
      name: varName,
      label: 'Auth token',
      reason: producers.length
        ? 'The login step did not return a token, so protected requests would all fail. Paste a valid token to continue.'
        : 'This flow has no login step that produces the auth token. Provide one to continue.',
      kind: 'auth_token',
      secret: true,
    };
  }

  if (SECRET_VAR.test(snake)) {
    return {
      name: varName,
      label: varName,
      reason: 'This secret is provisioned outside the API and cannot be generated automatically.',
      kind: 'secret',
      secret: true,
    };
  }

  // Any other producerless value (an ordinary id, base_url) is NOT interrupted
  // for here — it stays a `blocked`/unbound step and is covered by the pre-run
  // variables dialog. Only the categories above are worth pausing a run over.
  return null;
}

/**
 * Questions to ask before running `nodes`, de-duped by variable name and
 * excluding anything already asked this run. Empty array → run the group as-is.
 */
export function computeGroupNeedsInput(nodes: DAGNode[], params: NeedsInputParams): FlowInputQuestion[] {
  const byName = new Map<string, FlowInputQuestion>();
  for (const node of nodes) {
    for (const varName of collectReferencedVars(node)) {
      if (params.alreadyAsked.has(varName) || byName.has(varName)) continue;
      const q = classify(varName, params);
      if (q) byName.set(varName, q);
    }
  }
  return [...byName.values()];
}
