import { classifyPageHealth, pageHealthHasSignal, formatPageHealth } from '../page-health';
import type { NetworkError } from '../network-tracker';
import { TestBlackboard } from '../../pipeline/blackboard';

function netErr(status: number, url = 'https://app.test/x'): NetworkError {
  return { url, method: 'GET', status, error: `HTTP ${status}`, timestamp: 1 };
}

describe('classifyPageHealth — server errors', () => {
  it('flags a 5xx as a server error with the status', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [netErr(500)],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/dashboard',
    });
    expect(h.hasServerError).toBe(true);
    expect(h.serverErrorStatus).toBe(500);
  });

  it('keeps the highest 5xx when several errors occur', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [netErr(502), netErr(500), netErr(503)],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/x',
    });
    expect(h.serverErrorStatus).toBe(503);
  });

  it('does NOT flag a same-site 4xx as a server error (sub-resource 404 is noise)', () => {
    // Tightened semantics: only 5xx is a genuine server failure. A 404 on a
    // missing image / sub-resource was over-flagging healthy pages as broken.
    const h = classifyPageHealth({
      networkErrorsSince: [netErr(404)],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/x',
    });
    expect(h.hasServerError).toBe(false);
    expect(h.serverErrorStatus).toBeUndefined();
  });

  it('reports a healthy page with no errors', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/x',
    });
    expect(h.hasServerError).toBe(false);
    expect(h.sessionLost).toBe(false);
    expect(pageHealthHasSignal(h)).toBe(false);
  });
});

describe('classifyPageHealth — third-party noise filtering (same-site only)', () => {
  it('IGNORES a cross-site analytics/CDN error (not the app under test)', () => {
    // Reproduces the live bug: amplitude/CDN 404s flagged a healthy page broken.
    const h = classifyPageHealth({
      networkErrorsSince: [netErr(404, 'https://api2.amplitude.com/2/httpapi')],
      consoleErrorCount: 0,
      currentUrl: 'https://bi.group/ru/compare',
    });
    expect(h.hasServerError).toBe(false);
  });

  it('KEEPS a same-site subdomain server error (real app failure)', () => {
    // account.bi.group 500 during a login redirect — genuinely the app failing.
    const h = classifyPageHealth({
      networkErrorsSince: [netErr(500, 'https://account.bi.group/?backUrl=x')],
      consoleErrorCount: 0,
      currentUrl: 'https://bi.group/ru/compare',
    });
    expect(h.hasServerError).toBe(true);
    expect(h.serverErrorStatus).toBe(500);
  });

  it('keeps same-site error, drops cross-site error when both present', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [
        netErr(404, 'https://api2.amplitude.com/x'),
        netErr(503, 'https://account.bi.group/y'),
      ],
      consoleErrorCount: 0,
      currentUrl: 'https://bi.group/ru/compare',
    });
    expect(h.serverErrorStatus).toBe(503);
  });
});

describe('classifyPageHealth — session lost', () => {
  it('detects a redirect from an app page to a login URL', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      previousUrl: 'https://app.test/dashboard',
      currentUrl: 'https://app.test/login',
    });
    expect(h.sessionLost).toBe(true);
  });

  it('does NOT flag session lost for an auth flow (login URL is the goal)', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      previousUrl: 'https://app.test/home',
      currentUrl: 'https://app.test/signin',
      flowIsAuth: true,
    });
    expect(h.sessionLost).toBe(false);
  });

  it('does NOT flag session lost when already on a login page (no transition)', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      previousUrl: 'https://app.test/login',
      currentUrl: 'https://app.test/login',
    });
    expect(h.sessionLost).toBe(false);
  });

  it('does NOT flag session lost without a previous URL', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/login',
    });
    expect(h.sessionLost).toBe(false);
  });
});

describe('pageHealthHasSignal / formatPageHealth', () => {
  it('signals on console errors alone', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 3,
      currentUrl: 'https://app.test/x',
    });
    expect(pageHealthHasSignal(h)).toBe(true);
    expect(formatPageHealth(h)).toContain('console errors: 3');
  });

  it('renders an empty string for a healthy page', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/x',
    });
    expect(formatPageHealth(h)).toBe('');
  });

  it('renders server error + session lost together', () => {
    const h = classifyPageHealth({
      networkErrorsSince: [netErr(500)],
      consoleErrorCount: 1,
      previousUrl: 'https://app.test/cart',
      currentUrl: 'https://app.test/login',
    });
    const body = formatPageHealth(h);
    expect(body).toContain('SERVER ERROR: HTTP 500');
    expect(body).toContain('SESSION LOST');
    expect(body).toContain('console errors: 1');
  });
});

describe('stale-verdict clearing contract (blackboard round-trip)', () => {
  // Mirrors the rule in CommandExecutor.collectPageHealth:
  //   setPageHealth(pageHealthHasSignal(h) ? h : undefined)
  // A clean window MUST clear an earlier round's verdict, otherwise the
  // Reviewer health gate would block a recovered page forever.
  const persist = (bb: TestBlackboard, h: ReturnType<typeof classifyPageHealth>) =>
    bb.setPageHealth(pageHealthHasSignal(h) ? h : undefined);

  it('clears a prior server-error verdict once the next window is healthy', () => {
    const bb = new TestBlackboard('goal', 'https://app.test/', 'ep-0', false);

    // Round 1: 500 → verdict persisted.
    persist(bb, classifyPageHealth({
      networkErrorsSince: [netErr(500)],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/x',
    }));
    expect(bb.getPageHealth()?.serverErrorStatus).toBe(500);

    // Round 2: clean window → verdict MUST be cleared, not left stale.
    persist(bb, classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      currentUrl: 'https://app.test/x',
    }));
    expect(bb.getPageHealth()).toBeUndefined();
  });

  it('clears a prior session-lost verdict once the next window is healthy', () => {
    const bb = new TestBlackboard('goal', 'https://app.test/', 'ep-1', false);

    persist(bb, classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      previousUrl: 'https://app.test/cart',
      currentUrl: 'https://app.test/login',
    }));
    expect(bb.getPageHealth()?.sessionLost).toBe(true);

    persist(bb, classifyPageHealth({
      networkErrorsSince: [],
      consoleErrorCount: 0,
      previousUrl: 'https://app.test/home',
      currentUrl: 'https://app.test/dashboard',
    }));
    expect(bb.getPageHealth()).toBeUndefined();
  });
});
