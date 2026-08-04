/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MOBILE BRIEFING — which questions to ask before exploring (max 3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A mobile exploration starts from an `appId` — a package name. Unlike the web,
 * there is no page to read: no landing copy, no sitemap, no robots.txt. An APK
 * manifest carries permissions and activity names, which is TECHNICAL data; it
 * cannot say what the business does, which flows matter, or whether this build
 * talks to production. Deriving a product brief from it would be inventing
 * business meaning out of technical artifacts.
 *
 * So mobile ASKS where web DERIVES. `briefing` is already an optional field on
 * the start request, and when it is absent the run currently proceeds in
 * silence — the agent explores with no product context and the user is never
 * told. These questions close that gap.
 *
 * The rules are deliberately the same as the web's `planBriefQuestions`:
 *   - **Max 3**, ranked, and only for what the run genuinely cannot proceed
 *     well without. Zero questions is the target outcome, not a failure.
 *   - A field the user already supplied is NEVER asked again.
 *   - Safety pre-empts: the destructive-action question takes slot 1 whenever
 *     nothing is known about what to avoid.
 *
 * Pure and dependency-free so the ranking is unit-testable without a runner,
 * a device, or an LLM.
 */

import type { MobileAppBriefing } from './mobile-runner.types';

/** Hard cap. A product decision (same as web), not a tuning knob. */
export const MAX_MOBILE_BRIEFING_QUESTIONS = 3;

export interface MobileBriefingQuestion {
  /** `MobileAppBriefing` field this answers — also the answer key. */
  key: keyof MobileAppBriefing;
  question: string;
  /** Fixed choices render as buttons; absent means free text. */
  options?: string[];
  /** Internal ranking score; never shown. */
  score: number;
}

/**
 * How bad it is to explore without this field.
 * 3 = risks an irreversible real-world action
 * 2 = the run explores the wrong things
 * 1 = output quality suffers
 */
type BlastRadius = 1 | 2 | 3;

const has = (v: unknown): boolean =>
  typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : false;

/**
 * Pick the questions worth interrupting a human for. Returns 0-3, best first.
 *
 * `goal` is the free-text objective the user typed when starting the run. It
 * frequently already names the flows to test ("test checkout and sign-up"), so
 * a run with a goal is NOT asked about key flows — asking would read as not
 * having listened.
 */
export function planMobileBriefingQuestions(
  briefing: MobileAppBriefing | undefined,
  goal?: string,
): MobileBriefingQuestion[] {
  const b = briefing ?? {};
  const candidates: MobileBriefingQuestion[] = [];

  const add = (
    key: keyof MobileAppBriefing,
    known: boolean,
    blast: BlastRadius,
    question: string,
    options?: string[],
  ) => {
    if (known) return;
    candidates.push({ key, question, options, score: blast });
  };

  // ── what must never happen — the only question with irreversible stakes ──
  // A mobile agent taps through a REAL app on a REAL device: it can place an
  // order, send a message, or delete an account for real. The runner has a
  // destructive-action guard, but it works on generic heuristics — only the
  // user knows that "Confirm transfer" moves actual money in THIS build.
  add(
    'avoid',
    has(b.avoid),
    3,
    'Is there anything the agent must NOT do in this app? (e.g. place a real order, send messages, delete data)',
    [
      'Nothing — it is a test build with fake data',
      'Do not complete payments or transfers',
      'Do not send anything to other people',
      'Do not delete or modify existing data',
    ],
  );

  // ── what the app is for ──
  // Seeds domain understanding for every subagent. Without it the agent reads
  // screens literally ("a list") instead of meaningfully ("the order history").
  add(
    'description',
    has(b.description),
    2,
    'In one sentence, what does this app do and who uses it?',
  );

  // ── which flows matter ──
  // Skipped when `goal` already says so: the user has told us once.
  add(
    'keyFlows',
    has(b.keyFlows) || has(goal),
    2,
    'Which 2-3 user journeys matter most? (e.g. sign up, checkout, book a ride)',
  );

  // ── data format rules ──
  // Lowest stakes: without it the FormFiller invents plausible values, which
  // usually work. It only matters for apps with strict local formats.
  add(
    'dataHints',
    has(b.dataHints) || has(b.region),
    1,
    'Do any fields need a specific format? (e.g. national ID = 12 digits, phone must be local)',
  );

  const ranked = [...candidates].sort((a, b2) => b2.score - a.score);

  // Safety pre-empt: the destructive question leads whenever it was asked at
  // all, regardless of arithmetic.
  const safety = ranked.find((q) => q.key === 'avoid');
  const ordered = safety ? [safety, ...ranked.filter((q) => q !== safety)] : ranked;

  return ordered.slice(0, MAX_MOBILE_BRIEFING_QUESTIONS);
}

/**
 * Fold answers into the briefing.
 *
 * Pure: returns a new object, never mutates. A skipped answer leaves the field
 * absent rather than writing an empty value, so a later run can ask again.
 *
 * The `avoid` answer is the one that changes agent BEHAVIOUR rather than just
 * its understanding, so its multiple-choice options are mapped to concrete
 * prohibitions instead of being stored as prose the agent has to interpret.
 */
export function applyMobileBriefingAnswers(
  briefing: MobileAppBriefing | undefined,
  answers: Array<{ key: string; answer: string | null }>,
): MobileAppBriefing {
  const next: MobileAppBriefing = { ...(briefing ?? {}) };

  for (const { key, answer } of answers) {
    const value = typeof answer === 'string' ? answer.trim() : '';
    if (!value) continue;

    switch (key) {
      case 'avoid': {
        const lower = value.toLowerCase();
        // "Nothing" is an explicit grant, not an empty answer — record it so a
        // later run does not re-ask, but store no prohibitions.
        if (lower.startsWith('nothing')) {
          next.avoid = ['(user confirmed: test build, no restrictions)'];
          break;
        }
        const known = [
          { match: 'payment', text: 'complete payments or transfers' },
          { match: 'transfer', text: 'complete payments or transfers' },
          { match: 'send', text: 'send messages or notifications to other people' },
          { match: 'delete', text: 'delete or modify existing data' },
        ].filter((k) => lower.includes(k.match));
        next.avoid = known.length
          ? [...new Set(known.map((k) => k.text))]
          : [value.slice(0, 120)];
        break;
      }

      case 'description':
        next.description = value.slice(0, 2000);
        break;

      case 'keyFlows':
        next.keyFlows = value
          .split(/[;\n]|(?:,\s)/)
          .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim())
          .filter((s) => s.length > 1)
          .slice(0, 6)
          .map((s) => s.slice(0, 120));
        break;

      case 'dataHints':
        next.dataHints = value.slice(0, 2000);
        break;
    }
  }

  return next;
}
