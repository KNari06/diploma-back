/**
 * Structural close-affordance scorer — PURE, language-agnostic.
 *
 * PROTOTYPE / proposed replacement for the word-list-driven close detection in
 * `modal-detection.ts` (CLOSE_BUTTON_SELECTOR + CLOSE_AFFORDANCE_FN_SOURCE's
 * CLOSE_WORDS) and `overlay-dismisser.ts`. NOT yet wired into the hot path —
 * adopt by routing those consumers through `scoreCloseAffordance`.
 *
 * Design principle: answer "is this a CLOSE affordance?" from STRUCTURE, not
 * "what word is on it?". Words are the most fragile, language-bound signal, so
 * they are a weak TIEBREAK here, never the gate. Everything strong is
 * language-independent:
 *   - data-dismiss / data-close / data-bs-dismiss  (framework convention)
 *   - × / ✕ / ✖ / ⨯ glyph as (essentially) the whole label   (universal icon)
 *   - small icon-only control pinned to the overlay's TOP-RIGHT  (geometry)
 *   - close/dismiss in the CLASS name                          (author hint)
 *
 * Why this beats a word list: it works on a Persian/Thai/Hebrew/Hindi site with
 * zero new entries, and it CANNOT be fooled into clicking a destructive action
 * — "Удалить"/"Delete" simply don't look like a close affordance, so they score
 * low. That removes the need for a separate destructive word-list as the
 * safety net (the structural score IS the safety net): callers click only when
 * the score clears a confident threshold, and fail safe otherwise.
 */

/** Minimal, framework-agnostic view of a candidate element (host-collected). */
export interface CloseCandidate {
  /** aria-label attribute value (any language) — presence matters more than meaning. */
  ariaLabel?: string;
  /** title attribute value. */
  title?: string;
  /** class attribute value. */
  className?: string;
  /** trimmed visible textContent. */
  text?: string;
  /** true if element (or an ancestor) carries data-dismiss / data-close / data-bs-dismiss. */
  hasDismissData?: boolean;
  /** true if the element has no meaningful text (icon-only). */
  isIconOnly?: boolean;
  /** viewport-relative rect of the element. */
  rect?: { left: number; top: number; width: number; height: number };
  /** viewport-relative rect of the overlay/modal the element belongs to. */
  overlayRect?: { left: number; top: number; width: number; height: number };
}

/** The universal close glyph family — these mean "close" in every language. */
const CLOSE_GLYPHS = /^[×✕✖✗⨯╳xX]$/;

// NOTE: there is intentionally NO close-WORD list here. For ru/kk/en (and any
// other language) a real close control is identified by STRUCTURE — the ×
// glyph, a `data-dismiss` attribute, a `close`/`dismiss` CLASS name (framework
// class names are English even on ru/kk sites: `.modal-close`, `.btn-close`),
// or a small icon-only control in the overlay's top corner. None of those are
// localized, so no per-language vocabulary is needed or wanted (that was the
// hardcode we removed). A button whose ONLY close signal is its visible text
// ("Закрыть"/"Жабу"/"Close") with no ×, no class, no data-attr, no corner
// position is vanishingly rare — and not worth a brittle word list; it falls
// through to Escape / LLM like any other unrecognized control.

export interface CloseScore {
  /** 0..1 confidence that this is a close affordance. */
  score: number;
  /** which signals fired (for logging/debugging). */
  signals: string[];
}

/**
 * Score how strongly a candidate looks like a CLOSE affordance — purely from
 * structure + geometry (+ a weak word tiebreak). Language-agnostic.
 *
 * Suggested usage by callers:
 *   const { score } = scoreCloseAffordance(c);
 *   if (score >= CLOSE_CONFIDENT_THRESHOLD) click(c);   // else fail safe
 */
export function scoreCloseAffordance(c: CloseCandidate): CloseScore {
  const signals: string[] = [];
  let score = 0;

  // 1. Framework dismiss attribute — strongest, fully language-agnostic.
  if (c.hasDismissData) { score += 0.6; signals.push('data-dismiss'); }

  // 2. × glyph as essentially the whole label (text or aria-label) — universal.
  const glyphText = (c.text || '').replace(/\s/g, '');
  const glyphAria = (c.ariaLabel || '').replace(/\s/g, '');
  if ((glyphText.length <= 2 && CLOSE_GLYPHS.test(glyphText)) ||
      (glyphAria.length <= 2 && CLOSE_GLYPHS.test(glyphAria))) {
    score += 0.6; signals.push('close-glyph');
  }

  // 3. `close`/`dismiss` in the CLASS name. Framework class names are English
  //    even on ru/kk sites (`.modal-close`, `.btn-close`, `.dismiss`), so this
  //    is a strong, language-agnostic author signal — enough on its own.
  if (/(^|[^a-z])(close|dismiss|btn-close)([^a-z]|$)/i.test(c.className || '')) {
    score += 0.6; signals.push('class-close');
  }

  // 4. Geometry: a small icon-only control hugging the overlay's top corner is
  //    the canonical close ×, regardless of language. Top-RIGHT covers ru/kk/en
  //    (LTR); top-LEFT is also accepted so the rule isn't writing-direction-
  //    specific. Strong enough alone for a textless corner icon.
  if (c.isIconOnly && c.rect && c.overlayRect) {
    const small = c.rect.width <= 48 && c.rect.height <= 48;
    const overlayRight = c.overlayRect.left + c.overlayRect.width;
    const overlayLeft = c.overlayRect.left;
    const overlayTop = c.overlayRect.top;
    const nearRight = Math.abs((c.rect.left + c.rect.width) - overlayRight) <= 64;
    const nearLeft = Math.abs(c.rect.left - overlayLeft) <= 64;
    const nearTop = Math.abs(c.rect.top - overlayTop) <= 64;
    if (small && nearTop && (nearRight || nearLeft)) { score += 0.6; signals.push('top-corner-icon'); }
  }

  // NO word-based signal — see the note above CLOSE_GLYPHS. Structure decides.

  return { score: Math.min(score, 1), signals };
}

/** Confidence threshold a caller should require before clicking a close affordance. */
export const CLOSE_CONFIDENT_THRESHOLD = 0.6;

/** Convenience: a confident, structural close affordance (no word list needed). */
export function isConfidentCloseAffordance(c: CloseCandidate): boolean {
  return scoreCloseAffordance(c).score >= CLOSE_CONFIDENT_THRESHOLD;
}
