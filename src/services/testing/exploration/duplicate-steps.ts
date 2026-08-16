/**
 * Consecutive-duplicate detection for PERSISTED `intent_test_cases.steps_json`.
 *
 * The runtime guard lives in `pipeline-step-extractor.ts` and works on
 * `DiscoveredStep` (`action`, pre-persist). Rows already in the database are
 * `IntentStep` (`type`, post-`toIntentSteps`), so the same rule needs a second
 * shape — kept here, in one place, rather than re-expressed inline in a
 * cleanup script where it could silently drift from the runtime rule.
 *
 * Both answer the same question: did the agent re-issue the identical action
 * twice in a row (a retry), rather than the flow legitimately touching the same
 * control again later?
 */

/** A persisted step — only the fields the rule reads. */
export interface PersistedStep {
  type?: string;
  value?: unknown;
  description?: string;
  compiled?: { targetFingerprint?: Record<string, unknown> } | null;
  options?: { cssSelector?: string } | null;
  bindingHints?: { label?: string } | null;
  [k: string]: unknown;
}

/**
 * Step types safe to collapse when repeated back-to-back.
 *
 * Mirrors the runtime rule: a repeated `type`/fill can be a deliberate
 * clear-and-retype, and a repeated `press` (ArrowDown twice) is real input —
 * only re-issuing a click or the same navigation is pure noise.
 */
const COLLAPSIBLE_TYPES = new Set(['click', 'navigate']);

/**
 * Identity of a persisted step: what it DOES, not where it ran.
 *
 * `pageUrl` is deliberately excluded — the observed prod repeat was the same
 * click captured on two different pages (clicked "H&M" on /brand_products/Polo,
 * landed on /Biba, clicked "H&M" again). Including the URL would call those
 * distinct and miss the very case this exists for.
 *
 * Prefers the compiled plan's `targetFingerprint`, which is stable across
 * rounds, over any snapshot-local id.
 */
export function persistedStepIdentity(step: PersistedStep): string {
  const fp = step.compiled?.targetFingerprint;
  const target = fp
    ? [
        fp.tag ?? '',
        fp.href ?? '',
        fp.text ?? '',
        fp.role ?? '',
        // POSITION is part of the identity, and dropping it is a data-loss bug.
        // Measured on prod: a product listing has many "Add to cart" links that
        // share tag/href(`javascript:void();`)/text/role and even the same
        // primary locator — they differ ONLY by where they sit on the page. Two
        // such clicks in a row are two different products, not a retry, so
        // ignoring the box would silently delete a real step from a saved test.
        // The genuine retry case keeps an identical box (same element, clicked
        // twice), so this stays precise for what it is meant to catch.
        fingerprintPosition(fp),
      ].join('|')
    : `${step.options?.cssSelector ?? ''}|${step.bindingHints?.label ?? ''}`;
  const value = typeof step.value === 'string' ? step.value : '';
  return [step.type ?? '', target, value, step.description ?? ''].join('§');
}

/**
 * Rounded on-page position of a fingerprint, or '' when it has none.
 *
 * Rounded to whole pixels: sub-pixel jitter between two captures of the SAME
 * element (fractional layout, scrollbar) must not defeat the retry match, while
 * genuinely different controls sit hundreds of pixels apart.
 */
function fingerprintPosition(fp: Record<string, unknown>): string {
  const box = fp.boundingBox as { x?: number; y?: number } | undefined;
  if (!box || typeof box.x !== 'number' || typeof box.y !== 'number') return '';
  return `${Math.round(box.x)},${Math.round(box.y)}`;
}

/**
 * Remove consecutive duplicate steps from a persisted `steps_json` array.
 *
 * Pure — returns a new array and never mutates the input, so a caller can
 * compare before/after and decide whether a write is warranted.
 *
 * Step `id`s are NOT renumbered: they are opaque (`step-1`, `step-2`) and
 * nothing joins on them, so rewriting them would enlarge the diff on a live row
 * for no gain. Callers that need a contiguous sequence should say so
 * explicitly.
 */
export function dedupePersistedSteps(steps: PersistedStep[]): {
  steps: PersistedStep[];
  removed: number;
} {
  if (!Array.isArray(steps) || steps.length < 2) {
    return { steps: Array.isArray(steps) ? steps : [], removed: 0 };
  }

  const out: PersistedStep[] = [];
  let removed = 0;

  for (const step of steps) {
    const prev = out[out.length - 1];
    const collapsible =
      prev !== undefined &&
      typeof step?.type === 'string' &&
      step.type === prev.type &&
      COLLAPSIBLE_TYPES.has(step.type) &&
      persistedStepIdentity(step) === persistedStepIdentity(prev);

    if (collapsible) {
      removed++;
      continue;
    }
    out.push(step);
  }

  return { steps: out, removed };
}
