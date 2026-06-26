import { parseClickAtCoordinates, validateInputValue } from '../native-input-helpers';

describe('parseClickAtCoordinates', () => {
  it('returns null for falsy input', () => {
    expect(parseClickAtCoordinates(null)).toBeNull();
    expect(parseClickAtCoordinates('')).toBeNull();
    expect(parseClickAtCoordinates(undefined)).toBeNull();
  });

  it('parses comma-separated strings, tolerating whitespace and decimals', () => {
    expect(parseClickAtCoordinates('500,300')).toEqual({ x: 500, y: 300 });
    expect(parseClickAtCoordinates('  500 , 300  ')).toEqual({ x: 500, y: 300 });
    expect(parseClickAtCoordinates('500.5,300.25')).toEqual({ x: 500.5, y: 300.25 });
  });

  it('parses a JSON-string object', () => {
    expect(parseClickAtCoordinates('{"x":10,"y":20}')).toEqual({ x: 10, y: 20 });
  });

  it('parses a plain object', () => {
    expect(parseClickAtCoordinates({ x: 5, y: 6 })).toEqual({ x: 5, y: 6 });
  });

  it('returns null for malformed or non-numeric shapes', () => {
    expect(parseClickAtCoordinates('abc')).toBeNull();
    expect(parseClickAtCoordinates('{"x":"a","y":2}')).toBeNull();
    expect(parseClickAtCoordinates({ x: 5 })).toBeNull();
    expect(parseClickAtCoordinates({ x: '5', y: 6 } as any)).toBeNull();
  });
});

describe('validateInputValue', () => {
  it('validates number and range inputs', () => {
    expect(validateInputValue('number', '42')).toEqual({ valid: true });
    expect(validateInputValue('range', '3.14')).toEqual({ valid: true });
    expect(validateInputValue('number', 'abc').valid).toBe(false);
  });

  it('validates hex colors (#RGB or #RRGGBB)', () => {
    expect(validateInputValue('color', '#fff')).toEqual({ valid: true });
    expect(validateInputValue('color', '#ffffff')).toEqual({ valid: true });
    expect(validateInputValue('color', 'red').valid).toBe(false);
  });

  it('validates date / time / datetime-local formats', () => {
    expect(validateInputValue('date', '2026-01-02')).toEqual({ valid: true });
    expect(validateInputValue('date', '2026/01/02').valid).toBe(false);
    expect(validateInputValue('time', '12:30')).toEqual({ valid: true });
    expect(validateInputValue('time', '12:30:45')).toEqual({ valid: true });
    expect(validateInputValue('time', '1230').valid).toBe(false);
    expect(validateInputValue('datetime-local', '2026-01-02T12:30')).toEqual({ valid: true });
    expect(validateInputValue('datetime-local', '2026-01-02').valid).toBe(false);
  });

  it('validates month and week formats', () => {
    expect(validateInputValue('month', '2026-01')).toEqual({ valid: true });
    expect(validateInputValue('month', '2026').valid).toBe(false);
    expect(validateInputValue('week', '2026-W05')).toEqual({ valid: true });
    expect(validateInputValue('week', '2026-05').valid).toBe(false);
  });

  it('passes through unknown input types as valid', () => {
    expect(validateInputValue('text', 'anything')).toEqual({ valid: true });
    expect(validateInputValue('email', 'not-an-email')).toEqual({ valid: true });
  });

  it('includes a descriptive warning on invalid values', () => {
    expect(validateInputValue('number', 'x').warning).toContain('valid number');
    expect(validateInputValue('color', 'x').warning).toContain('hex color');
    expect(validateInputValue('date', 'x').warning).toContain('YYYY-MM-DD');
  });
});
