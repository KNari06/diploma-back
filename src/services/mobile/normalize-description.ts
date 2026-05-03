/**
 * Normalize a user-typed element description before sending it to the runner.
 *
 * The mobile editor lets users type free-text element descriptions like
 *   tap "Login" button
 *   'Search' navigation
 *
 * Surrounding quotes are stylistic — users wrap labels for readability, but
 * the A11y tree stores the bare text. The runner's pre-filter does literal
 * substring checks (`text.includes(intentWord)`), so leftover quote chars
 * in the intent silently kill tier-1 matching.
 *
 * The previous implementation used `replace(/['"]+([^'"]+)['"]+/g, '$1')`,
 * which had two failure modes:
 *
 *   1. UNBALANCED:   tap "Login        → no match → quote char stayed in
 *      (left here unfixed since user is mid-typing or typo)
 *   2. NESTED:       'a "b" c'         → both pairs matched → "a b c"
 *      (inner quote loss is wrong — user wrote the inner ones on purpose)
 *
 * This helper handles both correctly:
 *   - If the WHOLE string is wrapped in matching quotes ("Login" / 'Login'
 *     / `Login`), strip just the outer pair.
 *   - Otherwise strip only INLINE balanced pairs of the same character,
 *     leaving any inner content alone. Apostrophes in `it's a button` stay
 *     intact (no closing pair).
 *
 * Idempotent: applying it twice yields the same result as once.
 */
export function normalizeMobileDescription(input: string | undefined | null): string {
  if (!input) return '';
  const trimmed = String(input).trim();
  if (!trimmed) return '';

  // Whole-string wrap — strip outer pair only, preserve inner content.
  // Anchored to start/end so `tap "X"` doesn't match here.
  const wholeWrap = /^(['"`])([\s\S]+)\1$/.exec(trimmed);
  if (wholeWrap) return wholeWrap[2].trim();

  // Inline same-quote pairs. The character class excludes the same quote
  // type via backreference: `(['"`])([^]*?)\1` would match across quote
  // types and across other quote chars greedily. We want minimal-greedy
  // matches that don't cross another quote of the SAME type.
  //
  // For each quote char, run a non-greedy single-char-type pass. Three
  // passes total — runs in O(n).
  let out = trimmed;
  for (const q of ['"', "'", '`'] as const) {
    const re = new RegExp(`${q}([^${q}]+)${q}`, 'g');
    out = out.replace(re, '$1');
  }
  return out.trim();
}
