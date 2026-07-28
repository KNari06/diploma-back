// Resolve the absolute base URL a flow's HTTP requests are sent against.
//
// A spec doesn't always carry one: an OpenAPI doc exported to a file often has
// no `servers`, and NestJS/Swagger UIs frequently omit an absolute server. When
// the base URL can't be derived we must NOT fire requests at a relative path
// (e.g. `/auth/login`) — the executor's `new URL(...)` throws "Invalid URL
// format" (status 0). Instead the caller asks the user for `{{base_url}}`.

/** Variable name the run dialog / environment uses to supply a base URL override. */
export const BASE_URL_VAR = 'base_url';

const isAbsolute = (u?: string | null): u is string => !!u && /^https?:\/\//i.test(u);
const stripTrailingSlash = (u: string): string => u.replace(/\/+$/, '');

/** A URL still carrying an unresolved `{var}` template segment (e.g. `https://{env}.api.com`). */
const hasUnresolvedTemplate = (u: string): boolean => /\{[^{}]+\}/.test(u);

/**
 * Substitute OpenAPI Server Object `{var}` placeholders with their declared
 * `variables[var].default`. A var with no usable default is left as `{var}` so
 * the caller can detect an unresolved template and fall back to `{{base_url}}`.
 * (OpenAPI 3 requires a `default` for every server variable, but real specs omit
 * it — hence the guard rather than a blind substitution.)
 */
const substituteServerVars = (url: string, variables: any): string => {
  if (!url.includes('{')) return url;
  return url.replace(/\{([^{}]+)\}/g, (whole, name) => {
    const def = variables?.[name]?.default;
    return typeof def === 'string' && def !== '' ? def : whole;
  });
};

/**
 * Best-effort absolute base URL from the spec alone (no run-time overrides).
 *
 * Order:
 *  1. an absolute `servers[0].url` (OpenAPI 3) or `host`(+`schemes`+`basePath`) (Swagger 2);
 *  2. else, if the spec was imported from a URL, that URL's origin — with a
 *     relative server path (e.g. "/api") appended to it.
 *
 * Returns '' when nothing absolute is derivable (file/paste import, no servers).
 */
export function deriveSpecBaseUrl(rawSpec: any, sourceUrl?: string | null): string {
  const raw = rawSpec && typeof rawSpec === 'object' ? rawSpec : {};
  const server0 = raw.servers?.[0];
  const serverUrl = typeof server0?.url === 'string'
    ? substituteServerVars(server0.url.trim(), server0.variables)
    : '';
  const swaggerHost = raw.host
    ? `${(Array.isArray(raw.schemes) && raw.schemes[0]) || 'https'}://${raw.host}${raw.basePath || ''}`
    : '';
  const candidate = serverUrl || swaggerHost;

  // A templated base (`https://{env}.api.com`) matches the absolute regex but is
  // NOT sendable — `new URL('/x', base)` yields a bogus host and DNS-fails at run
  // time. Treat it as underivable so the caller asks for `{{base_url}}` instead.
  if (isAbsolute(candidate) && !hasUnresolvedTemplate(candidate)) return stripTrailingSlash(candidate);

  let origin = '';
  try {
    if (sourceUrl) origin = new URL(sourceUrl).origin;
  } catch {
    origin = '';
  }
  if (origin) {
    return candidate.startsWith('/') ? stripTrailingSlash(origin + candidate) : origin;
  }

  return '';
}

/**
 * Resolve the base URL for a run: a user-provided override wins (from the run
 * dialog's `{{base_url}}` or a linked environment), else the spec-derived value.
 * An override must be absolute to be usable; anything else falls through to the
 * spec value (and ultimately '' → the caller blocks the run with a clear ask).
 */
export function resolveRunBaseUrl(
  rawSpec: any,
  sourceUrl: string | null | undefined,
  overrideValue: unknown,
): string {
  const override = typeof overrideValue === 'string' ? overrideValue.trim() : '';
  if (isAbsolute(override) && !hasUnresolvedTemplate(override)) {
    return stripTrailingSlash(override);
  }
  return deriveSpecBaseUrl(rawSpec, sourceUrl);
}
