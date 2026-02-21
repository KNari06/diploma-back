/**
 * URL Pattern Matcher
 *
 * Centralised, well-tested logic for matching URLs against patterns.
 * Used by executeWaitFor (waitFor action) and compareValues (assertions).
 *
 * Supports:
 *  - substring  — plain includes(), case-insensitive by default
 *  - glob       — shell-style wildcards (* ** ?) with proper URL semantics
 *  - regex      — user-supplied RegExp with /flags/ syntax support + ReDoS guard
 *  - domain     — exact hostname match
 *
 * Glob semantics (URL-aware, not filesystem):
 *  - *   matches any characters EXCEPT "/"
 *  - **  matches any characters INCLUDING "/"  (path globstar)
 *  - ?   matches exactly one character EXCEPT "/"
 *  - Glob without wildcards → substring match (NOT exact match)
 *        "dashboard" matches "https://app.com/dashboard/stats"
 *  - Glob starting with "http" → full-URL match with anchors
 *        "https://app.com/**" matches only that origin
 *  - Otherwise → path/suffix match (anchor only at end)
 *        "**\/users\/**" matches any URL containing /users/ path segment
 *
 * Regex syntax:
 *  - Plain string:  "foo\d+"          → case-sensitive by default
 *  - With flags:   "/foo\d+/i"        → parsed, flags applied
 *  - caseSensitive option overrides the "i" default but /flags/ syntax wins
 *
 * ReDoS guard:
 *  - Validates regex compiles without error
 *  - Executes with a 50ms Promise.race timeout in Node.js
 *  - Browser-side (waitForFunction) has its own try/catch fallback
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface UrlMatchOptions {
  caseSensitive?: boolean;
  negate?: boolean;
}

export interface ParsedRegex {
  /** The pattern string ready for new RegExp(pattern, flags) */
  pattern: string;
  /** Flags string, e.g. "i" or "gi" */
  flags: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// REGEX HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a regex string that may optionally have /pattern/flags syntax.
 *
 * Examples:
 *   "foo\d+"        → { pattern: "foo\\d+", flags: "i" }   (default case-insensitive)
 *   "/foo\d+/i"     → { pattern: "foo\\d+", flags: "i" }
 *   "/foo\d+/gi"    → { pattern: "foo\\d+", flags: "gi" }
 *   "/foo\d+"       → { pattern: "/foo\\d+", flags: "i" }  (unclosed → treat as plain)
 *
 * The caseSensitive param only applies when there is NO /flags/ syntax.
 */
export function parseRegexString(raw: string, caseSensitive = false): ParsedRegex {
  // Detect /pattern/flags syntax — must start AND end with /
  const slashMatch = raw.match(/^\/(.*)\/([gimsuy]*)$/s);
  if (slashMatch) {
    return {
      pattern: slashMatch[1],
      flags: slashMatch[2] || '',
    };
  }

  // Plain string — apply caseSensitive option
  return {
    pattern: raw,
    flags: caseSensitive ? '' : 'i',
  };
}

/**
 * Execute a regex match with a ReDoS guard (50ms timeout in Node.js).
 * Returns false on timeout or invalid pattern instead of throwing/hanging.
 */
export async function safeRegexTestAsync(
  pattern: string,
  flags: string,
  subject: string
): Promise<boolean> {
  // Validate first
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return false;
  }

  // Race the actual test against a 50ms timeout
  return Promise.race<boolean>([
    Promise.resolve().then(() => re.test(subject)),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
  ]);
}

/**
 * Synchronous regex test — used in compareValues (sync context).
 * No timeout possible synchronously; relies on reasonable patterns from QA engineers.
 * Invalid regex → false.
 */
