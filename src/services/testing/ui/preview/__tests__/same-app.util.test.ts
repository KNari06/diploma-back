import { isSameApp, hostnameOf, originOf } from '../same-app.util';

const u = (host: string) => `https://${host}/some/path?q=1`;

describe('isSameApp', () => {
  it('returns true for identical hostnames', () => {
    expect(isSameApp(u('app.example.com'), u('app.example.com'))).toBe(true);
  });

  it('returns true for www / m / staging subdomain variants', () => {
    expect(isSameApp(u('www.example.com'), u('example.com'))).toBe(true);
    expect(isSameApp(u('m.example.com'), u('example.com'))).toBe(true);
    expect(isSameApp(u('staging.example.com'), u('example.com'))).toBe(true);
  });

  it('returns true for sibling subdomains of the same registrable domain', () => {
    expect(isSameApp(u('account.documentolog.com'), u('business.documentolog.com'))).toBe(true);
  });

  it('returns true for the same brand across sibling ccTLDs (documentolog regression)', () => {
    // The bug that caused the infinite external-nav revert loop.
    expect(isSameApp(u('account.documentolog.kz'), u('business.documentolog.com'))).toBe(true);
    expect(isSameApp(u('documentolog.kz'), u('documentolog.com'))).toBe(true);
  });

  it('returns false for genuinely different brands (still revert / new-tab)', () => {
    expect(isSameApp(u('kaspi.kz'), u('documentolog.com'))).toBe(false);
    expect(isSameApp(u('stripe.com'), u('documentolog.com'))).toBe(false);
    expect(isSameApp(u('kaspi.com'), u('documentolog.com'))).toBe(false);
  });

  it('does not over-match unrelated short-label multi-part ccTLDs across TLDs', () => {
    // brand label is the public "co" (< 4 chars) → the brand rule must NOT fire.
    expect(isSameApp(u('shop.co.uk'), u('shop.co.nz'))).toBe(false);
  });

  it('returns false when either URL is unparseable', () => {
    expect(isSameApp('', u('example.com'))).toBe(false);
    expect(isSameApp('about:blank', u('example.com'))).toBe(false);
    expect(isSameApp('not a url', u('example.com'))).toBe(false);
  });

  it('treats same multi-label ccTLD as same-app (known last-2-label over-match, no PSL)', () => {
    // Documents the existing limitation: foo.co.uk vs bar.co.uk share last-2
    // labels. Tolerated (the original heuristic accepts it); turns red the day
    // a public-suffix list is wired in.
    expect(isSameApp(u('foo.co.uk'), u('bar.co.uk'))).toBe(true);
  });
});

describe('hostnameOf / originOf', () => {
  it('extracts the hostname', () => {
    expect(hostnameOf('https://a.b.example.com/x?y=1')).toBe('a.b.example.com');
  });

  it('returns empty string for an unparseable URL', () => {
    expect(hostnameOf('garbage')).toBe('');
  });

  it('returns the origin or null', () => {
    expect(originOf('https://example.com:8443/x')).toBe('https://example.com:8443');
    expect(originOf('garbage')).toBeNull();
  });
});
