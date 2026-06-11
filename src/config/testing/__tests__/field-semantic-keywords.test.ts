/**
 * Contract + behavior tests for the field-semantic keyword registry.
 * Guards the regression that motivated extracting it: Kazakh stems kept
 * getting dropped from the inline ru/en map, so a Kazakh intent never
 * inferred the field in the degraded (LLM-down) path.
 */

import {
  FIELD_SEMANTIC_KEYWORDS,
  fieldSemanticStems,
  KEYWORD_STOP_WORDS,
  buildStopWordSet,
} from '../field-semantic-keywords';

describe('FIELD_SEMANTIC_KEYWORDS contract', () => {
  it('covers the four canonical autocomplete tokens', () => {
    expect(Object.keys(FIELD_SEMANTIC_KEYWORDS).sort()).toEqual(
      ['email', 'password', 'tel', 'username'],
    );
  });

  it('every field has non-empty en, ru AND kk stems (no language dropped)', () => {
    for (const [token, list] of Object.entries(FIELD_SEMANTIC_KEYWORDS)) {
      expect(list.en.length).toBeGreaterThan(0);
      expect(list.ru.length).toBeGreaterThan(0);
      // The whole point: Kazakh must be present for every field.
      expect(list.kk.length).toBeGreaterThanOrEqual(1);
      // Stems are lowercase surface forms (matched via includes()).
      for (const stem of fieldSemanticStems(list)) {
        expect(stem).toBe(stem.toLowerCase());
        expect(stem.trim().length).toBeGreaterThan(0);
      }
      expect(token).toBe(token.toLowerCase());
    }
  });

  it('infers password from a Kazakh intent (the original miss)', () => {
    const intent = 'құпиясөзді енгіз'.toLowerCase();
    const matched = fieldSemanticStems(FIELD_SEMANTIC_KEYWORDS.password)
      .some((stem) => intent.includes(stem));
    expect(matched).toBe(true);
  });

  it('infers email from a Russian inflected intent via stem match', () => {
    const intent = 'введите вашу почту'.toLowerCase();
    const matched = fieldSemanticStems(FIELD_SEMANTIC_KEYWORDS.email)
      .some((stem) => intent.includes(stem)); // "почт" ⊆ "почту"
    expect(matched).toBe(true);
  });

  it('infers tel from an English intent', () => {
    const intent = 'enter your phone number'.toLowerCase();
    const matched = fieldSemanticStems(FIELD_SEMANTIC_KEYWORDS.tel)
      .some((stem) => intent.includes(stem));
    expect(matched).toBe(true);
  });
});

describe('KEYWORD_STOP_WORDS', () => {
  it('has en, ru AND kk action verbs', () => {
    expect(KEYWORD_STOP_WORDS.en).toContain('click');
    expect(KEYWORD_STOP_WORDS.ru).toContain('нажми');
    expect(KEYWORD_STOP_WORDS.kk.length).toBeGreaterThanOrEqual(1);
  });

  it('buildStopWordSet drops ru/kk noise verbs but keeps the real target token', () => {
    const stop = buildStopWordSet();
    // Noise that previously survived as "keywords":
    expect(stop.has('нажми')).toBe(true);
    expect(stop.has('кнопку')).toBe(true);
    expect(stop.has('батырма')).toBe(true);
    // The actual target token must NOT be filtered:
    expect(stop.has('войти')).toBe(false);
  });
});
