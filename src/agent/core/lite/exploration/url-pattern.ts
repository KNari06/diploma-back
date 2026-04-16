/**
 * ═══════════════════════════════════════════════════════════════════════════
 * URL PATTERN EXTRACTOR — parameterize dynamic path segments
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns /products/123 and /products/456 into the same key /products/:id, so
 * the tree dedup treats them as one page node. Without this, a catalogue of
 * 50 items exhausts the survey budget in the first crawl.
 *
 * Design:
 *   - Token-by-token inspection of pathname segments
 *   - Replaces id-like tokens with placeholders; preserves static segments
 *   - Hash routes (#/foo/123) are parameterized too
 *   - Query strings are dropped (already handled upstream; kept for safety)
 *   - Returns the original URL on parse failure — never throws
 *
 * This is intentionally conservative: a false positive (treating a static
 * segment as an id) collapses two distinct pages into one node; a false
 * negative just leaves the behaviour as it was before. We lean toward fewer
 * false positives by requiring strong signals (digits, uuid shape, long slug).
 */

/** Matches canonical UUID v1-v5. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pure integer id, e.g. /users/42 */
const NUMERIC_RE = /^\d+$/;

/** MongoDB ObjectId: 24 hex chars. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** 32-char hex (md5 digest or short uuid without dashes). */
const HEX_32_RE = /^[0-9a-f]{32}$/i;

/**
 * Opaque long slug: ≥16 chars with BOTH letters and digits or multiple
 * separators. Catches nanoid / base62 / db-generated keys without collapsing
 * human-readable slugs like "how-to-cook-pasta".
 */
function looksLikeOpaqueSlug(token: string): boolean {
  if (token.length < 16) return false;
  const hasDigit = /\d/.test(token);
  const hasLetter = /[a-z]/i.test(token);
  // Human slugs have 2+ hyphens with no digits; opaque keys usually don't.
  const hyphens = (token.match(/-/g) || []).length;
  const looksHumanReadable = hyphens >= 2 && !hasDigit;
  if (looksHumanReadable) return false;
  return hasDigit && hasLetter;
}

/**
 * Classify a single path segment. Returns either the original token (static)
 * or a typed placeholder.
 */
export function classifySegment(token: string): string {
  if (!token) return token;
  if (UUID_RE.test(token)) return ':uuid';
  if (OBJECT_ID_RE.test(token)) return ':objectid';
  if (HEX_32_RE.test(token)) return ':hash';
  if (NUMERIC_RE.test(token)) return ':id';
  if (looksLikeOpaqueSlug(token)) return ':slug';
  return token;
}

/**
 * Parameterize a pathname by replacing id-like segments with placeholders.
 * Static segments (e.g. "products", "settings") are preserved.
 */
function parameterizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return pathname;
  const segments = pathname.split('/');
  // First element is empty (leading slash); keep it so the rejoin produces /a/b.
  const mapped = segments.map((seg, idx) => (idx === 0 ? seg : classifySegment(seg)));
  let result = mapped.join('/');
  // Strip trailing slash except for root.
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Parameterize a hash route (e.g. "#/users/42" → "#/users/:id").
 * Non-route hashes (e.g. "#section", empty) are returned as-is.
 */
function parameterizeHash(hash: string): string {
  if (!hash) return '';
  // Only parameterize route-like hashes: #/..., #!/..., or #/
  const routeMatch = hash.match(/^(#!?\/)(.*)$/);
  if (!routeMatch) return hash;
  const [, prefix, rest] = routeMatch;
  if (!rest) return hash;
  const parts = rest.split('/').map(classifySegment);
  return `${prefix}${parts.join('/')}`;
}

/**
 * Normalize a URL and parameterize dynamic path segments.
 *
 * Returns a stable key suitable for dedup. Two URLs that differ only in
 * id-shaped segments will produce the same output. Query strings are
 * dropped; route-style hashes are preserved (and parameterized).
 *
 * @param url Raw URL string.
 * @returns Normalized pattern, or the original string if parsing fails.
 */
export function normalizeUrlWithPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const pathPattern = parameterizePathname(parsed.pathname);
    const hashPattern = parameterizeHash(parsed.hash);
    // Preserve route hashes; drop anchor-only hashes.
    const isRouteHash = /^#!?\//.test(parsed.hash);
    return isRouteHash
      ? `${parsed.origin}${pathPattern}${hashPattern}`
      : `${parsed.origin}${pathPattern}`;
  } catch {
    return url;
  }
}
