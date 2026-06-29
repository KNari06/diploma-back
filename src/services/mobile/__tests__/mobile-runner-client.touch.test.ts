/**
 * touchSession: bumps the runner-side session `lastActivityAt` so an
 * actively-edited editor session isn't capacity-evicted during think-time.
 * Pins the runner contract (method + path) and the best-effort guarantee
 * (a 404 / transport error must never throw — keepalive can't break).
 */

import { MobileRunnerClient } from '../mobile-runner-client';

jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_RUNNER_URL: 'http://localhost:4100',
    MOBILE_RUNNER_API_KEY: 'test-api-key',
    MOBILE_RUNNER_ENABLED: true,
    RUNNER_USER_TOKEN_SECRET: '',
    MOBILE_RUNNER_ALLOWED_HOSTS: '',
    GEMINI_API_KEY: '',
  },
}));

function mockFetchOnce(body: unknown, status = 200) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  global.fetch = jest.fn().mockResolvedValue(response);
}

function getFetchCall(): { url: string; init: RequestInit } {
  const mock = global.fetch as unknown as jest.Mock;
  const [url, init] = mock.mock.calls[0];
  return { url: String(url), init: (init || {}) as RequestInit };
}

describe('MobileRunnerClient.touchSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs /api/sessions/:id/touch', async () => {
    mockFetchOnce({ ok: true });
    const client = new MobileRunnerClient();
    await client.touchSession('sess-1');

    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/sessions/sess-1/touch');
    expect(init.method).toBe('POST');
  });

  it('attaches X-API-Key header', async () => {
    mockFetchOnce({ ok: true });
    const client = new MobileRunnerClient();
    await client.touchSession('sess-1');
    const headers = getFetchCall().init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-api-key');
  });

  it('does not throw when the runner returns 404 (session already gone)', async () => {
    mockFetchOnce({ error: 'session not found' }, 404);
    const client = new MobileRunnerClient();
    await expect(client.touchSession('sess-gone')).resolves.toBeUndefined();
  });

  it('does not throw when the transport fails (runner unreachable)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new MobileRunnerClient();
    await expect(client.touchSession('sess-1')).resolves.toBeUndefined();
  });
});

describe('MobileRunnerClient.sessionExists', () => {
  beforeEach(() => jest.clearAllMocks());

  // REGRESSION (2026-06-29): the runner returns `{ sessions: [...] }`, but the
  // client used to parse it as a bare array and `Array.isArray` it — always
  // false on an object → sessionExists returned false for EVERY live session →
  // unconditional 410 on the first lint + perpetual "creating fresh" warmup.
  it('returns true for a live session in the runner\'s { sessions: [...] } envelope', async () => {
    mockFetchOnce({ sessions: [{ id: 'sess-1' }, { id: 'sess-2' }] });
    const client = new MobileRunnerClient();
    await expect(client.sessionExists('sess-1')).resolves.toBe(true);
  });

  it('returns false when the session id is absent from the list', async () => {
    mockFetchOnce({ sessions: [{ id: 'other' }] });
    const client = new MobileRunnerClient();
    await expect(client.sessionExists('sess-1')).resolves.toBe(false);
  });

  it('still tolerates a bare-array response (defensive — older/forward shape)', async () => {
    mockFetchOnce([{ id: 'sess-1' }]);
    const client = new MobileRunnerClient();
    await expect(client.sessionExists('sess-1')).resolves.toBe(true);
  });

  it('returns false (never throws) on a transport error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new MobileRunnerClient();
    await expect(client.sessionExists('sess-1')).resolves.toBe(false);
  });
});

describe('MobileRunnerClient.getSessionDestroyReason', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GETs /api/sessions/:id/destroy-reason and returns the reason', async () => {
    mockFetchOnce({ sessionId: 'sess-1', reason: 'evicted' });
    const client = new MobileRunnerClient();
    const reason = await client.getSessionDestroyReason('sess-1');

    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/sessions/sess-1/destroy-reason');
    expect(init.method).toBe('GET');
    expect(reason).toBe('evicted');
  });

  it('returns null when the runner reports an unknown cause', async () => {
    mockFetchOnce({ sessionId: 'sess-1', reason: null });
    const client = new MobileRunnerClient();
    await expect(client.getSessionDestroyReason('sess-1')).resolves.toBeNull();
  });

  it('returns null (never throws) on a transport error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new MobileRunnerClient();
    await expect(client.getSessionDestroyReason('sess-1')).resolves.toBeNull();
  });
});
