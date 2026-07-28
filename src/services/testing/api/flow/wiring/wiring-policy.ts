/**
 * Single source of truth for API-flow dependency-wiring vocabulary.
 *
 * The auth/reference-id/realm heuristics used to be inlined (and subtly diverged)
 * across the resolver's safety-net passes and the eval scorer. This module
 * consolidates them so the candidate-graph builder (Phase 1), the resolver
 * passes, the repair loop (Phase 3) and the scorer all agree on the same rules.
 *
 * Phase 0.5 keeps behaviour identical: each predicate reproduces the EXACT set
 * its former call site used. The three auth-var predicates differ only by whether
 * `authorization` / `api_key` count — a divergence preserved verbatim here so it
 * is visible in one place; Phase 1 reconciles it once the candidate-graph is the
 * single producer of auth edges.
 */

const reExact = (names: string[]) => new RegExp(`^(${names.join('|')})$`, 'i');

/** Token/credential names a login step is expected to PRODUCE (extract). */
const AUTH_TOKEN_VARS = ['auth_token', 'access_token', 'jwt', 'bearer_token', 'session_token', 'token'];

/** Base auth-token set — used for producer detection, realm partitioning and the reference-id auth-bootstrap closure. */
export const isAuthTokenVar = (name: string): boolean => reExact(AUTH_TOKEN_VARS).test(name);

/** Base set plus `authorization` — used when SKIPPING auth vars in the non-auth variable-dependency pass. */
export const isAuthOrAuthorizationVar = (name: string): boolean =>
  reExact([...AUTH_TOKEN_VARS, 'authorization']).test(name);

/** Broadest set (adds `authorization` + `api_key`) — used to detect auth producers in autoWireAuthDependencies. */
export const isAuthCredentialVar = (name: string): boolean =>
  reExact([...AUTH_TOKEN_VARS, 'authorization', 'api_key']).test(name);

/** Variables the user may supply at run time (initialVariables / variableChain) — an injection of one is kept even without a producer. */
export const isUserProvidedVar = (name: string): boolean =>
  reExact([
    'auth_token',
    'access_token',
    'api_key',
    'bearer_token',
    'jwt',
    'session_token',
    'oauth_client_id',
    'oauth_client_secret',
    'base_url',
    'token',
    'authorization',
  ]).test(name);

/**
 * Suffix matcher used by the SCORER / coverage checks (broader than the
 * resolver's exact-name sets by design — it must recognise per-realm tokens like
 * `admin_token` that the resolver names explicitly).
 */
export const isAuthTokenSuffix = (name: string): boolean => /(token|jwt)$/i.test(name);

/** Path segments that mark the start of an auth endpoint (used for realm partitioning). */
export const AUTH_PATH_SEGMENT =
  /^(auth|login|signin|sign-in|register|signup|sign-up|otp|token|session|oauth|authenticate)$/i;

/**
 * Path segments of an endpoint that ESTABLISHES a session/token (narrower than
 * AUTH_PATH_SEGMENT). `/auth/login` and `/auth/otp/verify` establish; `/auth/logout`
 * and `/auth/otp/send` do NOT — they sit under `/auth` but produce no credential.
 */
export const AUTH_ESTABLISH_SEGMENT =
  /^(login|signin|sign-in|register|signup|sign-up|token|refresh|verify|authenticate|session)$/i;

/** True when the path has a session-establishing segment (→ a candidate auth producer). */
export const isAuthEstablishPath = (path: string): boolean =>
  path.split('/').filter(Boolean).some(s => AUTH_ESTABLISH_SEGMENT.test(s));

/**
 * Realm prefix = the path prefix BEFORE the first auth segment.
 * `/api/v1/admin/auth/login` → `/api/v1/admin`; `/api/v1/auth/register` → `/api/v1`.
 * A protected endpoint is wired to the producer of the realm whose prefix is the
 * longest prefix of its path.
 */
export const realmPrefixOf = (path: string): string => {
  const parts = path.split('/');
  const idx = parts.findIndex(p => AUTH_PATH_SEGMENT.test(p));
  return idx > 0 ? parts.slice(0, idx).join('/') : '';
};

// ── Reference-id helpers (autoResolveReferenceIds) ────────────────────────────

/** camelCase / kebab / spaced → snake_case. */
export const toSnakeCase = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();

