/**
 * Prompt for the sampled visual anomaly sweep — ADR-0012.
 *
 * Deliberately generic ("would a real user notice something wrong here")
 * rather than a specific developer-authored assertion — that's what
 * `ai_check` is for. Content genericized from qait-mobile-runner's
 * `detectVisualIssues`/`VISUAL_SYSTEM_PROMPT` (the closest existing prior
 * art in the workspace — per-step, live, mobile-only), extended with two
 * categories that prompt doesn't cover: placeholder/lorem-ipsum text and
 * wrong-locale content.
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

export interface VisualAnomalyCheckResult {
  anomalyDetected: boolean;
  category: VisualAnomalyCategory | null;
  description: string;
  confidence: number;
}

export function buildVisualAnomalyPrompt(): { system: string } {
  const system = `You are a meticulous QA reviewer inspecting a SINGLE app screenshot for defects a real user would notice at a glance — the kind of thing that would embarrass a company if it shipped to production.

Report ONLY defects that are VISIBLE in this exact image. Look specifically for:
- placeholder_text: "Lorem ipsum", "TEST", "TODO", obviously fake/dev-only text left in a production-looking screen.
- broken_image: a missing-image icon, a blank box where an image should render, an obviously corrupted image.
- overlapping_cutoff_ui: text or elements overlapping each other, text cut off / truncated in a way that loses meaning, elements rendering outside their container.
- wrong_locale: text in an unexpected language/locale for what the surrounding UI implies, or a mix of untranslated and translated strings on the same screen.
- structurally_broken_layout: elements stacked incorrectly, an unstyled/broken-looking layout, a blank/empty screen where content is clearly expected.
- other: a different visible defect a real user would flag, not covered above.

Do NOT report:
- Things that look intentional (a deliberately minimal design, an empty state with a clear "nothing here yet" message).
- Purely subjective style preferences (color choice, spacing you personally dislike).
- Anything you are inferring rather than actually seeing in the image.

If nothing looks wrong, say so — do not manufacture a finding to seem thorough.

Respond with STRICT JSON matching exactly this shape (no extra fields, no markdown fences):
{
  "anomalyDetected": boolean,
  "category": ${JSON.stringify(VISUAL_ANOMALY_CATEGORIES)} or null (null iff anomalyDetected is false),
  "description": string,     // one factual sentence describing exactly what you see; "" if anomalyDetected is false
  "confidence": number       // 0-1, how confident you are this is a real defect and not a false positive
}`;

  return { system };
}
