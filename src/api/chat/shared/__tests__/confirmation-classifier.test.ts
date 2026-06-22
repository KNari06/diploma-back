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
});
