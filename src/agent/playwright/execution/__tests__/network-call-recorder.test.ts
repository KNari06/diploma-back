import { NetworkCallRecorder } from '../network-call-recorder';

/** Minimal Playwright-shaped page that lets a test emit responses. */
function makePage() {
  let handler: ((resp: any) => void) | undefined;
  return {
    on: (event: string, fn: (resp: any) => void) => {
      if (event === 'response') handler = fn;
    },
    emit: (resp: any) => handler?.(resp),
    get listenerAttached() {
      return !!handler;
    },
  };
}

const response = (method: string, url: string, status: number, resourceType = 'fetch') => ({
  status: () => status,
  request: () => ({ method: () => method, url: () => url, resourceType: () => resourceType }),
});

describe('NetworkCallRecorder', () => {
  it('records fetch/xhr/document responses', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    page.emit(response('POST', 'https://acme.com/api/auth', 200, 'fetch'));
    page.emit(response('GET', 'https://acme.com/api/me', 200, 'xhr'));
    page.emit(response('GET', 'https://acme.com/', 200, 'document'));

    expect(rec.getAllCalls()).toHaveLength(3);
  });

  it('ignores noise resource types (images, css, fonts)', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    page.emit(response('GET', 'https://acme.com/logo.png', 200, 'image'));
    page.emit(response('GET', 'https://acme.com/app.css', 200, 'stylesheet'));
    page.emit(response('GET', 'https://acme.com/f.woff2', 200, 'font'));

    expect(rec.getAllCalls()).toEqual([]);
  });

  it('captures method, url and status', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    page.emit(response('DELETE', 'https://acme.com/api/items/7', 204));

    expect(rec.getAllCalls()[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://acme.com/api/items/7',
      status: 204,
    });
  });

  it('is idempotent — a second attach does not double-count', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);
    rec.attach(page as any);

    page.emit(response('GET', 'https://acme.com/api/x', 200));

    expect(rec.getAllCalls()).toHaveLength(1);
  });

  it('never throws when Playwright throws on a destroyed request', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    const exploding = {
      status: () => 200,
      request: () => {
        throw new Error('Target closed');
      },
    };

    // Recording is best-effort: a missed call must never fail a replayed step.
    expect(() => page.emit(exploding)).not.toThrow();
    expect(rec.getAllCalls()).toEqual([]);
  });

  it('scopes calls by timestamp so a step can assert only its own traffic', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    page.emit(response('GET', 'https://acme.com/api/early', 200));
    const cutoff = Date.now() + 1;
    // Advance past the cutoff without a real sleep.
    const realNow = Date.now;
    Date.now = () => cutoff + 10;
    try {
      page.emit(response('GET', 'https://acme.com/api/late', 200));
    } finally {
      Date.now = realNow;
    }

    const since = rec.getCallsSince(cutoff);
    expect(since).toHaveLength(1);
    expect(since[0].url).toMatch(/late/);
  });

  it('bounds memory — a chatty page cannot grow the log without limit', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    for (let i = 0; i < 700; i++) {
      page.emit(response('GET', `https://acme.com/api/${i}`, 200));
    }

    const calls = rec.getAllCalls();
    expect(calls.length).toBeLessThanOrEqual(500);
    // Oldest dropped, newest kept.
    expect(calls[calls.length - 1].url).toMatch(/699/);
  });

  it('clear() drops the log for reuse across test cases', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);

    page.emit(response('GET', 'https://acme.com/api/x', 200));
    rec.clear();

    expect(rec.getAllCalls()).toEqual([]);
  });

  it('getAllCalls returns a copy, so callers cannot mutate internal state', () => {
    const page = makePage();
    const rec = new NetworkCallRecorder();
    rec.attach(page as any);
    page.emit(response('GET', 'https://acme.com/api/x', 200));

    rec.getAllCalls().push({ method: 'X', url: 'y', status: 1, timestamp: 0 });

    expect(rec.getAllCalls()).toHaveLength(1);
  });
});
