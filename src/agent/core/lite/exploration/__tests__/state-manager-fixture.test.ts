/**
 * StateManager auth-fixture preload tests.
 *
 * Covers:
 *   - preloadAuthState marks hasAuthState = true
 *   - createAuthenticatedContext uses the preloaded state
 *   - clearAuthState undoes preload
 *   - Non-serializable state is tolerated (logs, no crash)
 *
 * We only mock Playwright's Browser interface — the logic we care about
 * here is the JSON plumbing, not the real browser lifecycle.
 */

import { StateManager } from '../state-manager';
import type { Browser, BrowserContext } from 'playwright';

function mockBrowser(): {
  browser: Browser;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const fakeContext = {
    addInitScript: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;

  const browser = {
    newContext: jest.fn(async (opts: Record<string, unknown>) => {
      calls.push(opts);
      return fakeContext;
    }),
  } as unknown as Browser;

  return { browser, calls };
}

describe('StateManager.preloadAuthState', () => {
  it('marks auth as available after preloading a non-empty state', () => {
    const { browser } = mockBrowser();
    const sm = new StateManager(browser);
    expect(sm.hasAuthState()).toBe(false);

    sm.preloadAuthState({ cookies: [{ name: 'x' }], origins: [] });

    expect(sm.hasAuthState()).toBe(true);
  });

  it('passes the preloaded state as storageState into browser.newContext', async () => {
    const { browser, calls } = mockBrowser();
    const sm = new StateManager(browser);
    const fixture = {
      cookies: [{
        name: 'session', value: 'abc', domain: '.example.com', path: '/',
        expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
      }],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'u', value: '42' }] }],
    };
    sm.preloadAuthState(fixture);

    await sm.createAuthenticatedContext();

    expect(calls).toHaveLength(1);
    // Playwright options object should carry the fixture verbatim.
    expect(calls[0].storageState).toEqual(fixture);
  });

  it('clearAuthState undoes the preload', () => {
    const { browser } = mockBrowser();
    const sm = new StateManager(browser);
    sm.preloadAuthState({ cookies: [], origins: [] });
    expect(sm.hasAuthState()).toBe(true);
    sm.clearAuthState();
    expect(sm.hasAuthState()).toBe(false);
  });

  it('falls back to a clean context when no fixture is preloaded', async () => {
    const { browser, calls } = mockBrowser();
    const sm = new StateManager(browser);

    await sm.createAuthenticatedContext();

    expect(calls).toHaveLength(1);
    expect(calls[0].storageState).toBeUndefined();
  });

  it('tolerates a non-serializable object without throwing', () => {
    const { browser } = mockBrowser();
    const sm = new StateManager(browser);

    // Cyclic reference — JSON.stringify would throw
    const cyclic: any = { cookies: [], origins: [] };
    cyclic.self = cyclic;

    expect(() => sm.preloadAuthState(cyclic)).not.toThrow();
    // State is still usable — createAuthenticatedContext will pass the
    // live object to Playwright regardless of the cached JSON string.
    expect(sm.hasAuthState()).toBe(true);
  });
});

describe('StateManager.getAuthState — runner-to-runner auth handoff (P0.1)', () => {
  it('returns null before any login', () => {
    const { browser } = mockBrowser();
    expect(new StateManager(browser).getAuthState()).toBeNull();
  });

  it('exports the preloaded state so a second StateManager can reuse the session', async () => {
    // Simulates the Phase-2.5 handoff: runner A logs in, runner B inherits its
    // auth state. Before the fix, B started with a null auth state and (with
    // loginCompleted=true) ran auth-gated flows logged-out.
    const fixture = {
      cookies: [{
        name: 'session', value: 'abc', domain: '.example.com', path: '/',
        expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
      }],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'u', value: '42' }] }],
    };

    const runnerA = new StateManager(mockBrowser().browser);
    runnerA.preloadAuthState(fixture);

    // Hand A's exported state to B (what restoreFromCheckpoint({authState}) does).
    const exported = runnerA.getAuthState();
    expect(exported).toEqual(fixture);

    const { browser: browserB, calls: callsB } = mockBrowser();
    const runnerB = new StateManager(browserB);
    runnerB.preloadAuthState(exported!);

    expect(runnerB.hasAuthState()).toBe(true);
    await runnerB.createAuthenticatedContext();
    expect(callsB[0].storageState).toEqual(fixture);
  });
});

describe('FlowRunner auth routing logic', () => {
  // This mirrors the decision logic in runSingleFlow — if it ever gets
  // refactored, the test should drift with it. The actual FlowRunner is
  // too coupled to Playwright to exercise end-to-end in a unit test.
  function pickContextPath(params: {
    requiresAuth: boolean;
    hasAuthState: boolean;
    hasCredentials: boolean;
  }): 'authenticated' | 'clean' {
    const hasAuthAvailable = params.hasAuthState || params.hasCredentials;
    return params.requiresAuth && hasAuthAvailable ? 'authenticated' : 'clean';
  }

  it('uses authenticated context when a fixture is preloaded even without credentials', () => {
    // Regression: before the fix, (requiresAuth && credentials) was used,
    // which silently routed fixture-only flows to a clean context and
    // defeated the entire pre-seeded path.
    expect(
      pickContextPath({ requiresAuth: true, hasAuthState: true, hasCredentials: false }),
    ).toBe('authenticated');
  });

  it('uses authenticated context when credentials are present without fixture', () => {
    expect(
      pickContextPath({ requiresAuth: true, hasAuthState: false, hasCredentials: true }),
    ).toBe('authenticated');
  });

  it('falls back to clean context for an auth-gated flow with neither fixture nor credentials', () => {
    // We have no way to authenticate — a clean context at least lets the
    // flow surface a clear "blocked by login wall" result.
    expect(
      pickContextPath({ requiresAuth: true, hasAuthState: false, hasCredentials: false }),
    ).toBe('clean');
  });

  it('uses clean context for a public flow even when auth material is available', () => {
    expect(
      pickContextPath({ requiresAuth: false, hasAuthState: true, hasCredentials: true }),
    ).toBe('clean');
  });
});
