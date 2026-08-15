/**
 * A draft must not die because a `scroll` had no target.
 *
 * `description` on a draft step is a TARGET — the text the runner resolves
 * against the a11y tree. Steps that address no element (scroll, go_back, wait)
 * have nothing to put there, so requiring one rejects a correct draft over a
 * field that is meaningless for that type.
 *
 * The cost of that rejection is what makes it worth fixing. A refused draft is
 * a negative example the model keeps in context: live on JanaPost TC-33
 * (2026-08-13) a single refusal was enough to stop it calling the draft tool
 * for the rest of the conversation — 4 of 4 chats holding one never drafted
 * again, while 2 of 2 fresh chats drafted first time. One of those refusals
 * was literally `Step #6 (6) is missing "description"`, thrown away with the
 * five good steps around it.
 *
 * The risk got worse deliberately: the prompt now asks the agent to author the
 * scroll it performed, so targetless steps are expected in every multi-screen
 * draft rather than being rare.
 *
 * The backfill must stay narrow — a `tap` with no description is genuinely
 * incomplete and still has to bail.
 */

import { describeTargetlessStep } from '../tools';

describe('steps that address no element get a readable label', () => {
  it('labels a scroll by its direction — the thing that defines it', () => {
    expect(describeTargetlessStep('scroll', { options: { direction: 'up' } })).toBe('Scroll up');
  });

  it('labels a directionless scroll rather than rejecting it', () => {
    expect(describeTargetlessStep('scroll', {})).toBe('Scroll');
  });

  it('labels a swipe the same way', () => {
    expect(describeTargetlessStep('swipe', { options: { direction: 'left' } })).toBe('Swipe left');
  });

  it('labels navigation keys', () => {
    expect(describeTargetlessStep('go_back', {})).toBe('Go back');
    expect(describeTargetlessStep('go_home', {})).toBe('Go to home screen');
  });

  it('labels a wait with its duration when given', () => {
    expect(describeTargetlessStep('wait', { options: { timeoutMs: 2000 } })).toBe('Wait 2000ms');
    expect(describeTargetlessStep('wait', {})).toBe('Wait');
  });

  it('labels a key press from the step value', () => {
    expect(describeTargetlessStep('press_key', { value: 'enter' })).toBe('Press enter');
  });

  it('labels a rotate by orientation', () => {
    expect(
      describeTargetlessStep('rotate', { options: { rotateOrientation: 'landscape' } }),
    ).toBe('Rotate to landscape');
  });
});

describe('element-targeting steps are untouched', () => {
  it('gives a tap nothing, so a missing description still bails the draft', () => {
    expect(describeTargetlessStep('tap', {})).toBe('');
    expect(describeTargetlessStep('click', { options: { direction: 'up' } })).toBe('');
  });

  it('gives type / assert / ai_check nothing either', () => {
    expect(describeTargetlessStep('type', {})).toBe('');
    expect(describeTargetlessStep('assert', {})).toBe('');
    expect(describeTargetlessStep('ai_check', {})).toBe('');
  });

  it('gives an unknown type nothing rather than inventing a label', () => {
    expect(describeTargetlessStep('some_future_type', {})).toBe('');
  });
});

describe('assertions carry their content in assertionText, not description', () => {
  it('backfills an ai_check from its assertionText', () => {
    expect(
      describeTargetlessStep('ai_check', {
        assertionText: 'Thank you for your feedback! is shown',
      }),
    ).toBe('Thank you for your feedback! is shown');
  });

  it('backfills assert_text from value when that is where the text lives', () => {
    expect(describeTargetlessStep('assert_text', { value: 'Рахмет' })).toBe('Рахмет');
  });

  it('prefers assertionText over value when both are present', () => {
    expect(
      describeTargetlessStep('assert', { assertionText: 'the banner is visible', value: 'x' }),
    ).toBe('the banner is visible');
  });

  it('truncates a very long assertion so the label stays readable', () => {
    const long = 'x'.repeat(200);
    const out = describeTargetlessStep('ai_check', { assertionText: long });
    expect(out.length).toBe(118);
    expect(out.endsWith('…')).toBe(true);
  });

  it('still returns nothing for an assertion with no content at all', () => {
    // Nothing to name it by — that IS incomplete, and the draft should bail.
    expect(describeTargetlessStep('ai_check', {})).toBe('');
  });
});
