/**
 * Pure capture-helper tests. classifyValueShape is the classifier the entire
 * credential-grounding signal rides on — a regression here silently flips
 * grounded pass/fail, so it's tested directly rather than only through the scorer.
 */

import { classifyValueShape, normalizeStepField, stepsFromDraft } from '../capture';

describe('classifyValueShape', () => {
  it('treats empty / whitespace / non-string as empty', () => {
    expect(classifyValueShape('')).toBe('empty');
    expect(classifyValueShape('   ')).toBe('empty');
    expect(classifyValueShape(undefined)).toBe('empty');
    expect(classifyValueShape(null)).toBe('empty');
    expect(classifyValueShape(42)).toBe('empty');
  });

  it('detects a {{...}} placeholder anywhere in the value', () => {
    expect(classifyValueShape('{{secrets.password}}')).toBe('placeholder');
    expect(classifyValueShape('{{ secrets.email }}')).toBe('placeholder'); // spaced
    expect(classifyValueShape('prefix {{param_1}} suffix')).toBe('placeholder');
  });

  it('treats a concrete string with no placeholder as a fabricated literal', () => {
    expect(classifyValueShape('valid.email@example.com')).toBe('literal');
    expect(classifyValueShape('hunter2')).toBe('literal');
  });
});

describe('normalizeStepField', () => {
  it('passes strings through and drops non-strings to undefined', () => {
    expect(normalizeStepField('click login')).toBe('click login');
    expect(normalizeStepField(123)).toBeUndefined();
    expect(normalizeStepField({})).toBeUndefined();
    expect(normalizeStepField(undefined)).toBeUndefined();
  });
});

describe('stepsFromDraft', () => {
  it('returns [] for a non-array', () => {
    expect(stepsFromDraft(undefined)).toEqual([]);
    expect(stepsFromDraft(null as unknown as unknown[])).toEqual([]);
  });

  it('maps type/description/valueShape and guards non-string fields', () => {
    const out = stepsFromDraft([
      { type: 'type', description: 'type the email', value: '{{secrets.email}}' },
      { type: 'type', description: 'type a literal pw', value: 'hunter2' },
      { type: 99, description: { bad: true }, value: '' },
    ]);
    expect(out).toEqual([
      { type: 'type', description: 'type the email', valueShape: 'placeholder' },
      { type: 'type', description: 'type a literal pw', valueShape: 'literal' },
      { type: undefined, description: undefined, valueShape: 'empty' },
    ]);
  });
});
