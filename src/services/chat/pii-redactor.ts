/**
 * Phase B-SEC — PII redactor for content that ends up in the LLM prompt.
 *
 * Scope:
 *   Mobile chat injects the a11y tree (text from EditText/TextView nodes)
 *   into the LLM system prompt. Visible app UI commonly contains email,
 *   phone numbers, OTP codes, card numbers, and JWT-shaped tokens — any
 *   of which would be exfiltrated to OpenAI / Gemini in every chat turn
 *   without redaction. That's a compliance problem (GDPR/CCPA/SOC2) and
 *   a customer-trust problem.
 *
 * Policy:
 *   Whitelist by format. We do NOT try to detect "this is a password" —
 *   that heuristic family produces both false positives (benign search
 *   queries flagged) and false negatives (a real password slips through),
 *   either failure mode breaks trust. Categories here are purely
 *   character-shape based:
 *     - email      → `<redacted:email>`
 *     - phone      → `<redacted:phone>`
 *     - card       → `<redacted:card>` (Luhn-validated to suppress order
 *                                       IDs / tracking numbers / dates
 *                                       that just happen to be 13-19 digits)
 *     - OTP        → `<redacted:otp>` (4-8 digit sequences in word boundaries)
 *     - jwt        → `<redacted:jwt>` (xxx.yyy.zzz base64ish)
 *
 *   The replacement keeps the TYPE TAG so the LLM understands "there's
 *   a field here, just hidden" rather than "the field is empty". The
 *   user's chat experience is "the email field has something in it"
 *   instead of "the email field is blank".
 *
 * Toggle:
 *   `env.MOBILE_CHAT_PII_REDACTION` — default true. Off bypasses ALL
 *   patterns. Per-workspace customisation is a future refactor.
 */

// ─── Patterns ──────────────────────────────────────────────────────────────

/**
 * Email — RFC 5321 strict-ish. We deliberately keep it loose because
 * the goal is "blanket-catch anything that LOOKS like an email" rather
 * than "validate per the spec". False positives here are OK — they
 * mean we over-redact, never under-redact.
 */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Phone — international + common local formats. Matches:
 *   +1 555 123 4567
 *   +7 (123) 456-78-90
 *   555-555-5555
 *   8 (800) 555-35-35
 *
 * Requires at least 10 digits across the run to suppress order numbers /
 * short ID codes.
 */
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g;

/**
 * JWT — three base64url-ish chunks joined by dots. Length minimums
 * suppress "x.y.z" style version strings (e.g. "1.2.3") from triggering.
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * OTP — 4 to 8 digits surrounded by word boundaries. This DOES catch
 * benign 4-digit numbers (years, prices), but the false-positive cost
 * is much lower than the false-negative cost (a leaked 2FA code). The
 * a11y tree rarely contains numeric content other than form values
 * anyway.
 */
const OTP_RE = /\b\d{4,8}\b/g;

/**
 * Card number candidate — 13-19 digits, allowing spaces / dashes between
 * digits but NOT trailing. The end is forced to be a digit to suppress
 * the "trailing separator eats the next word's leading whitespace" bug
 * (e.g. `Card 4111111111111111 used.` would otherwise lose the space
 * before `used`).
 *
 * We MUST Luhn-validate before redacting because plenty of order IDs,
 * tracking numbers, and date strings match this length.
 */
const CARD_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

// ─── Luhn check ────────────────────────────────────────────────────────────

/**
 * Standard mod-10 Luhn check. Exported for direct unit testing — the
 * regex catches order IDs / tracking numbers, this trims them off so
 * we don't redact things that aren't card numbers.
 */
export function isValidLuhn(digits: string): boolean {
  const cleaned = digits.replace(/[ -]/g, '');
  if (cleaned.length < 13 || cleaned.length > 19) return false;
  if (!/^\d+$/.test(cleaned)) return false;
  let sum = 0;
  let doubleNext = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let d = cleaned.charCodeAt(i) - 48;
    if (doubleNext) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleNext = !doubleNext;
  }
  return sum % 10 === 0;
}

// ─── Redactor ──────────────────────────────────────────────────────────────

/**
 * Run the full redaction pipeline. Order matters:
 *   1. JWT  — has high specificity; safe to do first.
 *   2. Email — matches strings with `@`, can't conflict with phone/card.
 *   3. Card — Luhn-validated; runs BEFORE phone/OTP so its longer-digit
 *             matches don't get pre-eaten by the phone or OTP patterns.
 *   4. Phone — international/local formats.
 *   5. OTP — 4-8 digits last, smallest match.
 *
 * Each step replaces with a tagged placeholder so the LLM sees there's
 * a value present, just hidden.
 */
export function redactPii(input: string): string {
  if (!input) return input;
  let out = input;

  out = out.replace(JWT_RE, '<redacted:jwt>');
  out = out.replace(EMAIL_RE, '<redacted:email>');

  // Cards: regex finds candidates; Luhn separates real cards from
  // tracking numbers / dates. We pass each candidate through Luhn and
  // only replace on a positive match.
  out = out.replace(CARD_CANDIDATE_RE, (m) => (isValidLuhn(m) ? '<redacted:card>' : m));

  out = out.replace(PHONE_RE, (m) => {
    // Phone regex over-matches anything digit-heavy; require ≥10 digits
    // after stripping separators.
    const digits = m.replace(/\D/g, '');
    return digits.length >= 10 ? '<redacted:phone>' : m;
  });

  out = out.replace(OTP_RE, '<redacted:otp>');

  return out;
}
