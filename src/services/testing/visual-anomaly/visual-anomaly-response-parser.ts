/**
 * Turns one Gemini vision response's raw JSON into a clean, deduped list of
 * findings — ADR-0016. Extracted out of `visual-anomaly-check.service.ts`
 * (which does recurrence-gating/DB-upsert orchestration, a distinct concern)
 * per this repo's architecture rule: when a change pushes an existing file
 * past ~400 lines, extract the concern you're adding rather than perpetuate
 * the violation. No Supabase, no LLM calls, no network — the only side
 * effect is a `logger` call on a dropped/collapsed finding, which is why the
 * test file relies on this repo's global logger auto-mock rather than being
 * fully mock-free.
 */
import { VISUAL_ANOMALY_CATEGORIES, VisualAnomalyCategory } from '@/ai/prompts/visual-anomaly-prompts';
import { logger } from '@/utils/core/logger';

export interface NormalizedFinding {
  category: VisualAnomalyCategory;
  description: string;
  confidence: number;
}

/**
 * Confirmed live (2026-07-10): despite the old single-category schema saying
 * `category` is a bare string or null, Gemini sometimes wrapped it in a
 * single-element array (`["overlapping_cutoff_ui"]`). Confirmed AGAIN live
 * (2026-07-11, pilot for the multi-finding schema — ADR-0016): under the new
 * schema Gemini can ALSO put a MULTI-element array on one finding
 * (`"category":["placeholder_text","broken_image"]`) when it reads one
 * visual element as satisfying two categories at once (e.g. a placeholder
 * image area that is both "showing placeholder text" and "missing an actual
 * image"). Passed through unnormalized, an array value fails
 * `visual_anomaly_findings`'s `category` CHECK constraint at insert time
 * (Postgres error 23514) and silently drops an otherwise-valid,
 * high-confidence finding — exactly the failure mode this whole file exists
 * to avoid.
 *
 * Rather than pick one and drop the rest, this EXPANDS a multi-category
 * finding into one normalized entry per category — lossless, and a natural
 * fit now that the schema already tracks one row per (test_case_id, role,
 * category) fingerprint. Falls back to 'other' for any value outside the
 * known category set (future schema drift on Gemini's side should degrade
 * gracefully, not throw a DB constraint violation), drops non-string
 * entries, and de-dups so `["broken_image","broken_image"]` doesn't expand
 * into two identical categories.
 */
export function normalizeCategoryList(raw: unknown): VisualAnomalyCategory[] {
  const values = Array.isArray(raw) ? raw : [raw];
  const out: VisualAnomalyCategory[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    out.push(
      (VISUAL_ANOMALY_CATEGORIES as readonly string[]).includes(value)
        ? (value as VisualAnomalyCategory)
        : 'other',
    );
  }
  return Array.from(new Set(out));
}

/**
 * Unwraps a SINGLE-element array the same way `normalizeCategoryList` does
 * for `category` — Gemini has confirmed-live demonstrated array-wrapping on
 * that sibling field twice, so a `"confidence":[0.92]` shape is plausible
 * here too. Without this, `typeof [0.92] === 'object'` (never `'number'`),
 * so a genuinely high-confidence finding would silently persist as
 * `confidence: 0` and read as noise to `applyVisualAnomalySoftening`'s
 * `confidence >= 0.7` filter.
 *
 * Deliberately does NOT unwrap a multi-element array the way
 * `normalizeCategoryList` expands one — for category, multiple values
 * genuinely mean "multiple categories apply." For a scalar like confidence
 * there's no principled way to pick one of several values, so a
 * multi-element array falls through to the safe `0` default instead of
 * silently cherry-picking an arbitrary element.
 */
