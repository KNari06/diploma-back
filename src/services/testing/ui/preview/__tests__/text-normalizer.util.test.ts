import { normalizeText, escapeHasText, CELL_SEP } from '../text-normalizer.util';

describe('normalizeText', () => {
  it('passes through undefined / null / empty unchanged', () => {
    expect(normalizeText(undefined)).toBeUndefined();
    expect(normalizeText(null)).toBeUndefined();
    expect(normalizeText('')).toBe('');
  });

  it('applies NFC canonical composition', () => {
    // "e" + combining acute U+0301 (NFD, 2 code units) → precomposed "é" U+00E9 (NFC)
    const nfd = 'é';
    expect(nfd).toHaveLength(2);
    expect(normalizeText(nfd)).toBe('é');
    expect(normalizeText(nfd)).toHaveLength(1);
  });

  it('strips zero-width and BOM characters', () => {
    expect(normalizeText('a​b')).toBe('ab'); // ZERO WIDTH SPACE
    expect(normalizeText('a﻿b')).toBe('ab'); // BOM / ZWNBSP
    expect(normalizeText('a‍‌b')).toBe('ab'); // ZWJ + ZWNJ
    expect(normalizeText('a‮b')).toBe('ab'); // RIGHT-TO-LEFT OVERRIDE
  });

  it('collapses internal whitespace runs and trims', () => {
    expect(normalizeText('a   b\n\tc')).toBe('a b c');
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('is idempotent', () => {
    const messy = '  Қ​  test\n\nvalue  ';
    const once = normalizeText(messy)!;
    expect(normalizeText(once)).toBe(once);
  });

  it('leaves clean unicode text untouched', () => {
    expect(normalizeText('Войти')).toBe('Войти');
  });
});

describe('escapeHasText', () => {
  it('escapes backslashes and double quotes', () => {
    expect(escapeHasText('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeHasText('a\\b')).toBe('a\\\\b');
  });

  it('passes unicode through unmodified', () => {
    expect(escapeHasText('Войти')).toBe('Войти');
    expect(escapeHasText('登录')).toBe('登录');
  });

  it('handles a value with both special chars and unicode', () => {
    expect(escapeHasText('Статус: "Активен"')).toBe('Статус: \\"Активен\\"');
  });
});

describe('CELL_SEP', () => {
  it('is the Unicode Information Separator One (U+241F)', () => {
    expect(CELL_SEP).toBe('␟');
  });
});
