/**
 * Mobile-step sanitizer — credentials replacement for `intent_test_cases.steps_json`.
 *
 * Why this exists:
 *   `RegressionSaveService.sanitizeCommands()` (web) sanitises Playwright
 *   `commands` payloads. It looks at `selector` + `description` + `label` —
 *   web-only fields. Mobile steps don't have any of those; they have
 *   `description` plus targeting via `bindingHints` and `value`.
 *
 *   Enforcement point: `RegressionSaveService.saveFromRecording()` calls this
 *   function on every mobile save, so the sanitisation is guaranteed at the
 *   persistence boundary — a caller that forgets to sanitise cannot persist
 *   plaintext credentials. Callers MAY also sanitise earlier (e.g. before
 *   echoing steps back to the user); the function is idempotent, so a second
 *   pass is a no-op.
 *
 * Detection signals, in priority order:
 *   1. `step.isSensitive === true` — the explicit flag the mobile agent sets
 *      when it typed a credential (`type_text` tool / draft-step authoring).
 *      Always wins; no regex needed.
 *   2. Regex catalogue over the step's descriptive context (`description` +
 *      `bindingHints` text fields). Fallback for steps that lost the flag or
 *      were authored elsewhere. Patterns are deliberately narrow — a bare
 *      "key" or "auth" would false-positive on "press key" / "OAuth screen"
 *      and parameterize values that aren't secrets.
 *
 * Output shape:
 *   - Each detected sensitive value becomes `{{param_<name>}}`.
 *   - A parametersSchema map is returned alongside, ready to be persisted on
 *     `intent_test_cases.parameters_schema`.
 *   - Step shape is otherwise preserved verbatim — we only mutate `value`
 *     when a signal fires.
 */

import type { MobileIntentStep } from '@/services/mobile/mobile-runner.types';

const SENSITIVE_PATTERNS: RegExp[] = [
  /pass[\s_-]?(word|code|phrase|key)/i, // password, passcode, passphrase, passkey
  /\btoken\b/i,
  /\bsecret\b/i,
  /\bapi[\s_-]?key\b/i,
  /credential/i,
  /\bpin([\s_-]?code)?\b/i,
  /\botp\b/i,
  /one[\s_-]?time[\s_-]?(password|passcode|code|pin)/i,
  /\bcvv\b|\bcvc\b/i,
  // "auth" only in a compound that names a credential artifact — a bare
  // /auth/ would match "Authorize button" / "OAuth login screen".
  /\bauth(entication|orization)?[\s_-]?(code|token|key|header)\b/i,
  // Chat descriptions are multilingual (en/ru/kk) — cover the anchor words.
  /парол/i, // ru: пароль / пароля / паролем
  /құпия/i, // kk: құпия сөз (password / secret)
];

/**
 * Minimum shape the sanitizer needs. `MobileIntentStep` satisfies it, and so
 * does the generic `IntentStep` the save service works with — the generic
 * signature lets `RegressionSaveService` sanitise without a type cast.
 */
export interface SanitizableStep {
  id: string;
  description?: string;
  value?: unknown;
  bindingHints?: unknown;
  /** Explicit authoring-time flag: this step's value is a credential. */
  isSensitive?: boolean;
}

export interface SanitizedMobileResult<T extends SanitizableStep = MobileIntentStep> {
  steps: T[];
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
export function sanitizeMobileSteps<T extends SanitizableStep>(
  steps: T[],
): SanitizedMobileResult<T> {
  const parametersSchema: SanitizedMobileResult<T>['parametersSchema'] = {};

  const sanitized = steps.map<T>((step) => {
    const value = step.value;
    if (typeof value !== 'string' || value.length === 0) return step;

    // Already a placeholder — don't re-substitute. Defensive against
    // double-sanitisation when callers run this on already-sanitised JSON.
    // We compare the trimmed string but persist the trimmed version so a
    // later double-pass also matches (avoids leak through whitespace drift).
    const trimmed = value.trim();
    if (/^\{\{.+\}\}$/.test(trimmed)) {
      // Re-register `param_*` placeholders into the schema so a caller that
      // sanitised BEFORE the save boundary still gets a complete
      // `parameters_schema` persisted (the schema is derived here, at the
      // boundary — a pre-sanitised pass would otherwise persist null).
      // Other namespaces ({{secrets.*}}, {{env.*}}, {{extracted.*}}) are
      // NOT parameters and stay out of the schema.
      const paramMatch = /^\{\{(param_[a-zA-Z0-9_]+)\}\}$/.exec(trimmed);
      if (paramMatch && !(paramMatch[1] in parametersSchema)) {
        parametersSchema[paramMatch[1]] = {
          type: 'string',
          description: `Value for ${step.description || step.id}`,
          required: true,
          sensitive: true,
        };
      }
      // Persist the trimmed form so the next pass remains idempotent even
      // if upstream re-introduced whitespace.
      return value === trimmed ? step : { ...step, value: trimmed };
    }

    // Primary signal: the agent flagged the step at authoring time.
    let sensitive = step.isSensitive === true;

    if (!sensitive) {
      // Fallback: regex over the descriptive context. `description` is the
      // LLM's intent ("Type password into login field"). The
      // MobileBindingHints fields listed below carry recorded targeting
      // metadata. Keys are aligned with the actual MobileBindingHints
      // interface (mobile-runner.types.ts): role, label, placeholder,
      // nearText, type, autocomplete. We do NOT inspect `value` itself —
      // the regex would false-positive on actual password strings just
      // because they contain "pin" by accident.
      const hintBits: string[] = [step.description ?? ''];
      const hints = step.bindingHints as Record<string, unknown> | undefined;
      if (hints) {
        for (const k of [
          'role',
          'label',
          'placeholder',
          'nearText',
          'type',
          'autocomplete',
        ]) {
          const v = hints[k];
          if (typeof v === 'string') hintBits.push(v);
        }
      }
      const context = hintBits.join(' ').trim();
      sensitive = context.length > 0
        && SENSITIVE_PATTERNS.some((pat) => pat.test(context));
    }

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

/**
 * Generate a stable parameter name. Falls back to step id, then to a
 * monotonic counter. Avoids collisions by appending a numeric suffix.
 */
function makeParamName(
  step: SanitizableStep,
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

function slugify(s: string | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}
