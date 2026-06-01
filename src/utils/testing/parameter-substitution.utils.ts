import { logger } from '@/utils/core/logger';

/**
 * Substitute plan parameters into a string.
 *
 * Accepts BOTH placeholder syntaxes in one pass:
 *   - `{{paramName}}` — the canonical web syntax (what CreateRegressionDialog
 *     and the Playwright agent have always used).
 *   - `${paramName}`  — the mobile/runtime-style syntax. The mobile RUNNER
 *     uses `${key}` for its per-session scratchpad (OTP, clipboard,
 *     see qait-mobile-runner src/runner/scratchpad.ts), so users who
 *     authored mobile step values intuitively wrote `${email}`. We
 *     substitute those HERE at dispatch time — BEFORE the runner gets
 *     the step — so plan-level parameters win over scratchpad, which is
 *     what a regression user expects. Scratchpad-only keys (e.g.
 *     `${otp_code}` captured at runtime) aren't in `parameters`, so
 *     the placeholder is left intact and the runner resolves it later.
 *
 * Unknown keys are left as-is (a warning is logged once per key) so a
 * typo is visible in the step rather than silently blanked out.
 */
export function substituteParamsInString(
  input: string,
  parameters: Record<string, any>,
): string {
  // Single regex matches both {{name}} and ${name}. Capture group 1
  // is the {{…}} body; group 2 is the ${…} body. Exactly one fires
  // per match.
  const PLACEHOLDER_RE = /\{\{([\w.]+)\}\}|\$\{([\w.]+)\}/g;
  return input.replace(PLACEHOLDER_RE, (match, doubleBrace?: string, dollar?: string) => {
    const name = doubleBrace ?? dollar;
    if (!name) return match;
    if (Object.prototype.hasOwnProperty.call(parameters, name)
      && parameters[name] !== undefined
      && parameters[name] !== null) {
      return String(parameters[name]);
    }
    // Only warn for {{name}} — ${name} may be legitimately runtime-only
    // (OTP, clipboard) and handled by the runner's scratchpad.
    if (doubleBrace) {
      logger.warn('[REGRESSION_RUN] Missing parameter', { paramName: name });
    }
    return match;
  });
}

/**
 * Deep-apply plan parameters to an arbitrary command/step tree.
 *
 * Walks every string leaf in every item and runs `substituteParamsInString`
 * against it. Arrays and nested objects are traversed recursively so
 * placeholders in `options.biometricAction`, `bindingHints.label`, or
 * `metadata.scenarioName` all get the same treatment. Non-string
 * values (numbers, booleans, dates) are passed through untouched.
 *
 * Used by both paths:
 *   - web `buildTestRequest` (PlaywrightCommand[])
 *   - mobile `dispatchMobileTest` (IntentStep[])
 *
 * The previous implementation only touched top-level `item.value`, which
 * meant a placeholder in `options.value`, `assertionText`, or a nested
 * `bindingHints.label` was passed to the runner as a literal string.
 * Replaying with plan parameters was silently broken for anything but the
 * simplest `type` step — fixed here.
 *
 * @param items      Step/command objects to substitute through.
 * @param parameters Runtime parameter values, keyed by placeholder name.
 */
export function applyParameters(
  items: any[],
  parameters: Record<string, any>,
): any[] {
  if (!parameters || Object.keys(parameters).length === 0) {
    return items;
  }

  const walk = (node: any): any => {
    if (node == null) return node;
    if (typeof node === 'string') {
      return substituteParamsInString(node, parameters);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === 'object') {
      const out: Record<string, any> = {};
      for (const key of Object.keys(node)) {
        out[key] = walk(node[key]);
      }
      return out;
    }
    return node; // number, boolean, bigint, symbol — untouched
  };

  return items.map((item) => walk(item));
}
