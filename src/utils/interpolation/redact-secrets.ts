/**
 * ═══════════════════════════════════════════════════════════════════════════
 * redactSecrets — strip `secrets.*` values from any string before logging
 *
 * Rationale:
 *   `resolvePlaceholders` substitutes `{{secrets.STRIPE}}` with the real
 *   value at run time. After substitution the step's `value` field
 *   contains plaintext credentials. Several call sites then log the
 *   resolved step body to:
 *     - editor JSONL trace
 *     - websocket progress events (run_step_progress)
 *     - server logs (logger.info)
 *   Any one of those leaks defeats the whole "encrypt at rest" story.
 *
 *   This helper takes a string AND the same `runVariables` Map the
 *   adapter populated, finds every value whose key starts with
 *   `secrets.`, and replaces every occurrence of that value with `***`.
 *   It's a strict superset of the inline masking that step-execution
 *   could do (`if (key.startsWith('secrets.')) replace with ***`)
 *   because it ALSO catches accidental concatenations: a developer
 *   constructing `\`Bearer ${token}\`` still gets `Bearer ***`.
 *
 * Limits / known gaps:
 *   - Only works against `runVariables`. Secrets read from external
 *     systems (env vars, vault) won't be redacted by this — keep them
 *     in `secrets.*` namespace so they go through here.
 *   - Very short values (< MIN_REDACT_LENGTH) are skipped, otherwise we
 *     would mangle every log line containing `1` / `true` / common
 *     short tokens. If a real secret happens to be 3 chars, that's a
 *     credential design problem, not a redaction problem.
 *   - Substring-based: a secret "abc" embedded inside an unrelated word
 *     "fabric" would still be masked. Fine — false-positive masking is
 *     never worse than a real leak.
 *   - Replacement is naive `String.split.join` rather than regex so
 *     special-character secrets (`/`, `+`, regex metas in JWTs) don't
 *     need escaping.
 *
 * Hot path note:
 *   This runs on every logged step body, so it's written to be cheap on
 *   the no-secrets case: zero secrets → returns the input untouched
 *   without iterating, no allocations.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SECRET_PREFIX = 'secrets.';
const MASK = '***';
const MIN_REDACT_LENGTH = 4;

/**
 * A step value bound to a stored secret: exactly `{{secrets.<key>}}`, nothing
 * around it. The key grammar matches `resolvePlaceholders`' own
 * `[\w.-]+` — a value that does NOT match must be treated as an unbound
 * literal and masked, so this is deliberately anchored (fails closed).
 *
 * Single source for the three places that need this shape: the authoring
 * freeze, the `toIntentSteps` mask guard, and the binding-emission check.
 */
/**
 * The ONE encoding of the bound-placeholder grammar. Everything that needs the
 * shape — anchored, unanchored, or as an alternation branch inside a larger
 * regex (`credential-step-templater`) — derives from this string, so the key
 * charset cannot drift between copies.
 */
export const SECRET_PLACEHOLDER_SOURCE = '\\{\\{secrets\\.[\\w.-]+\\}\\}';

const SECRET_PLACEHOLDER_RE = new RegExp(`^${SECRET_PLACEHOLDER_SOURCE}$`);

/** Is this value a `{{secrets.<key>}}` placeholder bound to a stored secret? */
export function isBoundSecretPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && SECRET_PLACEHOLDER_RE.test(value);
}

/**
 * Unanchored sibling: does the string CONTAIN a bound placeholder somewhere?
 *
 * An authored assertion is templated in place — `Welcome back,
 * {{secrets.login_email}}` — so it is a credential-safe string that the
 * anchored check above rejects. Callers that ask "has this already been made
 * safe?" (rather than "is this exactly a bound value?") need this one. Keeping
 * both here keeps the placeholder grammar in a single file.
 */
const SECRET_PLACEHOLDER_CONTAINS_RE = new RegExp(SECRET_PLACEHOLDER_SOURCE);

/**
 * Deliberately NOT a type predicate: callers ask this about a value they have
 * already narrowed to `string`, and `value is string` would narrow the FALSE
 * branch to `never` and break them.
 */
export function containsBoundSecretPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && SECRET_PLACEHOLDER_CONTAINS_RE.test(value);
}

/**
 * Build the placeholder frozen into an authored credential step. Returns
 * undefined for a key that could not round-trip through
 * `isBoundSecretPlaceholder` / `resolvePlaceholders` — freezing one of those
 * would make replay TYPE the literal `{{secrets.…}}` into the app under test.
 */
export function buildSecretPlaceholder(key: string): string | undefined {
  const candidate = `{{${SECRET_PREFIX}${key}}}`;
  return isBoundSecretPlaceholder(candidate) ? candidate : undefined;
}

