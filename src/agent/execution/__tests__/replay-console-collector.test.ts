/**
 * ReplayConsoleCollector — behaviour that the `assertNoConsoleErrors` step
 * depends on. The two properties worth pinning are the ones a naive
 * implementation gets wrong: warnings must never be collected (they would make
 * the assertion permanently red on real sites), and collection must survive a
 * tab switch (the replay executor swaps `this.page`, so a per-Page listener
 * would go deaf after the first popup).
 */

import { ReplayConsoleCollector } from '../replay-console-collector';

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Minimal Page test double that lets us fire console/pageerror events. */
class FakePage {
  private handlers: Record<string, Array<(arg: any) => void>> = {};

  on(event: string, handler: (arg: any) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }

  emitConsole(type: string, text: string, url?: string): void {
    for (const h of this.handlers['console'] ?? []) {
      h({ type: () => type, text: () => text, location: () => (url ? { url } : undefined) });
    }
  }

  emitPageError(message: string): void {
    for (const h of this.handlers['pageerror'] ?? []) h(new Error(message));
  }

  /** Playwright-shaped `response` event. */
  emitResponse(url: string, status: number, method = 'GET'): void {
    for (const h of this.handlers['response'] ?? []) {
      h({ status: () => status, url: () => url, request: () => ({ method: () => method }) });
    }
  }

  /** Playwright-shaped `requestfailed` event. */
  emitRequestFailed(url: string, errorText: string, method = 'GET'): void {
    for (const h of this.handlers['requestfailed'] ?? []) {
      h({ url: () => url, method: () => method, failure: () => ({ errorText }) });
    }
  }
}

/** Minimal BrowserContext double that can birth new pages. */
class FakeContext {
  private pageHandlers: Array<(p: any) => void> = [];
  constructor(private initialPages: FakePage[] = []) {}

  on(event: string, handler: (p: any) => void): void {
    if (event === 'page') this.pageHandlers.push(handler);
  }
  off(): void {
    this.pageHandlers = [];
  }
  pages(): FakePage[] {
    return this.initialPages;
  }
  /** Simulate a popup / new tab opening. */
  openPage(page: FakePage): void {
    for (const h of this.pageHandlers) h(page);
  }
}

const makeCollector = (pages: FakePage[] = []) => {
  const context = new FakeContext(pages);
  const collector = new ReplayConsoleCollector(context as any);
  collector.start();
  return { context, collector };
};

