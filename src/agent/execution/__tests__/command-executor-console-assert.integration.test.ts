/**
 * `assertNoConsoleErrors` driven through the REAL CommandExecutor.
 *
 * Scope of this test — read before trusting it: the Playwright BROWSER is
 * simulated. A fake Page/Context emits the same `console` / `pageerror` events
 * Playwright emits, with the same `msg.type()` / `msg.text()` shape. That makes
 * everything above the browser boundary real (executor dispatch, collector
 * wiring, windowing, ignore-pattern filtering, failure message, tab-switch
 * survival) but does NOT prove Playwright itself delivers those events as
 * assumed. The pure collector contract is pinned separately in
 * replay-console-collector.test.ts.
 *
 * Why this matters: the executor's `assertNoConsoleErrors` case is the piece
 * users actually hit, and it had NO coverage — the earlier suite only tested
 * the collector in isolation and the AI prompt builder.
 */

import { CommandExecutor } from '../command-executor';
import type { PlaywrightCommand } from '@/types';

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAiCheckError: jest.fn(),
}));

const mockEvaluateAiCheck = jest.fn();
jest.mock('@/services/testing/ui/preview/ai-check.service', () => ({
  evaluateAiCheck: (...args: unknown[]) => mockEvaluateAiCheck(...args),
}));
jest.mock('@/services/testing/ui/preview/html-context.service', () => ({
  buildSemanticHtmlFromPage: jest.fn().mockResolvedValue({
    html: '<html></html>', originalLength: 10, semanticLength: 10, tokens: 3,
  }),
}));

/** Fake Page that emits Playwright-shaped console/pageerror events. */
class FakePage {
  private handlers: Record<string, Array<(arg: unknown) => void>> = {};
  constructor(private currentUrl = 'https://example.com/') {}

  on(event: string, handler: (arg: unknown) => void): void {
    (this.handlers[event] ??= []).push(handler);
  }
  off(): void {}
  url(): string {
    return this.currentUrl;
  }
  /** The `wait` command calls this; used here only to advance the step window. */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  }
  // Minimal surface the aiCheck path touches.
  async content(): Promise<string> {
    return '<html></html>';
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from('fake');
  }
  emitResponse(url: string, status: number, method = 'GET'): void {
    this.emit('response', {
      status: () => status,
      url: () => url,
      request: () => ({ method: () => method }),
    });
  }
  emitRequestFailed(url: string, errorText: string, method = 'GET'): void {
    this.emit('requestfailed', { url: () => url, method: () => method, failure: () => ({ errorText }) });
  }
  context(): FakeContext {
    return this.ctx as FakeContext;
  }
  ctx: FakeContext | null = null;

  /** Emit a console message exactly as Playwright shapes it. */
  consoleError(text: string, url?: string): void {
    this.emit('console', {
      type: () => 'error',
      text: () => text,
      location: () => (url ? { url } : undefined),
    });
  }
  consoleWarning(text: string): void {
    this.emit('console', {
      type: () => 'warning',
      text: () => text,
      location: () => undefined,
    });
  }
  uncaught(message: string): void {
    this.emit('pageerror', new Error(message));
  }
  private emit(event: string, arg: unknown): void {
    for (const h of this.handlers[event] ?? []) h(arg);
  }
}

class FakeContext {
  private pageHandlers: Array<(p: FakePage) => void> = [];
  private _pages: FakePage[] = [];

  constructor(pages: FakePage[]) {
    this._pages = pages;
    pages.forEach((p) => (p.ctx = this));
  }
  on(event: string, handler: (p: FakePage) => void): void {
    if (event === 'page') this.pageHandlers.push(handler);
  }
  off(): void {
    this.pageHandlers = [];
  }
  pages(): FakePage[] {
    return this._pages;
  }
  /** The a11y channel opens a CDP session; return one that yields no nodes. */
  async newCDPSession(): Promise<{ send: () => Promise<{ nodes: [] }>; detach: () => Promise<void> }> {
    return { send: async () => ({ nodes: [] }), detach: async () => {} };
  }
  /** Simulate a popup: register it and notify listeners, like Playwright does. */
  openPage(page: FakePage): void {
    page.ctx = this;
    this._pages.push(page);
    for (const h of this.pageHandlers) h(page);
  }
}

