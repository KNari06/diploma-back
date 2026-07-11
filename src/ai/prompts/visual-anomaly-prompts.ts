/**
 * Prompt for the sampled visual anomaly sweep — ADR-0012, multi-finding
 * schema per ADR-0016.
 *
 * Deliberately generic ("would a real user notice something wrong here")
 * rather than a specific developer-authored assertion — that's what
 * `ai_check` is for. Content genericized from qait-mobile-runner's
 * `detectVisualIssues`/`VISUAL_SYSTEM_PROMPT` (the closest existing prior
 * art in the workspace — per-step, live, mobile-only), extended with two
 * categories that prompt doesn't cover: placeholder/lorem-ipsum text and
 * wrong-locale content.
 *
 * ADR-0016: the schema returns a LIST of findings, not a single category.
 * A single screenshot can genuinely have multiple distinct simultaneous
 * defects (e.g. a broken image AND lorem-ipsum text on the same product
 * card) — the original single-category schema forced the model to either
 * silently drop one or invent an undocumented array wrapping (observed
 * live: `"category":["placeholder_text"]`), and this feature's own
 * recurrence-gating mechanism depends on a STABLE per-defect fingerprint
 * across runs, which a model inconsistently picking one of several real
 * defects run-to-run would starve indefinitely.
 */
export const VISUAL_ANOMALY_CATEGORIES = [
  'placeholder_text',
  'broken_image',
  'overlapping_cutoff_ui',
  'wrong_locale',
  'structurally_broken_layout',
  'other',
] as const;

export type VisualAnomalyCategory = typeof VISUAL_ANOMALY_CATEGORIES[number];

export function buildVisualAnomalyPrompt(): { system: string } {
  const system = `You are a meticulous QA reviewer inspecting a SINGLE app screenshot for defects a real user would notice at a glance — the kind of thing that would embarrass a company if it shipped to production.

Find EVERY distinct defect visible in this exact image — do not stop at the first or most salient one. A single screenshot can genuinely have more than one real, unrelated defect (e.g. a broken image AND placeholder text on the same card). List each one as its own entry. Report ONLY defects that are VISIBLE in this exact image. Look specifically for:
- placeholder_text: "Lorem ipsum", "TEST", "TODO", obviously fake/dev-only text left in a production-looking screen — OR a raw/error value leaking into user-facing text instead of real data ("undefined", "null", "NaN", "[object Object]", "Invalid Date", an unformatted ISO timestamp/unix epoch where a formatted date is expected).
- broken_image: a missing-image icon, a blank box where an image should render, an obviously corrupted image.
- overlapping_cutoff_ui: text or elements overlapping each other, text cut off / truncated in a way that loses meaning, elements rendering outside their container.
- wrong_locale: text in an unexpected language/locale for what the surrounding UI implies, or a mix of untranslated and translated strings on the same screen. Does NOT include intentional multi-language UI (e.g. a language picker listing language names in their own language).
- structurally_broken_layout: elements stacked incorrectly, an unstyled/broken-looking layout, a blank/empty screen where content is clearly expected, or the same content block (e.g. a header, button, or list item) unexpectedly rendered twice on the screen.
- other: a different visible defect a real user would flag, not covered above.

Do NOT report:
- Things that look intentional (a deliberately minimal design, an empty state with a clear "nothing here yet" message, a legitimate "N/A" / "—" shown for an optional field with no value).
- Purely subjective style preferences (color choice, spacing you personally dislike).
- Anything you are inferring rather than actually seeing in the image.
- The same defect twice — if multiple elements share one root cause (e.g. three broken image icons from the same missing asset pattern), report it ONCE.

If nothing looks wrong, return an empty findings list — do not manufacture a finding to seem thorough.

Respond with STRICT JSON matching exactly this shape (no extra fields, no markdown fences):
{
  "findings": [
    {
      "category": "<exactly ONE of: ${VISUAL_ANOMALY_CATEGORIES.join(' | ')}>",
      "description": string,   // one factual sentence describing exactly what you see
      "confidence": number     // 0-1, how confident you are this is a real defect and not a false positive
    }
  ]
}
Each finding's "category" is a SINGLE string chosen from that list — never an array, even if a finding seems to fit more than one category (pick the closest single match). The top-level response is always the object shown above: "findings" is always an array — [] when nothing looks wrong, never omitted, and the response itself must never be a bare array or object in place of that "findings" array.`;

  return { system };
}
