import { normalizeMobileDescription } from '../normalize-description';

describe('normalizeMobileDescription', () => {
  it('returns empty for nullish/empty input', () => {
    expect(normalizeMobileDescription(undefined)).toBe('');
    expect(normalizeMobileDescription(null)).toBe('');
    expect(normalizeMobileDescription('')).toBe('');
    expect(normalizeMobileDescription('   ')).toBe('');
  });

  it('strips matching quotes that wrap the whole string', () => {
    expect(normalizeMobileDescription('"Login"')).toBe('Login');
    expect(normalizeMobileDescription("'Login'")).toBe('Login');
    expect(normalizeMobileDescription('`Login`')).toBe('Login');
    expect(normalizeMobileDescription('  "Login"  ')).toBe('Login');
  });

  it('preserves inner quotes when whole string is wrapped', () => {
    // Whole-wrap path matches first → only outer pair stripped, inner kept
    expect(normalizeMobileDescription(`'a "b" c'`)).toBe('a "b" c');
  });

  it('strips inline balanced same-quote pairs in the middle of a string', () => {
    expect(normalizeMobileDescription('tap "Sign in"')).toBe('tap Sign in');
    expect(normalizeMobileDescription("press the 'Cancel' button")).toBe('press the Cancel button');
  });

  it('leaves UNBALANCED quotes intact (user is mid-typing or natural punctuation)', () => {
    // Trailing-unclosed: regex used to silently drop the dangling quote
    // here, distorting the intent. Now it stays.
    expect(normalizeMobileDescription('tap "Login')).toBe('tap "Login');
    expect(normalizeMobileDescription("Login'")).toBe(`Login'`);
  });

  it('keeps apostrophes in natural English when no closing pair exists', () => {
    expect(normalizeMobileDescription("it's a button")).toBe(`it's a button`);
    expect(normalizeMobileDescription("don't tap that")).toBe(`don't tap that`);
  });

  it('handles multiple inline pairs of the same character', () => {
    expect(normalizeMobileDescription('tap "A" or "B"')).toBe('tap A or B');
  });

  it('handles mixed quote characters as separate inline passes', () => {
    expect(normalizeMobileDescription(`press "OK" not 'Cancel'`)).toBe('press OK not Cancel');
  });

  it('is idempotent — applying twice equals once', () => {
    const cases = ['"Login"', 'tap "Sign in"', `it's a button`, '   "X"   ', 'tap "Login'];
    for (const c of cases) {
      const once = normalizeMobileDescription(c);
      const twice = normalizeMobileDescription(once);
      expect(twice).toBe(once);
    }
  });

  it('trims surrounding whitespace from final output', () => {
    expect(normalizeMobileDescription('  Login  ')).toBe('Login');
    expect(normalizeMobileDescription('  "Login"  ')).toBe('Login');
  });
});
