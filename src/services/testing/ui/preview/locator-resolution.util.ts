/**
 * Locator Resolution Util
 *
 * Single source of truth for converting LocatorEntry → Playwright Locator.
 * Used by:
 *   - compiled-locator-executor (replay-time: try plan locators against live page)
 *   - locator-plan-builder (build-time: validate uniqueness via count() before
 *     persisting the plan)
 *
 * Symmetry guarantee: anything the executor can resolve, the builder can
 * validate; anything the builder validates, the executor can resolve. One
 * function, one codepath, no drift.
 */

import { Frame, Locator, Page } from 'playwright';
import type { LocatorEntry } from './preview.types';

export type PageLike = Page | Frame;

/**
 * Convert a LocatorEntry into a Playwright Locator.
 *
 * Returns null only for unknown strategies (forward-compatible — older plans
 * may carry strategy strings introduced after this util's last update).
 *
 * @param page  Playwright Page (or Frame for iframe contexts).
 * @param entry The compiled-plan entry: strategy + value (+ optional roleName).
 * @param scope Optional scope to resolve within (used by landmark prefilter
 *              in the executor). Defaults to page.
 */
export function buildStrategyLocator(
  page: PageLike,
  entry: LocatorEntry,
  scope: Locator | PageLike = page,
): Locator | null {
  switch (entry.strategy) {
    case 'ref':
    case 'css':
      return scope.locator(entry.value);
    case 'role':
      return entry.roleName
        ? scope.getByRole(entry.roleName as any, { name: entry.value })
        : scope.locator(entry.value);
    case 'label':
      return scope.getByLabel(entry.value);
    case 'testId':
      return scope.getByTestId(entry.value);
    case 'placeholder':
      return scope.getByPlaceholder(entry.value);
    case 'title':
      return scope.getByTitle(entry.value);
    case 'text':
      return scope.getByText(entry.value, { exact: false });
    default:
      return null;
  }
}

/**
 * Count matches with a hard timeout. Returns:
 *   ≥ 0  — actual count (page returned in time)
 *   -1   — timeout fired before count() resolved
 *   0    — any throw (invalid selector, page navigating, frame detached, ...)
 *
 * The -1 vs 0 distinction lets the caller decide whether to retry or treat
 * the locator as dead. validateOnPage in the builder treats both as
 * "not validated" but logs them differently for diagnostics.
 */
export async function safeCountWithTimeout(
  locator: Locator,
  timeoutMs: number = 200,
): Promise<number> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      locator.count(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => resolve(-1), timeoutMs);
      }),
    ]);
  } catch {
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
