/**
 * Auth-detector v3 — score-based login-gate detection.
 *
 * These tests exercise the public surface (`attachAuthDetector`,
 * `clearAuthDetectorSession`, `markApplyCooldown`) by simulating Playwright
 * `Page` events. We don't spin up a real browser; instead a tiny EventEmitter
 * faux-Page lets us drive `framenavigated`, `load`, and `response` events
 * deterministically and inspect what the detector emits to the WS room.
 *
 * Coverage matrix lines up 1:1 with Phase 0 acceptance criteria.
 */

import { EventEmitter } from 'events';

// ── Mock the WS service so we can capture emits without standing up Socket.IO ──
const emitToRoom = jest.fn();
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: {
    emitToRoom: (...args: unknown[]) => emitToRoom(...args),
  },
}));

// Mock the supabase loader — we don't want this test to touch the network
// or env vars. The detector consults workspace_settings + workspace_resource_defaults
// lazily; returning empty data here means tests run with the defaults.
jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              not: () => Promise.resolve({ data: [], error: null }),
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    }),
  },
}));

import {
  attachAuthDetector,
  clearAuthDetectorSession,
  markApplyCooldown,
} from '../auth-detector';

// ── Fake Page / Frame helpers ────────────────────────────────────────────────

interface DomProbe {
  hasPasswordField?: boolean;
  hasUsernameForm?: boolean;
  hasNoInputs?: boolean;
  hasLoginAction?: boolean;
  hasEmailOnlyForm?: boolean;
}

class FakeFrame extends EventEmitter {
  constructor(
    private _url: string,
    private _isMain: boolean,
    private _probe: () => DomProbe,
  ) {
    super();
  }
  url() {
    return this._url;
  }
  setUrl(u: string) {
    this._url = u;
  }
  setProbe(p: () => DomProbe) {
    this._probe = p;
  }
  // The detector calls `target.evaluate(fn)` on Page or Frame for the DOM probe.
  // Bypass the function and return the probe data we control from the test.
  // The shape returned must match the real probe result.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async evaluate(_fn: unknown) {
    const r = this._probe();
    return {
      hasPasswordField: !!r.hasPasswordField,
      hasUsernameForm: !!r.hasUsernameForm,
      hasNoInputs: r.hasNoInputs ?? (!r.hasPasswordField && !r.hasUsernameForm),
      hasLoginAction: !!r.hasLoginAction,
      hasEmailOnlyForm: !!r.hasEmailOnlyForm,
    };
  }
}

class FakePage extends EventEmitter {
  private _mainFrame: FakeFrame;
  private _frames: FakeFrame[] = [];
  private _probe: DomProbe = { hasNoInputs: true };
  constructor(initialUrl: string) {
    super();
    this._mainFrame = new FakeFrame(initialUrl, true, () => this._probe);
    this._frames.push(this._mainFrame);
  }
  url() {
    return this._mainFrame.url();
  }
  mainFrame() {
    return this._mainFrame;
  }
  // The detector calls `target.evaluate(fn)` on the Page for main-frame probes.
  async evaluate(_fn: unknown) {
    return this._mainFrame.evaluate(_fn);
  }
  // Helper: simulate a top-level navigation + load.
  async navigate(url: string, probe: DomProbe = { hasNoInputs: true }) {
    this._probe = probe;
    this._mainFrame.setUrl(url);
    this.emit('framenavigated', this._mainFrame);
    this.emit('load');
    // Yield to let the async handlers settle.
    await flush();
  }
  // Helper: simulate a main-frame HTTP response (e.g. 401) on the
  // current page URL.
  emitMainResponse(status: number, resourceType: 'document' | 'xhr' | 'fetch' = 'xhr') {
    const main = this._mainFrame;
    const pageUrl = main.url();
    const fakeResponse = {
      status: () => status,
      request: () => ({
        frame: () => main,
        resourceType: () => resourceType,
        url: () => pageUrl,
      }),
    };
    this.emit('response', fakeResponse);
  }
  // Helper: simulate a same-frame XHR/document response (mainly for 401/403).
  // Uses an arbitrary URL on `requestHost` so the detector's hostname
  // scoping path can be exercised independently of the page URL.
  emitMainResponseAt(status: number, requestHost: string, resourceType: 'document' | 'xhr' | 'fetch' = 'xhr') {
    const main = this._mainFrame;
    const fakeResponse = {
      status: () => status,
      request: () => ({
        frame: () => main,
        resourceType: () => resourceType,
        url: () => `https://${requestHost}/api/whatever`,
      }),
    };
    this.emit('response', fakeResponse);
  }
}

