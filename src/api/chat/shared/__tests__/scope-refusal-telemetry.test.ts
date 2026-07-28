/**
 * The predicate gates a diagnostic log line for the scope-guard misfires, so
 * the bar is: catch the guard's real refusals in any language, and do NOT
 * flag ordinary answers that happen to name the product.
 */

import { extractReplyText, looksLikeScopeRefusal } from '../scope-refusal-telemetry';

describe('looksLikeScopeRefusal', () => {
  it('flags the refusals recorded live, verbatim', () => {
    expect(
      looksLikeScopeRefusal('I can only help with testing/QAIT. What flow or screen should I test next?'),
    ).toBe(true);
    expect(
      looksLikeScopeRefusal("I'm only helping with testing/QAIT. What exact Tariffs assertion should I add next?"),
    ).toBe(true);
    expect(
      looksLikeScopeRefusal(
        'I can only help with testing/QAIT. What test flow or step list would you like me to fix or author?',
      ),
    ).toBe(true);
  });

  // The guard tells the model to reply "in the user's language", but the
  // product names survive translation — which is why the predicate keys off
  // them instead of a hand-written ru/kk phrase list that would have missed
  // exactly these.
  it('flags a translated refusal, because the product names do not translate', () => {
    expect(looksLikeScopeRefusal('Я помогаю только с testing/QAIT. Какой сценарий протестировать?')).toBe(true);
    expect(looksLikeScopeRefusal('Мен тек testing/QAIT бойынша көмектесемін. Қандай ағынды тексереміз?')).toBe(true);
  });

  it('tolerates spacing around the slash', () => {
    expect(looksLikeScopeRefusal('I only help with testing / QAIT. What should I test?')).toBe(true);
  });

  it('does NOT flag a long answer that merely mentions the product', () => {
    const helpful =
      'Yes — I added the assertion to step 4. '.repeat(12) +
      'You can also run this from testing/QAIT as a regression later.';
    expect(helpful.length).toBeGreaterThan(400);
    expect(looksLikeScopeRefusal(helpful)).toBe(false);
  });

  it('does NOT flag ordinary replies', () => {
    expect(looksLikeScopeRefusal('Drafted 7 steps for "TC-31 Education". Confirm to run them.')).toBe(false);
    expect(looksLikeScopeRefusal('📱 No active mobile session. Start a device in the editor, then ask again.')).toBe(
      false,
    );
    expect(looksLikeScopeRefusal('')).toBe(false);
    expect(looksLikeScopeRefusal(undefined)).toBe(false);
    expect(looksLikeScopeRefusal({ message: 'nope' })).toBe(false);
  });
});

describe('extractReplyText', () => {
  it('reads the field names handlers actually use', () => {
    expect(extractReplyText({ message: 'hello' })).toBe('hello');
    expect(extractReplyText({ reply: 'hello' })).toBe('hello');
    expect(extractReplyText({ response: 'hello' })).toBe('hello');
  });

  it('prefers `message` when several are present', () => {
    expect(extractReplyText({ message: 'first', reply: 'second' })).toBe('first');
  });

  it('returns undefined for shapes with no reply text', () => {
    expect(extractReplyText({ metadata: {} })).toBeUndefined();
    expect(extractReplyText({ message: '   ' })).toBeUndefined();
    expect(extractReplyText(null)).toBeUndefined();
    expect(extractReplyText([])).toBeUndefined();
  });
});
