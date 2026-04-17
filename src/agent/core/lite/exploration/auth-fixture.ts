/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTH FIXTURE — pre-seeded storageState for exploration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Background:
 *
 *   Exploration against an auth-gated app currently runs the login flow
 *   from scratch every run: navigate → find form → fill credentials →
 *   submit → wait for dashboard. That is ~2-3 minutes of every 15-minute
 *   budget spent on work the user has already done manually in their
 *   browser. On top of that, login flows are the most fragile:
 *   CAPTCHAs, 2FA, anti-bot detection, email-link auth all block here.
 *
 *   The Autonomous Web Explorer design calls this out:
 *
 *     "Pre-seeded: user gives fixture (cookies + localStorage) before
 *      start → agent starts already logged in."
 *
 *   This module is the pre-seeded path. A user exports the browser's
 *   cookies + localStorage for the target app (e.g. via Playwright's
 *   `browser.contexts()[0].storageState()` or a manual JSON dump) and
 *   hands the JSON to the exploration config. We load it into the
 *   StateManager *before* Phase 1 starts, so the survey itself runs
 *   authenticated.
 *
 * Safety:
 *
 *   The fixture is arbitrary JSON from the user. We validate the shape
 *   *before* handing it to Playwright because Playwright's storageState
 *   parser will silently accept objects missing required cookie fields
 *   and only blow up when the browser tries to apply them — at which
 *   point the whole BrowserContext construction fails mid-flow.
 *
 *   We also cap sizes: a 5MB fixture with 10k cookies is almost certainly
 *   pasted garbage and will hang the storage-state apply.
 */

/**
 * The JSON shape Playwright accepts for `BrowserContextOptions.storageState`.
 * Intentionally re-declared here (rather than importing from 'playwright')
 * so this module has no runtime dependency on Playwright — keeps tests
 * fast and the validator reusable from places that don't own a browser.
 */
export interface AuthFixtureCookie {
  name: string;
  value: string;
  /** Cookie domain. Required by Playwright. */
  domain: string;
  /** Cookie path. Required by Playwright. */
  path: string;
  /** Unix epoch seconds. Use -1 for session cookies. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  /** Chromium expects 'Strict' | 'Lax' | 'None'. */
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface AuthFixtureOrigin {
  /** e.g. "https://app.example.com" (no trailing slash). */
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface AuthFixture {
  cookies: AuthFixtureCookie[];
  origins: AuthFixtureOrigin[];
}

/**
 * Strict upper bounds. These are diagnostic numbers, not security limits —
 * a legitimate storageState for a web app is rarely more than a few dozen
 * cookies and a few localStorage entries. Crossing these caps almost
 * always means the user pasted the wrong thing (browser-wide export,
 * unrelated app, etc.).
 */
const MAX_COOKIES = 500;
const MAX_ORIGINS = 50;
const MAX_LOCAL_STORAGE_ENTRIES_PER_ORIGIN = 500;
const MAX_STRING_LEN = 64 * 1024; // 64 KB per cookie/value — generous

const VALID_SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/** Shape returned by the validator. */
export interface AuthFixtureValidationResult {
  valid: boolean;
  /** When valid, a normalized fixture safe to hand to Playwright. */
  fixture?: AuthFixture;
  /** When invalid, one human-readable reason per problem (bounded). */
  errors?: string[];
}

/**
 * Parse + normalize a user-supplied storageState JSON object.
 *
 * Accepts anything that *looks like* Playwright's storageState shape.
 * Returns `{valid: false, errors}` on any structural problem so the
 * caller can log a precise diagnostic. When valid, returns a normalized
 * AuthFixture with:
 *
 *   - cookies[].sameSite defaulted to 'Lax' when missing / invalid
 *     (matches Playwright's own fallback; safer than rejecting a
 *     fixture just because Firefox exported no sameSite).
 *   - cookies[].expires coerced to -1 for session cookies (any value
 *     that is NaN or negative).
 *   - origins[].localStorage defaulted to [] when missing.
 *
 * Never throws. Any unexpected input produces an error list.
 */
export function validateAuthFixture(raw: unknown): AuthFixtureValidationResult {
  const errors: string[] = [];

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['AuthFixture must be a JSON object'] };
  }

  const obj = raw as Record<string, unknown>;

  // ── cookies ─────────────────────────────────────────────────────────
  const rawCookies = obj.cookies;
  if (!Array.isArray(rawCookies)) {
    errors.push('AuthFixture.cookies must be an array (even if empty)');
  }
  const cookies: AuthFixtureCookie[] = [];
  if (Array.isArray(rawCookies)) {
    if (rawCookies.length > MAX_COOKIES) {
      errors.push(`Too many cookies (${rawCookies.length} > ${MAX_COOKIES}) — likely wrong export`);
    }
    for (let i = 0; i < Math.min(rawCookies.length, MAX_COOKIES); i++) {
      const c = rawCookies[i];
      if (!c || typeof c !== 'object') {
        errors.push(`cookies[${i}] is not an object`);
        continue;
      }
      const cookie = c as Record<string, unknown>;
      const problems = validateCookie(cookie, i);
      if (problems.length > 0) {
        errors.push(...problems);
        continue;
      }
      cookies.push(normalizeCookie(cookie));
    }
  }

