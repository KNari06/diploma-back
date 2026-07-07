/**
 * Mobile-step sanitizer — credentials replacement for `intent_test_cases.steps_json`.
 *
 * Why this exists:
 *   `RegressionSaveService.sanitizeCommands()` (web) sanitises Playwright
 *   `commands` payloads. It looks at `selector` + `description` + `label` —
 *   web-only fields. Mobile steps don't have any of those; they have
 *   `description` plus targeting via `bindingHints` and `value`.
 *
 *   `RegressionSaveService.saveFromRecording()` (the entrypoint we use for
 *   mobile authoring) does NOT sanitise — same as web step-editor authoring.
 *   That gap means a mobile_agent that types "qwerty123" into a password
 *   field would persist the password in plaintext inside steps_json.
 *
 *   We close that gap on the mobile-agent side. The same regex catalogue
 *   web uses (password / token / secret / api_key / auth / credential / key)
 *   gates the substitution; the matching context is the mobile equivalent
 *   of selector+description: `description + bindingHints text fields`.
 *
 * Output shape:
 *   - Each detected sensitive value becomes `{{param_<name>}}`.
 *   - A parametersSchema map is returned alongside, ready to be persisted on
 *     `intent_test_cases.parameters_schema`.
 *   - `assertionText` is redacted the same way `value` is (an agent can put a
 *     secret in an assertion — "screen shows token sk_live_..."), and
 *     always-secret option fields (`totpSecret`, `otpCode`) are masked
 *     unconditionally. This matters because the sanitised copy is what the
 *     UI renders and what gets persisted into chat history + steps_json —
 *     leaving a secret in `assertionText`/`options` there is a real leak
 *     (backend invariant #10). Step shape is otherwise preserved verbatim.
 */

import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';

const SENSITIVE_PATTERNS: RegExp[] = [
  /password/i,
  /token/i,
  /secret/i,
  /api[_-]?key/i,
  /auth(?!or)/i, // "auth" but skip "author" / "authoring"
  /credential/i,
  /\bpin\b/i,
  /\botp\b/i,
  /\bkey\b/i,
];

export interface SanitizedMobileResult {
  steps: MobileIntentStep[];
  parametersSchema: Record<
    string,
    {
      type: 'string';
      description: string;
      required: true;
      sensitive: true;
    }
  >;
}

/**
 * Returns a copy of `steps` with sensitive `value` strings replaced by
 * `{{param_<id>}}` placeholders. Idempotent: an already-templated value
 * is left alone.
 *
 * Caller responsibility:
 *   - Pass the FINAL ordered list (post-normalisation). We don't reorder.
 *   - Persist the returned `parametersSchema` to
 *     `intent_test_cases.parameters_schema`.
 *   - Replay-time substitution (`{{...}}` → actual creds) is already
 *     handled by the regression run path; this function only rewrites
 *     authoring-time payloads.
 */
export function sanitizeMobileSteps(
  steps: MobileIntentStep[],
): SanitizedMobileResult {
  const parametersSchema: SanitizedMobileResult['parametersSchema'] = {};

  const sanitized = steps.map<MobileIntentStep>((rawStep) => {
    // First mask always-secret option fields + a sensitive assertionText, then
    // fall through to the value-parameterisation logic below. `step` carries
    // those masks forward so a step with BOTH a sensitive value and a secret
    // option is fully cleaned.
    let step = maskSecretOptionFields(rawStep);
    step = maskSensitiveAssertionText(step);

    const value = step.value;
    if (typeof value !== 'string' || value.length === 0) return step;

    // Already a placeholder — skip. Defensive against double-sanitisation
    // when callers run this on already-sanitised JSON. We compare the
    // trimmed string but persist the trimmed version so a later
    // double-pass also matches (avoids leak through whitespace drift).
    const trimmed = value.trim();
    if (/^\{\{.+\}\}$/.test(trimmed)) {
      // Persist the trimmed form so the next pass remains idempotent even
      // if upstream re-introduced whitespace.
      return value === trimmed ? step : { ...step, value: trimmed };
    }

    // Build the matching context from every text field that hints at the
    // semantic role of the value. `description` is the LLM's intent
    // ("Type password into login field"). The MobileBindingHints fields
    // listed below carry recorded targeting metadata. Keys are aligned
    // with the actual MobileBindingHints interface
    // (mobile-runner.types.ts:66-73): role, label, placeholder, nearText,
    // type, autocomplete. We do NOT inspect `value` itself — the regex
    // would false-positive on actual password strings just because they
    // contain "key" by accident.
    const context = [step.description ?? '', ...bindingHintBits(step)].join(' ').trim();
    if (!context) return step;

    const sensitive = SENSITIVE_PATTERNS.some((pat) => pat.test(context));
    if (!sensitive) return step;

    const paramName = makeParamName(step, parametersSchema);
    parametersSchema[paramName] = {
      type: 'string',
      description: `Value for ${step.description || step.id}`,
      required: true,
      sensitive: true,
    };

    return { ...step, value: `{{${paramName}}}` };
  });

  return { steps: sanitized, parametersSchema };
}

