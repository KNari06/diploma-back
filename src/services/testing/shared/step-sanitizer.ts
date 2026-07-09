/**
 * Shared step sanitizer — credential replacement for `intent_test_cases.steps_json`,
 * used by BOTH the mobile and web chat-agent save paths.
 *
 * Why this exists:
 *   `RegressionSaveService.saveFromRecording()` (the entrypoint the chat agents
 *   use) does NOT sanitise. That gap means an agent that types "qwerty123" into
 *   a password field would persist the password in plaintext inside steps_json,
 *   and a regression replay would then type the literal secret.
 *
 *   Web `IntentStep` and `MobileIntentStep` are structurally compatible for the
 *   fields this touches — `value`, `description`, `bindingHints`, `assertionText`,
 *   `options` — so ONE sanitizer serves both. It operates on the minimal
 *   `SanitizableStep` shape and preserves the concrete step type via a generic,
 *   so callers get their own type back unchanged (modulo the redactions).
 *
 * Output:
 *   - Each detected sensitive `value` becomes `{{param_<name>}}`, and a
 *     `parametersSchema` map is returned for persistence to
 *     `intent_test_cases.parameters_schema`.
 *   - `assertionText` is redacted when the assertion string itself looks
 *     sensitive; always-secret option fields (`totpSecret`, `otpCode`) are
 *     masked unconditionally. Step shape is otherwise preserved verbatim
 *     (backend invariant #10 — a new persist/emit sink must redact secrets).
 */

/**
 * Minimal structural shape the sanitizer reads. Concrete step types
 * (IntentStep, MobileIntentStep) are structurally compatible — the generic
 * bound below is deliberately loose (no index signature) so those types
 * satisfy it without one.
 */
export interface SanitizableStep {
  id?: string;
  value?: unknown;
  description?: unknown;
  assertionText?: unknown;
  bindingHints?: unknown;
  options?: unknown;
}

export interface StepParametersSchema {
  [param: string]: {
    type: 'string';
    description: string;
    required: true;
    sensitive: true;
  };
}

export interface SanitizedStepsResult<T> {
  steps: T[];
  parametersSchema: StepParametersSchema;
}

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

// Option fields that are ALWAYS a secret when present — a TOTP shared seed and
// a one-time code. Masked unconditionally (no keyword gate): there is no
// legitimate reason to persist or ship these in cleartext.
export const SECRET_OPTION_FIELDS = ['totpSecret', 'otpCode'] as const;
const MASKED_SECRET = '{{param_secret}}';

/**
 * Returns a copy of `steps` with sensitive `value` strings replaced by
 * `{{param_<name>}}` placeholders + the parametersSchema to persist. Generic in
 * the step type — the input type is preserved. Idempotent: an already-templated
 * value is left alone.
 */
export function sanitizeSteps<T extends SanitizableStep>(steps: T[]): SanitizedStepsResult<T> {
  const parametersSchema: StepParametersSchema = {};

  const sanitized = steps.map<T>((rawStep) => {
    // Mask always-secret option fields + a sensitive assertionText first, then
    // fall through to value-parameterisation. `step` carries those masks forward
    // so a step with BOTH a sensitive value and a secret option is fully cleaned.
    let step = maskSecretOptionFields(rawStep);
    step = maskSensitiveAssertionText(step);

    const value = step.value;
    if (typeof value !== 'string' || value.length === 0) return step;

    // Already a placeholder — skip (defends against double-sanitisation).
    const trimmed = value.trim();
    if (/^\{\{.+\}\}$/.test(trimmed)) {
      return value === trimmed ? step : ({ ...step, value: trimmed } as T);
    }

    // Build the match context from fields that hint at the value's role. We do
    // NOT inspect `value` itself (would false-positive on a password containing
    // "key" by accident).
    const desc = typeof step.description === 'string' ? step.description : '';
    const context = [desc, ...bindingHintBits(step)].join(' ').trim();
    if (!context) return step;

    if (!SENSITIVE_PATTERNS.some((pat) => pat.test(context))) return step;

    const paramName = makeParamName(step, parametersSchema);
    parametersSchema[paramName] = {
      type: 'string',
      description: `Value for ${desc || step.id || paramName}`,
      required: true,
      sensitive: true,
    };
    return { ...step, value: `{{${paramName}}}` } as T;
  });

  return { steps: sanitized, parametersSchema };
}

function maskSecretOptionFields<T extends SanitizableStep>(step: T): T {
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
  return changed ? ({ ...step, options: next } as T) : step;
}

/**
 * Mask a sensitive `assertionText` — scanning the assertion string ITSELF (not
 * the description, which describes the value; keying off it would wrongly mask
 * a benign assertion on a password step). A secret quoted in the assertion must
 * not persist. Masks to a placeholder (an assertion is not a replay input).
 */
function maskSensitiveAssertionText<T extends SanitizableStep>(step: T): T {
  const at = step.assertionText;
  if (typeof at !== 'string' || at.length === 0) return step;
  if (/^\{\{.+\}\}$/.test(at.trim())) return step;
  if (!SENSITIVE_PATTERNS.some((pat) => pat.test(at))) return step;
  return { ...step, assertionText: MASKED_SECRET } as T;
}

/** Text fields from bindingHints that hint at the semantic role of a value. */
function bindingHintBits(step: SanitizableStep): string[] {
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

/** Stable param name from description → id → counter, collision-safe. */
function makeParamName(step: SanitizableStep, existing: Record<string, unknown>): string {
  const slug =
    slugify(typeof step.description === 'string' ? step.description : undefined) ||
    slugify(typeof step.id === 'string' ? step.id : undefined) ||
    `field_${Object.keys(existing).length + 1}`;
  let candidate = `param_${slug}`;
  let counter = 2;
  while (candidate in existing) candidate = `param_${slug}_${counter++}`;
  return candidate;
}

/**
 * Lowercase → `_`-joined alnum slug, trimmed of edge underscores. `maxLen`
 * defaults to 32. Shared with the mobile-agent `extract_text` variable-name
 * builder so the two don't drift.
 */
export function slugify(s: string | undefined, maxLen = 32): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}
