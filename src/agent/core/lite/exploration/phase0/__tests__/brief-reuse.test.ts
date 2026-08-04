/**
 * The reuse decision: may a stored brief still speak for this product?
 *
 * The rule has to fail in one direction only. Re-deriving unnecessarily costs
 * one LLM call; reusing a stale brief silently mis-informs all four agents
 * while the run looks perfectly healthy.
 */

import {
  stripReusedPermissions,
  briefOriginKey,
  fingerprintEvidence,
  decideBriefReuse,
  PRODUCT_BRIEF_VERSION,
} from '../brief-reuse';
import type { ProductEvidence } from '../evidence-collector';

const evidence = (over: Partial<ProductEvidence> = {}): ProductEvidence =>
  ({
    originUrl: 'https://acme.com',
    sources: ['/'],
    documents: [{ path: '/', ok: true, body: '<h1>Acme Shop</h1>' }],
    disallowedPaths: [],
    robotsDisallowsAll: false,
    pathSegments: [{ segment: 'products', count: 12 }],
    sitemapUrlCount: 12,
    thirdPartyHosts: ['js.stripe.com'],
    localeHints: ['en'],
    ...over,
  }) as ProductEvidence;

describe('briefOriginKey', () => {
  it('keys on the product, not the page', () => {
    // Two pages of one site must share a brief — otherwise the user is asked
    // the same questions once per page they happen to start from.
    expect(briefOriginKey('https://acme.com/login')).toBe(briefOriginKey('https://acme.com/pricing'));
  });

  it('normalises case and the default port', () => {
    expect(briefOriginKey('https://ACME.com:443/x')).toBe('https://acme.com');
  });

  it('keeps a non-default port — a staging port is a different deployment', () => {
    expect(briefOriginKey('http://acme.com:8080/')).toBe('http://acme.com:8080');
  });

  it('separates schemes — http and https can be different environments', () => {
    expect(briefOriginKey('http://acme.com/')).not.toBe(briefOriginKey('https://acme.com/'));
  });

  it('returns null rather than a garbage key that could collide', () => {
    expect(briefOriginKey('not a url')).toBeNull();
    expect(briefOriginKey('')).toBeNull();
    expect(briefOriginKey('file:///etc/passwd')).toBeNull();
  });
});

describe('fingerprintEvidence', () => {
  it('is stable for identical evidence', () => {
    expect(fingerprintEvidence(evidence())).toBe(fingerprintEvidence(evidence()));
  });

  it('does not depend on document ORDER', () => {
    const a = evidence({ documents: [
      { path: '/', ok: true, body: 'x' },
      { path: '/pricing', ok: true, body: 'y' },
    ] });
    const b = evidence({ documents: [
      { path: '/pricing', ok: true, body: 'y' },
      { path: '/', ok: true, body: 'x' },
    ] });
    expect(fingerprintEvidence(a)).toBe(fingerprintEvidence(b));
  });

  it('CHANGES when a page rewrites — the product may have pivoted', () => {
    const before = fingerprintEvidence(evidence());
    const after = fingerprintEvidence(evidence({
      documents: [{ path: '/', ok: true, body: '<h1>Acme Consulting</h1>' }],
    }));
    expect(after).not.toBe(before);
  });

  it('CHANGES when a page moves, even with identical content', () => {
    const before = fingerprintEvidence(evidence({ documents: [{ path: '/pricing', ok: true, body: 'p' }] }));
    const after = fingerprintEvidence(evidence({ documents: [{ path: '/plans', ok: true, body: 'p' }] }));
    expect(after).not.toBe(before);
  });

  it('IGNORES catalogue growth — one more product is not a new product', () => {
    // Re-deriving the whole brief because a shop added an item is pure churn.
    const before = fingerprintEvidence(evidence({ pathSegments: [{ segment: 'products', count: 12 }], sitemapUrlCount: 12 }));
    const after = fingerprintEvidence(evidence({ pathSegments: [{ segment: 'products', count: 13 }], sitemapUrlCount: 13 }));
    expect(after).toBe(before);
  });

  it('CHANGES when a new entity type appears', () => {
    const before = fingerprintEvidence(evidence());
    const after = fingerprintEvidence(evidence({
      pathSegments: [{ segment: 'products', count: 12 }, { segment: 'subscriptions', count: 3 }],
    }));
    expect(after).not.toBe(before);
  });

  it('CHANGES when a payment provider appears — that is a safety-relevant shift', () => {
    const before = fingerprintEvidence(evidence({ thirdPartyHosts: [] }));
    const after = fingerprintEvidence(evidence({ thirdPartyHosts: ['js.stripe.com'] }));
    expect(after).not.toBe(before);
  });

  it('ignores failed fetches, so a flaky 500 does not invalidate the brief', () => {
    const clean = fingerprintEvidence(evidence());
    const withFailure = fingerprintEvidence(evidence({
      documents: [
        { path: '/', ok: true, body: '<h1>Acme Shop</h1>' },
        { path: '/about', ok: false, body: '', failure: 'timeout' },
      ],
    }));
    expect(withFailure).toBe(clean);
  });

  it('returns null when nothing was read — an empty hash would match everything', () => {
    expect(fingerprintEvidence(evidence({ documents: [] }))).toBeNull();
    expect(fingerprintEvidence(evidence({ documents: [{ path: '/', ok: false, body: '' }] }))).toBeNull();
  });
});

