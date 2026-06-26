// AISelectorEngine is only referenced by getLocator (not under test); stub it so
// importing selector-utils doesn't pull the AI dependency tree.
jest.mock('@/services/ai-selector/ai-selector-engine.service', () => ({
  AISelectorEngine: class {},
}));

import {
  validateSelectorFormat,
  normalizeSelector,
  isSelectorRelatedError,
} from '../selector-utils';

describe('validateSelectorFormat', () => {
  it('rejects an empty selector', () => {
    expect(validateSelectorFormat('')).toEqual({
      isValid: false,
      format: 'unknown',
      issue: 'Empty selector',
    });
  });

  it('flags mixed CSS + Playwright with a combinator', () => {
    const r = validateSelectorFormat('.class > role=button');
    expect(r.isValid).toBe(false);
    expect(r.format).toBe('mixed');
  });

  it('flags space-separated mixed CSS + Playwright', () => {
    const r = validateSelectorFormat('.class role=button');
    expect(r.isValid).toBe(false);
    expect(r.format).toBe('mixed');
  });

  it.each(['role=button', 'text=Login', 'label=Email', 'ROLE=link'])(
    'recognises Playwright selector %s',
    (sel) => {
      expect(validateSelectorFormat(sel)).toEqual({ isValid: true, format: 'playwright' });
    },
  );

  it.each(['//div', '/html/body', 'xpath=//button'])('recognises XPath %s', (sel) => {
    expect(validateSelectorFormat(sel)).toEqual({ isValid: true, format: 'xpath' });
  });

  it.each(['#id', '.cls', '[data-x]', 'button', 'div[role="x"]'])('recognises CSS %s', (sel) => {
    expect(validateSelectorFormat(sel)).toEqual({ isValid: true, format: 'css' });
  });

  it('treats a chained >> selector as Playwright', () => {
    expect(validateSelectorFormat('div >> text=Login')).toEqual({ isValid: true, format: 'playwright' });
  });

  it('falls back to unknown for unclassifiable input', () => {
    expect(validateSelectorFormat('123abc')).toEqual({ isValid: true, format: 'unknown' });
  });
});

describe('normalizeSelector', () => {
  it('returns falsy input unchanged', () => {
    expect(normalizeSelector('')).toBe('');
  });

  it('returns an already-normalized >> selector as-is', () => {
    expect(normalizeSelector('div >> text=Login')).toBe('div >> text=Login');
  });

  it('repairs a double-processed "> >>" selector', () => {
    expect(normalizeSelector('.relative > >> role=textbox')).toBe('.relative >> role=textbox');
  });

  it('converts getBy* helpers to the key=value form', () => {
    expect(normalizeSelector("getByText('Login')")).toBe('text="Login"');
    expect(normalizeSelector("getByTestId('submit')")).toBe('testid="submit"');
    expect(normalizeSelector("getByLabel('Email')")).toBe('label="Email"');
    expect(normalizeSelector("getByRole('button')")).toBe('role=button');
    expect(normalizeSelector("getByRole('button', {name: 'Save'})")).toBe('role=button[name="Save"]');
  });

  it('normalizes single-quoted forms to double quotes', () => {
    expect(normalizeSelector("text='Login'")).toBe('text="Login"');
    expect(normalizeSelector("testid='submit'")).toBe('testid="submit"');
    expect(normalizeSelector("role=button[name='Save']")).toBe('role=button[name="Save"]');
    expect(normalizeSelector("label='Email'")).toBe('label="Email"');
  });

  it('simplifies a :has-text() contextual locator to text=', () => {
    expect(normalizeSelector("button:has-text('Login')")).toBe('text="Login"');
  });

  it('extracts the Playwright part from a mixed selector (combinator and space forms)', () => {
    expect(normalizeSelector('.foo > role=button')).toBe('role=button');
    expect(normalizeSelector('.foo role=button')).toBe('role=button');
  });

  it('leaves a plain CSS selector untouched', () => {
    expect(normalizeSelector('.foo .bar')).toBe('.foo .bar');
    expect(normalizeSelector('#submit')).toBe('#submit');
  });
});

describe('isSelectorRelatedError', () => {
  it('returns false for nullish input', () => {
    expect(isSelectorRelatedError(null)).toBe(false);
    expect(isSelectorRelatedError(undefined)).toBe(false);
  });

  it('treats a selector-mentioning TimeoutError as selector-related', () => {
    expect(isSelectorRelatedError({ name: 'TimeoutError', message: 'Timeout waiting for locator' })).toBe(true);
    expect(isSelectorRelatedError({ name: 'TimeoutError', message: 'element not ready' })).toBe(true);
  });

  it('treats an unrelated TimeoutError as not selector-related', () => {
    expect(isSelectorRelatedError({ name: 'TimeoutError', message: 'navigation timed out' })).toBe(false);
  });

  it.each([
    'selector not found',
    'Element not found in DOM',
    'waiting for selector ".x"',
    'strict mode violation: multiple elements',
    'Element is not visible',
    'element is not attached to the DOM',
  ])('matches the selector error pattern: %s', (message) => {
    expect(isSelectorRelatedError({ message })).toBe(true);
  });

  it('returns false for an unrelated error message', () => {
    expect(isSelectorRelatedError({ message: 'network request failed' })).toBe(false);
  });
});
