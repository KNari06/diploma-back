/**
 * Type-action helpers — clear / verify / retry for the `type` action.
 *
 * Extracted from `preview-step-apply.service.ts` (review feedback on MR !146):
 * the masked-input "verified clear + typed-value verify" logic is a cohesive,
 * pure-ish concern that does not need the 7k-line service around it. Keeping it
 * here makes the control-flow unit-testable in isolation and lets the
 * saved-test executor reuse the SAME logic later (see CLAUDE.md follow-ups)
 * instead of re-deriving raw `fill('') + pressSequentially`.
 *
 * All four exports are fail-open: an unreadable field (contenteditable / custom
 * widget) degrades to the old single `fill('')` / no-op behaviour rather than
 * throwing into the apply path.
 */

import type { Locator, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { redactWithValues } from '@/utils/interpolation/redact-secrets';

/** Trim a redacted value to a bounded log length. Redact FIRST so a secret can
 *  never survive the slice. */
function forLog(value: string, secretValues: readonly string[]): string {
  return redactWithValues(value, secretValues).slice(0, 50);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mask/format separators a field can legitimately INSERT while you type
 * (phone `+7 (702) 850-36-40`, card `4111 1111`, date `12/31/2024`,
 * money `1,000.00`). We strip these for comparison so pure reformatting is not
 * mistaken for a dropped character — but we DELIBERATELY keep other symbols
 * (`+ ! @ # $ %` …) so a dropped/added trailing special in a password is still
 * caught (Finding 5).
 */
const MASK_SEPARATORS = /[\s()[\]{}.,/\\-]+/gu;

function normalizeTypedValue(s: string): string {
  return s.replace(MASK_SEPARATORS, '').toLowerCase();
}

/**
 * Tolerant post-type verification for the `type` action.
 *
 * Masked / formatted inputs reformat the value as it is typed, so a strict
 * equality check would false-positive on every masked field. We strip mask
 * separators and compare case-insensitively: this still catches a DROPPED or
 * EXTRA character (the char-by-char masked-input bug) while ignoring pure
 * formatting differences.
 *
 * Returns true when nothing meaningful was expected (empty / whitespace-only
 * value → nothing to verify) so callers never retry on a no-op.
 */
export function typedValueLooksApplied(expected: string, actual: string): boolean {
  // Guard BEFORE normalizing: empty or whitespace-only expected = nothing to
  // verify. (Without this, a separator-only string would also fall through to
  // the raw compare below and spuriously fail.)
  if (expected.trim().length === 0) return true;

  const expectedNorm = normalizeTypedValue(expected);
  if (expectedNorm.length === 0) {
    // Separator-only expected (e.g. "---", "...") — normalization erases it, so
    // there is nothing alphanumeric to compare. Fall back to an exact (trimmed)
    // compare so a dropped/extra separator is still detected.
    return actual.trim() === expected.trim();
  }
  return normalizeTypedValue(actual) === expectedNorm;
}

/**
 * Decide whether a post-type mismatch is SAFE to repair with a full
 * `fill(value)` (Finding 1).
 *
 * `fill()` overwrites the entire field in one shot. That fixes the masked-input
 * dropped-trailing-char bug, but it WIPES a correct entry on fields where the
 * resolved locator only ever reads part of the value:
 *   - multi-box / auto-advancing OTP inputs — the box reads one segment;
 *   - `maxlength`-capped fields — the field truncates by design.
 * In both cases the read-back legitimately differs from the expected value and
 * a blind `fill()` would corrupt a working entry.
 *
 * So only retry when the mismatch matches a signature `fill()` can actually fix
 * without that risk:
 *   (a) dropped trailing char(s): the read-back is a short PREFIX of the
 *       expected value (`gap ≤ 2`) — the masked drop-last-char case. A large
 *       gap means a segmented/multi-box field, so we refuse.
 *   (b) residual prefix: the read-back ENDS WITH the full expected value but is
 *       longer (an under-cleared field now holds `<leftover>+value`). `fill()`
 *       safely replaces the whole content; an OTP box never ends with the full
 *       value, so this can't fire there.
 */
export function shouldRetryTypeWithFill(expected: string, actual: string): boolean {
  const expectedNorm = normalizeTypedValue(expected);
  const actualNorm = normalizeTypedValue(actual);
  if (expectedNorm.length === 0 || actualNorm.length === 0) return false;

  // (a) dropped trailing char(s) — small gap only.
  if (expectedNorm.startsWith(actualNorm) && expectedNorm.length - actualNorm.length <= 2) {
    return true;
  }
  // (b) residual prefix — field holds leftover + the full value.
  if (actualNorm.endsWith(expectedNorm) && actualNorm.length > expectedNorm.length) {
    return true;
  }
  return false;
}

/**
 * Clear an input before typing (used when `replaceContent !== false`).
 *
 * A single `fill('')` can silently no-op on a fast CONSECUTIVE step — the
 * element is mid-re-render right after the previous step touched it — and the
 * old `.catch(() => {})` then degraded to an APPEND: two `type` steps on the
 * same field concatenated their values instead of the second replacing the
 * first. Single-Apply doesn't hit this because the field settles between
 * manual clicks.
 *
 * So: clear, then VERIFY the field is empty. The verify SETTLE-POLLS (Finding 4)
 * — a controlled/masked input can re-commit its old value a tick after
 * `fill('')`, and under contention the read itself can lag, so a single early
 * read is unreliable. We escalate to a real keyboard clear (select-all +
 * Delete) ONLY on a CONFIRMED non-empty read (Finding 6): those key events have
 * side effects (chip/tag removal, contenteditable edits), so they must never
 * fire speculatively on an unreadable / merely-laggy field. Unreadable after
 * retries → fail open (old single `fill('')` behaviour).
 */
export async function clearFieldBeforeType(
  locator: Locator,
  timeout: number,
  opts: { secretValues?: readonly string[] } = {},
): Promise<void> {
  const { secretValues = [] } = opts;

  await locator.fill('', { timeout }).catch(() => {});

  // Read the post-clear value with a short settle. Two races to defend against:
  //   (4a) a controlled/masked input re-commits its old value a tick after
  //        fill('') — a single immediate '' read would conclude "empty" and let
  //        pressSequentially append; so an empty read is re-confirmed after a beat.
  //   (4b) under contention the read itself times out (null); a single null read
  //        must NOT be taken as "unreadable → done" and skip the escalation the
  //        busy page actually needs — so a null read is retried once.
  let value = await locator.inputValue({ timeout: 750 }).catch(() => null);
  if (value === null) {
    await sleep(40);
    value = await locator.inputValue({ timeout: 750 }).catch(() => null);
    if (value === null) return; // genuinely unreadable (contenteditable / custom) → fail open
  }
  if (value === '') {
    await sleep(40);
    const recheck = await locator.inputValue({ timeout: 750 }).catch(() => null);
    if (recheck === null || recheck === '') return; // stable empty (or now unreadable) → done
    value = recheck; // re-committed its old value → escalate
  }

  // `value` is a confirmed non-empty residue — clear with a real keyboard chain
  // controlled/masked inputs honor. Reached ONLY on confirmed residue (Finding
  // 6): select-all + Delete fire real key events with side effects (chip/tag
  // removal), so they must never run speculatively on an empty/unreadable field.
  await locator.focus({ timeout }).catch(() => {});
  await locator.press('ControlOrMeta+a', { timeout }).catch(() => {});
  await locator.press('Delete', { timeout }).catch(() => {});

  const after = await locator.inputValue({ timeout: 750 }).catch(() => null);
  if (after !== null && after !== '') {
    logger.warn('[EXECUTE_ACTION] field not empty after verified clear (fill + select-all/Delete)', {
      remaining: forLog(after, secretValues),
    });
  }
}

/**
 * Verify the typed value landed and, on a SAFE mismatch, repair it once with
 * `fill()` (Findings 1, 2, 3).
 *
 * Char-by-char typing (`pressSequentially`) silently drops the trailing
 * character on masked/formatted inputs that reset the caret per keystroke
 * (observed: "+7 702 850 3640" → "+7 702 850 364", which then fails the site's
 * own validation). `pressSequentially` has no built-in check, so we read the
 * value back and, on a tolerant mismatch, retry with an atomic `fill()` the
 * mask reformats in a single pass.
 *
 * Shared by BOTH the human-like and short-text typing branches so the headline
 * masked-drop bug is covered on `humanLike: true` too (Finding 2) — slower
 * typing makes the mask race WORSE, so that path needs the verify most.
 *
 * - Settle: masked inputs reformat over a tick or two, so the read can be
 *   transiently short right after typing. Poll briefly until it stabilizes
 *   before deciding (avoids a spurious `fill()` that flickers the live preview).
 * - The `fill()` retry is GATED by `shouldRetryTypeWithFill` so it can't wipe a
 *   correct OTP / maxlength / multi-box entry (Finding 1).
 * - Logs route the value through secret redaction before truncation (Finding 3).
 * - Fail-open: an unreadable value simply skips verification.
 */
export async function verifyTypedValueAndRetry(
  page: Page,
  locator: Locator,
  value: string,
  timeout: number,
  opts: { secretValues?: readonly string[] } = {},
): Promise<void> {
  const { secretValues = [] } = opts;

  let typedBack = await locator.inputValue({ timeout: 2000 }).catch(() => null);
  for (let i = 0; i < 5 && typedBack !== null && !typedValueLooksApplied(value, typedBack); i++) {
    await page.waitForTimeout(60);
    typedBack = await locator.inputValue({ timeout: 2000 }).catch(() => null);
  }

  // Unreadable, or already correct → nothing to do.
  if (typedBack === null || typedValueLooksApplied(value, typedBack)) return;

  if (!shouldRetryTypeWithFill(value, typedBack)) {
    // Mismatch on a transforming / truncating / multi-box field (OTP,
    // maxlength, auto-advance). A full fill() would WIPE a correct distributed
    // entry, so leave the typed value in place.
    logger.debug('[EXECUTE_ACTION] type() value mismatch but fill() retry unsafe (multi-box/capped/transform) — leaving as typed', {
      expected: forLog(value, secretValues),
      actual: forLog(typedBack, secretValues),
    });
    return;
  }

  logger.info('[EXECUTE_ACTION] type() value mismatch after pressSequentially (post-settle) — retrying with fill()', {
    expected: forLog(value, secretValues),
    actual: forLog(typedBack, secretValues),
  });
  await locator.fill(value, { timeout }).catch(() => {});

  const afterFill = await locator.inputValue({ timeout: 2000 }).catch(() => null);
  if (afterFill !== null && !typedValueLooksApplied(value, afterFill)) {
    logger.warn('[EXECUTE_ACTION] type() value still mismatched after fill() retry', {
      expected: forLog(value, secretValues),
      actual: forLog(afterFill, secretValues),
    });
  }
}