describe('decideBriefReuse — fails toward re-deriving', () => {
  const fp = 'abc123';
  const stored = { briefVersion: PRODUCT_BRIEF_VERSION, evidenceFingerprint: fp };

  it('reuses when the evidence is unchanged', () => {
    expect(decideBriefReuse({ stored, currentFingerprint: fp }))
      .toEqual({ reuse: true, reason: 'fingerprint_match' });
  });

  it('re-derives when the evidence changed', () => {
    expect(decideBriefReuse({ stored, currentFingerprint: 'different' }))
      .toEqual({ reuse: false, reason: 'evidence_changed' });
  });

  it('re-derives when nothing is stored yet', () => {
    expect(decideBriefReuse({ stored: null, currentFingerprint: fp }).reason).toBe('no_stored_brief');
    expect(decideBriefReuse({ currentFingerprint: fp }).reason).toBe('no_stored_brief');
  });

  it('re-derives when the brief SHAPE changed — old rows lack new fields', () => {
    expect(decideBriefReuse({
      stored: { briefVersion: PRODUCT_BRIEF_VERSION + 1, evidenceFingerprint: fp },
      currentFingerprint: fp,
    }).reason).toBe('version_changed');
  });

  it('re-derives when either fingerprint is missing', () => {
    expect(decideBriefReuse({ stored: { ...stored, evidenceFingerprint: null }, currentFingerprint: fp }).reason)
      .toBe('no_fingerprint');
    expect(decideBriefReuse({ stored, currentFingerprint: null }).reason).toBe('no_fingerprint');
  });

  it('never reuses on any uncertain input', () => {
    const uncertain = [
      { stored: null, currentFingerprint: null },
      { stored: { briefVersion: 0, evidenceFingerprint: null }, currentFingerprint: null },
      { stored: { briefVersion: 99, evidenceFingerprint: 'x' }, currentFingerprint: 'x' },
    ];
    for (const input of uncertain) {
      expect(decideBriefReuse(input).reuse).toBe(false);
    }
  });
});

describe('stripReusedPermissions — a grant belongs to the run it was given on', () => {
  const granted = {
    purpose: { value: 'Shop', source: 'observed', confidence: 'high' },
    environmentKind: { value: 'staging', source: 'user', confidence: 'high' },
    paymentPolicy: { value: 'allowed_sandbox', source: 'user', confidence: 'high' },
  };

  it('demotes an inherited payment permission', () => {
    // Verified before this guard existed: `allowed_sandbox` survived a
    // store/reload round trip, so a project-mate would have inherited
    // permission to complete REAL payments weeks after someone else granted it.
    const safe = stripReusedPermissions(granted) as any;
    expect(safe.paymentPolicy.value).toBe('stop_before_commit');
  });

  it('stops the grant reading as a user decision', () => {
    // The normalizer honours `source:'user'` — leaving it would re-promote the
    // value on the very next normalize.
    const safe = stripReusedPermissions(granted) as any;
    expect(safe.paymentPolicy.source).not.toBe('user');
  });

  it('KEEPS environmentKind — knowing a host is staging grants nothing', () => {
    const safe = stripReusedPermissions(granted) as any;
    expect(safe.environmentKind.value).toBe('staging');
  });

  it('leaves a brief that never carried a grant untouched', () => {
    const plain = { paymentPolicy: { value: 'never', source: 'inferred', confidence: 'low' } };
    expect((stripReusedPermissions(plain) as any).paymentPolicy).toEqual(plain.paymentPolicy);
  });

  it('does not mutate the input', () => {
    const snapshot = JSON.stringify(granted);
    stripReusedPermissions(granted);
    expect(JSON.stringify(granted)).toBe(snapshot);
  });

  it('never throws on a malformed stored row', () => {
    for (const v of [null, undefined, 'x', 42, [], {}, { paymentPolicy: 'oops' }]) {
      expect(() => stripReusedPermissions(v)).not.toThrow();
    }
  });
});
