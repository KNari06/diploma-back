/**
 * Step-options helper: append/replace fill (intent `fill` action).
 *
 * Extracted from CommandExecutor to keep step.options.* forwarding logic
 * out of the monolith. Honours `replaceContent`:
 *
 * - `replaceContent === false` → read current value, then fill with
 *   `existing + value` (append semantics).
 * - Default (undefined/true) → plain fill(value), which Playwright treats
 *   as a replace.
 *
 * Behaviour and Playwright call sequence are bit-for-bit identical to
 * the inline block that previously lived around command-executor.ts:1661.
 */
import type { Locator } from 'playwright';

/**
 * Execute the user-toggle-aware intent `fill` path.
 *
 * @param locator         Resolved Playwright locator for the field.
 * @param value           Text to fill (already stringified upstream).
 * @param timeout         Step timeout in ms (typically 30000).
 * @param replaceContent  Honoured value of `intentMeta.replaceContent`.
 */
export async function fillWithOptionalAppend(
  locator: Locator,
  value: string,
  timeout: number,
  replaceContent: boolean | undefined,
): Promise<void> {
  // Honour "Clear field before typing": when replaceContent === false,
  // append by reading current value and concatenating. Default (undefined/true)
  // uses fill() which inherently replaces.
  if (replaceContent === false) {
    const existing = await locator.inputValue({ timeout }).catch(() => '');
    await locator.fill(`${existing}${value}`, { timeout, noWaitAfter: true });
  } else {
    // V15.5: noWaitAfter skips post-action stability wait
    await locator.fill(value, { timeout, noWaitAfter: true });
  }
}
