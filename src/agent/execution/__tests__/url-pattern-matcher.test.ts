import {
  parseRegexString,
  safeRegexTestSync,
  safeRegexTestAsync,
  globToRegexString,
  matchSubstring,
  matchGlob,
  matchRegex,
  matchDomain,
  buildGlobWaitPayload,
  buildRegexWaitPayload,
} from '../url-pattern-matcher';

describe('parseRegexString', () => {
  it('defaults a plain string to case-insensitive', () => {
    expect(parseRegexString('foo\\d+')).toEqual({ pattern: 'foo\\d+', flags: 'i' });
  });

  it('honours caseSensitive for a plain string', () => {
    expect(parseRegexString('foo', true)).toEqual({ pattern: 'foo', flags: '' });
  });

  it('parses /pattern/flags syntax', () => {
    expect(parseRegexString('/foo\\d+/i')).toEqual({ pattern: 'foo\\d+', flags: 'i' });
    expect(parseRegexString('/foo/gi')).toEqual({ pattern: 'foo', flags: 'gi' });
  });

  it('lets the /flags/ syntax win over caseSensitive', () => {
    expect(parseRegexString('/foo/', true)).toEqual({ pattern: 'foo', flags: '' });
  });

  it('treats an unclosed slash form as a plain string', () => {
    expect(parseRegexString('/foo')).toEqual({ pattern: '/foo', flags: 'i' });
  });
});

describe('safeRegexTestSync', () => {
  it('returns true on a match and false on a miss', () => {
    expect(safeRegexTestSync('a\\d', '', 'a5')).toBe(true);
    expect(safeRegexTestSync('a\\d', '', 'ab')).toBe(false);
  });

  it('returns false for an invalid pattern instead of throwing', () => {
    expect(safeRegexTestSync('[', '', 'x')).toBe(false);
  });
});

describe('safeRegexTestAsync', () => {
  it('resolves true on a match', async () => {
    await expect(safeRegexTestAsync('a\\d', '', 'a5')).resolves.toBe(true);
  });

  it('resolves false for an invalid pattern', async () => {
    await expect(safeRegexTestAsync('(', '', 'x')).resolves.toBe(false);
  });
});

describe('globToRegexString', () => {
  it('treats a wildcard-free glob as an escaped substring (no anchors)', () => {
    expect(globToRegexString('dash.board')).toBe('dash\\.board');
  });

  it('maps * to non-slash and ** to any-char', () => {
    expect(globToRegexString('https://app.com/*')).toBe('^https://app\\.com/[^/]*$');
    expect(globToRegexString('https://app.com/**')).toBe('^https://app\\.com/.*$');
  });

  it('anchors only the end when there is no protocol prefix', () => {
    expect(globToRegexString('*/users')).toBe('[^/]*/users$');
  });
});

describe('matchSubstring', () => {
  it('matches case-insensitively by default', () => {
    expect(matchSubstring('https://App.com/Dashboard', 'dashboard')).toBe(true);
  });

  it('respects caseSensitive', () => {
    expect(matchSubstring('https://app.com/Dashboard', 'dashboard', { caseSensitive: true })).toBe(false);
  });

  it('inverts the result when negate is set', () => {
    expect(matchSubstring('https://app.com/x', 'zzz', { negate: true })).toBe(true);
  });
});

describe('matchGlob', () => {
  it('matches a wildcard-free glob as a substring', () => {
    expect(matchGlob('https://app.com/dashboard/stats', 'dashboard')).toBe(true);
  });

  it('* does not cross a path separator', () => {
    expect(matchGlob('https://app.com/users', 'https://app.com/*')).toBe(true);
    expect(matchGlob('https://app.com/users/5', 'https://app.com/*')).toBe(false);
  });

  it('** crosses path separators', () => {
    expect(matchGlob('https://app.com/users/5', 'https://app.com/**')).toBe(true);
  });

  it('treats ? between word characters as a literal query marker', () => {
    expect(matchGlob('https://x.com/page?id=1', 'page?id=1')).toBe(true);
    expect(matchGlob('https://x.com/pageXid=1', 'page?id=1')).toBe(false);
  });
});

describe('matchRegex', () => {
  it('is case-insensitive by default', () => {
    expect(matchRegex('https://APP.com/x', 'app')).toBe(true);
  });

  it('honours caseSensitive for a plain pattern', () => {
    expect(matchRegex('https://app.com/x', 'APP', { caseSensitive: true })).toBe(false);
  });

  it('applies /pattern/flags syntax', () => {
    expect(matchRegex('https://app.com/p1', '/P\\d/i')).toBe(true);
  });

  it('returns false for an invalid pattern', () => {
    expect(matchRegex('https://app.com', '[')).toBe(false);
  });
});

describe('matchDomain', () => {
  it('matches the exact hostname', () => {
    expect(matchDomain('https://app.example.com/x?y=1', 'app.example.com')).toBe(true);
    expect(matchDomain('https://app.example.com/x', 'example.com')).toBe(false);
  });

  it('is case-insensitive on the hostname by default', () => {
    expect(matchDomain('https://APP.com/x', 'app.com')).toBe(true);
  });

  it('falls back to substring when the URL is not parseable', () => {
    expect(matchDomain('relative/path/here', 'relative')).toBe(true);
  });
});

describe('wait payload builders', () => {
  it('buildGlobWaitPayload returns the converted regex and flags', () => {
    expect(buildGlobWaitPayload('https://app.com/**', false, false)).toEqual({
      pattern: '^https://app\\.com/.*$',
      flags: 'i',
      negate: false,
    });
  });

  it('buildRegexWaitPayload parses and validates the pattern', () => {
    expect(buildRegexWaitPayload('/foo\\d/i', false, true)).toEqual({
      pattern: 'foo\\d',
      flags: 'i',
      negate: true,
    });
  });

  it('buildRegexWaitPayload throws on an invalid pattern', () => {
    expect(() => buildRegexWaitPayload('[', false, false)).toThrow('Invalid regex pattern for waitFor');
  });
});
