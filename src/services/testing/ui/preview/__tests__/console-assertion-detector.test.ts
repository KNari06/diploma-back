import {
  detectConsoleAssertion,
  buildConsoleChannelHint,
} from '../console-assertion-detector';

describe('detectConsoleAssertion', () => {
  describe('recognises console assertions', () => {
    it.each([
      'Check that there are no console errors present',
      'no console errors',
      'There should be no JavaScript errors',
      'the page has no uncaught exceptions',
      'no js errors in the console',
    ])('en: %s', (text) => {
      expect(detectConsoleAssertion(text).isConsoleAssertion).toBe(true);
    });

    it.each([
      'Проверить, что нет ошибок в консоли',
      'в консоли нет ошибок',
      'консоль чистая',
    ])('ru: %s', (text) => {
      expect(detectConsoleAssertion(text).isConsoleAssertion).toBe(true);
    });

    it.each(['Консольде қате жоқ', 'консольде қателер жоқ'])('kk: %s', (text) => {
      expect(detectConsoleAssertion(text).isConsoleAssertion).toBe(true);
    });
  });

  describe('does NOT hijack assertions about errors visible in the UI', () => {
    // These are the dangerous false positives — rerouting them would break
    // tests that work correctly today.
    it.each([
      'An error message is displayed',
      'the error toast is shown',
      'a validation error is visible under the field',
      'Сообщение об ошибке отображается на экране',
      'ошибка показывается на странице',
      'Қате хабарламасы экранда көрсетіледі',
    ])('%s', (text) => {
      expect(detectConsoleAssertion(text).isConsoleAssertion).toBe(false);
    });

    it('does not fire on ordinary assertions with no error wording at all', () => {
      expect(detectConsoleAssertion('The cart shows 2 items').isConsoleAssertion).toBe(false);
      expect(detectConsoleAssertion('Login button is blue').isConsoleAssertion).toBe(false);
    });

    it('still fires when the author says "console" alongside a UI word', () => {
      // "shown" is a UI marker, but an explicit "console" means they meant it.
      const v = detectConsoleAssertion('no console errors are shown');
      expect(v.isConsoleAssertion).toBe(true);
    });
  });

  describe('separates a plain no-errors claim from a fuzzy one', () => {
    it('flags a bare absence claim as plain — the deterministic step covers it', () => {
      const v = detectConsoleAssertion('Check that there are no console errors present');
      expect(v.isConsoleAssertion).toBe(true);
      expect(v.isPlainNoErrors).toBe(true);
    });

    it('flags ru bare absence as plain', () => {
      expect(detectConsoleAssertion('нет ошибок в консоли').isPlainNoErrors).toBe(true);
    });

    it('does NOT call a qualified assertion plain — that is what the AI channel is for', () => {
      const v = detectConsoleAssertion('no payment-related console errors');
      expect(v.isConsoleAssertion).toBe(true);
      expect(v.isPlainNoErrors).toBe(false);
    });

    it('treats ru "связанные с" as a qualifier', () => {
      const v = detectConsoleAssertion('в консоли нет ошибок, связанных с оплатой');
      expect(v.isConsoleAssertion).toBe(true);
      expect(v.isPlainNoErrors).toBe(false);
    });

    it('a console assertion without negation is not "plain no errors"', () => {
      const v = detectConsoleAssertion('the console shows a 500 error');
      expect(v.isConsoleAssertion).toBe(true);
      expect(v.isPlainNoErrors).toBe(false);
    });
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(detectConsoleAssertion('').isConsoleAssertion).toBe(false);
    expect(detectConsoleAssertion('   ').isConsoleAssertion).toBe(false);
    expect(detectConsoleAssertion(undefined as unknown as string).isConsoleAssertion).toBe(false);
  });

  it('reports which term matched, for the log line', () => {
    expect(detectConsoleAssertion('no console errors').matchedTerm).toBe('console');
  });
});

describe('buildConsoleChannelHint', () => {
  it('points a plain assertion at the deterministic step', () => {
    const msg = buildConsoleChannelHint(true);
    expect(msg).toContain('No console errors');
    expect(msg).toContain('needs no AI');
  });

  it('offers the console context mode for a fuzzy assertion', () => {
    const msg = buildConsoleChannelHint(false);
    expect(msg).toContain('context mode');
    expect(msg).toContain('Console');
  });
});
