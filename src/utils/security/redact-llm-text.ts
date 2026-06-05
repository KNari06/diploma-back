/**
 * ═══════════════════════════════════════════════════════════════════════════
 * redactForPersist — the mandatory safeguard before persisting LLM text
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Full LLM prompts/completions are the richest debug signal but the most
 * dangerous thing to store: after `resolvePlaceholders`, a prompt's page
 * snapshot can contain plaintext secrets, and visible UI carries PII. Nothing
 * may be persisted to a durable store until it has passed through here.
 *
 * It composes the three redactors that already exist, each catching a class the
 * others miss:
 *   1. redactCredentials  — `password=`, `token:`, `api_key is …` assignments
 *      (utils/security/redact-credentials.ts)
 *   2. redactPii          — email / phone / card(Luhn) / JWT / OTP by shape
 *      (services/chat/pii-redactor.ts)
 *   3. URL query tokens    — `?token=`, `&api_key=`, `access_token=`, `session=`
 *      (NEW here — the audit found these slip past both above: a token in a URL
 *      query string is neither an assignment nor a PII shape.)
 *
 * Order: credentials FIRST, then URL tokens, then PII. Credentials runs first
 * on purpose — its `keyword=value` rule also covers `?token=…` query params, so
 * running URL-masking first would leave a `token=<redacted:urltoken>` fragment
 * that the credentials rule then re-matches (masking it again as
 * `token: [REDACTED]`). Both orders fully hide the value; cred-first just yields
 * one consistent marker instead of a double-pass artefact. URL-masking then
 * catches the remaining sensitive query keys that aren't `keyword=` shaped, and
 * PII runs last on the smallest shapes (email/phone/card/otp/jwt).
 *
 * Best-effort: never throws. A redactor failure must not block the caller — on
 * error we return a hard-masked marker rather than risk leaking the raw text.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { redactCredentials } from './redact-credentials';
import { redactPii } from '@/services/chat/pii-redactor';

/**
 * Mask the value of sensitive URL query parameters. Matches `key=value` inside
 * a query string where the key is a known sensitive name. Keeps the key so the
 * shape stays debuggable: `?token=abc123` → `?token=<redacted:urltoken>`.
 *
 * Value charset stops at `&`, whitespace, quotes and `#` so we don't eat the
 * next param or surrounding text.
 */
const URL_TOKEN_RE =
  /\b(token|api[_-]?key|access[_-]?token|refresh[_-]?token|session|sig|signature|password|secret|auth|key|code)=([^&\s"'#]+)/gi;

export function redactUrlTokens(input: string): string {
  if (!input || typeof input !== 'string') return typeof input === 'string' ? input : '';
  return input.replace(URL_TOKEN_RE, (_m, key: string) => `${key}=<redacted:urltoken>`);
}

/**
 * The single entry point. Run every string headed for a durable LLM-text store
 * through this. Idempotent: re-running over already-redacted text is a no-op
 * (the masks contain no patterns the redactors re-match).
 */
export function redactForPersist(input: string): string {
  if (!input || typeof input !== 'string') return typeof input === 'string' ? input : '';
  try {
    let out = input;
    out = redactCredentials(out); // `keyword=value` incl. ?token=… query params
    out = redactUrlTokens(out); // remaining sensitive query keys
    out = redactPii(out); // email / phone / card / otp / jwt by shape
    return out;
  } catch {
    // Never leak raw text on a redactor bug — fail closed.
    return '[redaction-error: content withheld]';
  }
}
