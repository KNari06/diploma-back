/**
 * Multilingual structural-label recognition.
 *
 * The CSV `scenario` field and the TestOps PDF carry the report's LOCALIZED
 * section labels. These tests lock in that "Expected result" / "Precondition" /
 * "Steps" and the `[attachment N]` marker are recognised across languages, not
 * only EN/RU/KZ (the old hardcoded set that silently mis-parsed other locales).
 */

import {
  EXPECTED_RESULT_LABEL,
  PRECONDITION_LABEL,
  STEPS_LABEL,
  isAttachmentMarkerWord,
  allSectionLabelForms,
} from '../allure-labels';

describe('EXPECTED_RESULT_LABEL — multilingual', () => {
  const positives = [
    'Expected result',
    'Expected result:',
    'Expected results',
    'Ожидаемый результат',
    'Күтілетін нәтиже',
    'Erwartetes Ergebnis',
    'Résultat attendu',
    'Resultado esperado',
    'Risultato atteso',
    'Beklenen sonuç',
    '预期结果',
    '예상 결과',
    '- Expected result:',   // with leading list marker
    '1. Expected result',   // with numbering
  ];
  it.each(positives)('recognises %s', (line) => {
    expect(EXPECTED_RESULT_LABEL.test(line.trim())).toBe(true);
  });

  it('captures trailing text on the same line', () => {
    const m = 'Expected result: the page loads'.match(EXPECTED_RESULT_LABEL);
    expect(m?.[1]).toBe('the page loads');
  });

  it('captures empty when the label is alone', () => {
    const m = 'Ожидаемый результат:'.match(EXPECTED_RESULT_LABEL);
    expect((m?.[1] ?? '').trim()).toBe('');
  });

  it('does NOT match an ordinary step line', () => {
    expect(EXPECTED_RESULT_LABEL.test('Click the login button')).toBe(false);
    expect(EXPECTED_RESULT_LABEL.test('Открыть страницу профиля')).toBe(false);
  });
});

describe('PRECONDITION_LABEL / STEPS_LABEL — multilingual', () => {
  it('recognises precondition in several languages', () => {
    for (const l of ['Precondition', 'Предусловие', 'Алдын ала шарт', 'Vorbedingung', '前提条件']) {
      expect(PRECONDITION_LABEL.test(l)).toBe(true);
    }
  });
  it('recognises steps header in several languages', () => {
    for (const l of ['Steps', 'Шаги', 'Қадамдар', 'Schritte', 'Étapes', '步骤']) {
      expect(STEPS_LABEL.test(l)).toBe(true);
    }
  });
});

describe('isAttachmentMarkerWord — multilingual', () => {
  it('matches attachment words across languages', () => {
    for (const w of ['attachment', 'Attachment', 'вложение', 'тіркеме', 'Anhang', '附件']) {
      expect(isAttachmentMarkerWord(w)).toBe(true);
    }
  });
  it('does not match step words', () => {
    for (const w of ['step', 'шаг', 'Schritt', '']) {
      expect(isAttachmentMarkerWord(w)).toBe(false);
    }
  });
});

describe('allSectionLabelForms', () => {
  it('exposes non-empty form lists for the prompt', () => {
    const f = allSectionLabelForms();
    expect(f.steps.length).toBeGreaterThan(5);
    expect(f.expected.length).toBeGreaterThan(5);
    expect(f.precondition.length).toBeGreaterThan(5);
  });
});
