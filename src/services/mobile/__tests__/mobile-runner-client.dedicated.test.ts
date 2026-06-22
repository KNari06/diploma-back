/**
 * Phase 6 — endDedicatedSession: ends a dedicated session WITHOUT destroying
 * its persistent container. Asserts the runner endpoint (method + path) so the
 * backend contract is pinned before the runner implements it.
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

describe('MobileRunnerClient.endDedicatedSession', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs /api/sessions/:id/end-dedicated (never DELETE — must not destroy the container)', async () => {
    mockFetchOnce({});
    const client = new MobileRunnerClient();
    await client.endDedicatedSession('sess-ded');

    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/sessions/sess-ded/end-dedicated');
    expect(init.method).toBe('POST');
  });

  it('attaches X-API-Key header', async () => {
    mockFetchOnce({});
    const client = new MobileRunnerClient();
    await client.endDedicatedSession('sess-ded');
    const headers = getFetchCall().init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-api-key');
  });
});