/** Naive singularizer: countries→country, cities→city, files→file. */
export const singularize = (s: string): string =>
  /ies$/i.test(s) ? s.replace(/ies$/i, 'y') : /s$/i.test(s) ? s.replace(/s$/i, '') : s;

/** Last meaningful path segment, stripping an `/api/vN` prefix and `{param}` parts. */
export const lastPathSegment = (p: string): string => {
  const parts = p.replace(/^\/(api\/)?v\d+\/?/, '').split('/').filter(x => x && !x.startsWith('{'));
  return parts[parts.length - 1] || '';
};

/** A path ending in a `{param}` — an item fetch (`/users/{id}`), not a collection. */
export const isItemPath = (p: string): boolean => {
  const parts = p.split('/').filter(Boolean);
  return !!parts[parts.length - 1]?.startsWith('{');
};

// ── Send→verify + session-teardown ordering ──────────────────────────────────
// Two ordering relationships the spec never encodes as a variable dependency, so
// no producer→consumer pass catches them:
//   • a verify/confirm step runs AFTER the send that issued the code it confirms;
//   • a logout/teardown runs AFTER every step that uses the session it destroys.

const pathSegments = (p: string): string[] => p.split('/').filter(Boolean);

/** Path with its last segment dropped — the resource prefix a send/verify pair shares. */
export const parentPathKey = (p: string): string => pathSegments(p).slice(0, -1).join('/');

const finalSegment = (p: string): string => pathSegments(p).pop() || '';

/** A confirm/verify step — consumes a code delivered out of band, so it must run AFTER its send. */
export const isVerifyStep = (path: string, id = ''): boolean =>
  /^(verify|confirm|validate|activate|submit|complete)$/i.test(finalSegment(path)) ||
  /(?:^|[_-])(verify|confirm|submit)/i.test(id);

/** A send/request step that ISSUES the code a verify step later confirms. */
export const isSendStep = (path: string, id = ''): boolean =>
  /^(request|send|resend|start|init|initiate|generate|challenge)$/i.test(finalSegment(path)) ||
  /(?:^|[_-])(request|send|resend)/i.test(id);

/**
 * Session-teardown endpoint — invalidates the session/token, so it must run LAST.
 * Covers logout/signout AND credential-revocation naming (`/token/revoke`,
 * `/sessions/terminate`, `/auth/end-session`, `/session/invalidate`).
 */
export const isSessionTeardown = (path: string, id = ''): boolean =>
  /(^|\/)(logout|log-out|signout|sign-out|revoke|terminate|end-session|end_session|invalidate|deauthenticate)(-[a-z0-9_-]*)?(\/|$)/i.test(path) ||
  /(?:^|[_-])(logout|signout|revoke|terminate|end[_-]?session|invalidate)/i.test(id);

/** Higher = tears down MORE (all-devices / global) → runs after a narrower logout. */
export const teardownSeverity = (path: string): number =>
  /(all|global|everywhere|other|devices|sessions)/i.test(path) ? 2 : 1;

/** A path param naming no entity of its own (`{id}`, `{_id}`) — only its path says what it identifies. */
export const isGenericIdParam = (name: string): boolean => /^_?id$/.test(toSnakeCase(name));

/**
 * The entity a path param identifies — the last literal segment before it.
 * `/users/{id}` → "user"; `/users/{userId}/posts/{id}` → "post".
 * Empty when the param is preceded by no literal segment (`/{id}`).
 */
export const pathEntityFor = (path: string, paramName: string): string => {
  const parts = path.split('/').filter(Boolean);
  const at = parts.indexOf(`{${paramName}}`);
  const before = at === -1 ? parts : parts.slice(0, at);
  for (let i = before.length - 1; i >= 0; i--) {
    if (!before[i].startsWith('{')) return singularize(before[i]).toLowerCase();
  }
  return '';
};

/** A request field that names a reference id (`userId`, `country_id`, …). */
export const isReferenceIdField = (field: string): boolean => /id$/i.test(field);

/** A 2xx response field name that carries a bearer token (accessToken, jwt, …). */
export const isTokenField = (name: string): boolean =>
  /^(access_?token|token|jwt|bearer_?token|id_?token)$/i.test(name);

/** A variable name in canonical `*_id` form (post toSnakeCase). */
export const isSnakeIdVar = (name: string): boolean => /_id$/.test(name);
