/**
 * Domain boundary tests.
 *
 * Covers:
 *   - Same-origin allow (entry URL and current URL count as valid anchors)
 *   - Cross-origin deny with informative reason
 *   - Relative / anchor / javascript / mailto / tel / empty → allow
 *   - Unparseable targets → deny (click won't succeed anyway)
 *   - Current-URL override (mid-flow redirect to billing subdomain)
 *   - Case-sensitivity of origin comparison (WHATWG canonicalizes case)
 *   - Graceful fallback when entry/current anchors are themselves junk
 */

import { checkDomainBoundary } from '../domain-boundary';

describe('checkDomainBoundary — allow same-origin', () => {
  it('allows same-origin absolute URL', () => {
    const r = checkDomainBoundary({
      targetUrl: 'https://app.example.com/dashboard',
      entryUrl: 'https://app.example.com',
    });
    expect(r.allowed).toBe(true);
    expect(r.targetOrigin).toBe('https://app.example.com');
  });

  it('allows relative path resolved against current URL', () => {
    const r = checkDomainBoundary({
      targetUrl: '/settings',
      entryUrl: 'https://app.example.com',
      currentUrl: 'https://app.example.com/dashboard',
    });
    expect(r.allowed).toBe(true);
  });

  it('allows URLs matching the current origin even if entry origin differs', () => {
    // Mid-flow redirect: we started on app.example.com, now on billing.example.com.
    // A click staying on billing.example.com should be allowed.
    const r = checkDomainBoundary({
      targetUrl: 'https://billing.example.com/invoice/42',
      entryUrl: 'https://app.example.com',
      currentUrl: 'https://billing.example.com/',
    });
    expect(r.allowed).toBe(true);
  });

  it('allows hash-only anchor links', () => {
    const r = checkDomainBoundary({
      targetUrl: '#section-faq',
      entryUrl: 'https://app.example.com',
      currentUrl: 'https://app.example.com/page',
    });
    expect(r.allowed).toBe(true);
  });

  it('allows javascript:/mailto:/tel:/data: schemes (in-document actions)', () => {
    const entry = 'https://app.example.com';
    for (const href of ['javascript:void(0)', 'mailto:a@b.com', 'tel:+100', 'data:text/plain,hi']) {
      expect(checkDomainBoundary({ targetUrl: href, entryUrl: entry }).allowed).toBe(true);
    }
  });

  it('allows empty / whitespace / undefined target', () => {
    const entry = 'https://app.example.com';
    expect(checkDomainBoundary({ targetUrl: '', entryUrl: entry }).allowed).toBe(true);
    expect(checkDomainBoundary({ targetUrl: '   ', entryUrl: entry }).allowed).toBe(true);
    expect(checkDomainBoundary({ targetUrl: null, entryUrl: entry }).allowed).toBe(true);
    expect(checkDomainBoundary({ targetUrl: undefined, entryUrl: entry }).allowed).toBe(true);
  });
});

describe('checkDomainBoundary — deny cross-origin', () => {
  it('denies an SSO redirect to a different provider', () => {
    const r = checkDomainBoundary({
      targetUrl: 'https://accounts.google.com/o/oauth2/auth',
      entryUrl: 'https://app.example.com',
      currentUrl: 'https://app.example.com/login',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('accounts.google.com');
    expect(r.reason).toContain('app.example.com');
    expect(r.targetOrigin).toBe('https://accounts.google.com');
  });

  it('denies different subdomain when no redirect has happened yet', () => {
    const r = checkDomainBoundary({
      targetUrl: 'https://docs.example.com/guide',
      entryUrl: 'https://app.example.com',
      currentUrl: 'https://app.example.com',
    });
    expect(r.allowed).toBe(false);
  });

  it('treats http vs https as different origins', () => {
    // WHATWG URL considers scheme part of origin — downgrading from https to
    // http is a navigation we should block (could be a mixed-content attack
    // vector or simply an external http-only partner site).
    const r = checkDomainBoundary({
      targetUrl: 'http://app.example.com/page',
      entryUrl: 'https://app.example.com',
    });
    expect(r.allowed).toBe(false);
  });

  it('denies unparseable target URLs with a descriptive reason', () => {
    const r = checkDomainBoundary({
      targetUrl: 'https://',
      entryUrl: 'https://app.example.com',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/unparseable/i);
  });
});

describe('checkDomainBoundary — graceful degradation', () => {
  it('default-allows when entryUrl itself is junk (no safe baseline to compare)', () => {
    // If we cannot compute the app-under-test origin, we have no grounds
    // to block anything — the alternative is blocking all clicks.
    const r = checkDomainBoundary({
      targetUrl: 'https://external.com',
      entryUrl: 'not-a-url',
    });
    expect(r.allowed).toBe(true);
  });

  it('canonicalizes port and case via WHATWG URL', () => {
    // Implicit 443 port and mixed-case host match.
    const r = checkDomainBoundary({
      targetUrl: 'https://APP.example.com:443/path',
      entryUrl: 'https://app.example.com',
    });
    expect(r.allowed).toBe(true);
  });
});

describe('checkDomainBoundary — Google SSO scenario (the bug this fixes)', () => {
  it('blocks exploration from leaving the app via SSO link', () => {
    // This is the concrete scenario from the design review: the Explorer
    // is running on app.example.com, the page shows "Sign in with Google",
    // and without this check the click burns 3 minutes on accounts.google.com.
    const r = checkDomainBoundary({
      targetUrl: 'https://accounts.google.com/oauth2?client_id=xyz',
      entryUrl: 'https://app.example.com',
      currentUrl: 'https://app.example.com/login',
    });
    expect(r.allowed).toBe(false);
  });
});
