/**
 * Text similarity helpers used by fake-success guards in preview-step-apply.
 *
 * Compares recorded step labels against the live element label the resolver
 * picked, so we can catch wrong-element clicks like:
 *   recorded "MAT-SMART раздел"   chosen "Б" (avatar)   →   no token overlap
 *
 * Single source of truth for tokenization + overlap. Both pre-click and
 * post-click guards import from here so the comparison stays symmetric.
 *
 * Performance: each call allocates a Set of tokens. At our scale (≤60
 * candidates × ≤80 chars each) this is a few thousand ops total per step,
 * well below the 50ms budget. Don't micro-optimise — correctness first.
 */

/* eslint-disable no-fallthrough */

// Cyrillic letters that share a glyph with a Latin letter — same visual shape,
// different Unicode codepoint. Recorders see the typed-in description
// ("MAT-SMART раздел") with Latin M/A/T while the live page often renders the
// same brand in Cyrillic ("МАТ-SMART"). Without folding, identical visible
// strings hash to disjoint token sets and the guard mis-fires.
//
// Single-direction Cyrillic→Latin is enough — both sides go through the same
// fold so the comparison is symmetric.
//
// Map-based lookup is O(1) per char vs the previous switch implementation —
// negligible perf difference but cleaner to extend (Greek glyph-twins later).
const CYR_TO_LAT: Record<number, string> = {
  0x0410: 'a', 0x0412: 'b', 0x0415: 'e', 0x041A: 'k', 0x041C: 'm',
  0x041D: 'h', 0x041E: 'o', 0x0420: 'p', 0x0421: 'c', 0x0422: 't',
  0x0425: 'x', 0x0423: 'y',
  0x0430: 'a', 0x0432: 'b', 0x0435: 'e', 0x043A: 'k', 0x043C: 'm',
  0x043D: 'h', 0x043E: 'o', 0x0440: 'p', 0x0441: 'c', 0x0442: 't',
  0x0445: 'x', 0x0443: 'y',
};

/**
 * Fold Cyrillic glyph-twin letters to their Latin equivalents and strip
 * combining diacritics so morphological variants in different scripts hash
 * to the same token. Single string scan + NFD normalisation = ~O(n).
 *
 * Examples:
 *   "МАТ-SMART"  → "mat-smart"   (Cyrillic М/А/Т → Latin)
 *   "Бекнұр"     → "беkнyp"      ('ұ' is Kazakh, no Latin twin — left as-is
 *                                  but ASCII-equivalent diacritic stripped if any)
 *   "café"       → "cafe"        (NFD strip combining acute accent)
 */
export function foldText(s: string): string {
  // NFD splits "é" → "e" + combining acute; \p{M} regex drops combining marks.
  // Catches accented Latin (café/résumé) and Vietnamese / Polish diacritics
  // without a custom map. No-op for already-decomposed strings.
  const decomposed = s.normalize('NFD').replace(/\p{M}/gu, '');
  let out = '';
  for (const ch of decomposed) {
    const code = ch.charCodeAt(0);
    out += CYR_TO_LAT[code] ?? ch;
  }
  return out;
}

// Stopwords that pass the 3-char filter but carry no identity. English +
// Russian + Kazakh service words. Conservative list — keep it short so we
// don't accidentally drop meaningful product names.
//
// Why: without filtering, "Wait for URL" recorded vs "Click for support"
// chosen both contain "for" → overlap=1 → guard skipped. Real overlap = 0.
const STOPWORDS = new Set<string>([
  // English
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'are',
  // Russian
  'для', 'или', 'что', 'как', 'это',
  // Kazakh
  'жане',
]);

/**
 * Split a label into a Set of identity-bearing tokens.
 *
 * - Lowercases + folds Cyrillic glyph-twins + strips diacritics.
 * - Splits on any non-letter/non-digit (Unicode-aware via \p{L}\p{N}).
 * - Drops tokens shorter than 3 chars (single letters / "ok" / "to").
 * - Drops stopwords (the/for/что/...).
 *
 * Returns empty set for null/undefined/empty input.
 */
export function tokenizeLabel(s: string | undefined | null): Set<string> {
  if (!s) return new Set();
  const tokens = foldText(s.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Damerau-Levenshtein distance ≤ 2 — captures common single-typo and
 * morphological inflection pairs (раздел vs разделах, save vs saved).
 *
 * Constraints:
 *   - Both sides ≥5 chars: short tokens collide too easily under DL≤2
 *     ("yes" vs "no" would falsely match a 3-char threshold; "code" vs
 *     "node" with DL=2 is intentionally rejected to keep precision high).
 *   - |la-lb| ≤ 2: any longer length-diff makes the substring overlap path
 *     in `tokenOverlap` the right tool, not fuzzy.
 *
 * Note: substring catching ("раздел" ⊂ "разделах") is NOT done here — it's
 * handled in `tokenOverlap` directly so the same logic doesn't run twice.
 *
 * Allocation: rolling 1D arrays (2 × (lb+1)) instead of full 2D table —
 * cheaper memory, still correct because DL only depends on prev row.
 * (Caveat: DL transposition needs prev-prev row — we keep 3 rows.)
 */
export function fuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return false;
  if (Math.min(la, lb) < 5) return false;

  // Three rolling rows: prevPrev (i-2), prev (i-1), curr (i). DL transposition
  // looks back two rows when checking a[i-1]===b[j-2] && a[i-2]===b[j-1].
  let prevPrev = new Array(lb + 1).fill(0);
  let prev = new Array(lb + 1).fill(0);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    const curr = new Array(lb + 1).fill(0);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,         // deletion
        curr[j - 1] + 1,     // insertion
        prev[j - 1] + cost,  // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prevPrev[j - 2] + 1);
      }
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > 2) return false; // early exit: whole row exceeds budget
    prevPrev = prev;
    prev = curr;
  }
  return prev[lb] <= 2;
}

/**
 * Count tokens in `a` that have a counterpart in `b`.
 *
 * Match waterfall (cheapest → most expensive):
 *   1. Exact (Set.has).
 *   2. Substring ≥3 chars on both sides — handles morphological variants
 *      ("папка" ⊂ "папкалар", "courses" ⊂ "course") symmetrically.
 *   3. Damerau-Levenshtein ≤ 2 — catches single-typo / inflection pairs.
 *
 * Returns the count, not boolean, because the post-click label-mismatch
 * guard logs the exact overlap value for diagnostics. For binary "any
 * overlap?" use `hasAnyOverlap` — it short-circuits on first hit.
 */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const t of a) {
    if (b.has(t)) { n++; continue; }
    let matched = false;
    if (t.length >= 3) {
      for (const u of b) {
        if (u.length >= 3 && (u.includes(t) || t.includes(u))) {
          matched = true; break;
        }
      }
    }
    if (matched) { n++; continue; }
    for (const u of b) {
      if (fuzzyEqual(t, u)) { n++; break; }
    }
  }
  return n;
}

/**
 * Boolean variant of `tokenOverlap` that short-circuits on the first match.
 * Use this in pre-click guards where we just need "any overlap?" — saves
 * the full O(|a|·|b|) scan on long labels.
 */
export function hasAnyOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) {
    if (b.has(t)) return true;
    if (t.length >= 3) {
      for (const u of b) {
        if (u.length >= 3 && (u.includes(t) || t.includes(u))) return true;
      }
    }
    for (const u of b) {
      if (fuzzyEqual(t, u)) return true;
    }
  }
  return false;
}
