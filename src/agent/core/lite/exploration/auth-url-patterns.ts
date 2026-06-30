/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTH URL PATTERNS — shared login/auth path heuristics
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source for "does this URL look like a login/auth page". Used by the
 * survey agent (page-type inference fallback) and by the per-flow pipeline's
 * page-health check (session-lost detection: a flow that lands back on a login
 * URL mid-run was almost certainly logged out).
 *
 * Kept separate from url-pattern.ts, whose job is dedup-key normalization
 * (parameterizing /products/123 → /products/:id) — a different concern.
 *
 * English-only by design today; matches the existing survey behaviour. The
 * LLM agents cover the non-English long tail. Do NOT inline a second copy of
 * these regexes elsewhere — import from here.
 */

/** Common login/auth URL path fragments. */
export const LOGIN_URL_PATTERNS: readonly RegExp[] = [
  /\/login/i,
  /\/signin/i,
  /\/sign-in/i,
  /\/auth/i,
  /\/log-in/i,
  /\/sso/i,
];

/** True if the URL (or pathname) looks like a login/auth page. */
export function isLoginUrl(url: string): boolean {
  return LOGIN_URL_PATTERNS.some((pattern) => pattern.test(url));
}
