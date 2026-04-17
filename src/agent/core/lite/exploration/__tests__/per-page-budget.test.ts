/**
 * PerPageBudget tests.
 *
 * Covers:
 *   - Default cap of 3 flows per page pattern
 *   - Custom caps (1, 5) and disabled gate (0, -1, Infinity, NaN)
 *   - URL pattern bucketing (/products/123 and /products/456 share cap)
 *   - Distinct routes (/products vs /users) have separate caps
 *   - Missing / unparseable source URL falls through (no false positives)
 *   - Reserve is monotonic and does not release on its own
 *   - Snapshot sorted descending by count
 */

import { PerPageBudget, DEFAULT_MAX_FLOWS_PER_PAGE } from '../per-page-budget';
import type { EntryPoint } from '../types';

function ep(overrides: Partial<EntryPoint> & { id: string; sourcePageUrl?: string }): EntryPoint {
  return {
    name: `ep-${overrides.id}`,
    goal: `goal ${overrides.id}`,
    category: 'other',
    priority: 'medium',
    requiresAuth: false,
    estimatedComplexity: 'medium',
    relatedElements: [],
    sourceNodeId: 'n',
    sourcePageUrl: 'https://app.example.com/page',
    ...overrides,
  };
}

describe('PerPageBudget — default cap (3)', () => {
  it('allows the first three reservations on a page', () => {
    const b = new PerPageBudget();
    const e = ep({ id: '1', sourcePageUrl: 'https://app.example.com/dash' });
    expect(b.canReserve(e)).toBe(true);
    b.reserve(e);
    expect(b.canReserve(e)).toBe(true);
    b.reserve(e);
    expect(b.canReserve(e)).toBe(true);
    b.reserve(e);
    expect(b.canReserve(e)).toBe(false); // cap reached
  });

  it('exports DEFAULT_MAX_FLOWS_PER_PAGE = 3 so callers don\'t guess', () => {
    expect(DEFAULT_MAX_FLOWS_PER_PAGE).toBe(3);
  });
});

describe('PerPageBudget — pattern bucketing', () => {
  it('treats /products/123 and /products/456 as the same bucket', () => {
    const b = new PerPageBudget(2);
    for (let i = 1; i <= 2; i++) {
      const e = ep({ id: `${i}`, sourcePageUrl: `https://shop.com/products/${i * 100}` });
      expect(b.canReserve(e)).toBe(true);
      b.reserve(e);
    }
    // Third catalogue detail page — same pattern, over cap
    const third = ep({ id: '3', sourcePageUrl: 'https://shop.com/products/999' });
    expect(b.canReserve(third)).toBe(false);
  });

  it('keeps /products vs /users on independent caps', () => {
    const b = new PerPageBudget(1);
    const products = ep({ id: 'p', sourcePageUrl: 'https://shop.com/products/42' });
    const users = ep({ id: 'u', sourcePageUrl: 'https://shop.com/users/42' });
    b.reserve(products);
    // products bucket saturated, but users still has room
    expect(b.canReserve(products)).toBe(false);
    expect(b.canReserve(users)).toBe(true);
  });

  it('drops query strings when bucketing', () => {
    const b = new PerPageBudget(1);
    const a = ep({ id: 'a', sourcePageUrl: 'https://app.com/search?q=foo' });
    const bEntry = ep({ id: 'b', sourcePageUrl: 'https://app.com/search?q=bar' });
    b.reserve(a);
    expect(b.canReserve(bEntry)).toBe(false);
  });
});

describe('PerPageBudget — disabled gate', () => {
  it('disables when cap is 0', () => {
    const b = new PerPageBudget(0);
    const e = ep({ id: '1' });
    for (let i = 0; i < 100; i++) {
      expect(b.canReserve(e)).toBe(true);
      b.reserve(e);
    }
  });

  it('disables when cap is negative', () => {
    const b = new PerPageBudget(-5);
    expect(b.getCap()).toBeNull();
    expect(b.canReserve(ep({ id: '1' }))).toBe(true);
  });

  it('disables when cap is NaN or Infinity (defensive)', () => {
    expect(new PerPageBudget(NaN).getCap()).toBeNull();
    expect(new PerPageBudget(Infinity).getCap()).toBeNull();
  });

  it('exposes a non-null cap when enabled', () => {
    expect(new PerPageBudget(3).getCap()).toBe(3);
  });
});

describe('PerPageBudget — unparseable / missing source', () => {
  it('allows entries with no sourcePageUrl (falls through, no false positive)', () => {
    const b = new PerPageBudget(1);
    const e = ep({ id: '1', sourcePageUrl: '' });
    expect(b.canReserve(e)).toBe(true);
    b.reserve(e); // no-op
    expect(b.canReserve(e)).toBe(true);
  });

  it('allows entries with garbage sourcePageUrl (opaque but stable bucket)', () => {
    const b = new PerPageBudget(2);
    const a = ep({ id: 'a', sourcePageUrl: 'not a url at all' });
    const bEntry = ep({ id: 'b', sourcePageUrl: 'not a url at all' });
    // normalizeUrlWithPattern returns the input verbatim; two invalid URLs
    // with identical strings share a bucket — which is the fair choice.
    expect(b.canReserve(a)).toBe(true);
    b.reserve(a);
    expect(b.canReserve(bEntry)).toBe(true);
    b.reserve(bEntry);
    expect(b.canReserve(a)).toBe(false);
  });
});

describe('PerPageBudget — counting', () => {
  it('countFor returns live count for a given page URL', () => {
    const b = new PerPageBudget(5);
    const e = ep({ id: '1', sourcePageUrl: 'https://app.com/x' });
    b.reserve(e);
    b.reserve(e);
    expect(b.countFor('https://app.com/x')).toBe(2);
  });

  it('countFor returns 0 for a never-touched page', () => {
    const b = new PerPageBudget();
    expect(b.countFor('https://app.com/never')).toBe(0);
  });

  it('snapshot is sorted by count desc', () => {
    const b = new PerPageBudget(10);
    b.reserve(ep({ id: 'a', sourcePageUrl: 'https://app.com/one' }));
    b.reserve(ep({ id: 'b', sourcePageUrl: 'https://app.com/two' }));
    b.reserve(ep({ id: 'c', sourcePageUrl: 'https://app.com/two' }));
    b.reserve(ep({ id: 'd', sourcePageUrl: 'https://app.com/two' }));
    const snap = b.snapshot();
    expect(snap[0]).toEqual({ pattern: 'https://app.com/two', count: 3 });
    expect(snap[1]).toEqual({ pattern: 'https://app.com/one', count: 1 });
  });

  it('reserve is strictly monotonic (no release path)', () => {
    const b = new PerPageBudget(3);
    const e = ep({ id: '1', sourcePageUrl: 'https://a.com/x' });
    b.reserve(e);
    b.reserve(e);
    expect(b.countFor('https://a.com/x')).toBe(2);
    // No release method exists; count only grows.
  });
});
