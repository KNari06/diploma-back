/**
 * ═══════════════════════════════════════════════════════════════════════════
 * New-Tab Opener
 *
 * Translates "click on a link that should open in a new tab" into a real
 * `context.newPage() + goto(href)` so the Playwright BrowserContext gains a
 * second Page and the preview session's `context.on('page', ...)` listener
 * picks it up (which in turn emits `preview:tab:opened` to the frontend).
 *
 * Why we need this — three failure modes converge on the same fix:
 *   1. `<a target="_blank">` clicked via `Playwright.locator.click()` does NOT
 *      reliably trigger a popup. Chromium *should* honour `target="_blank"`
 *      by creating a new page, but our preview launch args
 *      (`--disable-features=IsolateOrigins,site-per-process`) plus
 *      single-process/headless conditions collapse it back into the same
 *      tab on a large fraction of sites we tested (bi.group, juz40-edu.kz,
 *      etc.). Result: navigation happens inline, the active tab gets
 *      replaced, the user sees no new tab.
 *   2. `<a href="https://other.com">` WITHOUT `target` opens cross-origin
 *      inline — `external-nav-trap` then either reverts or accepts it,
 *      but the user still loses the original tab. Convention says: if a
 *      user clicks a link to a different site, that's "open in new tab"
 *      semantics in modern browsers anyway (most users middle/cmd-click).
 *   3. JS-driven `window.open(url)` DOES create a popup — Chromium's
 *      `context.on('page')` fires — but if the popup lands on about:blank
 *      and stalls, the popup handler closes it. (Out of scope for this
 *      module — handled in preview-session.attachPopupHandler.)
 *
 * Resolution strategy at click time (run BEFORE `locator.click()`):
 *   • Read the target element's tagName + href + target attribute.
 *   • If it's an `<a href>` and ANY of:
 *       (a) `target` attribute is non-empty (`_blank` / named target), OR
 *       (b) href is cross-origin relative to the current page,
 *     → open via `context.newPage(); newPage.goto(href)`.
 *     → return { opened: true, newPage } so the caller can swap its
 *       active-page reference (mirrors the existing post-click tab-switch
 *       logic in CommandExecutor at command-executor.ts:557+).
 *   • Otherwise → return { opened: false } and let the caller proceed with
 *     a normal click (same-origin inline nav, button onClick, etc.).
 *
 * What we DO NOT do:
 *   • `javascript:` / `mailto:` / `tel:` / `data:` hrefs — skipped (would
 *     fail `goto`, and they have no "new tab" semantics anyway).
 *   • In-page anchor hashes (`#foo`) — skipped, same-page jump.
 *   • Empty href — skipped, the click does something custom via JS.
 *   • Form submits / `<button onClick={window.open(...)}>` — out of scope;
 *     those go through `attachPopupHandler` which catches `context.on('page')`
 *     organically.
 *
 * Symmetry with the recorder: `recording-capture.service.ts` now captures
 * `<a target>` into `ProbedElement.linkTarget` (and bindingHints /
 * recordedFingerprint), so a replay round-trip knows the link should be a
 * new tab even on an unrecorded element. This module is the ground-truth
 * runtime check — the recorded hint is informational, not load-bearing.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BrowserContext, Locator, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { isSameApp } from './same-app.util';

const NEW_PAGE_LOAD_TIMEOUT_MS = 10_000;
const NEW_PAGE_FALLBACK_TIMEOUT_MS = 5_000;

export interface AnchorClickProbe {
  /** Tag name of the clicked element (lowercased). */
  tag: string;
  /** Resolved absolute href, when present. */
  href?: string;
  /** Raw `target` attribute value, when non-empty. */
  target?: string;
}

/**
 * Inspect a resolved Locator at click time. Returns `null` if the locator
 * is not an `<a href>` or if the read fails (we fail open — better to let
 * Playwright's normal click run than to mis-classify a button).
 *
 * The probe walks up `closest('a[href]')` so an inner `<span>` / `<img>`
 * inside an anchor still returns the anchor's href + target.
 */
