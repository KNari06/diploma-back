import { normalizeCoverageUrl, firstPathSegment, extractFirstUrl } from '../url-scope';

describe('normalizeCoverageUrl', () => {
  it('strips query + trailing slash and lowercases host', () => {
    expect(normalizeCoverageUrl('https://App.Example.com/Checkout/?ref=x')).toBe('https://app.example.com/Checkout');
  });

  it('adds https:// when protocol is missing', () => {
    expect(normalizeCoverageUrl('app.example.com/checkout')).toBe('https://app.example.com/checkout');
  });

  it('normalizes a bare root to "/"', () => {
    expect(normalizeCoverageUrl('https://app.example.com/')).toBe('https://app.example.com/');
  });

  it('two URLs differing only by query/trailing slash normalize equal (the scoping contract)', () => {
    expect(normalizeCoverageUrl('https://x.com/checkout')).toBe(normalizeCoverageUrl('https://x.com/checkout/?a=1'));
  });
});

describe('firstPathSegment', () => {
  it('returns the first path segment', () => {
    expect(firstPathSegment('https://x.com/checkout/step2')).toBe('checkout');
  });
  it('empty for root', () => {
    expect(firstPathSegment('https://x.com/')).toBe('');
  });
  it('works without protocol', () => {
    expect(firstPathSegment('x.com/settings/profile')).toBe('settings');
  });
});

describe('extractFirstUrl', () => {
  it('prefers an absolute http(s) URL and trims trailing punctuation', () => {
    expect(extractFirstUrl('please test https://example.com/login.')).toBe('https://example.com/login');
  });
  it('falls back to a bare domain', () => {
    const out = extractFirstUrl('the bug is on example.com/checkout');
    expect(out).toContain('example.com/checkout');
  });
  it('returns null when there is no URL', () => {
    expect(extractFirstUrl('just some words')).toBeNull();
    expect(extractFirstUrl('')).toBeNull();
  });
});
