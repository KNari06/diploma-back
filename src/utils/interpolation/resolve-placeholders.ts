/**
 * ═══════════════════════════════════════════════════════════════════════════
 * resolvePlaceholders — single canonical {{key}} interpolator
 *
 * Why this exists:
 *   Three call sites used to do the same `s.replace(/\{\{([\w.-]+)\}\}/g, …)`
 *   work but each consulted a different source map:
 *     - test-executor.ts (background replay)         → CommandExecutor.extractedData
 *     - preview-run.service.ts (Apply All in editor) → PreviewSession.contextData
 *     - preview-step-apply.service.ts (single Apply) → PreviewSession.contextData
 *
 *   That divergence meant `{{secrets.STRIPE}}` would work in one path and
 *   silently leak `{{secrets.STRIPE}}` as a literal in another. As we add
 *   workspace-level resources (environment / secret / data_fixture) every
 *   one of those resolvers needs another lookup source — and we don't want
 *   N copies of that fan-out.
 *
 *   This helper takes an ordered list of `VariableSource` and returns the
 *   first defined value. Sources are independent and have no mutable state
 *   between calls, so the function is reentrant.
 *
 * Resolution rules:
 *   1. Match `{{key}}` where `key` matches `[\w.\-]+` — same shape every
 *      caller used historically, kept identical for compatibility.
 *   2. For each match, walk `sources` in order; first source whose `lookup`
 *      returns something other than `undefined` wins.
 *   3. If the resolved value is a string, substitute it.
 *      If it's `null` or a non-string non-undefined (number, boolean), it's
 *      coerced via `String()`.
 *      If every source returns `undefined`, the placeholder is left as a
 *      literal — same fail-open behaviour the legacy code had. This is
 *      intentional so:
 *        a) Mistyped keys surface as visible literals in the UI rather
 *           than silently turning into empty strings.
 *        b) `{{_secret_<stepId>}}` placeholders (handled separately by
 *           `runtime/recipe-redaction.ts` inside the recipe-executor) are
 *           NOT consumed here when none of the configured sources knows
 *           about them.
 *   4. Strings without a `{{` substring fast-path early.
 *   5. Calling with `null` / `undefined` / non-string returns the input
 *      unchanged so the helper is safe to chain on optional fields.
 *
 * NOT in scope:
 *   - Locator / selector / elementDescription interpolation. Those fields
 *     intentionally bypass scratchpad — sticking variables into selectors
 *     breaks the element-resolver waterfall (compiled-plan keys would
 *     differ between record and replay). The legacy code only ever
 *     interpolated `value`, `url`, `assertionText`, `intentMeta.value`,
 *     and `description`. Callers continue to pass only those fields.
 *   - Default values, conditionals, JSON-path inside braces. If we ever
 *     need them, encode them in the `lookup` function of a richer source
 *     instead of growing this helper's grammar.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Lookup signature shared by every source. Return `undefined` to defer
 *  to the next source; return any other value to substitute it. */
export type VariableLookup = (key: string) => unknown;

export interface VariableSource {
  /** Diagnostic name (logs / debugging). Not consulted at runtime. */
  name: string;
  lookup: VariableLookup;
}

/**
 * Same regex shape used by all three legacy call sites — keep it stable
 * unless the placeholder grammar itself changes.
 *
 * `\w` covers `[A-Za-z0-9_]` so it matches the `email.otp`, `secrets.X`,
 * `env.BASE_URL`, `fixtures.testUser.email` shapes without false-matching
 * Mustache-style logic delimiters (`{{#if}}`, `{{else}}`).
 */
const PLACEHOLDER_RE = /\{\{([\w.\-]+)\}\}/g;

/**
 * Resolve `{{key}}` placeholders against an ordered chain of sources.
 *
 * @param value      The string to resolve. Non-string values returned as-is.
 * @param sources    Ordered list. First defined hit wins.
 */
export function resolvePlaceholders<T>(value: T, sources: VariableSource[]): T {
  if (typeof value !== 'string') return value;
  if (!value.includes('{{')) return value;
  if (!sources.length) return value;

  // Reset lastIndex defensively; the regex literal is module-scoped, so
  // even though it has the global flag we want each call to start from 0.
  PLACEHOLDER_RE.lastIndex = 0;

  return (value as unknown as string).replace(PLACEHOLDER_RE, (match, key: string) => {
    for (const src of sources) {
      let resolved: unknown;
      try {
        resolved = src.lookup(key);
      } catch {
        // A misbehaving source must NOT crash interpolation — skip it.
        continue;
      }
      if (resolved === undefined) continue;
      if (typeof resolved === 'string') return resolved;
      if (resolved === null) return 'null';
      // Coerce numbers / booleans / Dates / etc. JSON.stringify is too
      // aggressive (would quote strings); String() is the right shape.
      return String(resolved);
    }
    return match;
  }) as unknown as T;
}

// ─── Source factories ────────────────────────────────────────────────────────
//
// Tiny wrappers so call sites don't repeat `lookup: (k) => map.get(k)` boilerplate.

/** Source backed by a `Map<string, unknown>` (run-time scratchpad). */
export function mapSource(name: string, map: Map<string, unknown> | undefined | null): VariableSource {
  return {
    name,
    lookup: (key) => (map ? map.get(key) : undefined),
  };
}

/** Source backed by a plain `Record<string, unknown>` (preview session contextData). */
export function recordSource(name: string, record: Record<string, unknown> | undefined | null): VariableSource {
  return {
    name,
    lookup: (key) => {
      if (!record) return undefined;
      // Use `in` rather than truthiness so `false`/`0`/`""` survive.
      return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    },
  };
}
