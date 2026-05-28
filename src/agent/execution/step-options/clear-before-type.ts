/**
 * Step-options helper: clear-and-type (intent `type` action).
 *
 * Extracted from CommandExecutor to keep step.options.* forwarding logic
 * out of the 5k+ line monolith. Honours two fields:
 *
 * - `replaceContent === true` → clear the field before typing
 *   (click+focus, then fill('')). Default (undefined) preserves the
 *   pre-existing executor behaviour of NOT clearing.
 * - `keyPressDelay` (ms) → forwarded to pressSequentially({ delay }).
 *
 * Behaviour and Playwright call sequence are bit-for-bit identical to
 * the inline block that previously lived around command-executor.ts:768.
 */
import type { Locator } from 'playwright';

export interface ClearBeforeTypeOptions {
  /** Honoured value of `intentMeta.replaceContent`. */
  replaceContent?: boolean;
  /** Honoured value of `intentMeta.keyPressDelay`. */
  keyPressDelay?: number;
}

/**
 * Execute the user-toggle-aware intent `type` path:
 *   - Optionally clear (focus + fill(''))
 *   - Then pressSequentially with optional per-keystroke delay.
 *
 * @param locator   Resolved Playwright locator for the field.
 * @param value     Text to type (already stringified upstream).
 * @param timeout   Step timeout in ms (typically 30000).
 * @param options   Forwarded step.options values from intentMeta.
 */
export async function typeWithOptionalClear(
  locator: Locator,
  value: string,
  timeout: number,
  options: ClearBeforeTypeOptions,
): Promise<void> {
  // Honour the user's "Clear field before typing" toggle.
  // Default (undefined) → DO NOT clear, preserving today's
  // web-regression executor behaviour (plain pressSequentially,
  // no fill('') call). Only explicit `replaceContent === true`
  // opts into clearing. This is intentionally stricter than
  // preview's `!== false` form: the executor historically
  // never cleared by default, so silently flipping that for
  // every old saved step would be a regression.
  if (options.replaceContent === true) {
    // Focus the field first — preview's append branch does
    // this (preview-step-apply.service.ts:2565). Unfocused
    // fills can silently no-op on contenteditable / custom
    // widgets. Best-effort: ignore click failures since the
    // following fill/type will still surface a real error.
    await locator.click({ timeout }).catch(() => {});
    await locator.fill('', { timeout }).catch(() => {});
  }
  // Per-keystroke delay: honour `step.options.keyPressDelay`
  // when set. Mirrors preview-step-apply.service.ts:2566/2571.
  // Undefined → no delay option → Playwright default (matches
  // today's web regression behaviour).
  const userKeyDelay = options.keyPressDelay;
  const typeOpts: { timeout: number; delay?: number } = { timeout };
  if (Number.isFinite(userKeyDelay) && (userKeyDelay as number) >= 0) {
    typeOpts.delay = userKeyDelay;
  }
  // Use pressSequentially to simulate real keyboard events character by character
  await locator.pressSequentially(value, typeOpts);
}
