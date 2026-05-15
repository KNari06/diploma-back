/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Preview Auth Detector (v3 — score-based, spam-suppressed)
 *
 * Watches a preview Page for "we're on a login gate" signals and emits
 * `preview:auth:required` to the preview session room when a confidence
 * threshold is crossed. The client uses the event to show the Login
 * chooser overlay.
 *
 * Why score-based?
 *   v1 was boolean OR: any URL regex match OR a password input fired the
 *   overlay. Result: `/login-help` triggered it (false positive), and
 *   modern forms using `<input type="text" autocomplete="current-password">`
 *   missed it entirely (false negative). v2 combined signals with weights
 *   and a threshold so edge cases wash out instead of triggering spam.
 *   v3 added three high-value cheap signals (HTTP 401/403, form action,
 *   multi-step memory) plus opt-in iframe detection and a two-positive
 *   minimum to keep landing-page demos quiet.
 *
 * Suppression rules — the overlay shows AT MOST ONCE PER HOSTNAME per
 * session, except when one of these legitimate reasons forces a re-show:
 *   1) User switched to a different hostname (multi-domain app).
 *   2) User previously dismissed for this hostname but 30 minutes passed.
 *   3) A just-applied login broke (handled externally — apply handler
 *      resets the dedup for that hostname so the overlay re-fires with
 *      a "login expired" hint).
 *
 * Hard suppressions (no emit regardless of score):
 *   • Recording is active — user is mid-login, don't prompt them.
 *   • Apply cooldown (10s after apply:resource) — page is reloading.
 *   • Global rate-limit: at most 1 emit per 10s per session — closes any
 *     corner case with redirect chains we didn't predict.
 *   • Within-hostname dedup — already emitted for this hostname, skip.
 *   • User-dismissed for this hostname — skip until dismissal expires.
 *   • OAuth in-flight — after an OAuth external domain fires, the return
 *     to the origin domain is silent (user just finished logging in).
 *
 * Signal weights (sum ≥ THRESHOLD fires the overlay):
 *   +0.60  visible password input (incl. Shadow DOM + autocomplete="current-password")
 *   +0.55  OAuth allowlist match  → signal='external_oauth'
 *   +0.45  recent main-frame 401/403 response (within last 5s)
 *   +0.30  login URL regex (word-anchored; excludes /help, /status, /docs, ...)
 *   +0.25  workspace custom url_pattern from workspace_resource_defaults
 *   +0.25  <form action="…/login…"> or <button formaction="…/login…">
 *   +0.20  form with autocomplete="username" + submit button
 *   +0.20  multi-step boost — password page reached < 30s after an email-only
 *          submit on the same host (Google-style flow) → signal='multistep'
 *   −0.30  URL contains /help, /about, /status, /faq, /docs, /terms, /privacy,
 *          /history, /log (gerund: logs, logging) → kills `/login-help` etc.
 *   −0.20  page has zero <input> elements (landing pages with "Log in" links)
 *
 * Two-positive minimum (v3): unless a strong signal fires (oauth-host or
 * http-unauthorized), at least TWO positive triggers must be present. A
 * single password field on a marketing landing won't fire the overlay.
 *
 * THRESHOLD = 0.55 — empirically enough to require either a real password
 * field OR a URL match + a supporting signal.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { Page, Frame } from 'playwright';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';

// ── Tunables ───────────────────────────────────────────────────────────────
const THRESHOLD = 0.55;
const DOM_PROBE_TIMEOUT_MS = 500;
const RATE_LIMIT_MS = 10_000;           // at most 1 emit / session / 10s
const APPLY_COOLDOWN_MS = 10_000;       // 10s silence after apply:resource
const DISMISS_TTL_MS = 30 * 60_000;     // 30 min silence after user Skip
const OAUTH_RETURN_WINDOW_MS = 2 * 60_000; // post-OAuth return silence

