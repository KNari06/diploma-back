/**
 * Deterministic "must-ask" input detection for API flows.
 *
 * The Enricher fabricates realistic-looking test data for request bodies. That
 * is fine for names/emails/amounts, but WRONG for values that cannot be guessed
 * and that the API validates — a one-time code, an external API key, etc. A
 * hard-coded OTP like "123456" is rejected (OTP_INVALID) and sinks the whole
 * run. The Analyst is supposed to ask the user for these, but being an LLM it is
 * unreliable and sometimes asks nothing.
 *
 * This pass runs AFTER enrichment and closes that gap deterministically: any
 * request-body / query field whose NAME matches an un-fakeable pattern (and that
 * no prior step produces) is rewritten to a `{{placeholder}}` and surfaced as a
 * required run-time variable, so the "Configure Variables" dialog asks the user
 * to fill it fresh before each run instead of silently sending fake data.
 *
 * Kept conservative on purpose — only high-confidence, genuinely un-fakeable
 * categories, to avoid turning every fake email into a required field. Extend
 * the pattern tables below as new categories prove necessary.
 */

import type { DAGNode } from './flow.types';

// One-time / verification codes — delivered out-of-band, never guessable.
const VERIFICATION_CODE_FIELD =
  /^(otp|otp_?code|verification_?code|verify_?code|sms_?code|email_?code|confirmation_?code|one_?time_?code|one_?time_?password|totp|auth_?code|access_?code|two_?factor_?code|2fa_?code|mfa_?code|tfa_?code)$/i;
// Ambiguous names that are only a code IN an OTP context.
const BARE_CODE_FIELD = /^(code|pin)$/i;
// The address a code is delivered to. Only unambiguous delivery-target names —
// NOT `email`/`to`, which are commonly knowable fields the user shouldn't be
// forced to re-enter.
const OTP_TARGET_FIELD = /^(target|recipient|destination|msisdn|phone|phone_?number)$/i;
// Secrets provisioned outside the API (only when no endpoint produces them).
const SECRET_FIELD = /^(api_?key|client_?secret|app_?secret|private_?key)$/i;

// Strict: an ambiguous `code`/`pin` or a delivery-target field is only treated
// as OTP-related when the ENDPOINT PATH itself is about OTP. `verify`/`confirm`
// alone are too broad (e.g. `/shipping/verify`, `/account/confirm-email` would
// otherwise hijack a courier `code` or a knowable `email`).
const OTP_CONTEXT = /(^|[/_-])(otp|2fa|mfa|tfa)([/_-]|$)/i;

const CANONICAL_CODE_VAR = 'otp_code';
const CANONICAL_TARGET_VAR = 'otp_target';

function toSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

function isResolvedPlaceholder(v: unknown): boolean {
  return typeof v === 'string' && /\{\{.+?\}\}/.test(v);
}

export interface RequiredInputResult {
  nodes: DAGNode[];
  /** varName → '' (empty, so the run dialog marks it required). */
  requiredVars: Record<string, string>;
}

/**
 * Rewrite un-fakeable literal fields to `{{var}}` and collect the required
 * run-time variables. Only ADDS placeholders — never removes existing ones.
 */
export function detectRequiredInputs(nodes: DAGNode[]): RequiredInputResult {
  // Variables produced by some response extraction are NOT user inputs.
  const produced = new Set<string>();
  for (const n of nodes) for (const e of n.variableExtractions || []) produced.add(e.variableName);

  const requiredVars: Record<string, string> = {};

  const varForField = (field: string, nodePath: string): string | null => {
    if (VERIFICATION_CODE_FIELD.test(field)) return CANONICAL_CODE_VAR;
    if (BARE_CODE_FIELD.test(field) && OTP_CONTEXT.test(nodePath)) return CANONICAL_CODE_VAR;
    if (OTP_TARGET_FIELD.test(field) && OTP_CONTEXT.test(nodePath)) return CANONICAL_TARGET_VAR;
    if (SECRET_FIELD.test(field)) return toSnake(field);
    return null;
  };

  const consider = (field: string, value: unknown, nodePath: string): string | null => {
    const varName = varForField(field, nodePath);
    // Skip if the value is already a placeholder, or if either the canonical var
    // or the raw field name is produced by a prior step (already sourced).
    if (!varName || produced.has(varName) || produced.has(field) || isResolvedPlaceholder(value)) return null;
    if (!(varName in requiredVars)) requiredVars[varName] = '';
    return varName;
  };

  const rewriteBody = (val: any, nodePath: string): any => {
    if (val === null || val === undefined || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(v => rewriteBody(v, nodePath));
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== null && typeof v === 'object') {
        out[k] = rewriteBody(v, nodePath);
        continue;
      }
      const varName = consider(k, v, nodePath);
      out[k] = varName ? `{{${varName}}}` : v;
    }
    return out;
  };

  const newNodes = nodes.map(node => {
    let changed = false;

    let sampleRequestBody = node.sampleRequestBody;
    if (sampleRequestBody && typeof sampleRequestBody === 'object') {
      const rewritten = rewriteBody(sampleRequestBody, node.path);
      if (JSON.stringify(rewritten) !== JSON.stringify(sampleRequestBody)) {
        sampleRequestBody = rewritten;
        changed = true;
      }
    }

    let sampleQueryParams = node.sampleQueryParams;
    if (sampleQueryParams && typeof sampleQueryParams === 'object') {
      const q: Record<string, string> = {};
      let qChanged = false;
      for (const [k, v] of Object.entries(sampleQueryParams)) {
        const varName = consider(k, v, node.path);
        if (varName) { q[k] = `{{${varName}}}`; qChanged = true; } else { q[k] = v as string; }
      }
      if (qChanged) { sampleQueryParams = q; changed = true; }
    }

    return changed ? { ...node, sampleRequestBody, sampleQueryParams } : node;
  });

  return { nodes: newNodes, requiredVars };
}
