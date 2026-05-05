/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Recipe Redaction — single source of truth for {{_secret_*}} handling
 *
 * Why this file exists:
 *   - Two callsites work with the same placeholder grammar (the WS save-login
 *     handler that creates redacted recipes, and the recipe-executor that
 *     interpolates them at heal time). When the regex was duplicated they
 *     drifted (anchored ^...$ vs unanchored /g) and a downstream change
 *     could silently break replay.
 *   - Tests want to exercise the rules without spinning up Playwright.
 *
 * Contract:
 *   - Placeholder shape: `{{_secret_<key>}}` where `<key>` is a
 *     `[A-Za-z0-9_]+` slug derived from the IntentStep id.
 *   - Each sensitive value lives in `resource.sensitive[<placeholder-key>]`
 *     after redaction; the in-step `value` is replaced with the wrapped
 *     placeholder string.
 *   - `interpolateRecipeSecrets()` is the inverse — called by RecipeExecutor
 *     before handing steps to CommandExecutor. Missing keys throw loudly
 *     instead of leaving `{{_secret_X}}` to be typed into the live page.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

/**
 * The set of input `type` attributes whose recorded value is treated as a
 * secret and moved into the encrypted resource envelope. Kept explicit so
 * a future `email-otp` / `tel-otp` / etc. requires a deliberate code change
 * — broadening this implicitly would silently start redacting everyday
 * test data.
 */
export const REDACT_INPUT_TYPES: ReadonlySet<string> = new Set(['password']);

/** Prefix used for every redacted sensitive key. Exported so adapters can
 *  filter "is this a redacted recipe secret vs a real adapter sensitive
 *  field" without re-deriving the rule. */
export const SECRET_KEY_PREFIX = '_secret_';

/** Anchored — full-string equality test ("is this value already a placeholder?"). */
export const SECRET_PLACEHOLDER_FULL_RE = /^\{\{_secret_[A-Za-z0-9_]+\}\}$/;

/** Unanchored, global — for `String.replace(re, fn)` interpolation passes. */
export const SECRET_PLACEHOLDER_GLOBAL_RE = /\{\{(_secret_[A-Za-z0-9_]+)\}\}/g;

/**
 * Output of `redactRecipeForResource` — caller folds `sensitive` into the
 * resource's encrypted envelope (the service does field-level encryption)
 * and persists `recipe` as the unencrypted recipe column with placeholders
 * in place of plaintext.
 */
export interface RedactedRecipe {
  /** Steps with secret values replaced by `{{_secret_<key>}}`. */
  recipe: Array<Record<string, unknown>>;
  /**
   * Plaintext key→value pairs to merge into the resource's `sensitive`
   * envelope. Empty when no step needed redaction. Keys begin with
   * `SECRET_KEY_PREFIX`.
   */
  sensitive: Record<string, string>;
}

/**
 * Walk a raw recipe (typed loosely because callers receive it from network
 * payloads) and move sensitive `value` fields out into a sensitive map.
 *
 * Idempotency: a step whose `value` already matches
 * `SECRET_PLACEHOLDER_FULL_RE` is left alone — this lets a save-login
 * round-trip (load → edit name → re-save the same recipe) avoid creating
 * doubled placeholders or losing the original secret on the second save.
 *
 * Signal we trust: `recordedInputType` set by the recorder (FieldSession
 * close path). Steps without it are passed through unchanged — we never
 * guess at what's secret based on the user's typed text. That decision
 * lives at recording time, not here.
 */
export function redactRecipeForResource(
  rawRecipe: unknown,
): RedactedRecipe {
  const recipe: Array<Record<string, unknown>> = [];
  const sensitive: Record<string, string> = {};
  if (!Array.isArray(rawRecipe)) return { recipe, sensitive };

  for (const step of rawRecipe) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;

    const inputType = s.recordedInputType;
    const value = s.value;
    const isType = s.type === 'type';
    const shouldRedact =
      isType &&
      typeof inputType === 'string' &&
      REDACT_INPUT_TYPES.has(inputType.toLowerCase()) &&
      typeof value === 'string' &&
      value.length > 0 &&
      !SECRET_PLACEHOLDER_FULL_RE.test(value);

    if (!shouldRedact) {
      recipe.push(s);
      continue;
    }

    // Derive a deterministic, regex-safe key from the step id so a re-save
    // (same id, same value) overwrites the same `sensitive` slot rather
    // than accumulating ghost secrets. Fall back to a positional `s<n>` if
    // the id is missing or non-string (legacy clients).
    const rawId = typeof s.id === 'string' && s.id.length > 0 ? s.id : null;
    const slug = rawId
      ? rawId.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32)
      : `s${Object.keys(sensitive).length}`;
    const key = `${SECRET_KEY_PREFIX}${slug}`;

    sensitive[key] = value as string;
    recipe.push({ ...s, value: `{{${key}}}` });
  }

  return { recipe, sensitive };
}

/**
 * Inverse of redaction. Replace every `{{_secret_<key>}}` placeholder in
 * step values with the plaintext from `secrets`. Throws when a placeholder
 * references a key that isn't present — better to fail with "missing
 * secret" than to type the literal placeholder string into a password
 * field.
 *
 * Pure / sync; safe to call before handing steps to CommandExecutor.
 * Steps without placeholders are returned untouched (reference-equal).
 */
export function interpolateRecipeSecrets(
  steps: IntentStep[],
  secrets: Record<string, string> | undefined,
): IntentStep[] {
  return steps.map((step) => {
    const value = step.value;
    if (typeof value !== 'string') return step;
    // Quick-reject — most steps are not type-secrets, so skip the replace
    // when there's no `{{` at all. Resets stateful regex `lastIndex`.
    if (value.indexOf('{{') === -1) return step;
    SECRET_PLACEHOLDER_GLOBAL_RE.lastIndex = 0;
    if (!SECRET_PLACEHOLDER_GLOBAL_RE.test(value)) {
      SECRET_PLACEHOLDER_GLOBAL_RE.lastIndex = 0;
      return step;
    }
    SECRET_PLACEHOLDER_GLOBAL_RE.lastIndex = 0;
    const resolved = value.replace(
      SECRET_PLACEHOLDER_GLOBAL_RE,
      (_match, key: string) => {
        const secretValue = secrets?.[key];
        if (typeof secretValue !== 'string') {
          throw new Error(
            `Recipe references missing secret "${key}" — re-record the login`,
          );
        }
        return secretValue;
      },
    );
    return { ...step, value: resolved };
  });
}
