import { substituteParamsInString, applyParameters } from '../parameter-substitution.utils';

describe('substituteParamsInString', () => {
  it('substitutes a {{name}} placeholder', () => {
    expect(substituteParamsInString('hello {{name}}', { name: 'world' })).toBe('hello world');
  });

  it('substitutes a ${name} placeholder', () => {
    expect(substituteParamsInString('login ${email}', { email: 'a@b.com' })).toBe('login a@b.com');
  });

  it('substitutes both syntaxes in one pass', () => {
    expect(
      substituteParamsInString('{{user}} / ${pass}', { user: 'neo', pass: 'matrix' }),
    ).toBe('neo / matrix');
  });

  it('replaces every occurrence of a placeholder', () => {
    expect(substituteParamsInString('{{x}}-{{x}}', { x: '1' })).toBe('1-1');
  });

  it('coerces non-string parameter values to strings', () => {
    expect(substituteParamsInString('count={{n}}', { n: 42 })).toBe('count=42');
    expect(substituteParamsInString('flag={{b}}', { b: false })).toBe('flag=false');
  });

  it('supports dotted placeholder names', () => {
    expect(substituteParamsInString('{{user.email}}', { 'user.email': 'x@y.z' })).toBe('x@y.z');
  });

  it('leaves an unknown {{name}} placeholder intact', () => {
    expect(substituteParamsInString('hi {{missing}}', {})).toBe('hi {{missing}}');
  });

  it('leaves an unknown ${name} placeholder intact for runtime scratchpad resolution', () => {
    expect(substituteParamsInString('otp ${otp_code}', {})).toBe('otp ${otp_code}');
  });

  it('treats a null or undefined parameter value as missing and keeps the placeholder', () => {
    expect(substituteParamsInString('{{a}}', { a: null })).toBe('{{a}}');
    expect(substituteParamsInString('{{a}}', { a: undefined })).toBe('{{a}}');
  });

  it('returns the input unchanged when there are no placeholders', () => {
    expect(substituteParamsInString('plain text', { a: '1' })).toBe('plain text');
  });
});

describe('applyParameters', () => {
  it('returns items unchanged when no parameters are provided', () => {
    const items = [{ value: '{{a}}' }];
    expect(applyParameters(items, {})).toBe(items);
  });

  it('substitutes string leaves at the top level', () => {
    const result = applyParameters([{ value: '{{a}}' }], { a: 'X' });
    expect(result).toEqual([{ value: 'X' }]);
  });

  it('substitutes nested object and array leaves', () => {
    const result = applyParameters(
      [{ options: { value: '{{a}}' }, hints: ['${b}', 'static'] }],
      { a: 'X', b: 'Y' },
    );
    expect(result).toEqual([{ options: { value: 'X' }, hints: ['Y', 'static'] }]);
  });

  it('leaves non-string leaves untouched', () => {
    const result = applyParameters([{ n: 5, b: true, s: '{{a}}' }], { a: 'X' });
    expect(result).toEqual([{ n: 5, b: true, s: 'X' }]);
  });

  it('preserves null leaves', () => {
    const result = applyParameters([{ value: null, s: '{{a}}' }], { a: 'X' });
    expect(result).toEqual([{ value: null, s: 'X' }]);
  });

  it('does not mutate the original items', () => {
    const items = [{ value: '{{a}}' }];
    applyParameters(items, { a: 'X' });
    expect(items[0].value).toBe('{{a}}');
  });
});