// Option fields that are ALWAYS a secret when present — a TOTP shared seed and
// a one-time code. Masked unconditionally (no keyword gate): there is no
// legitimate reason to persist or ship these to the browser in cleartext.
export const SECRET_OPTION_FIELDS = ['totpSecret', 'otpCode'] as const;
const MASKED_SECRET = '{{param_secret}}';

/**
 * Mask always-secret fields inside `options` (totpSecret, otpCode). Returns
 * the step unchanged when none are present, so identity is preserved for the
 * common case. Does NOT clone `options` unless it actually masks something.
 */
function maskSecretOptionFields(step: MobileIntentStep): MobileIntentStep {
  const opts = step.options as Record<string, unknown> | undefined;
  if (!opts) return step;
  let changed = false;
  const next: Record<string, unknown> = { ...opts };
  for (const f of SECRET_OPTION_FIELDS) {
    const v = next[f];
    if (typeof v === 'string' && v.length > 0 && !/^\{\{.+\}\}$/.test(v.trim())) {
      next[f] = MASKED_SECRET;
      changed = true;
    }
  }
  return changed ? ({ ...step, options: next } as MobileIntentStep) : step;
}

/**
 * Mask a sensitive `assertionText`. We scan the assertion string ITSELF (not
 * the step's description — that describes the value, not the assertion, and
 * keying off it would wrongly mask a benign assertion on a
 * password-typing step). A secret quoted in the assertion
 * ("the screen shows token sk_live_…") must not persist or reach the browser.
 * Masks to a placeholder (an assertion is not a replay input to parameterise).
 */
function maskSensitiveAssertionText(step: MobileIntentStep): MobileIntentStep {
  const at = step.assertionText;
  if (typeof at !== 'string' || at.length === 0) return step;
  if (/^\{\{.+\}\}$/.test(at.trim())) return step;
  const sensitive = SENSITIVE_PATTERNS.some((pat) => pat.test(at));
  if (!sensitive) return step;
  return { ...step, assertionText: MASKED_SECRET };
}

/** Text fields from bindingHints that hint at the semantic role of a value. */
function bindingHintBits(step: MobileIntentStep): string[] {
  const out: string[] = [];
  const hints = step.bindingHints as Record<string, unknown> | undefined;
  if (hints) {
    for (const k of ['role', 'label', 'placeholder', 'nearText', 'type', 'autocomplete']) {
      const v = hints[k];
      if (typeof v === 'string') out.push(v);
    }
  }
  return out;
}

/**
 * Generate a stable parameter name. Falls back to step id, then to a
 * monotonic counter. Avoids collisions by appending a numeric suffix.
 */
function makeParamName(
  step: MobileIntentStep,
  existing: Record<string, unknown>,
): string {
  const slug =
    slugify(step.description) ||
    slugify(step.id) ||
    `field_${Object.keys(existing).length + 1}`;
  let candidate = `param_${slug}`;
  let counter = 2;
  while (candidate in existing) {
    candidate = `param_${slug}_${counter++}`;
  }
  return candidate;
}

/**
 * Lowercase → `_`-joined alnum slug, trimmed of edge underscores. Shared by
 * the param-name generator here and the mobile-agent `extract_text` variable
 * name builder (tools.ts) so the two don't drift. `maxLen` defaults to 32.
 */
export function slugify(s: string | undefined, maxLen = 32): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}
