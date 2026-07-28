/**
 * The predicate decides whether a turn gets ONE extra LLM round, so both
 * directions cost something: a miss ships a reply the draft card contradicts,
 * a false positive burns a round. The recorded live failures are the floor.
 */

import { replyClaimsStepRevision } from '../draft-claim-reconciliation';

describe('replyClaimsStepRevision', () => {
  // Verbatim from the JanaPost TC-31 session that motivated this — the agent
  // wrote this changelog and emitted no draft card at all.
  it('catches the changelog that shipped with no draft', () => {
    const reply = [
      'Changed / added / removed:',
      'Kept steps 1–4 unchanged as requested.',
      'Changed step 5 from a guessed marketplace assertion to a concrete detail-screen check.',
      'Added a new step to verify the Lesson content on the Pinduoduo detail page.',
    ].join('\n');
    expect(replyClaimsStepRevision(reply)).toBe(true);
  });

  it('catches the inverse claim from the same session', () => {
    expect(
      replyClaimsStepRevision(
        'Step 3 fixed and step 4 updated exactly as requested. Steps 1, 2, 3, 5, 6, and 7 were kept as-is.',
      ),
    ).toBe(true);
  });

  it('catches a single-step claim', () => {
    expect(replyClaimsStepRevision('I updated step 6 to use the CSS selector instead.')).toBe(true);
    expect(replyClaimsStepRevision('Removed step 2 and renumbered the rest.')).toBe(true);
  });

  // Hard invariant #15: ASCII \b never matches Cyrillic, and these chats run in
  // ru/kk as often as en — the agent answers in the user's language.
  it('catches Russian and Kazakh claims', () => {
    expect(replyClaimsStepRevision('Изменил шаг 5 — теперь проверяется конкретная цена.')).toBe(true);
    expect(replyClaimsStepRevision('4-қадам жаңартылды, қалған қадамдар өзгерген жоқ.')).toBe(false);
    expect(replyClaimsStepRevision('Қадам 4 жаңартылды.')).toBe(true);
  });

  it('does NOT fire on ordinary observations or plans', () => {
    expect(replyClaimsStepRevision('The screen shows a login form with email and password fields.')).toBe(false);
    expect(replyClaimsStepRevision('I will tap Profile, then open Lessons, and check the main video.')).toBe(false);
    expect(replyClaimsStepRevision('Which flow should I test — login, or the tariffs screen?')).toBe(false);
  });

  // A bare mention of the word must not be enough: the structural preconditions
  // in the pipeline are what make this narrow, and this keeps the text signal
  // from firing on every reply that says "step".
  it('does NOT fire on the bare word "step" with no number or changelog marker', () => {
    expect(replyClaimsStepRevision('Each step runs in order on the device.')).toBe(false);
    expect(replyClaimsStepRevision('That step needs a CSS selector to replay.')).toBe(false);
  });

  it('handles empty and missing input', () => {
    expect(replyClaimsStepRevision('')).toBe(false);
    expect(replyClaimsStepRevision('   ')).toBe(false);
    expect(replyClaimsStepRevision(undefined)).toBe(false);
  });
});
