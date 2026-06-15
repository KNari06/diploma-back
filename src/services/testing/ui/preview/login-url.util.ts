/**
 * Single source of truth for "does this URL path look like a login route".
 *
 * Extracted to its own module so BOTH the heuristic auth-detector and the LLM
 * observer's pre-gate read the exact same vocabulary — neither owns it, so no
 * second copy can drift (the bug class behind Hard invariant #17). Putting it
 * here also breaks what would otherwise be a circular import between
 * auth-detector and observer.service.
 *
 * Word-anchored by URL structure: the leading `(?:^|\/)` prevents `/login-help`
 * from matching mid-token, and the trailing `(?:\/|$|\?|#)` keeps it bounded to
 * a path segment. Multilingual — Russian login routes (`/вход`, `/войти`,
 * `/авторизация`, `/регистрация`) are matched directly (Cyrillic is fine here;
 * anchoring is by URL delimiters, not `\b`).
 */
export const LOGIN_URL_RE =
  /(?:^|\/)(?:login|log[-_]?in|signin|sign[-_]?in|oauth|sso|saml|idp|session|вход|войти|авторизация|регистрация)(?:\/|$|\?|#)/i;