// Allow microtasks + queued promises to settle.
async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('auth-detector v3', () => {
  beforeEach(() => {
    emitToRoom.mockClear();
  });

  afterEach(() => {
    // Each test uses a fresh sessionId, but be safe.
    clearAuthDetectorSession('s-default');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 1. Standard login: /login + password input → emit, signal=both
  // ─────────────────────────────────────────────────────────────────────
  it('emits on standard login (URL + password)', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's1');

    await page.navigate('https://app.example.com/login', {
      hasPasswordField: true,
      hasUsernameForm: true,
    });

    expect(emitToRoom).toHaveBeenCalledTimes(1);
    const [, sessionId, eventName, payload] = emitToRoom.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(eventName).toBe('preview:auth:required');
    expect(payload.signal).toBe('both');
    expect(payload.suggestedDomain).toBe('app.example.com');
    expect(payload.triggers).toEqual(
      expect.arrayContaining(['url-login', 'password-field']),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // 2. OAuth provider host (Google) → external_oauth, no two-positive gate
  // ─────────────────────────────────────────────────────────────────────
  it('emits external_oauth on Google sign-in page (single strong signal)', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's2');

    // OAuth host alone (0.55) triggers because oauth-host is a "strong" signal.
    await page.navigate('https://accounts.google.com/v3/signin/identifier', {
      hasPasswordField: false,
      hasUsernameForm: false,
    });

    expect(emitToRoom).toHaveBeenCalledTimes(1);
    expect(emitToRoom.mock.calls[0][3].signal).toBe('external_oauth');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 3. Custom backend wall: 401 alone is not enough (one positive)
  // ─────────────────────────────────────────────────────────────────────
  it('does NOT emit on 401 alone with no other signals', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's3');

    // Land on the page first (so 401 has a hostname to associate with),
    // emit the 401, then re-navigate to a different path with no DOM signals.
    await page.navigate('https://app.example.com/', { hasNoInputs: true });
    page.emitMainResponseAt(401, 'app.example.com');
    await flush();
    await page.navigate('https://app.example.com/dashboard', {
      hasPasswordField: false,
    });

    // http-unauthorized is "strong" so it'd bypass two-positive — BUT score
    // alone (0.45) is below THRESHOLD (0.55). So no emit.
    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 4. Custom wall + password → emit, http-unauthorized as strong signal
  // ─────────────────────────────────────────────────────────────────────
  it('emits on custom wall when 401 combines with password field', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's4');

    await page.navigate('https://app.example.com/', { hasNoInputs: true });
    page.emitMainResponseAt(401, 'app.example.com');
    await flush();
    await page.navigate('https://app.example.com/dashboard', {
      hasPasswordField: true,
    });

    expect(emitToRoom).toHaveBeenCalledTimes(1);
    const payload = emitToRoom.mock.calls[0][3];
    expect(payload.triggers).toEqual(
      expect.arrayContaining(['http-unauthorized', 'password-field']),
    );
    // password + http-unauthorized → not 'backend' (password disqualifies),
    // not 'external_oauth' (not OAuth host) → 'form'.
    expect(payload.signal).toBe('form');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 5. /change-password — negative URL kills it
  // ─────────────────────────────────────────────────────────────────────
  it('does NOT emit on /settings/change-password with password field', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's5');

    await page.navigate('https://app.example.com/settings/change-password', {
      hasPasswordField: true,
    });

    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 6. /login-help — negative regex covers it
  // ─────────────────────────────────────────────────────────────────────
  it('does NOT emit on /login-help', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's6');

    await page.navigate('https://app.example.com/login-help', {
      hasPasswordField: false,
    });

    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 7. Multi-step page 1 (email-only form) — remember, don't emit
  // ─────────────────────────────────────────────────────────────────────
  it('remembers an email-only form without emitting', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's7');

    await page.navigate('https://app.example.com/identifier', {
      hasUsernameForm: true,
      hasEmailOnlyForm: true,
    });

    // No password yet, URL doesn't match login — only username-form fires (0.20).
    // Two-positive minimum kicks in (no strong signal): fails.
    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 8. Multi-step page 2 (password right after) → multistep signal
  // ─────────────────────────────────────────────────────────────────────
  it('boosts and tags multistep when password follows email-only', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's8');

    await page.navigate('https://accounts.app.example.com/identifier', {
      hasUsernameForm: true,
      hasEmailOnlyForm: true,
    });
    await page.navigate('https://accounts.app.example.com/challenge/pwd', {
      hasPasswordField: true,
    });

    expect(emitToRoom).toHaveBeenCalledTimes(1);
    const payload = emitToRoom.mock.calls[0][3];
    expect(payload.signal).toBe('multistep');
    expect(payload.triggers).toEqual(
      expect.arrayContaining(['multistep-confirmed', 'password-field']),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // 9. Marketing landing page with a single password input → suppressed
  // ─────────────────────────────────────────────────────────────────────
  it('does NOT emit on a landing page with only a password field (two-positive gate)', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's9');

    await page.navigate('https://example.com/', {
      hasPasswordField: true,
    });

    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 10. Cross-host multi-step (Google-style SSO across subdomains).
  //     Fix #4: registrable-domain keying — `app.example.com/identifier`
  //     remembered, password page on `accounts.example.com/challenge`
  //     should still trigger the multistep boost.
  // ─────────────────────────────────────────────────────────────────────
  it('links cross-host multistep on the same registrable domain', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's10');

    await page.navigate('https://app.example.com/identifier', {
      hasUsernameForm: true,
      hasEmailOnlyForm: true,
    });
    await page.navigate('https://accounts.example.com/challenge/pwd', {
      hasPasswordField: true,
    });

    expect(emitToRoom).toHaveBeenCalledTimes(1);
    const payload = emitToRoom.mock.calls[0][3];
    expect(payload.signal).toBe('multistep');
    expect(payload.triggers).toEqual(
      expect.arrayContaining(['multistep-confirmed', 'password-field']),
    );
    expect(payload.suggestedDomain).toBe('accounts.example.com');
  });

  // ─────────────────────────────────────────────────────────────────────
  // 11. OAuth return → silenced
  // ─────────────────────────────────────────────────────────────────────
  it('silences OAuth return navigation', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's11');

    // Land on the origin first so __qai_origin_host__ is recorded.
    await page.navigate('https://app.example.com/', {
      hasPasswordField: false,
    });
    expect(emitToRoom).not.toHaveBeenCalled();

    // Redirect to OAuth provider — fires external_oauth and sets oauthInFlight.
    await page.navigate('https://accounts.google.com/v3/signin/identifier');
    expect(emitToRoom).toHaveBeenCalledTimes(1);
    expect(emitToRoom.mock.calls[0][3].signal).toBe('external_oauth');

    // Return navigation back to origin — silenced.
    emitToRoom.mockClear();
    await page.navigate('https://app.example.com/dashboard');
    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 12. Apply cooldown — silences for 10s after markApplyCooldown
  // ─────────────────────────────────────────────────────────────────────
  it('silences detection during apply cooldown', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's12');

    markApplyCooldown('s12');

    await page.navigate('https://app.example.com/login', {
      hasPasswordField: true,
    });

    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 13. Fix #2 — A 401 on app1.com must NOT boost a navigation to app2.com
  //     within the freshness window.
  // ─────────────────────────────────────────────────────────────────────
  it('does NOT carry a 401 boost across hostnames', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's13');

    await page.navigate('https://app1.com/', { hasNoInputs: true });
    page.emitMainResponseAt(401, 'app1.com');
    await flush();

    // Now navigate to a different host with NO password and a generic path.
    // Without hostname scoping, the leaked 401 boost (0.45) could combine
    // with even one other weak signal to fire. With scoping, no signals
    // apply on app2.com → no emit.
    await page.navigate('https://app2.com/dashboard', {
      hasPasswordField: false,
    });

    expect(emitToRoom).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // 14. Fix #3 — origin host must be tracked on every main-frame nav,
  //     not only on emit. Several non-emitting hops on the origin (a
  //     pre-fix bug only stashed `__qai_origin_host__` at emit time, so
  //     these would leave origin unset) → OAuth return must still
  //     silence afterwards.
  // ─────────────────────────────────────────────────────────────────────
  it('tracks origin host on every nav so OAuth return still silences', async () => {
    const page = new FakePage('about:blank');
    attachAuthDetector(page as unknown as never, 's14');

    // Hop around on the origin a few times — none of these emit (no
    // login signals), but each must update __qai_origin_host__.
    await page.navigate('https://app.example.com/', { hasNoInputs: true });
    await page.navigate('https://app.example.com/marketing', { hasNoInputs: true });
    await page.navigate('https://app.example.com/pricing', { hasNoInputs: true });
    expect(emitToRoom).not.toHaveBeenCalled();

    // OAuth redirect — must fire external_oauth and arm return-window
    // against the prior origin (`app.example.com`).
    await page.navigate('https://accounts.google.com/v3/signin/identifier');
    expect(emitToRoom).toHaveBeenCalledTimes(1);
    expect(emitToRoom.mock.calls[0][3].signal).toBe('external_oauth');

    // Return to origin — silenced via OAuth return window.
    emitToRoom.mockClear();
    await page.navigate('https://app.example.com/dashboard');
    expect(emitToRoom).not.toHaveBeenCalled();
  });
});