const makeExecutor = (page: FakePage) =>
  new CommandExecutor(page as never, { selfHealingEnabled: false });

/** Build the intent command the converter produces for this step type. */
const consoleCommand = (
  intentMeta: Record<string, unknown> = {},
): PlaywrightCommand =>
  ({
    action: 'assertNoConsoleErrors',
    description: 'No console errors',
    intentMeta: { stepId: 'step-1', intentDescription: 'No console errors', stepIndex: 0, ...intentMeta },
  }) as unknown as PlaywrightCommand;

/** A trivial second command used only to advance the step window. */
const noopCommand = (): PlaywrightCommand =>
  ({ action: 'wait', value: '1' }) as unknown as PlaywrightCommand;

/**
 * A failed assertion THROWS out of executeCommand — the same contract every
 * other assert in this executor uses (see `assertUrl`, `assertCount`). Capture
 * the message so we can assert on what the user actually sees in the report.
 */
const runExpectingFailure = async (
  ex: CommandExecutor,
  cmd: PlaywrightCommand,
): Promise<string> => {
  try {
    await ex.executeCommand(cmd);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('Expected the console assertion to fail, but it passed');
};

describe('CommandExecutor — assertNoConsoleErrors', () => {
  let page: FakePage;

  beforeEach(() => {
    page = new FakePage();
    new FakeContext([page]);
  });

  it('passes on a clean page', async () => {
    const ex = makeExecutor(page);
    const res = await ex.executeCommand(consoleCommand());
    expect(res.success).toBe(true);
  });

  it('fails and names the console error', async () => {
    const ex = makeExecutor(page);
    // Arm collection, then produce an error, then assert in a later step.
    ex.ensureConsoleCollector();
    page.consoleError('Cannot read properties of undefined');

    const message = await runExpectingFailure(ex, consoleCommand({ consoleScope: 'run' }));

    expect(message).toContain('Cannot read properties of undefined');
    expect(message).toContain('1 console error');
  });

  it('does NOT fail on warnings — errors only', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.consoleWarning('Deprecated API in use');
    page.consoleWarning('Slow network detected');

    const res = await ex.executeCommand(consoleCommand({ consoleScope: 'run' }));
    expect(res.success).toBe(true);
  });

  it('fails on an uncaught exception (what users see in red)', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.uncaught('TypeError: x is not a function');

    const message = await runExpectingFailure(ex, consoleCommand({ consoleScope: 'run' }));
    expect(message).toContain('TypeError: x is not a function');
    expect(message).toContain('uncaught');
  });

  it('ignores errors matching an ignore pattern, but not others', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.consoleError('Failed to load favicon.ico 404');
    page.consoleError('Real application failure');

    const message = await runExpectingFailure(
      ex,
      consoleCommand({ consoleScope: 'run', consoleIgnorePatterns: ['favicon'] }),
    );

    expect(message).toContain('Real application failure');
    expect(message).not.toContain('favicon');
    expect(message).toContain('1 console error');
  });

  it('passes when every error is ignored', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.consoleError('favicon 404');
    page.consoleError('analytics beacon blocked');

    const res = await ex.executeCommand(
      consoleCommand({ consoleScope: 'run', consoleIgnorePatterns: ['favicon', 'analytics'] }),
    );
    expect(res.success).toBe(true);
  });

  it('treats an invalid regex as a literal substring instead of throwing', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.consoleError('Unexpected token ( in JSON');

    const res = await ex.executeCommand(
      // '(' is not valid regex — must degrade to substring, not crash the step.
      consoleCommand({ consoleScope: 'run', consoleIgnorePatterns: ['token ('] }),
    );
    expect(res.success).toBe(true);
  });

  it("scope:'step' ignores an error from before the previous step boundary", async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.consoleError('old error from an earlier step');

    // Two later steps: the window for the assertion starts at the previous
    // step boundary, so the old error must fall outside it.
    await new Promise((r) => setTimeout(r, 5));
    await ex.executeCommand(noopCommand());
    await new Promise((r) => setTimeout(r, 5));
    await ex.executeCommand(noopCommand());

    const res = await ex.executeCommand(consoleCommand({ consoleScope: 'step' }));
    expect(res.success).toBe(true);
  });

  it("scope:'run' DOES catch that same earlier error", async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    page.consoleError('old error from an earlier step');

    await new Promise((r) => setTimeout(r, 5));
    await ex.executeCommand(noopCommand());
    await new Promise((r) => setTimeout(r, 5));

    const message = await runExpectingFailure(ex, consoleCommand({ consoleScope: 'run' }));
    expect(message).toContain('old error');
  });

  it('still catches errors after the executor swaps to a new tab', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();

    // Popup opens and becomes the active page, as the click/tab paths do.
    const popup = new FakePage('https://example.com/popup');
    page.context().openPage(popup);
    (ex as unknown as { page: FakePage }).page = popup;

    popup.consoleError('error inside the popup');

    const message = await runExpectingFailure(ex, consoleCommand({ consoleScope: 'run' }));
    expect(message).toContain('error inside the popup');
  });

  it('caps the failure message instead of dumping every error', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    for (let i = 0; i < 12; i++) page.consoleError(`error number ${i}`);

    const message = await runExpectingFailure(ex, consoleCommand({ consoleScope: 'run' }));
    expect(message).toContain('12 console error');
    expect(message).toContain('and 7 more');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ai_check + console: auto-attach and the actionable failure.
// This is the user-reported case — "Check that there are no console errors"
// authored as an AI check, which previously dead-ended on
// "Console errors cannot be verified from the provided HTML…".
// ═══════════════════════════════════════════════════════════════════════════
describe('CommandExecutor — ai_check console auto-attach', () => {
  let page: FakePage;

  const aiCheckCommand = (assertionText: string, aiContextMode?: string): PlaywrightCommand =>
    ({
      action: 'aiCheck',
      description: assertionText,
      intentMeta: {
        stepId: 'ai-1',
        intentDescription: assertionText,
        stepIndex: 0,
        assertionText,
        ...(aiContextMode ? { aiContextMode } : {}),
      },
    }) as unknown as PlaywrightCommand;

  beforeEach(() => {
    page = new FakePage();
    new FakeContext([page]);
    mockEvaluateAiCheck.mockReset();
    mockEvaluateAiCheck.mockResolvedValue({
      pass: true,
      explanation: 'ok',
      confidence: 0.9,
      artifactsUsed: { html: true, a11y: false, screenshot: false, console: true },
    });
  });

  it('auto-attaches the console channel for a console assertion at the DEFAULT context mode', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();          // armed earlier in the run
    await ex.executeCommand(noopCommand()); // advance the step window
    page.consoleError('Payment gateway timeout');

    await ex.executeCommand(aiCheckCommand('there are no payment-related console errors'));

    expect(mockEvaluateAiCheck).toHaveBeenCalledTimes(1);
    const input = mockEvaluateAiCheck.mock.calls[0][0];
    // The model got the console data even though nobody selected a console mode.
    expect(input.consoleErrors).toBeDefined();
    expect(input.consoleErrors.join('\n')).toContain('Payment gateway timeout');
  });

  it('does NOT attach the console channel for an ordinary DOM assertion', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    await ex.executeCommand(noopCommand());

    await ex.executeCommand(aiCheckCommand('The cart shows 2 items'));

    const input = mockEvaluateAiCheck.mock.calls[0][0];
    expect(input.consoleErrors).toBeUndefined();
  });

  it('does NOT hijack an assertion about an error visible on the page', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    await ex.executeCommand(noopCommand());

    await ex.executeCommand(aiCheckCommand('An error message is displayed'));

    const input = mockEvaluateAiCheck.mock.calls[0][0];
    expect(input.consoleErrors).toBeUndefined();
  });

  it('fails with a POINTER to the right step type instead of calling the model', async () => {
    // Nothing armed the collector, so there is no console history to judge.
    const ex = makeExecutor(page);

    const message = await runExpectingFailure(
      ex,
      aiCheckCommand('Check that there are no console errors present'),
    );

    expect(message).toContain('No console errors');
    expect(message).toContain('needs no AI');
    // Crucially: we did NOT spend an LLM call to say "I cannot see the console".
    expect(mockEvaluateAiCheck).not.toHaveBeenCalled();
  });

  it('suggests the console context mode for a FUZZY assertion it cannot answer', async () => {
    const ex = makeExecutor(page);

    const message = await runExpectingFailure(
      ex,
      aiCheckCommand('no payment-related console errors'),
    );

    expect(message).toContain('context mode');
    expect(mockEvaluateAiCheck).not.toHaveBeenCalled();
  });

  it('never reports an empty list when collection only started at this step', async () => {
    // Collector NOT armed beforehand: an empty array would read to the model as
    // "confirmed absence" and wrongly PASS the assertion on unobserved data.
    const ex = makeExecutor(page);

    const message = await runExpectingFailure(ex, aiCheckCommand('no console errors'));

    expect(message).toBeTruthy();
    expect(mockEvaluateAiCheck).not.toHaveBeenCalled();
  });

  it('passes a genuinely clean console through as a confirmed absence', async () => {
    const ex = makeExecutor(page);
    ex.ensureConsoleCollector();
    await ex.executeCommand(noopCommand()); // armed, nothing logged

    const res = await ex.executeCommand(aiCheckCommand('no console errors'));

    expect(res.success).toBe(true);
    const input = mockEvaluateAiCheck.mock.calls[0][0];
    // [] — "we looked and found none", distinct from undefined.
    expect(input.consoleErrors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Network errors through the REAL executor. Opt-in, same-site, 5xx-only —
// the defaults that keep the assertion usable on a healthy app.
// ═══════════════════════════════════════════════════════════════════════════
describe('CommandExecutor — assertNoConsoleErrors with network errors', () => {
  const BASE = 'https://app.example.com/checkout';

  const makeNetExecutor = () => {
    const page = new FakePage(BASE);
    new FakeContext([page]);
    const ex = new CommandExecutor(page as never, {
      selfHealingEnabled: false,
      metadata: { url: BASE },
    });
    return { page, ex };
  };

  const netCommand = (extra: Record<string, unknown> = {}) =>
    consoleCommand({ consoleScope: 'run', consoleIncludeNetworkErrors: true, ...extra });

  it('ignores network failures when the option is off', async () => {
    const { page, ex } = makeNetExecutor();
    ex.ensureConsoleCollector();
    page.emitResponse(`${BASE}/api/pay`, 500, 'POST');

    const res = await ex.executeCommand(consoleCommand({ consoleScope: 'run' }));
    expect(res.success).toBe(true);
  });

  it('fails on a same-site HTTP 500 when opted in', async () => {
    const { page, ex } = makeNetExecutor();
    ex.ensureConsoleCollector({ includeNetworkErrors: true });
    page.emitResponse(`${BASE}/api/pay`, 500, 'POST');

    const message = await runExpectingFailure(ex, netCommand());
    expect(message).toContain('HTTP 500');
    expect(message).toContain('network');
    expect(message).toContain('including network failures');
  });

  it('ignores third-party 500s even when opted in', async () => {
    const { page, ex } = makeNetExecutor();
    ex.ensureConsoleCollector({ includeNetworkErrors: true });
    page.emitResponse('https://analytics.vendor.io/collect', 500);

    const res = await ex.executeCommand(netCommand());
    expect(res.success).toBe(true);
  });

  it('ignores a same-site 404 by default', async () => {
    const { page, ex } = makeNetExecutor();
    ex.ensureConsoleCollector({ includeNetworkErrors: true });
    page.emitResponse(`${BASE}/favicon.ico`, 404);

    const res = await ex.executeCommand(netCommand());
    expect(res.success).toBe(true);
  });

  it('ignore patterns apply to network errors too', async () => {
    const { page, ex } = makeNetExecutor();
    ex.ensureConsoleCollector({ includeNetworkErrors: true });
    page.emitResponse(`${BASE}/api/legacy`, 500);

    const res = await ex.executeCommand(
      netCommand({ consoleIgnorePatterns: ['/api/legacy'] }),
    );
    expect(res.success).toBe(true);
  });

  it('reports console and network failures together', async () => {
    const { page, ex } = makeNetExecutor();
    ex.ensureConsoleCollector({ includeNetworkErrors: true });
    page.consoleError('render failed');
    page.emitResponse(`${BASE}/api/pay`, 503, 'POST');

    const message = await runExpectingFailure(ex, netCommand());
    expect(message).toContain('render failed');
    expect(message).toContain('HTTP 503');
    expect(message).toContain('2 console error');
  });
});
