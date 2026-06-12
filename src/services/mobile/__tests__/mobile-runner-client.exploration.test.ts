/**
 * Slice 1 — tests for the backend-brokered exploration methods on
 * `MobileRunnerClient`. The point of brokering is that the runner API
 * key is injected server-side (X-API-Key) and never travels through the
 * browser; these tests assert URL composition, the key header, body
 * forwarding, and that the typed response is parsed back unchanged.
 *
 * Same fetch-mock harness as mobile-runner-client.observation.test.ts.
 */

import { MobileRunnerClient } from '../mobile-runner-client';
import type {
  MobileExplorationStartResponse,
  MobileExplorationReadiness,
} from '../mobile-runner.types';

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

function mockFetchOnce(body: unknown, init: { status?: number } = {}) {
  const response = new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
  global.fetch = jest.fn().mockResolvedValue(response);
}

function getFetchCall(): { url: string; init: RequestInit } {
  const mock = global.fetch as unknown as jest.Mock;
  const [url, init] = mock.mock.calls[0];
  return { url: String(url), init: (init || {}) as RequestInit };
}

beforeEach(() => jest.clearAllMocks());

describe('MobileRunnerClient — exploration brokering', () => {
  it('startExploration POSTs to /api/explorer/sessions/:id/start with the body', async () => {
    const expected: MobileExplorationStartResponse = { runId: 'expl-abc', status: 'running' };
    mockFetchOnce(expected, { status: 202 });

    const client = new MobileRunnerClient();
    const got = await client.startExploration('sess-1', { appId: 'com.demo.app', goal: 'checkout' });

    expect(got).toEqual(expected);
    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/explorer/sessions/sess-1/start');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ appId: 'com.demo.app', goal: 'checkout' });
  });

  it('injects the server-held X-API-Key (key never comes from the caller)', async () => {
    mockFetchOnce({ runId: 'r', status: 'running' }, { status: 202 });
    const client = new MobileRunnerClient();
    await client.startExploration('sess-1', { appId: 'com.demo.app' });
    const headers = getFetchCall().init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-api-key');
  });

  it('getExplorationStatus GETs /api/explorer/runs/:runId', async () => {
    mockFetchOnce({ runId: 'expl-abc', status: 'running', stats: {} });
    const client = new MobileRunnerClient();
    const snap = await client.getExplorationStatus('expl-abc');
    expect(snap.status).toBe('running');
    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/explorer/runs/expl-abc');
    expect(init.method).toBe('GET');
  });

  it('getExplorationResult GETs /api/explorer/runs/:runId/result', async () => {
    mockFetchOnce({ runId: 'expl-abc', status: 'finished', flows: [] });
    const client = new MobileRunnerClient();
    await client.getExplorationResult('expl-abc');
    expect(getFetchCall().url).toBe('http://localhost:4100/api/explorer/runs/expl-abc/result');
  });

  it('submitExplorationAnswer POSTs the answer payload', async () => {
    mockFetchOnce({ ok: true });
    const client = new MobileRunnerClient();
    await client.submitExplorationAnswer('expl-abc', { questionId: 'q1', value: '123456' });
    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/explorer/runs/expl-abc/answer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ questionId: 'q1', value: '123456' });
  });

  it('cancelExploration POSTs to /api/explorer/runs/:runId/cancel', async () => {
    mockFetchOnce({ ok: true });
    const client = new MobileRunnerClient();
    await client.cancelExploration('expl-abc');
    const { url, init } = getFetchCall();
    expect(url).toBe('http://localhost:4100/api/explorer/runs/expl-abc/cancel');
    expect(init.method).toBe('POST');
  });

  it('getExplorationReadiness GETs /api/explorer/readiness and returns the shape', async () => {
    const expected: MobileExplorationReadiness = {
      runner: { ok: true, version: '1' },
      llm: { openaiKeySet: true, geminiKeySet: false, explorerModel: 'gpt-x' },
      defaults: { budget: { maxSteps: 100 } },
    };
    mockFetchOnce(expected);
    const client = new MobileRunnerClient();
    const got = await client.getExplorationReadiness();
    expect(got).toEqual(expected);
    expect(getFetchCall().url).toBe('http://localhost:4100/api/explorer/readiness');
  });
});
