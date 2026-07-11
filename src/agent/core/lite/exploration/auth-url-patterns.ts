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

/**
 * Auth/identity HOST prefixes. Many apps host login on a dedicated subdomain
 * with a non-auth path (e.g. `account.bi.group/?backUrl=…`, `auth.example.com/`),
 * so the path-only patterns above miss them. A redirect to such a host mid-flow
 * is a strong "you must log in" signal. Matched against the hostname only.
 */
const AUTH_HOST_PREFIXES = ['account.', 'accounts.', 'auth.', 'login.', 'signin.', 'id.', 'sso.'];

/** True if the URL (or pathname) looks like a login/auth page. */
export function isLoginUrl(url: string): boolean {
  if (LOGIN_URL_PATTERNS.some((pattern) => pattern.test(url))) return true;
  // Host-based: a dedicated auth subdomain even when the path is just "/".
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AUTH_HOST_PREFIXES.some((p) => host.startsWith(p));
  } catch {
    return false; // not a full URL (e.g. a bare pathname) → path check above already ran
  }
}
