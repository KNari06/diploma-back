import { CompanionRunnerClient } from '../companion-runner-client';
import { companionRegistry } from '../companion-registry';

jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_RUNNER_ENABLED: true,
    GEMINI_API_KEY: '',
    RUNNER_USER_TOKEN_SECRET: '',
  },
}));

jest.mock('../companion-registry', () => ({
  companionRegistry: {
    proxyRequest: jest.fn(),
  },
}));

const mockProxyRequest = companionRegistry.proxyRequest as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CompanionRunnerClient', () => {
  it('creates a session through the companion proxy', async () => {
    mockProxyRequest.mockResolvedValue({
      ok: true,
      status: 200,
      body: { sessionId: 'sess-1', platform: 'android' },
    });
    const client = new CompanionRunnerClient('user-123');

    const result = await client.createSession('android', {
      deviceSelector: { source: 'local-physical', serial: 'device-1' },
      userId: 'user-123',
    });

    expect(result).toEqual({ sessionId: 'sess-1', platform: 'android' });
    expect(mockProxyRequest).toHaveBeenCalledWith(
      'user-123',
      'POST',
      '/api/sessions',
      {
        platform: 'android',
        deviceSelector: { source: 'local-physical', serial: 'device-1' },
      },
      expect.objectContaining({ 'Content-Type': 'application/json' }),
      expect.objectContaining({ timeoutMs: 180_000 }),
    );
  });

  it('uses the long runner timeout for runSteps', async () => {
    mockProxyRequest.mockResolvedValue({ ok: true, status: 200, body: { success: true, results: [] } });
    const client = new CompanionRunnerClient('user-123');

    await client.runSteps('sess-1', [{ type: 'tap', description: 'Continue' } as never], {
      screenshotEachStep: false,
      userId: 'user-123',
    });

    expect(mockProxyRequest).toHaveBeenCalledWith(
      'user-123',
      'POST',
      '/api/runs/sess-1/run-steps',
      expect.objectContaining({
        steps: [{ type: 'tap', description: 'Continue' }],
        screenshotEachStep: false,
      }),
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it('passes abort signals through long-running runSteps requests', async () => {
    mockProxyRequest.mockResolvedValue({ ok: true, status: 200, body: { success: true, results: [] } });
    const client = new CompanionRunnerClient('user-123');
    const controller = new AbortController();

    await client.runSteps('sess-1', [{ type: 'tap', description: 'Continue' } as never], {
      signal: controller.signal,
      userId: 'user-123',
    });

    expect(mockProxyRequest).toHaveBeenCalledWith(
      'user-123',
      'POST',
      '/api/runs/sess-1/run-steps',
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal, timeoutMs: 300_000 }),
    );
  });

  it('translates runner error responses into MobileRunnerError', async () => {
    mockProxyRequest.mockResolvedValue({
      ok: false,
      status: 404,
      body: { error: 'Session not found', code: 'SESSION_NOT_FOUND', reason: 'evicted' },
    });
    const client = new CompanionRunnerClient('user-123');

    await expect(client.destroySession('missing', { userId: 'user-123' })).rejects.toMatchObject({
      statusCode: 404,
      code: 'SESSION_NOT_FOUND',
      reason: 'evicted',
    });
  });

  it('proxies getSessionDestroyReason and returns the reason', async () => {
    mockProxyRequest.mockResolvedValue({ ok: true, status: 200, body: { reason: 'evicted' } });
    const client = new CompanionRunnerClient('user-123');

    const reason = await client.getSessionDestroyReason('sess-1');

    expect(reason).toBe('evicted');
    expect(mockProxyRequest).toHaveBeenCalledWith(
      'user-123',
      'GET',
      '/api/sessions/sess-1/destroy-reason',
      undefined,
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it('getSessionDestroyReason returns null when the proxy call fails (best-effort)', async () => {
    mockProxyRequest.mockRejectedValue(new Error('companion gone'));
    const client = new CompanionRunnerClient('user-123');
    await expect(client.getSessionDestroyReason('sess-1')).resolves.toBeNull();
  });

  it('proxies touchSession to the runner touch endpoint and swallows errors', async () => {
    mockProxyRequest.mockResolvedValue({ ok: true, status: 200, body: {} });
    const client = new CompanionRunnerClient('user-123');

    await client.touchSession('sess-1', { userId: 'user-123' });

    expect(mockProxyRequest).toHaveBeenCalledWith(
      'user-123',
      'POST',
      '/api/sessions/sess-1/touch',
      undefined,
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 5_000 }),
    );

    // Best-effort: a transport failure must not throw out of keepalive.
    mockProxyRequest.mockRejectedValue(new Error('companion gone'));
    await expect(client.touchSession('sess-1', { userId: 'user-123' })).resolves.toBeUndefined();
  });

  it('sends upload payloads over the companion proxy as base64 JSON', async () => {
    mockProxyRequest.mockResolvedValue({
      ok: true,
      status: 200,
      body: { path: '/tmp/app.apk', filename: 'app.apk', originalName: 'app.apk', size: 3 },
    });
    const client = new CompanionRunnerClient('user-123');

    await client.uploadApp(Buffer.from('apk'), 'app.apk', { userId: 'user-123' });

    expect(mockProxyRequest).toHaveBeenCalledWith(
      'user-123',
      'POST',
      '/api/upload/apk',
      { fieldName: 'file', fileBase64: Buffer.from('apk').toString('base64'), originalName: 'app.apk' },
      expect.any(Object),
      expect.objectContaining({ bodyEncoding: 'base64-file', timeoutMs: 120_000 }),
    );
  });
});
