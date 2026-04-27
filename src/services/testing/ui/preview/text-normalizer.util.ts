/**
 * Unicode text normalizer for fingerprint / locator text comparison.
 *
 * Two scenarios this guards against:
 *
 * 1. NFC vs NFD canonical equivalence
 *    "Қ" (Kazakh Qa) can be U+049A (single glyph, NFC)
 *    or U+041A + U+0301 (К + combining acute, NFD).
 *    Both render identically in browsers but compare unequal in JS.
 *    Recording in NFC + replay live DOM in NFD = silent fingerprint
 *    mismatch + LLM fallback. Native String.normalize('NFC') is the
 *    canonical fix per Unicode TR15.
 *
 * 2. Invisible / format characters
 *    Zero-width chars (ZWSP, ZWNJ, ZWJ), bidi marks (LRM, RLM, LRE/RLE/
 *    PDF/LRO/RLO/LRI/RLI/FSI/PDI), word joiners, BOMs — all visually
 *    invisible but present in copied/pasted text and many CMS-rendered
 *    pages. Cause spurious mismatches across record/replay boundaries.
 *
 * Symmetry contract: this function MUST be applied identically on both
 * sides of every text comparison (probe-time + heal-time + locator
 * generation). Asymmetric application creates silent breakage worse than
 * no normalization at all.
 *
 * Performance: NFC is implemented in V8 native code (~50ns/call for
 * typical strings). Safe to call in hot paths.
 */

// Invisible / format / bidi characters that browsers render as nothing
// but break exact string equality. Sourced from Unicode TR9 (bidi) and
// TR36 (security considerations).
//   ​  ZERO WIDTH SPACE
//   ‌  ZERO WIDTH NON-JOINER
//   ‍  ZERO WIDTH JOINER
//   ‎  LEFT-TO-RIGHT MARK
//   ‏  RIGHT-TO-LEFT MARK
//   ‪  LEFT-TO-RIGHT EMBEDDING
//   ‫  RIGHT-TO-LEFT EMBEDDING
//   ‬  POP DIRECTIONAL FORMATTING
//   ‭  LEFT-TO-RIGHT OVERRIDE
//   ‮  RIGHT-TO-LEFT OVERRIDE
//   ⁠  WORD JOINER
//   ⁡  FUNCTION APPLICATION
//   ⁢  INVISIBLE TIMES
//   ⁣  INVISIBLE SEPARATOR
//   ⁤  INVISIBLE PLUS
//   ⁦  LEFT-TO-RIGHT ISOLATE
//   ⁧  RIGHT-TO-LEFT ISOLATE
//   ⁨  FIRST STRONG ISOLATE
//   ⁩  POP DIRECTIONAL ISOLATE
//   ﻿  ZERO WIDTH NO-BREAK SPACE (BOM)
const INVISIBLE_CHARS_RE = /[​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Normalize a text string for stable equality comparison across record /
 * replay / heal boundaries.
 *
 * - Returns undefined unchanged (sparse-friendly for optional fields).
 * - Returns empty string unchanged (callers may treat "" as "no text").
 * - Otherwise: NFC + invisible-char strip + whitespace collapse.
 *
 * Idempotent: normalize(normalize(s)) === normalize(s). Safe to apply
 * defensively at any layer.
 */
export function normalizeText(s: string | undefined | null): string | undefined {
  if (s === undefined || s === null) return undefined;
  if (s.length === 0) return '';
  // 1. Canonical composition (NFC) — collapses combining-char sequences
  //    into precomposed glyphs. Idempotent on already-NFC strings.
  // 2. Strip invisible/format chars that don't render but break ===.
  // 3. Collapse internal whitespace runs (multiple spaces/tabs/newlines
  //    → single space). Real DOM text rarely contains these by design;
  //    when it does, they're typically incidental whitespace from
  //    template-literal indentation that varies between renders.
  // 4. Trim leading/trailing whitespace.
  return s
    .normalize('NFC')
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cell separator for nearestRowText concatenation. Uses Unicode
 * Information Separator One (U+241F) — a control char reserved
 * specifically for data field separation since the original ASCII
 * standard (1963). Never appears in human-typed text or HTML, so
 * .split(CELL_SEP) is collision-free regardless of cell contents.
 *
 * Replaces the earlier " | " separator which collided with cells
 * containing literal pipe-with-spaces (e.g. "Status: Active | 5 items").
 */
export const CELL_SEP = '␟';

/**
 * Escape a text value for safe inclusion inside Playwright's
 * `:has-text("...")` pseudo-class. Playwright accepts a JS string
 * literal — backslash and double-quote must be escaped, but Unicode
 * (cyrillic, arabic, CJK, emoji) passes through unmodified.
 *
 * Use for `tr:has-text("X")` / `li:has-text("X")` strategies.
 * For getByText() / regular text-strategy, raw value is fine — no
 * escaping needed since Playwright accepts the JS string directly.
 */
export function escapeHasText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