/**
 * Replace every occurrence of every `secrets.*` value in `runVariables`
 * with `***`. Returns the input unchanged when nothing to mask.
 *
 * Pass the *same* runVariables Map the resolver consulted — this is
 * by design: the redactor masks exactly what the resolver could have
 * substituted. If you have a Map<string,string> shape variant, use
 * `collectSecretValues` directly to build the value set yourself.
 */
export function redactSecrets(
  value: string,
  runVariables: Map<string, unknown> | null | undefined,
): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  const secretValues = collectSecretValues(runVariables);
  if (secretValues.length === 0) return value;
  return redactWithValues(value, secretValues);
}

/**
 * Collect the redact-eligible values from a runVariables Map.
 * Sorted longest-first so a long secret containing a shorter one as a
 * substring is masked entirely (otherwise the inner short value would
 * mask first and leave half of the long secret in the output).
 */
export function collectSecretValues(
  runVariables: Map<string, unknown> | null | undefined,
): string[] {
  if (!runVariables || runVariables.size === 0) return [];
  const out: string[] = [];
  for (const [key, raw] of runVariables) {
    if (typeof key !== 'string' || !key.startsWith(SECRET_PREFIX)) continue;
    const str = raw == null ? '' : String(raw);
    if (str.length < MIN_REDACT_LENGTH) continue;
    out.push(str);
  }
  // Stable: longest first so substrings don't pre-empt longer matches.
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * Lower-level form for callers that already cached the value list (e.g.
 * to redact many strings in a hot loop without rebuilding the array).
 *
 * Use `collectSecretValues(runVariables)` to construct the input list.
 */
export function redactWithValues(value: string, secretValues: readonly string[]): string {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (secretValues.length === 0) return value;
  let out = value;
  for (const v of secretValues) {
    if (!v || v.length < MIN_REDACT_LENGTH) continue;
    if (!out.includes(v)) continue;
    out = out.split(v).join(MASK);
  }
  return out;
}

/** Result of masking a flat key→string snapshot against a secret-value list. */
export interface SnapshotRedactionResult {
  /** Same keys as the input, with masked values where a secret matched. */
  snapshot: Record<string, string>;
  /** Keys whose value was actually changed by masking — i.e. held a secret. */
  redactedKeys: string[];
}

/**
 * Redact every string VALUE in a flat key→string snapshot (e.g. a
 * `link_test_case` scratchpad/extractedData snapshot) against a secret-value
 * list. Keys are dynamic variable names, so every value is checked rather
 * than a fixed field list — mirrors `redactRuntimeMeta`'s snapshot handling
 * in `command-executor.ts` (CLAUDE.md Hard invariant #10).
 *
 * Returns `undefined` when nothing needed masking (no snapshot / no secrets
 * / no match) so callers can cheaply skip cloning their meta object.
 *
 * `redactedKeys` lets a caller distinguish "this variable legitimately holds
 * `{{secrets.*}}`" from "this variable never had a secret" — needed so
 * `link_test_case` outputBinding resolution can fail loudly instead of
 * silently handing back the literal mask as if it were the real value.
 */
export function redactSnapshotValues(
  snapshot: Record<string, string> | null | undefined,
  secretValues: readonly string[],
): SnapshotRedactionResult | undefined {
  if (!snapshot || secretValues.length === 0) return undefined;
  let redacted: Record<string, string> | undefined;
  const redactedKeys: string[] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value !== 'string') continue;
    const r = redactWithValues(value, secretValues);
    if (r === value) continue;
    if (!redacted) redacted = { ...snapshot };
    redacted[key] = r;
    redactedKeys.push(key);
  }
  return redacted ? { snapshot: redacted, redactedKeys } : undefined;
}

/** Structural shape of the runtime credentials carried by agent configs. */
export interface RedactableCredentials {
  email?: string;
  username?: string;
  password?: string;
  phone?: string;
}

/**
 * Strip any configured credential value (email / username / password / phone)
 * out of an LLM-facing or trace-bound string. A page that echoes a credential
 * into its console / DOM / form labels would otherwise leak it into a prompt or
 * the JSONL trace. Single source so every agent sink redacts identically
 * (CLAUDE.md invariant #10). Identity on the no-creds path.
 */
export function redactCredentialValues(
  value: string,
  credentials: RedactableCredentials | null | undefined,
): string {
  if (!credentials) return value;
  const values = [credentials.password, credentials.email, credentials.username, credentials.phone]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    // Longest-first so a value that is a substring of another (e.g. username
    // inside email) can't mask first and leave the longer one's tail exposed.
    // Mirrors collectSecretValues' ordering above.
    .sort((a, b) => b.length - a.length);
  return redactWithValues(value, values);
}
