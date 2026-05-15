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