// Word-anchored login regex. The leading `(?:^|\/)` prevents `/login-help`
// from matching, and the exclusion of "auth" on its own stops false
// positives like `/authorization-status` / `/authenticate-me`. URLs that
// actually want to match "auth" still hit via `/oauth` or `/auth/login`.
const LOGIN_URL_RE =
  /(?:^|\/)(?:login|log[-_]?in|signin|sign[-_]?in|oauth|sso|saml|idp|session)(?:\/|$|\?|#)/i;

// Negative keywords — if URL path contains one, we're probably NOT on
// the login gate itself. Covers three families:
//   - help/doc/status pages that happen to mention "login"
//     (`/login-help`, `/login-status`, `/help/login`)
//   - already-logged-in areas where password fields appear for
//     password-change / recovery flows, not login
//     (`/settings/change-password`, `/profile/security`, `/account/password`)
//   - read-only listings (`/login-history`, `/logs`, `/logging`)
// The list is path-segment bounded so it doesn't collapse hostnames.
const URL_NEGATIVE_RE =
  /\/(?:help|about|status|faq|docs?|terms|privacy|policy|history|logs?|logging|tutorial|guide|support|contact|blog|settings|profile|account|change|reset|recover|forgot|security|preferences)(?:\/|$|\?|#)/i;

// OAuth provider allowlist. Match is substring on hostname — a page on
// `accounts.google.com` is never our app, so a password field there is
// always an external auth gate.
const OAUTH_HOSTS: readonly string[] = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'auth0.com',           // and subdomains via endsWith check below
  'okta.com',
  'login.salesforce.com',
  'github.com',          // github.com/login — filtered by path check below
  'gitlab.com',
  'bitbucket.org',
  'api.twitter.com',
  'www.facebook.com',
  'www.linkedin.com',
];

function isOauthHost(hostname: string, pathname: string): boolean {
  const h = hostname.toLowerCase();
  for (const oauth of OAUTH_HOSTS) {
    if (h === oauth || h.endsWith('.' + oauth)) {
      // For generic hosts like github.com / gitlab.com, the allowlist
      // only applies on an auth-looking path — otherwise every github
      // repo visit would fire the overlay.
      if (oauth === 'github.com' || oauth === 'gitlab.com' || oauth === 'bitbucket.org') {
        return /\/(?:login|signin|oauth|sessions\/new)/i.test(pathname);
      }
      return true;
    }
  }
  return false;
}

// ── Per-page state ─────────────────────────────────────────────────────────
/** Pages we've already attached to (prevents double-subscribe on reuse). */
const attached = new WeakSet<Page>();

/** hostnames already emitted in this session (dedup key: hostname). */
const emitted = new Map<string, Set<string>>();

/** Dismissals: sessionId → hostname → expiresAt (ms). */
const dismissed = new Map<string, Map<string, number>>();

/** Apply cooldown: sessionId → cooldown expiresAt (ms). */
const applyCooldown = new Map<string, number>();

/** Global rate-limit: sessionId → lastEmitAt (ms). */
const lastEmitAt = new Map<string, number>();

/** OAuth return window: sessionId → { originHost, until } — after an
 *  external_oauth emit, a return nav to originHost within this window
 *  is treated as "user completed login" and silenced. */
const oauthInFlight = new Map<string, { originHost: string; until: number }>();

/** Per-session configured URL patterns (from workspace_resource_defaults).
 *  Loaded lazily on first navigation; refreshed when attachAuthDetector
 *  is re-called for a new session. */
const sessionPatterns = new Map<string, string[]>();

/** Pending pattern-load promises (dedup concurrent loads). */
const patternLoads = new Map<string, Promise<void>>();

/** v3 — Last seen 401/403 main-frame response per session.
 *  Stored together with the hostname the request was made against so a
 *  401 on app1.com doesn't leak a score boost to a subsequent navigation
 *  on app2.com (multi-host preview, middle-click, redirect chain).
 *  Cleared on session stop; not eagerly expired since the Map only ever
 *  holds one entry per session. */
const lastUnauthAt = new Map<string, { at: number; hostname: string }>();

/** v3 — Multi-step memory: when we see an email-only form submit on a
 *  hostname, remember it. If the next post-load on the same registrable
 *  domain shows a password input within MULTISTEP_WINDOW_MS, score gets a
 *  boost and the emit is tagged signal='multistep'.
 *
 *  We key on the registrable domain (`example.com`) rather than the full
 *  hostname so Google-style cross-host SSO flows still link
 *  (`app.example.com/identifier` → `accounts.example.com/challenge`). */
const emailStepAt = new Map<string, { at: number; registrable: string }>();

const UNAUTH_WINDOW_MS = 5_000;          // 401/403 freshness window
const MULTISTEP_WINDOW_MS = 30_000;      // email-step → password-step linkage

// ── Helpers ────────────────────────────────────────────────────────────────
function safeUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

function hostnameOf(raw: string): string | undefined {
  return safeUrl(raw)?.hostname.toLowerCase();
}

function pathnameOf(raw: string): string {
  return safeUrl(raw)?.pathname ?? raw;
}

function now(): number {
  return Date.now();
}

/**
 * Cheap "registrable domain" approximation — returns the last two labels
 * of a hostname (`accounts.app.example.com` → `example.com`). Avoids
 * pulling in a Public Suffix List dependency for the multi-step memory
 * use case where exact correctness isn't required.
 *
 * Known imprecision on suffix-of-suffix TLDs (`co.uk`, `com.br`):
 *   `foo.co.uk` → `co.uk` (groups too aggressively across all UK sites).
 * In practice that just means one extra opportunity for a multi-step
 * boost on the same TLD — strictly more lenient than the previous
 * exact-hostname check, never less. If we ever see a false-positive
 * incident from this, swap to `tldts` and key on `domain`.
 *
 * IP literals and single-label hostnames return as-is.
 */
function registrableDomainOf(hostname: string): string {
  const h = (hostname || '').toLowerCase();
  if (!h) return '';
  // IPv4 literal: keep whole.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
  // IPv6 literal (URL parser strips brackets, but be defensive).
  if (h.includes(':')) return h;
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 2) return h;
  return labels.slice(-2).join('.');
}

