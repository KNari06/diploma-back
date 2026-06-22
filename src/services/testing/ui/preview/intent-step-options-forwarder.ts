/**
 * Step-options → IntentPlaywrightCommand forwarder.
 *
 * Extracted from `convertIntentStepToCommand` to keep the per-field
 * forwarding logic (5 new fields plus the cssSelector special case)
 * out of the converter's body. Behaviour is bit-for-bit identical to
 * the inline blocks that previously lived in intent-step-converter.service.ts.
 *
 * Field family documented here so both the converter and CommandExecutor
 * can refer back to one source of truth:
 *
 *  - `replaceContent`             → only set for `type` steps when defined
 *  - `keyPressDelay`              → only set for `type` steps when finite & ≥ 0
 *  - `cssSelectorOverride`        → set whenever `step.options.cssSelector`
 *                                   is a non-empty trimmed string; also
 *                                   overrides `command.selector`
 *  - `disableStabilityChecks`     → set only when === true
 *  - `disableCaching`             → set only when === true
 *
 * Mutates `command` in place. Caller invokes this exactly once, AFTER the
 * initial command (with primarySelector / base intentMeta) has been built.
 */
import type { IntentStep } from './preview.types';
import type { IntentPlaywrightCommand } from './intent-step-converter.service';

export function applyStepOptionsToCommand(
  step: IntentStep,
  command: IntentPlaywrightCommand,
): void {
  const opts = step.options;
  if (!opts) return;
  // `command.intentMeta` is always defined for intent commands by the time
  // the converter calls us, but each per-field block below guards on it
  // anyway so the type system is satisfied and a future refactor that
  // routes a non-intent command through here doesn't crash.

  // Stability / caching toggles — mirror preview-step-apply.service.ts:2451
  // (stability) and intent-step-lint.service.ts:1227 (caching). Only set
  // when explicitly true so the executor's "undefined === default" branch
  // is preserved for steps saved before these toggles existed.
  if (command.intentMeta && opts?.disableStabilityChecks === true) {
    command.intentMeta.disableStabilityChecks = true;
  }
  if (command.intentMeta && opts?.disableCaching === true) {
    command.intentMeta.disableCaching = true;
  }

  // Manual CSS selector override: when the user pins a raw CSS selector via
  // step.options.cssSelector, route it through command.selector AND flag
  // intentMeta.cssSelectorOverride so the executor can distinguish a
  // user-pinned selector from one derived from the compiled plan. Mirrors
  // preview-step-apply.service.ts:2093 — preview uses this raw CSS instead
  // of the resolver waterfall.
  const pinnedCss = typeof opts?.cssSelector === 'string'
    ? opts.cssSelector.trim()
    : '';
  if (pinnedCss.length > 0) {
    command.selector = pinnedCss;
    if (command.intentMeta) {
      command.intentMeta.cssSelectorOverride = pinnedCss;
    }
  }

  // Per-action: type-specific toggles. Both fields only make sense for
  // the intent `type` path. We gate on step.type to keep intentMeta clean
  // for other actions.
  if (step.type === 'type' && command.intentMeta) {
    // Pass replaceContent flag so the executor honours the user's
    // "Clear field before typing" toggle. Only forward when explicitly
    // set — undefined keeps the default (clear), matching preview.
    if (opts?.replaceContent !== undefined) {
      command.intentMeta.replaceContent = opts.replaceContent;
    }
    // Forward per-keystroke delay to the executor's intent type path.
    // Mirrors preview-step-apply.service.ts:2566/2571 — the value is
    // passed to pressSequentially({ delay }). Negative / non-finite
    // values are dropped so the executor falls back to Playwright's
    // default (no delay), same as preview's "unset" branch.
    if (
      Number.isFinite(opts?.keyPressDelay) &&
      (opts!.keyPressDelay as number) >= 0
    ) {
      command.intentMeta.keyPressDelay = opts!.keyPressDelay;
    }
  }
}
