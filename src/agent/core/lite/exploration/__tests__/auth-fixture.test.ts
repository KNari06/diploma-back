/**
 * AuthFixture validation tests.
 *
 * Covers:
 *   - Happy path: Playwright-compatible storageState round-trips cleanly
 *   - Cookie shape validation (required fields, type coercion)
 *   - sameSite default to 'Lax' on missing / invalid value
 *   - Session cookies (expires = -1 or missing → normalized to -1)
 *   - Origin validation (must be canonical absolute URL)
 *   - localStorage validation (name/value required strings)
 *   - Size caps (DoS-ish input rejected)
 *   - Structural errors (non-object, non-array fields, null/undefined)
 *   - isAuthFixtureNonEmpty helper correctness
 */

import {
  validateAuthFixture,
  isAuthFixtureNonEmpty,
  type AuthFixture,
} from '../auth-fixture';

function baseCookie(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    ...overrides,
  };
}

describe('validateAuthFixture — happy path', () => {
  it('accepts a minimal valid fixture with one cookie', () => {
    const r = validateAuthFixture({
      cookies: [baseCookie()],
      origins: [],
    });
    expect(r.valid).toBe(true);
    expect(r.fixture?.cookies).toHaveLength(1);
    expect(r.fixture?.origins).toEqual([]);
  });

  it('accepts a fixture with cookies + localStorage origins', () => {
    const r = validateAuthFixture({
      cookies: [baseCookie({ name: 'auth_token' })],
      origins: [
        {
          origin: 'https://app.example.com',
          localStorage: [
            { name: 'user_id', value: '42' },
            { name: 'theme', value: 'dark' },
          ],
        },
      ],
    });
    expect(r.valid).toBe(true);
    expect(r.fixture?.cookies[0].name).toBe('auth_token');
    expect(r.fixture?.origins[0].localStorage).toHaveLength(2);
  });

  it('allows origins field to be omitted entirely', () => {
    const r = validateAuthFixture({
      cookies: [baseCookie()],
    });
    expect(r.valid).toBe(true);
    expect(r.fixture?.origins).toEqual([]);
  });

  it('allows an empty fixture (cookies: [], origins: [])', () => {
    // Structurally valid. isAuthFixtureNonEmpty distinguishes useful fixtures.
    const r = validateAuthFixture({ cookies: [], origins: [] });
    expect(r.valid).toBe(true);
  });
});

describe('validateAuthFixture — cookie normalization', () => {
  it("defaults sameSite to 'Lax' when missing", () => {
    const r = validateAuthFixture({
      cookies: [baseCookie({ sameSite: undefined })],
      origins: [],
    });
    expect(r.valid).toBe(true);
    expect(r.fixture?.cookies[0].sameSite).toBe('Lax');
  });

  it("defaults sameSite to 'Lax' when value is not one of Strict|Lax|None", () => {
    const r = validateAuthFixture({
      cookies: [baseCookie({ sameSite: 'lax' })], // lowercase — Playwright only accepts Strict|Lax|None
      origins: [],
    });
    expect(r.valid).toBe(true);
    expect(r.fixture?.cookies[0].sameSite).toBe('Lax');
  });

  it('coerces session expires (missing, NaN, negative, Infinity) to -1', () => {
    for (const bad of [undefined, null, NaN, Infinity, -5, 'soon']) {
      const r = validateAuthFixture({
        cookies: [baseCookie({ expires: bad })],
        origins: [],
      });
      expect(r.valid).toBe(true);
      expect(r.fixture?.cookies[0].expires).toBe(-1);
    }
  });

  it('preserves a valid absolute expires timestamp', () => {
    const when = 1_800_000_000;
    const r = validateAuthFixture({
      cookies: [baseCookie({ expires: when })],
      origins: [],
    });
    expect(r.fixture?.cookies[0].expires).toBe(when);
  });

  it('coerces httpOnly / secure to boolean', () => {
    const r = validateAuthFixture({
      cookies: [baseCookie({ httpOnly: 'yes', secure: 0 })],
      origins: [],
    });
    expect(r.fixture?.cookies[0].httpOnly).toBe(true);
    expect(r.fixture?.cookies[0].secure).toBe(false);
  });
});