export function normalizeConfidence(raw: unknown): number {
  const unwrapped = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  const value = typeof unwrapped === 'string' ? Number(unwrapped) : unwrapped;
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * ADR-0016 — turns one Gemini response's raw `findings` payload into a flat,
 * normalized list. Tolerates three shapes: the documented `{findings:[...]}`
 * wrapper, a bare top-level array (some models occasionally skip the
 * wrapper), and the OLD pre-ADR-0016 flat single-finding object
 * (`{category, description, confidence}`, no `findings` key) — this file's
 * own history already shows Gemini drifting schema more than once, so a
 * regression to the shape this whole rework replaced is plausible, not
 * theoretical.
 *
 * Each raw entry expands to 1+ normalized findings via `normalizeCategoryList`
 * (see its doc comment for why "1+", not "1"). A raw entry that contributes
 * ZERO categories (not a string, not an array of strings, or the entry
 * itself isn't an object) is logged and dropped — there is no fingerprint to
 * persist it under, but silently losing a real detection with no trace is
 * exactly the failure mode this file exists to avoid, so the drop itself
 * must be visible even when the finding can't be.
 */
export function normalizeFindings(raw: unknown): NormalizedFinding[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.findings)
      ? (raw as any).findings
      // Legacy flat shape: a bare object that looks like one finding
      // (`category` present) rather than a `findings` wrapper.
      : raw && typeof raw === 'object' && 'category' in (raw as object)
        ? [raw]
        : [];

  const out: NormalizedFinding[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      logger.warn('[VISUAL_ANOMALY] Dropping non-object finding entry — no category to resolve', { entry });
      continue;
    }
    const categories = normalizeCategoryList((entry as any).category);
    const description = typeof (entry as any).description === 'string' ? (entry as any).description : '';
    const confidence = normalizeConfidence((entry as any).confidence);
    if (categories.length === 0) {
      logger.warn('[VISUAL_ANOMALY] Dropping finding with unresolvable category', {
        rawCategory: (entry as any).category,
        description,
      });
      continue;
    }
    for (const category of categories) {
      out.push({ category, description, confidence });
    }
  }
  return out;
}

/**
 * The persisted fingerprint (`fingerprint()` in `visual-anomaly-check.service.ts`)
 * is (test_case_id, role, category) — unchanged by ADR-0016 (see DECISIONS.md).
 * Two findings that expand to the SAME known category within one screenshot
 * (either two genuinely distinct same-category defects, or the
 * multi-category-array expansion in `normalizeCategoryList` producing an
 * overlapping category from two different raw entries) would otherwise race
 * to upsert the same row within one `runSweep` call. Keeps the
 * higher-confidence one and logs the collapse — an accepted, documented
 * limitation (same trade-off the pre-existing pattern-key design already
 * made for wording drift ACROSS runs; this is the same trade-off WITHIN one
 * run).
 *
 * `'other'` is EXEMPT from this collapse. Unlike a known category (where two
 * findings sharing it are usually the same underlying defect described
 * slightly differently), `'other'` is a heterogeneous catch-all — two
 * `'other'` findings are not reliably the same defect, so collapsing them
 * risks silently discarding a genuinely distinct description. Every
 * `'other'` finding survives this function; `upsertObservation`'s
 * confidence-gated overwrite (see `upsertExisting`) is the backstop if they
 * still collide at the DB layer under the shared `'other'` fingerprint.
 */
export function dedupeByCategory(findings: NormalizedFinding[]): NormalizedFinding[] {
  const byCategory = new Map<string, NormalizedFinding>();
  const otherFindings: NormalizedFinding[] = [];

  for (const finding of findings) {
    if (finding.category === 'other') {
      otherFindings.push(finding);
      continue;
    }
    const existing = byCategory.get(finding.category);
    if (!existing) {
      byCategory.set(finding.category, finding);
      continue;
    }
    const [kept, dropped] = finding.confidence > existing.confidence ? [finding, existing] : [existing, finding];
    logger.info('[VISUAL_ANOMALY] Collapsing duplicate-category finding within one screenshot', {
      category: finding.category,
      kept: kept.description,
      dropped: dropped.description,
    });
    byCategory.set(finding.category, kept);
  }

  return [...byCategory.values(), ...otherFindings];
}