/** Test a user-provided pattern as a glob ("*.staging/*" → regex).
 *  Keep conversion minimal: `*` → `.*`, everything else literal. */
function patternMatches(pattern: string, url: string): boolean {
  try {
    const re = new RegExp(
      '^' +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // escape regex specials
          .replace(/\*/g, '.*') +
        '$',
      'i',
    );
    return re.test(url);
  } catch {
    return false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Called by apply:resource handler right after injection + reload start.
 *  Silences the detector for 10s so the post-reload `framenavigated` doesn't
 *  re-fire an overlay while the browser is still picking up the new cookies. */
export function markApplyCooldown(sessionId: string): void {
  applyCooldown.set(sessionId, now() + APPLY_COOLDOWN_MS);
}

/** Called by apply:resource when the login turns out to be broken/expired.
 *  Clears hostname dedup for the current host so the overlay re-fires with
 *  a "login expired" hint instead of silently hanging. */
export function resetHostDedup(sessionId: string, hostname: string): void {
  emitted.get(sessionId)?.delete(hostname.toLowerCase());
}

/** Called by frontend via `preview:auth:dismiss` WS event. Silences
 *  for `DISMISS_TTL_MS` on the given hostname. */
export function markDismissed(sessionId: string, hostname: string): void {
  let map = dismissed.get(sessionId);
  if (!map) {
    map = new Map();
    dismissed.set(sessionId, map);
  }
  map.set(hostname.toLowerCase(), now() + DISMISS_TTL_MS);
}

/** Called on session stop — free all state for this session.
 *
 * IMPORTANT: must be invoked from `PreviewSessionService.stop()` as well
 * as the page `close` event. A browser-context teardown that happens
 * without a `close` event (crash, abrupt context.close) won't fire the
 * page close listener, so the session-service `stop` is the canonical
 * cleanup hook. */
export function clearAuthDetectorSession(sessionId: string): void {
  emitted.delete(sessionId);
  dismissed.delete(sessionId);
  applyCooldown.delete(sessionId);
  lastEmitAt.delete(sessionId);
  oauthInFlight.delete(sessionId);
  sessionPatterns.delete(sessionId);
  patternLoads.delete(sessionId);
  // v3 state
  lastUnauthAt.delete(sessionId);
  emailStepAt.delete(sessionId);
}

/**
 * Attach the detector to a preview page. Safe to call repeatedly — the
 * WeakSet guard makes extra calls a no-op. Takes projectId + userId so
 * the detector can load workspace-configured URL patterns as an
 * additional positive signal.
 */
export function attachAuthDetector(
  page: Page,
  sessionId: string,
  opts?: { projectId?: string; userId?: string; isRecording?: () => boolean },
): void {
  if (attached.has(page)) return;
  attached.add(page);

  const isRecording = opts?.isRecording;
  const projectId = opts?.projectId;
  const userId = opts?.userId;

  // Load workspace URL patterns asynchronously. We don't block detection
  // on this — the first few nav events may miss the custom patterns, but
  // that's fine: once loaded, all subsequent navs benefit.
  if (projectId && userId) {
    void loadWorkspacePatterns(sessionId, projectId, userId);
  }

  // v3 — listen for HTTP 401/403 on the main-frame so backend-driven
  // auth walls (no `/login` path, no password input until redirect)
  // can be detected. We only count document/xhr/fetch from the main
  // frame; image/css/script 401s are noise. The hostname is recorded
  // alongside the timestamp so a 401 on app1.com doesn't leak a score
  // boost when the user navigates to a different host within the window.
  page.on('response', (response) => {
    try {
      const req = response.request();
      const rt = req.resourceType();
      if (rt !== 'document' && rt !== 'xhr' && rt !== 'fetch') return;
      const frame = req.frame();
      if (!frame || frame !== page.mainFrame()) return;
      const status = response.status();
      if (status !== 401 && status !== 403) return;
      // Take the request URL (where the credentials would have applied),
      // not the page URL — they can differ during XHR-driven flows.
      const requestHost = hostnameOf(req.url()) ?? hostnameOf(page.url());
      if (!requestHost) return;
      lastUnauthAt.set(sessionId, { at: now(), hostname: requestHost });
    } catch {
      /* page tearing down */
    }
  });

  const maybeEmit = async (
    url: string,
    trigger: 'nav' | 'post-load',
  ): Promise<void> => {
    // ── Pre-flight hard suppressions ────────────────────────────────────
    if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('chrome')) return;

    const parsed = safeUrl(url);
    if (!parsed) return;
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;
    if (!hostname) return;

    // Recording in progress → never prompt (user is mid-login).
    if (isRecording?.()) return;

    // Apply just happened → page is reloading, stay quiet.
    const cooldownUntil = applyCooldown.get(sessionId) ?? 0;
    if (cooldownUntil > now()) return;

    // Already emitted for this hostname in this session? Skip.
    if (emitted.get(sessionId)?.has(hostname)) return;

    // User dismissed this hostname recently? Skip until TTL expires.
    const dismissMap = dismissed.get(sessionId);
    const dismissalExpiry = dismissMap?.get(hostname);
    if (dismissalExpiry) {
      if (dismissalExpiry > now()) return;
      // TTL expired — fall through and allow re-emit.
      dismissMap!.delete(hostname);
    }
    // Opportunistic cleanup of stale entries so a long-lived session
    // with many dismissed domains doesn't accumulate unbounded state.
    if (dismissMap && dismissMap.size > 16) {
      const cutoff = now();
      for (const [h, exp] of dismissMap) {
        if (exp <= cutoff) dismissMap.delete(h);
      }
    }

    // Post-OAuth return? User just finished logging in externally —
    // landing back on their origin is not a new login gate.
    const oauthState = oauthInFlight.get(sessionId);
    if (oauthState && oauthState.until > now() && oauthState.originHost === hostname) {
      // Mark the origin as "resolved" — silence further prompts on it.
      let set = emitted.get(sessionId);
      if (!set) { set = new Set(); emitted.set(sessionId, set); }
      set.add(hostname);
      oauthInFlight.delete(sessionId);
      logger.info('[PREVIEW_AUTH_DETECTOR] OAuth return silenced', {
        sessionId, hostname,
      });
      return;
    }

    // Global rate-limit.
    const lastEmit = lastEmitAt.get(sessionId) ?? 0;
    if (now() - lastEmit < RATE_LIMIT_MS) return;

    // ── Compute score ───────────────────────────────────────────────────
    let score = 0;
    const triggers: string[] = [];

    // OAuth allowlist — dominant positive signal.
    if (isOauthHost(hostname, pathname)) {
      score += 0.55;
      triggers.push('oauth-host');
    }

    // v3 — recent 401/403 on the SAME hostname within the freshness window.
    // Hostname-scoped so a 401 on app1.com doesn't boost a subsequent
    // navigation to app2.com (multi-host preview, middle-click, redirect).
    const unauth = lastUnauthAt.get(sessionId);
    if (unauth && unauth.hostname === hostname && now() - unauth.at < UNAUTH_WINDOW_MS) {
      score += 0.45;
      triggers.push('http-unauthorized');
    }

    // URL regex. If the login token is the LAST significant segment
    // (e.g. `/account/login`, `/auth/sign-in`), treat it as the real
    // gate and skip the negative-keyword penalty — otherwise a path
    // like `/account/login` would cancel itself out (account=-, login=+).
    const urlMatches = LOGIN_URL_RE.test(pathname);
    const lastSegment = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    const loginIsLastSegment = /^(?:login|log[-_]?in|signin|sign[-_]?in|oauth|sso|saml|idp|session)$/i.test(lastSegment);

    if (urlMatches) {
      score += 0.30;
      triggers.push('url-login');
    }

    // Negative URL hints — only apply when login token isn't the
    // terminal segment. `/settings/change-password` → penalty; but
    // `/account/login` → positive wins untouched.
    if (!loginIsLastSegment && URL_NEGATIVE_RE.test(pathname)) {
      score -= 0.30;
      triggers.push('url-negative');
    }

    // Workspace-configured pattern.
    const patterns = sessionPatterns.get(sessionId);
    if (patterns && patterns.length) {
      for (const p of patterns) {
        if (patternMatches(p, url)) {
          score += 0.25;
          triggers.push('workspace-pattern');
          break;
        }
      }
    }

    // DOM signals — only on post-load (DOM may not be settled yet on nav).
    if (trigger === 'post-load') {
      const dom = await probeDomSignals(page);
      if (dom.hasPasswordField) {
        score += 0.60;
        triggers.push('password-field');
      }
      if (dom.hasUsernameForm) {
        score += 0.20;
        triggers.push('username-form');
      }
      if (dom.hasNoInputs) {
        score -= 0.20;
        triggers.push('no-inputs');
      }
      // v3 — login form action (or formaction on submit button) referring
      // to a login endpoint. Strong "developer says this is a login form"
      // signal even before a password field is present.
      if (dom.hasLoginAction) {
        score += 0.25;
        triggers.push('form-action');
      }

      // v3 — multi-step memory: remember email-only forms, then on the
      // NEXT post-load with a password input boost the score and tag the
      // signal so the UI can explain "we caught a 2-step login". Linked
      // by registrable domain (`example.com`) instead of hostname so
      // Google-style cross-host SSO flows still associate
      // (`app.example.com/identifier` → `accounts.example.com/challenge`).
      const registrable = registrableDomainOf(hostname);
      if (dom.hasEmailOnlyForm && registrable) {
        emailStepAt.set(sessionId, { at: now(), registrable });
      }
      const prev = emailStepAt.get(sessionId);
      if (
        prev &&
        prev.registrable === registrable &&
        now() - prev.at < MULTISTEP_WINDOW_MS &&
        dom.hasPasswordField
      ) {
        score += 0.20;
        triggers.push('multistep-confirmed');
        emailStepAt.delete(sessionId);
      }
    }

    if (score < THRESHOLD) return;

    // ── v3 — Two-positive minimum gate ──────────────────────────────────
    // Without a "strong" signal (oauth-host or http-unauthorized), require
    // at least TWO positive triggers. Kills the marketing-landing-page
    // scenario where a single decorative password input would have hit
    // the 0.55 threshold by itself.
    const hasStrongSignal =
      triggers.includes('oauth-host') || triggers.includes('http-unauthorized');
    const POSITIVE_TRIGGERS = new Set([
      'oauth-host',
      'http-unauthorized',
      'url-login',
      'workspace-pattern',
      'form-action',
      'password-field',
      'username-form',
      'multistep-confirmed',
    ]);
    const positiveCount = triggers.filter((t) => POSITIVE_TRIGGERS.has(t)).length;
    if (!hasStrongSignal && positiveCount < 2) {
      logger.debug('[PREVIEW_AUTH_DETECTOR] Below two-positive minimum', {
        sessionId, hostname, score, triggers,
      });
      return;
    }

    // ── Determine signal type for the payload ───────────────────────────
    const isExternal = triggers.includes('oauth-host');
    const isMultistep = triggers.includes('multistep-confirmed');
    const isBackend =
      triggers.includes('http-unauthorized') && !triggers.includes('password-field');
    const hasPwd = triggers.includes('password-field');
    const hasUrl = triggers.includes('url-login') || triggers.includes('workspace-pattern');

    let signal: 'url' | 'form' | 'both' | 'external_oauth' | 'multistep' | 'backend';
    if (isExternal) signal = 'external_oauth';
    else if (isMultistep) signal = 'multistep';
    else if (isBackend) signal = 'backend';
    else if (hasPwd && hasUrl) signal = 'both';
    else if (hasPwd) signal = 'form';
    else signal = 'url';

    // ── Record emit and fire ────────────────────────────────────────────
    let hostSet = emitted.get(sessionId);
    if (!hostSet) { hostSet = new Set(); emitted.set(sessionId, hostSet); }
    hostSet.add(hostname);
    lastEmitAt.set(sessionId, now());

    // OAuth redirect bookkeeping: when we emit on an OAuth provider host,
    // remember the ORIGIN host so the return-nav doesn't re-trigger.
    // Stashing the origin BEFORE this point happens in the dedicated
    // framenavigated listener below — by the time we hit the OAuth host,
    // `__qai_origin_host__` is already the prior main-frame origin.
    if (signal === 'external_oauth') {
      const originHost = (page as any).__qai_origin_host__ as string | undefined;
      if (originHost && originHost !== hostname) {
        oauthInFlight.set(sessionId, {
          originHost,
          until: now() + OAUTH_RETURN_WINDOW_MS,
        });
      }
    }

    try {
      webSocketService.emitToRoom('preview', sessionId, 'preview:auth:required', {
        previewSessionId: sessionId,
        signal,
        url,
        suggestedDomain: hostname,
        score: Math.round(score * 100) / 100,
        triggers,
        timestamp: new Date().toISOString(),
      });
      logger.info('[PREVIEW_AUTH_DETECTOR] Login gate detected', {
        sessionId, hostname, pathname, signal, score, triggers,
      });
    } catch (err) {
      logger.warn('[PREVIEW_AUTH_DETECTOR] Emit failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Main-frame navigations only — sub-frame events are intentionally
  // ignored. Sub-resource iframes (ads/analytics) routinely carry
  // auth-shaped URLs that aren't relevant to the user. If we ever need
  // iframe login detection, gate it behind an explicit opt-in (don't
  // turn it on globally).
  //
  // Two listeners run on every main-frame nav:
  //   1. originStash — remembers the latest "we are here" host BEFORE the
  //      OAuth redirect, so we can detect the return. This is decoupled
  //      from emit to avoid the "stash only ran on first same-origin
  //      emit" bug — origin tracking is independent of detection.
  //   2. maybeEmit — the score/threshold pipeline.
  page.on('framenavigated', async (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const frameUrl = frame.url();
    // Always update origin host on a real (http/https) navigation. OAuth
    // hosts are excluded so their return target stays the prior origin.
    const parsed = safeUrl(frameUrl);
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      const host = parsed.hostname.toLowerCase();
      if (host && !isOauthHost(host, parsed.pathname)) {
        (page as any).__qai_origin_host__ = host;
      }
    }
    try {
      await maybeEmit(frameUrl, 'nav');
    } catch (err) {
      logger.debug('[PREVIEW_AUTH_DETECTOR] framenavigated probe threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  page.on('load', async () => {
    try {
      await maybeEmit(page.url(), 'post-load');
    } catch {
      /* page may be closing */
    }
  });

  page.once('close', () => {
    clearAuthDetectorSession(sessionId);
  });
}

// ── DOM probe (Shadow-DOM aware, autocomplete-aware) ───────────────────────
interface DomSignals {
  hasPasswordField: boolean;
  hasUsernameForm: boolean;
  hasNoInputs: boolean;
  /** v3 — `<form action="…/login…">` or `<button formaction="…/login…">`.
   *  Strong "developer says this is a login form" signal that fires even
   *  before the user reveals a password input. */
  hasLoginAction: boolean;
  /** v3 — page has visible username/email input + submit button but NO
   *  visible password input. Used to remember a multi-step login's first
   *  page so the second (password) page gets a confirmation boost. */
  hasEmailOnlyForm: boolean;
}

async function probeDomSignals(target: Page | Frame): Promise<DomSignals> {
  // Run a single page.evaluate that does a recursive Shadow-DOM walk —
  // cheaper than three separate locator queries and catches custom
  // elements that wrap their inputs. Wrapped in Promise.race so a slow
  // page can't stall the detector.
  const emptyResult: DomSignals = {
    hasPasswordField: false,
    hasUsernameForm: false,
    hasNoInputs: true,
    hasLoginAction: false,
    hasEmailOnlyForm: false,
  };

  try {
    return await Promise.race([
      target.evaluate((): DomSignals => {
        // @ts-expect-error - browser context
        const doc = document;
        // @ts-expect-error - browser context
        const win = window;

        let hasPassword = false;
        let hasUsernameForm = false;
        let inputCount = 0;
        let hasLoginAction = false;
        let visibleEmailInput = false;
        let visibleSubmit = false;

        // Word-boundary match — matches `…/login`, `?action=signin` but not
        // `/loginhelp`. Browser-side regex (must be inline; no shared file).
        const ACTION_RE = /\b(?:login|signin|sign[-_]?in|auth|session)\b/i;

        const isVisible = (el: any): boolean => {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = (el.ownerDocument?.defaultView || win).getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none';
        };

        const walk = (root: any): void => {
          const all = root.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            const el = all[i];
            const tag = el.tagName;
            if (tag === 'INPUT') {
              inputCount++;
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
              const visible = isVisible(el);
              if (type === 'password' && visible) {
                hasPassword = true;
              } else if (ac === 'current-password' && visible) {
                // Modern forms that mask via JS — we still treat them as password.
                hasPassword = true;
              } else if (ac === 'username' || ac === 'email' || type === 'email') {
                hasUsernameForm = true;
                if (visible) visibleEmailInput = true;
              }
              // Submit-input also counts toward email-only form detection.
              if (type === 'submit' && visible) visibleSubmit = true;
              // formaction on submit buttons.
              const fa = (el.getAttribute('formaction') || '').toLowerCase();
              if (fa && ACTION_RE.test(fa)) hasLoginAction = true;
            } else if (tag === 'BUTTON') {
              const btnType = (el.getAttribute('type') || 'submit').toLowerCase();
              if (btnType === 'submit' && isVisible(el)) visibleSubmit = true;
              const fa = (el.getAttribute('formaction') || '').toLowerCase();
              if (fa && ACTION_RE.test(fa)) hasLoginAction = true;
            } else if (tag === 'FORM') {
              const action = (el.getAttribute('action') || '').toLowerCase();
              if (action && ACTION_RE.test(action)) hasLoginAction = true;
            }
            // Recurse into open shadow roots. (Closed roots are invisible
            // to JS — there's nothing we can do about those.)
            const sr = el.shadowRoot;
            if (sr) walk(sr);
          }
        };

        try {
          walk(doc);
        } catch {
          /* best-effort */
        }

        return {
          hasPasswordField: hasPassword,
          hasUsernameForm: hasUsernameForm && !hasPassword ? hasUsernameForm : false,
          hasNoInputs: inputCount === 0,
          hasLoginAction,
          // Email-only form: visible username/email + visible submit, no password.
          hasEmailOnlyForm: visibleEmailInput && visibleSubmit && !hasPassword,
        };
      }),
      new Promise<DomSignals>((resolve) =>
        setTimeout(() => resolve(emptyResult), DOM_PROBE_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return emptyResult;
  }
}

// ── Workspace-configured URL patterns ──────────────────────────────────────
async function loadWorkspacePatterns(
  sessionId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  if (sessionPatterns.has(sessionId)) return;
  // Dedup concurrent loads.
  const existing = patternLoads.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const { supabaseAdmin } = await import('@/db/supabase');
      const { data, error } = await supabaseAdmin
        .from('workspace_resource_defaults')
        .select('url_pattern')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('kind', 'auth')
        .not('url_pattern', 'is', null);

      if (error || !data) {
        sessionPatterns.set(sessionId, []);
        return;
      }

      const patterns = data
        .map((row) => (row as any).url_pattern as string | null)
        .filter((p): p is string => !!p && p.length > 0);

      sessionPatterns.set(sessionId, patterns);
      if (patterns.length > 0) {
        logger.debug('[PREVIEW_AUTH_DETECTOR] Loaded workspace patterns', {
          sessionId, projectId, count: patterns.length,
        });
      }
    } catch (err) {
      logger.debug('[PREVIEW_AUTH_DETECTOR] Pattern load failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      sessionPatterns.set(sessionId, []);
    } finally {
      patternLoads.delete(sessionId);
    }
  })();

  patternLoads.set(sessionId, promise);
  return promise;
}