describe('validateAuthFixture — rejects structural problems', () => {
  it('rejects non-object input', () => {
    expect(validateAuthFixture(null).valid).toBe(false);
    expect(validateAuthFixture(undefined).valid).toBe(false);
    expect(validateAuthFixture('{"cookies":[]}').valid).toBe(false); // string, not object
    expect(validateAuthFixture([]).valid).toBe(false); // array, not object
    expect(validateAuthFixture(42).valid).toBe(false);
  });

  it('rejects when cookies field is missing or not an array', () => {
    expect(validateAuthFixture({}).valid).toBe(false);
    expect(validateAuthFixture({ cookies: 'not-an-array' }).valid).toBe(false);
    expect(validateAuthFixture({ cookies: {} }).valid).toBe(false);
  });

  it('rejects when origins is present but not an array', () => {
    const r = validateAuthFixture({
      cookies: [],
      origins: 'nope',
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/origins.*array/i);
  });

  it('reports precise errors per invalid cookie', () => {
    const r = validateAuthFixture({
      cookies: [
        baseCookie(), // ok
        { value: 'no-name' }, // missing name/domain/path
        { name: '', value: 'empty-name', domain: 'x.com', path: '/' }, // empty name
      ],
      origins: [],
    });
    expect(r.valid).toBe(false);
    // At least one error per problematic cookie
    expect(r.errors?.some((e) => e.includes('[1]'))).toBe(true);
    expect(r.errors?.some((e) => e.includes('[2]'))).toBe(true);
    // No error for the valid one
    expect(r.errors?.some((e) => e.includes('cookies[0]'))).toBe(false);
  });

  it('rejects when cookie.domain or cookie.path is missing', () => {
    const r = validateAuthFixture({
      cookies: [
        { name: 'x', value: 'y', path: '/', expires: -1, httpOnly: false, secure: false },
      ],
      origins: [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /domain/.test(e))).toBe(true);
  });
});

describe('validateAuthFixture — origin validation', () => {
  it('rejects origin that is not an absolute URL', () => {
    const r = validateAuthFixture({
      cookies: [],
      origins: [{ origin: 'example.com', localStorage: [] }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/origin/i);
  });

  it('rejects origin with trailing slash / path (non-canonical)', () => {
    const r = validateAuthFixture({
      cookies: [],
      origins: [{ origin: 'https://app.example.com/', localStorage: [] }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/canonical/i);
  });

  it('accepts origin with explicit port', () => {
    const r = validateAuthFixture({
      cookies: [],
      origins: [{ origin: 'https://app.example.com:8443', localStorage: [] }],
    });
    expect(r.valid).toBe(true);
  });

  it('defaults localStorage to [] when missing', () => {
    const r = validateAuthFixture({
      cookies: [],
      origins: [{ origin: 'https://ok.example.com' }],
    });
    expect(r.valid).toBe(true);
    expect(r.fixture?.origins[0].localStorage).toEqual([]);
  });

  it('rejects localStorage entry with missing name/value', () => {
    const r = validateAuthFixture({
      cookies: [],
      origins: [
        {
          origin: 'https://ok.example.com',
          localStorage: [{ name: 'ok', value: 'v' }, { name: '', value: 'bad' }],
        },
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.some((e) => /localStorage/.test(e))).toBe(true);
  });
});

describe('validateAuthFixture — size caps', () => {
  it('rejects a fixture with absurd cookie count (likely wrong export)', () => {
    const manyCookies = Array.from({ length: 600 }, (_, i) => baseCookie({ name: `c${i}` }));
    const r = validateAuthFixture({ cookies: manyCookies, origins: [] });
    expect(r.valid).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/too many cookies/i);
  });

  it('caps error list to avoid log spam on garbage input', () => {
    const badCookies = Array.from({ length: 50 }, () => ({ broken: true }));
    const r = validateAuthFixture({ cookies: badCookies, origins: [] });
    expect(r.valid).toBe(false);
    expect(r.errors?.length).toBeLessThanOrEqual(20);
  });
});

describe('isAuthFixtureNonEmpty', () => {
  it('returns false for a fully empty fixture', () => {
    const f: AuthFixture = { cookies: [], origins: [] };
    expect(isAuthFixtureNonEmpty(f)).toBe(false);
  });

  it('returns true when cookies are present', () => {
    const f: AuthFixture = {
      cookies: [{
        name: 'x', value: 'y', domain: 'a.com', path: '/',
        expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
      }],
      origins: [],
    };
    expect(isAuthFixtureNonEmpty(f)).toBe(true);
  });

  it('returns true when only localStorage is present', () => {
    const f: AuthFixture = {
      cookies: [],
      origins: [{
        origin: 'https://a.com',
        localStorage: [{ name: 'k', value: 'v' }],
      }],
    };
    expect(isAuthFixtureNonEmpty(f)).toBe(true);
  });

  it('returns false when origins exist but all localStorage arrays are empty', () => {
    const f: AuthFixture = {
      cookies: [],
      origins: [{ origin: 'https://a.com', localStorage: [] }],
    };
    expect(isAuthFixtureNonEmpty(f)).toBe(false);
  });
});
