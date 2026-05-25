/**
 * Phase B5 — tests for the new observation fetch methods on
 * `MobileRunnerClient`: fetchForeground / fetchStepHistory /
 * fetchRecentLogs.
 *
 * Mocks the global `fetch` so we can assert:
 *   1. URL composition (path + query string) is exactly what the
 *      runner exposes.
 *   2. Request headers carry X-API-Key + optional X-User-Token.
 *   3. The typed response shape is parsed back unchanged.
 *   4. AbortSignal propagates.
 *
 * We construct the client with `baseUrl: http://localhost:4100` so the
 * SSRF validator (Phase B-SEC) auto-allowlists the host. Tests don't
 * touch the validator directly — that's covered separately.
 */

import { MobileRunnerClient } from '../mobile-runner-client';
import type {
  MobileForegroundResponse,
  MobileStepHistoryResponse,
  MobileLogsResponse,
} from '../mobile-runner.types';

// Mock env so the test doesn't depend on shell env vars. We allow a
// localhost runner URL (default) and DISABLE the SSRF allowlist (empty
// CSV) so the validator runs against its own internal-address rules.
// localhost is auto-allowed because it's the env URL.
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

// Helper: mock global fetch with a single canned response.
function mockFetchOnce(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
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

// ═══════════════════════════════════════════════════════════════════════════
// fetchForeground
// ═══════════════════════════════════════════════════════════════════════════

describe('MobileRunnerClient.fetchForeground', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GETs /api/sessions/:id/foreground with no query string', async () => {
    const expected: MobileForegroundResponse = {
      sessionId: 's1',
      platform: 'android',
      expectedApp: 'kz.kolesa',
      foreground: {
        screenState: 'awake',
        windows: [],
        primary: null,
        capturedAt: '2026-05-25T10:00:00.000Z',
        durationMs: 50,
      },
      mismatch: null,
      capturedAt: '2026-05-25T10:00:00.000Z',
    };
    mockFetchOnce(expected);

    const client = new MobileRunnerClient();
    const got = await client.fetchForeground('s1');

    expect(got).toEqual(expected);
    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/sessions/s1/foreground');
    expect(init.method).toBe('GET');
  });

  it('attaches X-API-Key header', async () => {
    mockFetchOnce({ sessionId: 's1', platform: 'android', foreground: {}, mismatch: null, capturedAt: '' });
    const client = new MobileRunnerClient();
    await client.fetchForeground('s1');
    const { init } = getFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-api-key');
  });

  it('passes signal through (caller can abort)', async () => {
    mockFetchOnce({ sessionId: 's1', platform: 'android', foreground: {}, mismatch: null, capturedAt: '' });
    const client = new MobileRunnerClient();
    const ac = new AbortController();
    await client.fetchForeground('s1', { signal: ac.signal });
    const { init } = getFetchCall();
    // The client uses an internal AbortSignal.any when both its own
    // timer signal AND the caller's signal are present; what we
    // verify here is just "a signal was passed".
    expect(init.signal).toBeDefined();
  });

  it('surfaces 410 as MobileRunnerError (session destroying)', async () => {
    mockFetchOnce({ error: 'session destroying' }, { status: 410 });
    const client = new MobileRunnerClient();
    await expect(client.fetchForeground('s1')).rejects.toMatchObject({
      statusCode: 410,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fetchStepHistory
// ═══════════════════════════════════════════════════════════════════════════

describe('MobileRunnerClient.fetchStepHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GETs /api/sessions/:id/step-history with no params by default', async () => {
    const expected: MobileStepHistoryResponse = {
      sessionId: 's1',
      steps: [],
      redacted: true,
      capturedAt: '2026-05-25',
    };
    mockFetchOnce(expected);

    const client = new MobileRunnerClient();
    const got = await client.fetchStepHistory('s1');

    expect(got).toEqual(expected);
    const { url } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/sessions/s1/step-history');
  });

  it('forwards limit as a query param', async () => {
    mockFetchOnce({ sessionId: 's1', steps: [], redacted: true, capturedAt: '' });
    const client = new MobileRunnerClient();
    await client.fetchStepHistory('s1', { limit: 5 });
    const { url } = getFetchCall();
    expect(url).toContain('limit=5');
  });

  it('forwards includeRawInputs=true (debug path)', async () => {
    mockFetchOnce({ sessionId: 's1', steps: [], redacted: false, capturedAt: '' });
    const client = new MobileRunnerClient();
    await client.fetchStepHistory('s1', { includeRawInputs: true });
    const { url } = getFetchCall();
    expect(url).toContain('includeRawInputs=true');
  });

  it('does NOT add includeRawInputs when false/undefined (avoid logging false flag)', async () => {
    mockFetchOnce({ sessionId: 's1', steps: [], redacted: true, capturedAt: '' });
    const client = new MobileRunnerClient();
    await client.fetchStepHistory('s1', { includeRawInputs: false });
    const { url } = getFetchCall();
    expect(url).not.toContain('includeRawInputs');
  });

  it('returns redacted=true when runner stripped sensitive fields', async () => {
    const body: MobileStepHistoryResponse = {
      sessionId: 's1',
      steps: [
        {
          stepIndex: 0,
          commandType: 'type_text',
          paramsSummary: { selector: '#pw', inputLength: 13, inputClass: 'mixed' },
          success: true,
          durationMs: 50,
          startedAt: 1,
          completedAt: 51,
        },
      ],
      redacted: true,
      capturedAt: '2026-05-25',
    };
    mockFetchOnce(body);
    const client = new MobileRunnerClient();
    const got = await client.fetchStepHistory('s1');
    expect(got.steps[0].paramsSummary.text).toBeUndefined();
    expect(got.steps[0].paramsSummary.inputClass).toBe('mixed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// fetchRecentLogs
// ═══════════════════════════════════════════════════════════════════════════

describe('MobileRunnerClient.fetchRecentLogs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GETs /api/sessions/:id/logs with no params', async () => {
    mockFetchOnce({
      sessionId: 's1',
      platform: 'android',
      level: 'warn',
      lines: [],
      truncated: false,
      capturedAt: '',
    });
    const client = new MobileRunnerClient();
    await client.fetchRecentLogs('s1');
    const { url } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/sessions/s1/logs');
  });

  it('forwards level / limit / since correctly', async () => {
    mockFetchOnce({
      sessionId: 's1',
      platform: 'android',
      level: 'error',
      lines: [],
      truncated: false,
      capturedAt: '',
    });
    const client = new MobileRunnerClient();
    await client.fetchRecentLogs('s1', { level: 'error', limit: 50, since: '2026-05-25 10:00:00' });
    const { url } = getFetchCall();
    expect(url).toContain('level=error');
    expect(url).toContain('limit=50');
    // URLSearchParams encodes the space as `+` (the standard form-urlencoded
    // form). Decoders on the runner side handle both `+` and `%20`.
    expect(url).toMatch(/since=2026-05-25[+ ]10/);
  });

  it('returns truncated flag and trimmed lines verbatim', async () => {
    const body: MobileLogsResponse = {
      sessionId: 's1',
      platform: 'android',
      level: 'warn',
      lines: ['line1', 'line2 …[truncated]'],
      truncated: true,
      capturedAt: '2026-05-25',
    };
    mockFetchOnce(body);
    const client = new MobileRunnerClient();
    const got = await client.fetchRecentLogs('s1');
    expect(got.truncated).toBe(true);
    expect(got.lines).toEqual(['line1', 'line2 …[truncated]']);
  });

  it('surfaces 409 (platform unsupported) as MobileRunnerError', async () => {
    mockFetchOnce({ error: 'logs endpoint not supported for this platform' }, { status: 409 });
    const client = new MobileRunnerClient();
    await expect(client.fetchRecentLogs('s1')).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
