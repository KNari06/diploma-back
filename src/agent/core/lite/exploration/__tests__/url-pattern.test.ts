/**
 * URL pattern extractor tests.
 *
 * Covers:
 *   - Classification of id-like segments (uuid, objectid, numeric, hash, slug)
 *   - Preservation of static segments + human-readable slugs
 *   - Hash route parameterization (SPA style)
 *   - Query string dropping
 *   - Graceful handling of invalid input
 *   - Dedup equivalence: distinct ids → same pattern
 */

import { classifySegment, normalizeUrlWithPattern } from '../url-pattern';

describe('classifySegment', () => {
  it('returns :id for pure numeric tokens', () => {
    expect(classifySegment('42')).toBe(':id');
    expect(classifySegment('0')).toBe(':id');
    expect(classifySegment('9999999')).toBe(':id');
  });

  it('returns :uuid for canonical UUIDs', () => {
    expect(classifySegment('550e8400-e29b-41d4-a716-446655440000')).toBe(':uuid');
    expect(classifySegment('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(':uuid');
  });

  it('returns :objectid for 24-char hex (MongoDB)', () => {
    expect(classifySegment('507f1f77bcf86cd799439011')).toBe(':objectid');
  });

  it('returns :hash for 32-char hex', () => {
    expect(classifySegment('d41d8cd98f00b204e9800998ecf8427e')).toBe(':hash');
  });

  it('returns :slug for long opaque alphanumeric tokens', () => {
    // nanoid-like: 21 chars, mixed case, digits
    expect(classifySegment('V1StGXR8_Z5jdHi6B-myT')).toBe(':slug');
    // 16+ char base62 with digits
    expect(classifySegment('abc123def456ghi789')).toBe(':slug');
  });

  it('preserves human-readable slugs (multi-hyphen, no digits)', () => {
    expect(classifySegment('how-to-cook-pasta')).toBe('how-to-cook-pasta');
    expect(classifySegment('getting-started-guide')).toBe('getting-started-guide');
    expect(classifySegment('about-us')).toBe('about-us');
  });

  it('preserves short tokens even if alphanumeric', () => {
    expect(classifySegment('v2')).toBe('v2');
    expect(classifySegment('abc123')).toBe('abc123'); // <16 chars
  });

  it('preserves typical static path segments', () => {
    expect(classifySegment('products')).toBe('products');
    expect(classifySegment('settings')).toBe('settings');
    expect(classifySegment('api')).toBe('api');
    expect(classifySegment('v1')).toBe('v1');
  });

  it('handles empty tokens without crashing', () => {
    expect(classifySegment('')).toBe('');
  });
});

describe('normalizeUrlWithPattern — dynamic segments', () => {
  it('collapses numeric id paths to :id', () => {
    const a = normalizeUrlWithPattern('https://ex.com/products/123');
    const b = normalizeUrlWithPattern('https://ex.com/products/456');
    expect(a).toBe(b);
    expect(a).toBe('https://ex.com/products/:id');
  });

  it('collapses UUID paths to :uuid', () => {
    const a = normalizeUrlWithPattern('https://ex.com/users/550e8400-e29b-41d4-a716-446655440000');
    const b = normalizeUrlWithPattern('https://ex.com/users/f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(a).toBe(b);
    expect(a).toBe('https://ex.com/users/:uuid');
  });

  it('collapses deeply nested id paths', () => {
    const a = normalizeUrlWithPattern('https://ex.com/orgs/42/projects/99/tasks/7');
    const b = normalizeUrlWithPattern('https://ex.com/orgs/100/projects/200/tasks/300');
    expect(a).toBe(b);
    expect(a).toBe('https://ex.com/orgs/:id/projects/:id/tasks/:id');
  });

  it('preserves static segments alongside ids', () => {
    const url = normalizeUrlWithPattern('https://ex.com/api/v1/users/42/settings');
    expect(url).toBe('https://ex.com/api/v1/users/:id/settings');
  });

  it('preserves human-readable slugs', () => {
    const url = normalizeUrlWithPattern('https://ex.com/blog/how-to-cook-pasta');
    expect(url).toBe('https://ex.com/blog/how-to-cook-pasta');
  });

  it('handles root path without crashing and normalizes both forms to the same key', () => {
    // The WHATWG URL parser canonicalizes "https://ex.com" to pathname "/",
    // so both inputs should produce the same normalized key.
    const a = normalizeUrlWithPattern('https://ex.com/');
    const b = normalizeUrlWithPattern('https://ex.com');
    expect(a).toBe(b);
    expect(a).toBe('https://ex.com/');
  });
});

describe('normalizeUrlWithPattern — query + trailing slash', () => {
  it('drops query strings', () => {
    const a = normalizeUrlWithPattern('https://ex.com/page?foo=bar');
    const b = normalizeUrlWithPattern('https://ex.com/page?baz=qux');
    expect(a).toBe(b);
    expect(a).toBe('https://ex.com/page');
  });

  it('strips trailing slash (except for root)', () => {
    expect(normalizeUrlWithPattern('https://ex.com/page/')).toBe('https://ex.com/page');
    expect(normalizeUrlWithPattern('https://ex.com/')).toBe('https://ex.com/');
  });
});

describe('normalizeUrlWithPattern — hash routes (SPA)', () => {
  it('parameterizes hash route ids', () => {
    const a = normalizeUrlWithPattern('https://ex.com/app#/users/42');
    const b = normalizeUrlWithPattern('https://ex.com/app#/users/99');
    expect(a).toBe(b);
    expect(a).toBe('https://ex.com/app#/users/:id');
  });

  it('preserves hashbang routes (#!/...)', () => {
    const a = normalizeUrlWithPattern('https://ex.com/app#!/posts/550e8400-e29b-41d4-a716-446655440000');
    expect(a).toBe('https://ex.com/app#!/posts/:uuid');
  });

  it('drops anchor-only hashes (#section)', () => {
    expect(normalizeUrlWithPattern('https://ex.com/page#top')).toBe('https://ex.com/page');
    expect(normalizeUrlWithPattern('https://ex.com/page#foo')).toBe('https://ex.com/page');
  });

  it('preserves distinct hash routes as distinct', () => {
    const a = normalizeUrlWithPattern('https://ex.com/app#/dashboard');
    const b = normalizeUrlWithPattern('https://ex.com/app#/settings');
    expect(a).not.toBe(b);
  });
});

describe('normalizeUrlWithPattern — error handling', () => {
  it('returns original string on invalid URL', () => {
    expect(normalizeUrlWithPattern('not a url')).toBe('not a url');
    expect(normalizeUrlWithPattern('')).toBe('');
  });
});

describe('normalizeUrlWithPattern — dedup equivalence (real scenarios)', () => {
  it('collapses catalogue pages so BFS does not explode', () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://shop.com/products/${i + 1}`);
    const patterns = new Set(urls.map(normalizeUrlWithPattern));
    expect(patterns.size).toBe(1);
  });

  it('collapses mixed id shapes on same route', () => {
    const patterns = new Set([
      normalizeUrlWithPattern('https://ex.com/u/42'),
      normalizeUrlWithPattern('https://ex.com/u/999'),
      normalizeUrlWithPattern('https://ex.com/u/0'),
    ]);
    expect(patterns.size).toBe(1);
  });

  it('keeps semantically-distinct routes separate', () => {
    const patterns = new Set([
      normalizeUrlWithPattern('https://ex.com/users/42'),
      normalizeUrlWithPattern('https://ex.com/posts/42'),
      normalizeUrlWithPattern('https://ex.com/users/42/edit'),
    ]);
    expect(patterns.size).toBe(3);
  });
});