export async function probeAnchorAtLocator(locator: Locator): Promise<AnchorClickProbe | null> {
  try {
    // We intentionally type the in-page DOM via `unknown` casts — the repo's
    // tsconfig does not pull in lib.dom, mirroring every other Playwright
    // probe in this folder (probeAtPoint, snapshot collector, etc.).
    const result = await locator.evaluate((el: unknown) => {
      const node = el as { tagName?: string; closest?: (sel: string) => unknown };
      const closest = typeof node.closest === 'function'
        ? (node.closest('a[href]') as { href?: string; getAttribute?: (n: string) => string | null } | null)
        : null;
      if (!closest) {
        return {
          tag: (node.tagName || '').toLowerCase(),
        };
      }
      return {
        tag: 'a',
        href: closest.href || undefined,
        target: (closest.getAttribute && closest.getAttribute('target')) || undefined,
      };
    });
    return (result as AnchorClickProbe) || null;
  } catch (err) {
    logger.debug('[NEW_TAB_OPENER] Anchor probe failed, failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Decision: should this anchor click open as a new tab instead of inline nav?
 *
 * Returns `null` when the answer is "no" and a structured reason when "yes"
 * so callers can log + telemetry.
 *
 * `currentUrl` is the page URL at click time — used for cross-origin check.
 */
export function shouldOpenAsNewTab(
  probe: AnchorClickProbe | null,
  currentUrl: string,
): { reason: 'explicit_target' | 'cross_origin_anchor'; href: string; target?: string } | null {
  if (!probe || probe.tag !== 'a' || !probe.href) return null;

  const href = probe.href;

  // Non-http(s) schemes — skip. `javascript:` mutates the current page;
  // `mailto:` / `tel:` / `data:` are handled by the existing
  // `probeExternalAnchorAt` block in `preview-session` and have no popup
  // semantics worth preserving.
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // In-page hash jump on the same document — never a new tab.
  try {
    const here = new URL(currentUrl);
    if (
      parsed.origin === here.origin &&
      parsed.pathname === here.pathname &&
      parsed.search === here.search &&
      parsed.hash
    ) {
      return null;
    }
  } catch {
    // currentUrl unparseable → fall through; we'll still honour explicit target.
  }

  // (a) Explicit `target` attribute on the anchor — always new tab. Covers
  // `_blank`, named targets, and anything else the author put there.
  // `_self` / `_top` / `_parent` are intentionally NOT new-tab triggers,
  // they're explicit in-place navigation.
  if (probe.target) {
    const t = probe.target.toLowerCase();
    if (t !== '_self' && t !== '_top' && t !== '_parent') {
      return { reason: 'explicit_target', href, target: probe.target };
    }
  }

  // (b) Cross-origin anchor without explicit target. Matches the
  // "user expects new tab" convention for clicks across sites.
  if (!isSameApp(href, currentUrl)) {
    return { reason: 'cross_origin_anchor', href };
  }

  return null;
}

/**
 * Why an anchor click was promoted to a new tab. Carried into logs and
 * (eventually) telemetry so a grep over "Opened link as new tab" gives an
 * honest breakdown of which channel fired — `_blank` attribute on the
 * anchor, cross-site link convention, or a held Cmd/Ctrl modifier.
 */
export type NewTabReason = 'explicit_target' | 'cross_origin_anchor' | 'modifier_driven' | 'programmatic';

export interface OpenNewTabResult {
  opened: true;
  newPage: Page;
  href: string;
  reason: NewTabReason;
}

/**
 * Open `href` in a new tab via `context.newPage(); newPage.goto(href)`.
 *
 * The new Page is created in the SAME BrowserContext as the source page,
 * so it inherits cookies / storage / auth state and the context-level
 * `on('page')` listener (preview-session's `attachPopupHandler`) fires
 * automatically — that listener does all the bookkeeping
 * (push to `session.pages`, swap `session.page`, restart screencast,
 * emit `preview:tab:opened`).
 *
 * If `goto` fails the new page is closed and we return null so the caller
 * can fall back to the regular click (preserving original behaviour rather
 * than dead-locking on a half-opened tab).
 */
export async function openHrefInNewTab(
  context: BrowserContext,
  href: string,
  reason: NewTabReason,
): Promise<OpenNewTabResult | null> {
  let newPage: Page | undefined;
  try {
    newPage = await context.newPage();
    // Use `commit` (URL is locked in, document creation started) instead of
    // `load` (waits for all subresources — images, fonts, iframes — can take
    // 2-5s on media-heavy pages). The tab needs to APPEAR in the user's pill
    // bar as soon as it exists; deeper loading is handled by the receiving
    // `attachPopupHandler` which does its own `domcontentloaded` wait before
    // emitting `preview:tab:opened`. Two sequential `load` waits previously
    // stacked into the visible delay between click and second tab appearing.
    //
    // If even `commit` fails (network error, bad URL), fall back to a tiny
    // `domcontentloaded` so we don't dead-lock — the page stays open either
    // way; popup-handler will decide what to do with it.
    try {
      await newPage.goto(href, { waitUntil: 'commit', timeout: NEW_PAGE_LOAD_TIMEOUT_MS });
    } catch {
      await newPage
        .waitForLoadState('domcontentloaded', { timeout: NEW_PAGE_FALLBACK_TIMEOUT_MS })
        .catch(() => {});
    }
    logger.info('[NEW_TAB_OPENER] Opened link as new tab', {
      reason,
      href,
      landingUrl: newPage.url(),
    });
    return { opened: true, newPage, href, reason };
  } catch (err) {
    logger.warn('[NEW_TAB_OPENER] Failed to open new tab, falling back to inline click', {
      reason,
      href,
      error: err instanceof Error ? err.message : String(err),
    });
    if (newPage) {
      try {
        await newPage.close().catch(() => {});
      } catch {
        /* best effort */
      }
    }
    return null;
  }
}

/**
 * Convenience: probe + decide + open in one call. Returns the result of
 * `openHrefInNewTab` (or null when the click should proceed normally).
 *
 * Callers should branch on the return: when non-null, SKIP the original
 * `locator.click()` (the navigation is already done in the new tab); when
 * null, fall through to normal click.
 */
export async function tryOpenAnchorAsNewTab(
  locator: Locator,
  context: BrowserContext,
  currentUrl: string,
): Promise<OpenNewTabResult | null> {
  const probe = await probeAnchorAtLocator(locator);
  const decision = shouldOpenAsNewTab(probe, currentUrl);
  if (!decision) return null;
  return openHrefInNewTab(context, decision.href, decision.reason);
}
