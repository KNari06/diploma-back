/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PHASE 0 — WHICH QUESTIONS TO ASK (max 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The analyst derives most of the brief from evidence. A handful of fields are
 * structurally underivable — no amount of crawling reveals whether a host is
 * production, or which role the supplied test account holds — and those are worth
 * interrupting a human for.
 *
 * PRODUCT DECISION (user, 2026-08-01): **max 3, and only when genuinely needed.**
 * Not four, and not infer-only. So each question must EARN its slot:
 *
 *   - A field the analyst already answered with real confidence is never asked.
 *     Showing it in the editable review card is free; a question is not.
 *   - Questions are ranked `blastRadius × (1 − confidence) × consumerCount`, then
 *     truncated to 3.
 *   - Safety pre-empts: if payments/irreversible flows exist and the environment
 *     is unproven, that question takes slot 1 unconditionally.
 *   - **Zero questions is the target outcome**, not a failure. Strong evidence
 *     should mean silence.
 */

import type { ProductBrief, BriefField } from './product-brief.types';

/** Hard cap. The product decision, not a tuning knob. */
export const MAX_BRIEF_QUESTIONS = 3;

export interface BriefQuestion {
  /** Brief field this answers — also the `askLog` key. */
  key: string;
  question: string;
  /** Fixed choices render as buttons; absent means free text. */
  options?: string[];
  /** Internal ranking score; not shown to the user. */
  score: number;
}

/**
 * How bad it is to get this field wrong.
 * 3 = an irreversible real-world side effect (money, notifications, publishing)
 * 2 = the whole run is mis-prioritised
 * 1 = a few wasted flows
 */
type BlastRadius = 1 | 2 | 3;

const CONFIDENCE_WEIGHT: Record<string, number> = { high: 0, medium: 0.5, low: 0.9 };

/** `1 − confidence`, where an unknown field is maximally uncertain. */
function uncertainty(f: BriefField<unknown> | undefined): number {
  if (!f || f.source === 'unknown') return 1;
  // A user already answered this — never ask again.
  if (f.source === 'user') return 0;
  return CONFIDENCE_WEIGHT[f.confidence] ?? 0.9;
}

/**
 * Does this product have anything irreversible to protect?
 *
 * Drives the safety pre-empt. Deliberately broad: a payment provider, a non-'never'
 * policy, or any flow the normalizer marked stop-before-commit all count.
 */
function hasIrreversibleSurface(brief: ProductBrief): boolean {
  if (brief.paymentProvider && brief.paymentProvider.source !== 'unknown') return true;
  if (brief.paymentPolicy.source !== 'unknown' && brief.paymentPolicy.value !== 'never') return true;
  // `stopBeforeCommit` is NOT evidence of risk on its own: the normalizer sets it
  // on every non-user flow as a precaution, so reading it here would ask a blog
  // whether it takes payments. Only an ANALYST-flagged flow counts — a user-listed
  // one carries the same flag purely from that default.
  return brief.criticalFlows.value.some((f) => f.stopBeforeCommit && f.source !== 'user');
}

/**
 * Pick the questions worth a human's attention. Returns 0-3, best first.
 */
export function planBriefQuestions(brief: ProductBrief): BriefQuestion[] {
  const candidates: BriefQuestion[] = [];

  const add = (
    key: string,
    field: BriefField<unknown> | undefined,
    blast: BlastRadius,
    consumers: number,
    question: string,
    options?: string[],
  ) => {
    const u = uncertainty(field);
    // Nothing to gain: the analyst is already confident, or a user answered.
    if (u === 0) return;
    candidates.push({ key, question, options, score: blast * u * consumers });
  };

  // ── environment + payment: the only questions with irreversible stakes ──
  // Asked as ONE question because the answers move together, and a slot spent on
  // each would crowd out everything else.
  if (hasIrreversibleSurface(brief)) {
    add(
      'environmentKind',
      brief.environmentKind,
      3,
      3,
      'Is this a production environment, and may the agent complete real purchases or payments?',
      [
        'Production — never complete payments',
        'Production — stop before the final confirm',
        'Staging/sandbox — completing payments is fine',
        'Not sure — be conservative',
      ],
    );
  }

  // ── which role the test account holds ──
  // Unknowable before login, and a wrong assumption burns flows on 403s.
  if (brief.roles.source !== 'unknown' && brief.roles.value.length > 1) {
    add(
      'testAccountRole',
      brief.testAccountRole,
      2,
      2,
      `This product seems to have several roles (${brief.roles.value.map((r) => r.name).join(', ')}). Which one does your test account have?`,
      [...brief.roles.value.map((r) => r.name), 'Not sure'],
    );
  }

  // ── critical flows: confirm-or-correct, pre-filled so "yes" is cheapest ──
  add(
    'criticalFlows',
    brief.criticalFlows,
    2,
    3,
    brief.criticalFlows.source === 'unknown'
      ? 'Which 2-3 user journeys matter most for this product?'
      : `I think these matter most: ${brief.criticalFlows.value.map((f) => f.name).join('; ')}. Correct, or would you reorder/replace them?`,
  );

  // ── never-touch: the highest-consequence field, but only worth a slot when
  // the analyst found nothing. An inferred list is already enforced. ──
  add(
    'mustNeverTouch',
    brief.mustNeverTouch,
    3,
    3,
    'Is there anything the agent must never do on this site? (e.g. email real customers, publish content, delete records)',
  );

  const ranked = candidates.sort((a, b) => b.score - a.score);

  // Safety pre-empts: the environment/payment question takes slot 1 whenever it
  // was asked at all, regardless of arithmetic.
  const safety = ranked.find((q) => q.key === 'environmentKind');
  const ordered = safety ? [safety, ...ranked.filter((q) => q !== safety)] : ranked;

  return ordered.slice(0, MAX_BRIEF_QUESTIONS);
}

/**
 * Fold a user's answers back into the brief.
 *
 * An answered field becomes `source:'user'` with `confidence:'high'` — the user IS
 * the evidence, which is also why the normalizer exempts user-sourced values from
 * the basis-required downgrade. A SKIPPED question leaves the field untouched and
 * is recorded in `askLog`, so the next run knows it was already offered.
 *
 * Pure: returns a new brief, never mutates the input.
 */
export function applyBriefAnswers(
  brief: ProductBrief,
  answers: Array<{ key: string; answer: string | null }>,
): ProductBrief {
  const next: ProductBrief = { ...brief };
  const askLog = [...(brief.askLog ?? [])];

  for (const { key, answer } of answers) {
    const answered = typeof answer === 'string' && answer.trim().length > 0;
    askLog.push({ key, answered });
    if (!answered) continue;

    const value = answer!.trim();

    switch (key) {
      case 'environmentKind': {
        // Map the multiple-choice answer onto BOTH fields it settles. Fail-closed:
        // an unrecognised answer leaves the conservative default in place.
        const lower = value.toLowerCase();
        if (lower.includes('staging') || lower.includes('sandbox')) {
          next.environmentKind = { value: 'staging', source: 'user', confidence: 'high', basis: 'user answered' };
          next.paymentPolicy = { value: 'allowed_sandbox', source: 'user', confidence: 'high', basis: 'user answered' };
        } else if (lower.includes('stop before')) {
          next.environmentKind = { value: 'production', source: 'user', confidence: 'high', basis: 'user answered' };
          next.paymentPolicy = { value: 'stop_before_commit', source: 'user', confidence: 'high', basis: 'user answered' };
        } else if (lower.includes('production')) {
          next.environmentKind = { value: 'production', source: 'user', confidence: 'high', basis: 'user answered' };
          next.paymentPolicy = { value: 'never', source: 'user', confidence: 'high', basis: 'user answered' };
        }
        // "Not sure" deliberately changes nothing — the defaults are already the
        // conservative reading.
        break;
      }

      case 'testAccountRole': {
        if (!/not sure/i.test(value)) {
          next.testAccountRole = { value, source: 'user', confidence: 'high', basis: 'user answered' };
        }
        break;
      }

      case 'criticalFlows': {
        // Free text. Split on separators and keep it as a user-ranked list.
        const names = value
          .split(/[;\n]|(?:,\s)/)
          .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim())
          .filter((s) => s.length > 1)
          .slice(0, 6);
        if (names.length) {
          next.criticalFlows = {
            value: names.map((name, i) => ({
              name: name.slice(0, 120),
              rank: i + 1,
              // Still stop-before-commit: naming a flow is not permission to
              // complete an irreversible action inside it. Only the
              // environment/payment answer grants that.
              stopBeforeCommit: true,
              source: 'user' as const,
              confidence: 'high' as const,
            })),
            source: 'user',
            confidence: 'high',
            basis: 'user answered',
          };
        }
        break;
      }

      case 'mustNeverTouch': {
        if (!/^\s*(no|none|nothing)\s*$/i.test(value)) {
          const items = value
            .split(/[;\n]|(?:,\s)/)
            .map((s) => s.trim())
            .filter((s) => s.length > 1)
            .slice(0, 20);
          if (items.length) {
            next.mustNeverTouch = {
              value: items.map((s) => s.slice(0, 200)),
              source: 'user',
              confidence: 'high',
              basis: 'user answered',
            };
          }
        }
        break;
      }
    }
  }

  next.askLog = askLog.slice(0, MAX_BRIEF_QUESTIONS);

  // Answered questions are no longer open.
  const answeredKeys = new Set(answers.filter((a) => a.answer?.trim()).map((a) => a.key));
  next.openQuestions = brief.openQuestions.filter(
    (q) => ![...answeredKeys].some((k) => q.toLowerCase().startsWith(k.toLowerCase())),
  );

  return next;
}
