/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Preview Auth Detector
 *
 * Watches a preview Page for "we're on a login gate" signals and emits
 * `preview:auth:required` to the preview session room when they fire.
 * Client uses the event to show a Login chooser overlay.
 *
 * Design:
 *   - One listener per page (attach is idempotent via WeakSet).
 *   - Two orthogonal signals:
 *       1) URL matches /login|/signin|/auth|/sso — cheap, fires on every
 *          `framenavigated` for the MAIN frame only.
 *       2) A password input appeared — DOM probe after load settle.
 *     Either alone = emit once with signal='url' or 'form'. Both = 'both'
 *     (highest confidence — downgrades false positives).
 *   - Dedup: emit at most once per (sessionId, pathname) so repeated
 *     navigations within the login flow don't spam the client.
 *
 * What we DO NOT do here:
 *   - Actually apply or record a login — that's the preview controller's
 *     job (separate handlers react to this event).
 *   - Detect logout post-session — out of scope for the recorder.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { Page, Frame } from 'playwright';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';

const LOGIN_URL_RE = /\/(login|signin|sign[-_]?in|auth|oauth|sso)(\/|$|\?)/i;

/** Pages we've already attached to (prevents double-subscribe on reuse). */
const attached = new WeakSet<Page>();

/** Keyed set of (sessionId, pathname) combos already emitted. */
const emitted = new Map<string, Set<string>>();

function extractHostname(raw: string): string | undefined {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function extractPathname(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

function alreadyEmitted(sessionId: string, url: string): boolean {
  const key = extractPathname(url);
  const set = emitted.get(sessionId);
  if (!set) return false;
  return set.has(key);
}

function markEmitted(sessionId: string, url: string): void {
  const key = extractPathname(url);
  const set = emitted.get(sessionId) ?? new Set<string>();
  set.add(key);
  emitted.set(sessionId, set);
}

/** Called when the session ends — free the dedup set. */
export function clearAuthDetectorSession(sessionId: string): void {
  emitted.delete(sessionId);
}

/**
 * Probe the DOM for a visible password input. Short timeout — we want a
 * best-effort answer, not a blocking wait.
 */
async function hasVisiblePasswordInput(page: Page): Promise<boolean> {
  // Bound the DOM probe — if the page is slow to respond we'd rather
  // miss this detection than block the detector loop. 500ms is plenty
  // for a synchronous querySelector in Chromium.
  try {
    const raced = await Promise.race([
      page
        .locator('input[type="password"]:visible')
        .first()
        .count(),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 500)),
    ]);
    return raced > 0;
  } catch {
    return false;
  }
}

/**
 * Attach the detector to a preview page. Safe to call repeatedly — the
 * WeakSet guard makes extra calls a no-op. Does NOT take ownership of
 * other page.on listeners (we only add, never remove others).
 */
export function attachAuthDetector(page: Page, sessionId: string): void {
  if (attached.has(page)) return;
  attached.add(page);

  const maybeEmit = async (url: string, trigger: 'nav' | 'post-load'): Promise<void> => {
    if (!url || alreadyEmitted(sessionId, url)) return;

    const urlMatches = LOGIN_URL_RE.test(url);

    // For URL-triggered checks we fire immediately (fast path). For
    // post-load checks we need the password probe to decide.
    let signal: 'url' | 'form' | 'both' | null = null;
    if (trigger === 'nav' && urlMatches) {
      signal = 'url';
    } else if (trigger === 'post-load') {
      const hasPwd = await hasVisiblePasswordInput(page);
      if (urlMatches && hasPwd) signal = 'both';
      else if (hasPwd) signal = 'form';
      else if (urlMatches) signal = 'url';
    }

    if (!signal) return;

    markEmitted(sessionId, url);
    try {
      webSocketService.emitToRoom('preview', sessionId, 'preview:auth:required', {
        previewSessionId: sessionId,
        signal,
        url,
        suggestedDomain: extractHostname(url),
        timestamp: new Date().toISOString(),
      });
      logger.info('[PREVIEW_AUTH_DETECTOR] Login gate detected', {
        sessionId,
        signal,
        url: extractPathname(url),
      });
    } catch (err) {
      logger.warn('[PREVIEW_AUTH_DETECTOR] Emit failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Main-frame navigations only — subresource iframes (ads, analytics)
  // can carry auth paths that don't concern the user.
  page.on('framenavigated', async (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === 'about:blank') return;
    await maybeEmit(url, 'nav');
  });

  // After each settled load, re-check with the DOM probe. `load` fires
  // reliably and once per navigation, whereas `domcontentloaded` can
  // race the password input being added by client-side JS.
  page.on('load', async () => {
    try {
      const url = page.url();
      if (!url || url === 'about:blank') return;
      await maybeEmit(url, 'post-load');
    } catch {
      /* page may be closing */
    }
  });

  // Cleanup dedup on close so a session reuse doesn't miss events.
  page.once('close', () => {
    clearAuthDetectorSession(sessionId);
  });
}