  // ── origins ─────────────────────────────────────────────────────────
  const rawOrigins = obj.origins;
  const origins: AuthFixtureOrigin[] = [];
  if (rawOrigins !== undefined && !Array.isArray(rawOrigins)) {
    errors.push('AuthFixture.origins must be an array when present');
  } else if (Array.isArray(rawOrigins)) {
    if (rawOrigins.length > MAX_ORIGINS) {
      errors.push(`Too many origins (${rawOrigins.length} > ${MAX_ORIGINS}) — likely wrong export`);
    }
    for (let i = 0; i < Math.min(rawOrigins.length, MAX_ORIGINS); i++) {
      const o = rawOrigins[i];
      if (!o || typeof o !== 'object') {
        errors.push(`origins[${i}] is not an object`);
        continue;
      }
      const origin = o as Record<string, unknown>;
      const problems = validateOrigin(origin, i);
      if (problems.length > 0) {
        errors.push(...problems);
        continue;
      }
      origins.push(normalizeOrigin(origin));
    }
  }

  // An entirely empty fixture is allowed syntactically but useless —
  // signal it so the caller can log a warning without rejecting.
  if (errors.length > 0) {
    // Cap error list to keep logs readable on genuinely broken input.
    return { valid: false, errors: errors.slice(0, 20) };
  }

  return { valid: true, fixture: { cookies, origins } };
}

/**
 * Whether a fixture carries any actual auth material. Used by the engine
 * to decide whether preloading is worth logging as "authenticated".
 */
export function isAuthFixtureNonEmpty(fixture: AuthFixture): boolean {
  if (fixture.cookies.length > 0) return true;
  return fixture.origins.some((o) => o.localStorage.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════════════

function validateCookie(c: Record<string, unknown>, idx: number): string[] {
  const errors: string[] = [];
  if (typeof c.name !== 'string' || c.name.length === 0) {
    errors.push(`cookies[${idx}].name must be a non-empty string`);
  } else if (c.name.length > MAX_STRING_LEN) {
    errors.push(`cookies[${idx}].name too large`);
  }
  if (typeof c.value !== 'string') {
    errors.push(`cookies[${idx}].value must be a string`);
  } else if (c.value.length > MAX_STRING_LEN) {
    errors.push(`cookies[${idx}].value too large`);
  }
  if (typeof c.domain !== 'string' || c.domain.length === 0) {
    errors.push(`cookies[${idx}].domain is required`);
  }
  if (typeof c.path !== 'string' || c.path.length === 0) {
    errors.push(`cookies[${idx}].path is required`);
  }
  return errors;
}

function normalizeCookie(c: Record<string, unknown>): AuthFixtureCookie {
  // Playwright accepts -1 for session cookies. Anything non-numeric /
  // negative / NaN is coerced to -1 so we never hand Playwright a bogus
  // expires value (Chromium rejects the whole context if it sees Infinity).
  let expires: number = -1;
  if (typeof c.expires === 'number' && Number.isFinite(c.expires) && c.expires >= 0) {
    expires = c.expires;
  }

  const rawSameSite = typeof c.sameSite === 'string' ? c.sameSite : 'Lax';
  const sameSite: AuthFixtureCookie['sameSite'] = VALID_SAME_SITE.has(rawSameSite)
    ? (rawSameSite as AuthFixtureCookie['sameSite'])
    : 'Lax';

  return {
    name: c.name as string,
    value: (c.value as string) ?? '',
    domain: c.domain as string,
    path: c.path as string,
    expires,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    sameSite,
  };
}

function validateOrigin(o: Record<string, unknown>, idx: number): string[] {
  const errors: string[] = [];
  if (typeof o.origin !== 'string' || o.origin.length === 0) {
    errors.push(`origins[${idx}].origin must be a non-empty string`);
  } else {
    try {
      // Playwright requires absolute origin form: "https://host[:port]".
      // Reject anything that URL cannot parse as a proper origin.
      const u = new URL(o.origin);
      if (u.origin !== o.origin) {
        errors.push(`origins[${idx}].origin should be canonical "${u.origin}" (got "${o.origin}")`);
      }
    } catch {
      errors.push(`origins[${idx}].origin is not a valid absolute URL`);
    }
  }

  const ls = o.localStorage;
  if (ls !== undefined && !Array.isArray(ls)) {
    errors.push(`origins[${idx}].localStorage must be an array`);
  } else if (Array.isArray(ls)) {
    if (ls.length > MAX_LOCAL_STORAGE_ENTRIES_PER_ORIGIN) {
      errors.push(`origins[${idx}].localStorage too large`);
    }
    for (let j = 0; j < Math.min(ls.length, MAX_LOCAL_STORAGE_ENTRIES_PER_ORIGIN); j++) {
      const entry = ls[j];
      if (!entry || typeof entry !== 'object') {
        errors.push(`origins[${idx}].localStorage[${j}] is not an object`);
        continue;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== 'string' || e.name.length === 0) {
        errors.push(`origins[${idx}].localStorage[${j}].name must be a non-empty string`);
      }
      if (typeof e.value !== 'string') {
        errors.push(`origins[${idx}].localStorage[${j}].value must be a string`);
      }
    }
  }

  return errors;
}

function normalizeOrigin(o: Record<string, unknown>): AuthFixtureOrigin {
  const rawLs = Array.isArray(o.localStorage) ? o.localStorage : [];
  const localStorage = rawLs
    .filter((e): e is Record<string, unknown> =>
      !!e && typeof e === 'object' && typeof (e as any).name === 'string' && typeof (e as any).value === 'string',
    )
    .slice(0, MAX_LOCAL_STORAGE_ENTRIES_PER_ORIGIN)
    .map((e) => ({ name: e.name as string, value: e.value as string }));

  return {
    origin: o.origin as string,
    localStorage,
  };
}