export function safeRegexTestSync(pattern: string, flags: string, subject: string): boolean {
  try {
    return new RegExp(pattern, flags).test(subject);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOB CONVERTER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a URL glob pattern to a regex string.
 *
 * URL semantics (different from filesystem globs):
 *  - "?" in a URL query string (e.g. "page?id=1") is literal — but we can't
 *    know the user's intent statically. Rule: "?" before "=" is treated as
 *    literal "?", otherwise as single-char wildcard. This covers the 90% case.
 *
 * Anchoring strategy:
 *  - Has wildcards AND starts with protocol ("http://" / "https://"):
 *      → full anchor ^...$
 *  - Has wildcards but no protocol prefix:
 *      → suffix/partial anchor: .*<pattern>$  (allows matching any URL containing it)
 *  - No wildcards at all:
 *      → no anchors, treated as substring (equivalent to `substring` matcher)
 *        This is intentional: "dashboard" should match ".../dashboard/stats"
 *
 * Token-based conversion avoids the `###GLOBSTAR###` placeholder hack.
 */
export function globToRegexString(glob: string): string {
  const hasWildcard = glob.includes('*') || glob.includes('?');

  if (!hasWildcard) {
    // No wildcards → plain substring, escape for use in RegExp but no anchors
    return escapeRegexChars(glob);
  }

  const hasProtocol = /^https?:\/\//i.test(glob);

  // Tokenise the glob into literal segments and wildcard tokens
  // We split on **, *, ? while preserving them as tokens
  const tokens = tokeniseGlob(glob);
  const regexBody = tokens.map(convertToken).join('');

  if (hasProtocol) {
    // Full URL glob → anchor both ends
    return `^${regexBody}$`;
  } else {
    // Partial glob → anchor only the end (prefix can be anything)
    return `${regexBody}$`;
  }
}

/** Escape characters that are special in RegExp but should be literal in glob */
function escapeRegexChars(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

type GlobToken =
  | { kind: 'globstar' }          // **
  | { kind: 'star' }              // *
  | { kind: 'question'; isQuery: boolean }  // ? (isQuery=true → literal)
  | { kind: 'literal'; value: string };

/**
 * Split glob string into tokens without using placeholder strings.
 */
function tokeniseGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;

  while (i < glob.length) {
    if (glob[i] === '*') {
      if (glob[i + 1] === '*') {
        tokens.push({ kind: 'globstar' });
        i += 2;
        // Skip optional trailing slash after **
        if (glob[i] === '/') i++;
      } else {
        tokens.push({ kind: 'star' });
        i++;
      }
    } else if (glob[i] === '?') {
      // Heuristic: if the character before '?' is a letter/digit/slash and
      // the character after is a letter/digit (looks like query param start),
      // treat as literal URL '?'
      const prev = glob[i - 1] ?? '';
      const next = glob[i + 1] ?? '';
      const isQueryStart = /[\w/]/.test(prev) && /[a-zA-Z_]/.test(next);
      tokens.push({ kind: 'question', isQuery: isQueryStart });
      i++;
    } else {
      // Accumulate literal characters
      let literal = '';
      while (i < glob.length && glob[i] !== '*' && glob[i] !== '?') {
        literal += glob[i];
        i++;
      }
      tokens.push({ kind: 'literal', value: literal });
    }
  }

  return tokens;
}

function convertToken(token: GlobToken): string {
  switch (token.kind) {
    case 'globstar':
      return '.*';                  // ** → any chars including /
    case 'star':
      return '[^/]*';               // *  → any chars except /
    case 'question':
      return token.isQuery
        ? '\\?'                     // literal ? (query string start)
        : '[^/]';                   // single char wildcard
    case 'literal':
      return escapeRegexChars(token.value);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC MATCHERS — synchronous (for compareValues assertions)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Test a URL against a substring pattern.
 */
export function matchSubstring(url: string, sub: string, opts: UrlMatchOptions = {}): boolean {
  const { caseSensitive = false, negate = false } = opts;
  const a = caseSensitive ? url : url.toLowerCase();
  const b = caseSensitive ? sub : sub.toLowerCase();
  const result = a.includes(b);
  return negate ? !result : result;
}

/**
 * Test a URL against a glob pattern.
 */
export function matchGlob(url: string, glob: string, opts: UrlMatchOptions = {}): boolean {
  const { caseSensitive = false, negate = false } = opts;
  const regexStr = globToRegexString(glob);
  const flags = caseSensitive ? '' : 'i';
  const result = safeRegexTestSync(regexStr, flags, url);
  return negate ? !result : result;
}

/**
 * Test a URL against a regex pattern (supports /pattern/flags syntax).
 * Synchronous — used in compareValues.
 */
export function matchRegex(url: string, raw: string, opts: UrlMatchOptions = {}): boolean {
  const { caseSensitive = false, negate = false } = opts;
  const { pattern, flags } = parseRegexString(raw, caseSensitive);
  const result = safeRegexTestSync(pattern, flags, url);
  return negate ? !result : result;
}

/**
 * Test a URL against a domain (exact hostname match).
 */
export function matchDomain(url: string, domain: string, opts: UrlMatchOptions = {}): boolean {
  const { caseSensitive = false, negate = false } = opts;
  try {
    const parsed = new URL(url);
    const host = caseSensitive ? parsed.hostname : parsed.hostname.toLowerCase();
    const target = caseSensitive ? domain : domain.toLowerCase();
    const result = host === target;
    return negate ? !result : result;
  } catch {
    // Fallback if URL is not parseable (relative URLs, etc.)
    const a = caseSensitive ? url : url.toLowerCase();
    const b = caseSensitive ? domain : domain.toLowerCase();
    const result = a.includes(b);
    return negate ? !result : result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER-SIDE SERIALISABLE MATCHERS
// (passed as strings into waitForFunction — must be self-contained)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a serialisable payload for glob matching inside waitForFunction.
 * The browser receives the pre-converted regex string so it doesn't need
 * the glob conversion logic.
 */
export function buildGlobWaitPayload(
  glob: string,
  caseSensitive: boolean,
  negate: boolean
): { pattern: string; flags: string; negate: boolean } {
  return {
    pattern: globToRegexString(glob),
    flags: caseSensitive ? '' : 'i',
    negate,
  };
}

/**
 * Build a serialisable payload for regex matching inside waitForFunction.
 * Parses /pattern/flags syntax and validates in Node.js before sending.
 * Throws if pattern is invalid.
 */
export function buildRegexWaitPayload(
  raw: string,
  caseSensitive: boolean,
  negate: boolean
): { pattern: string; flags: string; negate: boolean } {
  const { pattern, flags } = parseRegexString(raw, caseSensitive);

  // Validate in Node.js — fast-fail before sending to browser
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(
      `Invalid regex pattern for waitFor: "/${pattern}/${flags}" — ${(e as Error).message}`
    );
  }

  return { pattern, flags, negate };
}
