/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONSOLE-ASSERTION DETECTOR — is this ai_check really asking about the console?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The problem this solves, verbatim from a user report: someone authored an
 * `ai_check` with "Check that there are no console errors" and got
 *
 *     "Console errors cannot be verified from the provided HTML, accessibility
 *      tree, or screenshot."
 *
 * The model was right — HTML/a11y/screenshot genuinely cannot show console
 * state — but the failure is a dead end. Nothing tells the author that a
 * deterministic `assert_no_console_errors` step exists and would just work.
 *
 * So before spending an LLM call, we check whether the assertion is *about* the
 * console and whether the console channel is actually attached, and act on it.
 *
 * Deliberately NOT an LLM call: this runs on every ai_check, and paying a model
 * to decide whether to pay a model is absurd. Keyword matching is the right
 * tool — the cost of a wrong guess is bounded (see below).
 *
 * Multilingual because the product ships ru/kk/en (workspace invariant: control
 * vocabulary must cover all three, Kazakh is the one that gets forgotten).
 */

/**
 * Console-topic markers. Matching is substring-based over a lowercased
 * assertion, so inflected forms ("консоли", "консолью", "консольде") are
 * covered by the stem.
 */
const CONSOLE_TERMS: readonly string[] = [
  // en
  'console',
  'javascript error',
  'js error',
  'uncaught',
  'stack trace',
  // ru — stem, catches консоль/консоли/консолью
  'консол',
  'ошибк', // paired with a console/JS term below, never alone
  // kk — stem, catches консольде/консольден
  'қате', // same: only meaningful paired with a console term
];

/**
 * Terms that alone are enough to call it a console assertion. `ошибк`/`қате`
 * ("error") are far too broad on their own — "shows an error message" is a
 * normal UI assertion — so they are excluded here and only count when they
 * co-occur with a console word.
 */
const STANDALONE_TERMS: readonly string[] = [
  'console',
  'консол',
  'javascript error',
  'js error',
  'uncaught',
  'stack trace',
];

/**
 * Phrases that mean the assertion is about text VISIBLE ON THE PAGE, even
 * though it mentions errors. These must NOT be routed to the console channel —
 * "an error message is displayed" is a legitimate DOM assertion and rerouting
 * it would break a working test.
 */
const VISIBLE_UI_MARKERS: readonly string[] = [
  'on screen',
  'on the page',
  'is displayed',
  'is shown',
  'is visible',
  'error message',
  'toast',
  'banner',
  'на экране',
  'на странице',
  'отображается',
  'показывается',
  'видно',
  'сообщение об ошибке',
  'экранда',
  'бетте',
  'көрсетіледі',
];

export interface ConsoleAssertionVerdict {
  /** The assertion is asking about browser console / JS errors. */
  isConsoleAssertion: boolean;
  /**
   * It reads as a plain "there are no console errors" — i.e. fully answerable
   * by the deterministic step, with no fuzzy qualifier a model is needed for.
   * When true we should point the author at `assert_no_console_errors`.
   */
  isPlainNoErrors: boolean;
  /** Which term triggered the match — for the log line and the error text. */
  matchedTerm?: string;
}

/**
 * Classify an ai_check assertion with respect to the console.
 *
 * Conservative by construction: an assertion that merely mentions an error
 * *visible in the UI* is NOT treated as a console assertion, because the cost
 * of a false positive (hijacking a working DOM assertion) is much higher than
 * the cost of a false negative (the author sees today's behaviour).
 */
export function detectConsoleAssertion(assertionText: string): ConsoleAssertionVerdict {
  const text = (assertionText || '').toLowerCase().trim();
  if (!text) return { isConsoleAssertion: false, isPlainNoErrors: false };

  // A visible-UI phrasing wins outright — unless the author explicitly said
  // "console", in which case they meant the console and the UI word is
  // incidental ("no console errors are shown").
  const mentionsConsoleWord = text.includes('console') || text.includes('консол');
  if (!mentionsConsoleWord && VISIBLE_UI_MARKERS.some((m) => text.includes(m))) {
    return { isConsoleAssertion: false, isPlainNoErrors: false };
  }

  const standalone = STANDALONE_TERMS.find((t) => text.includes(t));
  let matchedTerm = standalone;

  if (!matchedTerm) {
    // No standalone term: allow the generic "error" words only when a
    // console/JS context word is also present.
    const hasErrorWord = text.includes('ошибк') || text.includes('қате') || text.includes('error');
    const hasContextWord = CONSOLE_TERMS.some(
      (t) => t !== 'ошибк' && t !== 'қате' && text.includes(t),
    );
    if (hasErrorWord && hasContextWord) {
      matchedTerm = CONSOLE_TERMS.find((t) => text.includes(t));
    }
  }

  if (!matchedTerm) return { isConsoleAssertion: false, isPlainNoErrors: false };

  // "Plain" = a bare absence claim. A qualifier ("no PAYMENT-related errors",
  // "errors mentioning checkout") means the author wants judgement, which is
  // exactly what the AI console channel is for — don't redirect those.
  const negation =
    /\b(no|not|without|zero|free of)\b/.test(text) ||
    text.includes('нет ') ||
    text.includes('не должно') ||
    text.includes('без ') ||
    text.includes('жоқ');

  // Qualifiers that imply filtering/reasoning rather than a flat count.
  const hasQualifier =
    /(related|about|mentioning|containing|matching|kind of|type of|except|other than)/.test(text) ||
    text.includes('связанн') ||
    text.includes('кроме') ||
    text.includes('содержащ') ||
    text.includes('байланысты');

  return {
    isConsoleAssertion: true,
    isPlainNoErrors: negation && !hasQualifier,
    matchedTerm,
  };
}

/**
 * The message shown when an ai_check asks about the console but the console
 * channel was never attached. Replaces the model's dead-end "cannot be
 * verified" with the actionable next step.
 */
export function buildConsoleChannelHint(isPlainNoErrors: boolean): string {
  return isPlainNoErrors
    ? 'This assertion is about browser console errors, which an AI check cannot see from HTML, the accessibility tree, or a screenshot. Use the "No console errors" step type instead — it checks the console directly and needs no AI.'
    : 'This assertion is about browser console errors. Set this step\'s context mode to one that includes "Console" so the console output is provided to the AI check, or use the "No console errors" step type for a plain no-errors check.';
}
