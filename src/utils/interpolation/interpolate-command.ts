/**
 * ═══════════════════════════════════════════════════════════════════════════
 * interpolateCommandPlaceholders — resolve `{{...}}` across every field of a
 * replay command that actually carries user data.
 *
 * Symmetry partner of `redactStepShape`: that one knows which fields must be
 * REDACTED after substitution, this one knows which fields must be SUBSTITUTED
 * in the first place. Keeping the two lists next to each other is deliberate —
 * a field that is interpolated but not redacted is a leak, and a field that is
 * redacted but not interpolated is a false-RED.
 *
 * The field set is NOT the same as `redact-step`'s, because a `PlaywrightCommand`
 * is the CONVERTED shape, not an `IntentStep`:
 *   - `value` / `url`                — direct action inputs
 *   - `assertionText`                — legacy top-level field; kept for callers
 *                                      that build a command by hand
 *   - `intentMeta.value`             — the intent-side copy the resolver reads
 *   - `intentMeta.assertionText`     — where the converter ACTUALLY puts
 *                                      `ai_check` text, and what the executor
 *                                      reads (`intent-step-converter` →
 *                                      `command-executor`). The top-level field
 *                                      above is dead for converted commands.
 *   - `assertion.expected`           — the deterministic `assert` step's
 *                                      expectation, compiled from `step.value`
 *                                      at CONVERSION time, so substituting
 *                                      `value` alone never reaches it.
 *
 * `selector` / `elementDescription` are intentionally excluded — see Hard
 * invariant #9.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { resolvePlaceholders, type VariableSource } from './resolve-placeholders';

/**
 * Mutates `command` in place (matching the replay loop's existing style) and
 * returns it. A non-string field is left untouched, so this is safe to call on
 * any command shape in the discriminated union.
 */
export function interpolateCommandPlaceholders<T extends object>(
  command: T,
  sources: VariableSource[],
): T {
  const cmd = command as unknown as Record<string, any>;

  if (typeof cmd.value === 'string') cmd.value = resolvePlaceholders(cmd.value, sources);
  if (typeof cmd.url === 'string') cmd.url = resolvePlaceholders(cmd.url, sources);
  if (typeof cmd.assertionText === 'string') {
    cmd.assertionText = resolvePlaceholders(cmd.assertionText, sources);
  }

  if (cmd.intentMeta && typeof cmd.intentMeta === 'object') {
    if (typeof cmd.intentMeta.value === 'string') {
      cmd.intentMeta.value = resolvePlaceholders(cmd.intentMeta.value, sources);
    }
    if (typeof cmd.intentMeta.assertionText === 'string') {
      cmd.intentMeta.assertionText = resolvePlaceholders(cmd.intentMeta.assertionText, sources);
    }
  }

  if (cmd.assertion && typeof cmd.assertion === 'object') {
    if (typeof cmd.assertion.expected === 'string') {
      cmd.assertion.expected = resolvePlaceholders(cmd.assertion.expected, sources);
    }
  }

  return command;
}