describe('ReplayConsoleCollector', () => {
  it('collects console.error messages', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);

    page.emitConsole('error', 'Boom');

    const errors = collector.getAllErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: 'error', text: 'Boom', source: 'console' });
  });

  it('ignores warnings — only errors can fail a test', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);

    page.emitConsole('warning', 'Deprecated API');
    page.emitConsole('warn', 'Also a warning');
    page.emitConsole('log', 'just a log');
    page.emitConsole('info', 'fyi');

    expect(collector.getAllErrors()).toHaveLength(0);
  });

  it('collects uncaught exceptions via pageerror', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);

    page.emitPageError('TypeError: x is not a function');

    const errors = collector.getAllErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe('pageerror');
    expect(errors[0].text).toContain('TypeError');
  });

  it('keeps collecting after a new tab opens', () => {
    const first = new FakePage();
    const { context, collector } = makeCollector([first]);

    const popup = new FakePage();
    context.openPage(popup);

    first.emitConsole('error', 'from original tab');
    popup.emitConsole('error', 'from popup');

    expect(collector.getAllErrors().map((e) => e.text)).toEqual([
      'from original tab',
      'from popup',
    ]);
  });

  it('does not double-count a page wired twice', () => {
    const page = new FakePage();
    const { context, collector } = makeCollector([page]);

    // Context re-announces a page we already know about.
    context.openPage(page);
    page.emitConsole('error', 'once');

    expect(collector.getAllErrors()).toHaveLength(1);
  });

  it('windows errors by timestamp so a step judges only its own slice', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);

    page.emitConsole('error', 'old');
    const boundary = Date.now() + 1;
    // Advance the clock past the boundary before the second error.
    jest.spyOn(Date, 'now').mockReturnValue(boundary + 10);
    page.emitConsole('error', 'new');

    expect(collector.getErrorsSince(boundary).map((e) => e.text)).toEqual(['new']);
    jest.restoreAllMocks();
  });

  it('caps retention and reports how many it dropped', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);

    for (let i = 0; i < 250; i++) page.emitConsole('error', `err-${i}`);

    expect(collector.getAllErrors()).toHaveLength(200);
    expect(collector.getDroppedCount()).toBe(50);
    // Oldest were evicted, newest retained.
    expect(collector.getAllErrors()[199].text).toBe('err-249');
  });

  it('truncates a single enormous message', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);

    page.emitConsole('error', 'x'.repeat(5000));

    const text = collector.getAllErrors()[0].text;
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain('(truncated)');
  });

  it('start() is idempotent', () => {
    const page = new FakePage();
    const { collector } = makeCollector([page]);
    collector.start();

    page.emitConsole('error', 'once');

    expect(collector.getAllErrors()).toHaveLength(1);
  });

  it('never throws when the context cannot be listened to', () => {
    const broken = {
      on() {
        throw new Error('context closed');
      },
      off() {},
      pages() {
        return [];
      },
    };
    const collector = new ReplayConsoleCollector(broken as any);

    // Fail-soft: observability must not break a run.
    expect(() => collector.start()).not.toThrow();
    expect(collector.getAllErrors()).toEqual([]);
  });

  it('dispose() is safe after the context is gone', () => {
    const collector = new ReplayConsoleCollector({
      on() {},
      off() {
        throw new Error('already closed');
      },
      pages() {
        return [];
      },
    } as any);
    collector.start();

    expect(() => collector.dispose()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Network errors — OPT-IN. A 404/500 shows red in the DevTools console, so
// users asking for "no console errors" may expect it to count. But counting
// third-party noise by default would make the assertion permanently red on
// healthy sites, so every default here leans conservative.
// ═══════════════════════════════════════════════════════════════════════════
describe('ReplayConsoleCollector — network errors', () => {
  const BASE = 'https://app.example.com/checkout';

  const makeNet = (opts: Record<string, unknown> = {}) => {
    const page = new FakePage();
    const context = new FakeContext([page]);
    const collector = new ReplayConsoleCollector(context as any, {
      enabled: true,
      baseUrl: BASE,
      ...opts,
    } as any);
    collector.start();
    return { page, collector };
  };

  it('collects nothing from the network when not enabled', () => {
    const page = new FakePage();
    // Default construction = network disabled.
    const { collector } = makeCollector([page]);
    page.emitResponse('https://app.example.com/api', 500);
    page.emitRequestFailed('https://app.example.com/x', 'net::ERR_FAILED');
    expect(collector.getAllErrors()).toHaveLength(0);
  });

  it('records a same-site HTTP 500', () => {
    const { page, collector } = makeNet();
    page.emitResponse('https://app.example.com/api/pay', 500, 'POST');

    const errs = collector.getAllErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0].source).toBe('network');
    expect(errs[0].text).toContain('HTTP 500');
    expect(errs[0].text).toContain('/api/pay');
  });

  it('ignores 4xx by default — only server failures count', () => {
    const { page, collector } = makeNet();
    page.emitResponse('https://app.example.com/api/flags', 404);
    page.emitResponse('https://app.example.com/api/auth', 401);
    expect(collector.getAllErrors()).toHaveLength(0);
  });

  it('includes 4xx when minStatus is lowered', () => {
    const { page, collector } = makeNet({ minStatus: 400 });
    page.emitResponse('https://app.example.com/missing.png', 404);
    expect(collector.getAllErrors()).toHaveLength(1);
  });

  it('ignores third-party failures — blocked trackers are not app bugs', () => {
    const { page, collector } = makeNet();
    page.emitResponse('https://analytics.vendor.io/collect', 500);
    page.emitResponse('https://ads.doubleclick.net/beacon', 503);
    expect(collector.getAllErrors()).toHaveLength(0);
  });

  it('counts third-party failures when sameSiteOnly is turned off', () => {
    const { page, collector } = makeNet({ sameSiteOnly: false });
    page.emitResponse('https://analytics.vendor.io/collect', 500);
    expect(collector.getAllErrors()).toHaveLength(1);
  });

  it('treats a subdomain of the app as same-site', () => {
    const { page, collector } = makeNet();
    page.emitResponse('https://api.example.com/v1/pay', 500);
    expect(collector.getAllErrors()).toHaveLength(1);
  });

  it('records a failed request (DNS / connection refused)', () => {
    const { page, collector } = makeNet();
    page.emitRequestFailed('https://app.example.com/api/x', 'net::ERR_CONNECTION_REFUSED');

    const errs = collector.getAllErrors();
    expect(errs).toHaveLength(1);
    expect(errs[0].text).toContain('ERR_CONNECTION_REFUSED');
  });

  it('ignores ERR_ABORTED — that is a cancelled navigation, not a failure', () => {
    const { page, collector } = makeNet();
    page.emitRequestFailed('https://app.example.com/api/x', 'net::ERR_ABORTED');
    expect(collector.getAllErrors()).toHaveLength(0);
  });

  it('skips network errors (and warns once) when sameSiteOnly has no baseUrl', () => {
    const page = new FakePage();
    const context = new FakeContext([page]);
    const collector = new ReplayConsoleCollector(context as any, {
      enabled: true,
      // sameSiteOnly defaults true, but no baseUrl to compare against.
    } as any);
    collector.start();

    page.emitResponse('https://app.example.com/api', 500);
    page.emitResponse('https://other.example.org/api', 500);

    // Dropped rather than silently counting everything.
    expect(collector.getAllErrors()).toHaveLength(0);
  });

  it('keeps console and network errors distinguishable by source', () => {
    const { page, collector } = makeNet();
    page.emitConsole('error', 'boom');
    page.emitResponse('https://app.example.com/api', 500);

    const sources = collector.getAllErrors().map((e) => e.source).sort();
    expect(sources).toEqual(['console', 'network']);
  });
});
