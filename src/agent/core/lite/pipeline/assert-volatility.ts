/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ASSERT VOLATILITY GUARD — is this value safe to freeze into a test?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An authored `assert_text` is re-verified on EVERY replay. Freezing a value
 * that changes on its own — a timestamp, an order id, a relative date — does
 * not produce a test, it produces a permanently RED one.
 *
 * Until now the only protection was a line in the Executor prompt ("do NOT
 * assert volatile values"). That is adequate for the editor, where a human sees
 * the authored step and can delete it. It is NOT adequate for exploration,
 * where nobody reviews the assertion before it lands in the user's project — so
 * a single bad assert turns a whole discovered suite into triage noise.
 *
 * DELIBERATELY STRICT (product decision): a rejected assertion costs one
 * missing check; a false-RED costs the credibility of every test around it.
 * When the two trade off, stay silent rather than lie. The rejection is
 * returned to the model as a tool error, so it can pick a different value or
 * element rather than losing the round.
 *
 * Pure and dependency-free so the rules are unit-testable in isolation.
 */

/** Why a value was refused. The reason is shown to the model, so it must be actionable. */
export interface VolatilityVerdict {
  volatile: boolean;
  /** Present when `volatile` — a short, model-facing explanation. */
  reason?: string;
}

const STABLE: VolatilityVerdict = { volatile: false };

const reject = (reason: string): VolatilityVerdict => ({ volatile: true, reason });

/**
 * Values shorter than this are treated as inherently low-risk labels ("OK",
 * "3") and skip the entropy-based checks, which would otherwise misfire on
 * short product text.
 */
const MIN_LENGTH_FOR_ENTROPY_CHECKS = 8;

/** Rules that reject outright, checked in order. Order matters only for which reason is reported. */
const PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // ── clock time — the single most common false-RED source ──
  {
    re: /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/i,
    reason: 'it contains a clock time, which changes on every run',
  },
  // ── ISO-8601 / RFC timestamps ──
  {
    re: /\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2})?/,
    reason: 'it contains a date, which will not match on a later run',
  },
  // ── numeric dates in any common separator/order ──
  {
    re: /\b\d{1,4}[./]\d{1,2}[./]\d{1,4}\b/,
    reason: 'it contains a date, which will not match on a later run',
  },
  // ── written dates ("14 Aug", "August 14, 2026", "Aug 2026") ──
  {
    re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,4}\b|\b\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i,
    reason: 'it contains a date, which will not match on a later run',
  },
  // ── relative time — re-renders differently within minutes ──
  {
    re: /\b(just now|(a|an|\d+)\s+(few\s+)?(sec|second|min|minute|hour|hr|day|week|month|year)s?\s+ago|in\s+\d+\s*(sec|second|min|minute|hour|hr|day|week)s?)\b/i,
    reason: 'it is a relative time ("… ago"), which changes as time passes',
  },
  // ── explicit id-ish labels: "Order ID: a4f9", "Invoice no. INV-2026".
  //    The id WORD alone is not enough — "Order confirmed" and "Payment
  //    reference saved" are perfectly stable assertions. Require an explicit
  //    number/no./#/: marker AND a token that actually carries a digit, so a
  //    plain English phrase after the word can never trip this. ──
  {
    re: /\b(id|uuid|guid|order|invoice|ticket|ref|reference|receipt|transaction|txn|session|token|trace)\s*(no\.?|number|#|:)\s*[#:]?\s*(?=[a-z0-9-]*\d)[a-z0-9][a-z0-9-]{2,}\b/i,
    reason: 'it looks like a generated identifier, which differs on every run',
  },
  { re: /#\s*\d{3,}/, reason: 'it contains a generated number (e.g. an order number)' },
  // ── UUID ──
  {
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    reason: 'it contains a UUID, which is regenerated every run',
  },
  // ── currency WITH cents: a live total that moves with tax/stock/promotions.
  //    Whole amounts ("$20") are usually a fixed price and are allowed.
  //    BOTH orders matter: most non-US locales put the symbol AFTER the number
  //    ("1 250,00 ₸", "1.234,56 €"). The postfix branch must NOT end in `\b` —
  //    a currency SYMBOL is not a word character, so `\b` never matches after
  //    it and the whole branch silently failed for every symbol-suffix locale. ──
  {
    re: /[$€£¥₸₽]\s*\d[\d\s,.']*[.,]\d{2}(?![\d])|\d[\d\s,.']*[.,]\d{2}\s*([$€£¥₸₽]|usd|eur|gbp|kzt|rub)(?![\p{L}\p{N}])/iu,
    reason: 'it is a precise monetary amount, which moves with tax, stock or promotions',
  },
  // ── percentages/counters that read as live metrics ──
  {
    re: /\b\d+\s*%\s*(complete|loaded|uploaded|progress|remaining)\b/i,
    reason: 'it is a progress value, which is transient',
  },
];

/**
 * Long unbroken alphanumeric runs that mix letters and digits: hashes, tokens,
 * short-ids. Checked separately because it needs per-token inspection rather
 * than one regex over the whole string.
 */
function hasHighEntropyToken(value: string): boolean {
  for (const token of value.split(/[\s,;|/\\()[\]{}<>"']+/)) {
    const t = token.replace(/^[#:@-]+|[.,:;!?]+$/g, '');
    if (t.length < 10) continue;
    // Reject only when the run genuinely looks machine-generated: both cases or
    // digits mixed into letters, and no word-like structure.
    const hasDigit = /\d/.test(t);
    const hasAlpha = /[a-z]/i.test(t);
    if (!hasDigit || !hasAlpha) continue;
    // A token with separators reads as human text ("build-2026-plan"); one solid
    // run of letters+digits reads as generated ("a4f9c2be71").
    if (/[-_.]/.test(t)) continue;
    return true;
  }
  return false;
}

/**
 * Decide whether `expected` is safe to freeze into a replayed assertion.
 *
 * Only ever called on the value the model chose to assert — never on page text
 * in general.
 */
export function checkAssertVolatility(expected: string): VolatilityVerdict {
  const value = (expected ?? '').trim();
  if (!value) return STABLE;

  for (const { re, reason } of PATTERNS) {
    if (re.test(value)) return reject(reason);
  }

  if (value.length >= MIN_LENGTH_FOR_ENTROPY_CHECKS && hasHighEntropyToken(value)) {
    return reject('it contains a generated-looking code, which differs on every run');
  }

  return STABLE;
}

/**
 * The model-facing rejection message. Kept here so the wording stays in one
 * place: it has to tell the model both WHY and WHAT TO DO, or it just retries
 * the same value.
 */
export function volatilityRejectionMessage(expected: string, reason: string): string {
  return (
    `assert rejected: "${expected}" is not safe to assert because ${reason}. ` +
    'Assert a value that is stable across runs — a label, a status, a product name, ' +
    'a heading — or skip the assertion for this step.'
  );
}
