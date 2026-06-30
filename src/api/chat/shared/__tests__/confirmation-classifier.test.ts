import { classifyConfirmationByRegex } from '../confirmation-classifier';

describe('classifyConfirmationByRegex', () => {
  it('classifies affirmatives as confirm (EN + RU)', () => {
    for (const m of ['yes', 'yeah', 'ok', 'sure', 'go ahead', 'confirm', 'да', 'давай', 'подтверждаю', 'запускай']) {
      expect(classifyConfirmationByRegex(m)).toBe('confirm');
    }
  });

  it('classifies negatives as decline (EN + RU)', () => {
    for (const m of ['no', 'nope', 'cancel', 'stop', 'нет', 'отмена', 'отменить']) {
      expect(classifyConfirmationByRegex(m)).toBe('decline');
    }
  });

  it('classifies anything else as other', () => {
    for (const m of ['maybe', 'what will it do?', 'change the time to 10am', '']) {
      expect(classifyConfirmationByRegex(m)).toBe('other');
    }
  });

  it('matches at the start of a longer affirmative phrase', () => {
    expect(classifyConfirmationByRegex('yes please do it')).toBe('confirm');
    expect(classifyConfirmationByRegex('no, cancel that')).toBe('decline');
  });

  it('does NOT match an affirmative that is not at the start ("let\'s start")', () => {
    // The anchor is intentional (^word) — "let's start" is NOT a regex confirm.
    // This is BY DESIGN: the LLM classifier handles such casual phrasing, and
    // the exploration-confirm "other" branch re-asks rather than looping.
    // Do not "fix" this by un-anchoring the regex — keep the anchor + LLM split.
    expect(classifyConfirmationByRegex("let's start")).toBe('other');
    expect(classifyConfirmationByRegex("let's go")).toBe('other');
  });
});
