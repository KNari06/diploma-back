/**
 * ═══════════════════════════════════════════════════════════════════════════
 * redact-credentials — mask credential-like assignments in free-form text
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Distinct from `redactSecrets` (utils/interpolation/redact-secrets.ts):
 *   - redactSecrets is VALUE-based — it needs the `runVariables` Map and masks
 *     known `secrets.*` values. Use it when you have the resolved secret set.
 *   - THIS is PATTERN-based — it masks `password=...`, `token: ...`,
 *     `api_key is ...` in arbitrary prose WITHOUT knowing the values. Use it
 *     for LLM prompts/completions and any free-form text where a credential
 *     might appear in any shape (env token, pasted creds, model output).
 *
 * Originally lived in mobile_agent/reasoning-trace.ts; extracted here so the
 * AI-action logger (and any other free-text sink) shares one catalogue.
 *
 * Design (kept verbatim from the proven reasoning-trace version):
 *   1. Require an assignment separator (`=`, `:`, or ` is `) between keyword
 *      and value — free-form English ("the password remains hidden") has no
 *      separator, so prose is left alone.
 *   2. The value must look like a credential — ≥6 alphanumerics OR contain a
 *      digit/special char. Short English words are skipped.
 *   We prefer under-masking when the syntactic signal is missing: a wrongly
 *   masked phrase is noise, a leaked credential is a compliance issue, but the
 *   previous over-aggressive regex produced too much noise.
 *
 *   - `password=qwerty123`      → masked
 *   - `token: 'abc-def!'`       → masked
 *   - `api_key is sk-live-xxxx` → masked
 *   - `password into the field` → NOT masked (no separator)
 * ═══════════════════════════════════════════════════════════════════════════
 */

const KEYWORD =
  '(password|passwd|passcode|pin|otp|token|secret|api[_-]?key|auth[a-z_]*|credential[s]?)';
// Separator: `=`, `:`, or whitespace + "is" + whitespace.
const SEP = '\\s*(?:[:=]|\\bis\\b)\\s*';
// Value: optionally quoted; ≥6 alphanumeric OR contains a digit/special char.
const VALUE = `["']?((?:[A-Za-z0-9]{6,80})|(?:[^\\s"',.;!?]*[\\d!@#$%^&*+\\-_/\\\\][^\\s"',.;!?]{2,80}))["']?`;

const SENSITIVE_ASSIGNMENT_RE = new RegExp(`\\b${KEYWORD}\\b${SEP}${VALUE}`, 'gi');

// ─── Bare-shape secrets ──────────────────────────────────────────────────
// Some credentials arrive WITHOUT a keyword separator — a user pastes the raw
// value into chat ("8977713030:AAG..."). The assignment regex above can't see
// those. Match the unmistakable shapes directly so connect-flow pastes don't
// land verbatim in chat history / logs.
//
// Telegram bot token: <bot_id digits>:<35-char A-Za-z0-9_- secret>. Anchored on
// the 30+ char tail so ordinary "12:34" / time-like tokens never match.
const TELEGRAM_BOT_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g;
// Slack incoming webhook URL.
const SLACK_WEBHOOK_RE = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi;

/**
 * Mask credential-like assignments AND bare-shape secrets in a single string.
 * Returns the sanitised string; leaves non-matching prose untouched. Never throws.
 */
export function redactCredentials(input: string): string {
  if (!input || typeof input !== 'string') return typeof input === 'string' ? input : '';
  return input
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, label) => `${label}: [REDACTED]`)
    .replace(TELEGRAM_BOT_TOKEN_RE, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(SLACK_WEBHOOK_RE, '[REDACTED_SLACK_WEBHOOK]');
}

/**
 * Recursively redact every string inside a structured value (objects, arrays,
 * nested). Non-string leaves are returned as-is. Bounded depth so a pathological
 * payload can't blow the stack — beyond the cap we stop descending and keep the
 * value verbatim (it will still be truncated by the caller's field cap).
 */
export function redactCredentialsDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return redactCredentials(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactCredentialsDeep(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactCredentialsDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
