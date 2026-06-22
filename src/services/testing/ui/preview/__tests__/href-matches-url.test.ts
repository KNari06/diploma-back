import { hrefMatchesUrl } from '../preview-step-apply.service';

// V28: powers the "newtab is a STRONG signal when the popup landed on the
// clicked link's OWN destination" rule. A real target="_blank" navigation must
// match (→ compiled plan persists, no stale orange "Needs apply" dot); an
// unrelated ad/tracker popup must NOT match (→ stays weak, fake-success guard
// still rejects it).
describe('hrefMatchesUrl', () => {
  it('matches identical href and tab URL', () => {
    expect(hrefMatchesUrl('https://app.com/dashboard', 'https://app.com/dashboard')).toBe(true);
  });

  it('matches when the tab adds tracking query params (origin+path tier)', () => {
    expect(
      hrefMatchesUrl('https://app.com/pricing', 'https://app.com/pricing?utm_source=email&ref=x'),
    ).toBe(true);
  });

  it('matches a trailing-slash difference', () => {
    expect(hrefMatchesUrl('https://app.com/docs/', 'https://app.com/docs')).toBe(true);
  });

  it('matches case-insensitively on host', () => {
    expect(hrefMatchesUrl('https://App.Com/x', 'https://app.com/x')).toBe(true);
  });

  it('matches same origin when path differs (redirect to a sibling page)', () => {
    // origin tier — the link pointed at /signup but the site redirected to
    // /signup/step-1; still the link's own destination, not a foreign popup.
    expect(hrefMatchesUrl('https://app.com/signup', 'https://app.com/signup/step-1')).toBe(true);
  });

  it('does NOT match a foreign domain (ad/tracker popup → stays weak)', () => {
    expect(hrefMatchesUrl('https://app.com/checkout', 'https://ads.doubleclick.net/abc')).toBe(false);
  });

  it('does NOT match a brand-new about:blank popup', () => {
    expect(hrefMatchesUrl('https://app.com/x', 'about:blank')).toBe(false);
  });

  it('does NOT match across http/https (scheme mismatch)', () => {
    expect(hrefMatchesUrl('https://app.com/x', 'http://app.com/x')).toBe(false);
  });

  it('rejects non-http schemes (javascript:, mailto:)', () => {
    expect(hrefMatchesUrl('javascript:void(0)', 'https://app.com/x')).toBe(false);
    expect(hrefMatchesUrl('mailto:a@b.com', 'mailto:a@b.com')).toBe(false);
  });

  it('returns false on unparseable input', () => {
    expect(hrefMatchesUrl('not a url', 'https://app.com/x')).toBe(false);
    expect(hrefMatchesUrl('', '')).toBe(false);
  });

  it('matches different ports as distinct origins', () => {
    expect(hrefMatchesUrl('https://app.com:8443/x', 'https://app.com/x')).toBe(false);
  });
});
