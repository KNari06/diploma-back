/**
 * ═══════════════════════════════════════════════════════════════════════════
 * redactStepLikeShape — apply `redactSecrets` across the well-known
 * step-shaped fields (value / assertionText / description / url) without
 * the caller having to spell each one out.
 *
 * Call sites that emit / persist a step (or step-result) object run this
 * once with the active runVariables Map; the helper collects secret
 * values and walks the documented field set. Anything not in the field
 * set is preserved verbatim — selectors, IDs, fingerprints, recipe
 * payloads, etc. NEVER pass an arbitrary object hoping the helper will
 * descend into it; that's a deliberate non-goal because over-redacting
 * can mangle locator metadata that LOOKS like a secret value.
 *
 * Use this from:
 *   - WS emits that include the post-interpolation step body
 *     (preview:step:apply:result, preview:run:progress, ...)
 *   - JSONL writers (editor-trace, replay-trace, intent-resolve-audit)
 *   - Anywhere `logger.info({ value, url, ... })` carries the
 *     interpolated body (use `redactSecrets` directly there instead —
 *     this helper is for object copies).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { collectSecretValues, redactWithValues } from './redact-secrets';

/** Fields routinely substituted by `resolvePlaceholders`. */
const REDACT_FIELDS = ['value', 'assertionText', 'description', 'url'] as const;
type RedactField = typeof REDACT_FIELDS[number];

/**
 * Build a redactor closure that's cheap to call per-emit. Pre-collects
 * the secret value list once so a hot loop doesn't iterate the Map
 * repeatedly. When `runVariables` has zero secrets, returns identity.
 */
/**
 * `object` is the broadest type that skips the index-signature
 * constraint of `Record<string, unknown>`. It accepts plain interfaces
 * like `IntentStep` directly, eliminating the `as unknown as Record<...>`
 * double-cast that polluted every emit / persist site. The redactor
 * still only touches the documented field set; everything else is
 * preserved through `{ ...obj }`.
 */
export type StepLike = object;

export function buildStepRedactor(
  runVariables: Map<string, unknown> | null | undefined,
): <T extends StepLike>(obj: T) => T {
  const values = collectSecretValues(runVariables);
  if (values.length === 0) {
    return (obj) => obj;
  }
  return <T extends StepLike>(obj: T): T => {
    if (!obj || typeof obj !== 'object') return obj;
    const bag = obj as unknown as Record<string, unknown>;
    let cloned: T | undefined;
    for (const f of REDACT_FIELDS) {
      const v = bag[f as RedactField];
      if (typeof v !== 'string') continue;
      const r = redactWithValues(v, values);
      if (r === v) continue;
      if (!cloned) cloned = { ...obj };
      (cloned as unknown as Record<string, unknown>)[f as RedactField] = r;
    }
    return cloned ?? obj;
  };
}

/**
 * One-shot version when the caller just has one object. Equivalent to
 * `buildStepRedactor(map)(obj)` but avoids the closure when only used
 * once.
 */
export function redactStepShape<T extends StepLike>(
  obj: T,
  runVariables: Map<string, unknown> | null | undefined,
): T {
  return buildStepRedactor(runVariables)(obj);
}
