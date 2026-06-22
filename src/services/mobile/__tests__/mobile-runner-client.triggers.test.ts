/**
 * MobileRunnerClient.runSteps — triggers forwarding.
 *
 * Triggers are the canonical cross-repo event→action contract. The backend
 * forwards them VERBATIM in the run-steps POST body; the runner re-validates
 * with the same shape. These tests pin the wire body so the contract can't
 * drift silently:
 *   1. triggers appear in the body exactly as passed when present.
 *   2. the field is OMITTED from the body when absent/empty (so a no-trigger
 *      run is byte-identical to pre-trigger behaviour).
 *
 * Mocks global `fetch` (the transport boundary), per testing.md.
 */

import { MobileRunnerClient } from '../mobile-runner-client';
import type { MobileIntentStep, Trigger } from '../mobile-runner.types';

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

function getRequestBody(): Record<string, unknown> {
  const mock = global.fetch as unknown as jest.Mock;
  const [, init] = mock.mock.calls[0];
  return JSON.parse(String((init as RequestInit).body));
}

const RUN_STEPS_OK = {
  sessionId: 's1',
  totalSteps: 1,
  passedSteps: 1,
  failedSteps: 0,
  skippedSteps: 0,
  passRate: 1,
  steps: [],
  durationMs: 10,
  status: 'passed',
};

const steps: MobileIntentStep[] = [
  { id: 's1', type: 'tap', description: 'Tap login' } as unknown as MobileIntentStep,
];

const triggers: Trigger[] = [
  { id: 'trg-1', condition: { kind: 'permission_dialog' }, action: { kind: 'permission', decision: 'allow' } },
  { id: 'trg-2', condition: { kind: 'dialog_text', contains: 'Allow' }, action: { kind: 'tap', text: 'OK' } },
];

describe('MobileRunnerClient.runSteps — triggers in the request body', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs /api/runs/:sessionId/run-steps with triggers verbatim', async () => {
    mockFetchOnce(RUN_STEPS_OK);
    const client = new MobileRunnerClient();
    await client.runSteps('sess-1', steps, { triggers });

    const mock = global.fetch as unknown as jest.Mock;
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:4100/api/runs/sess-1/run-steps');
    expect((init as RequestInit).method).toBe('POST');
    expect(getRequestBody().triggers).toEqual(triggers);
  });

  it('omits triggers from the body when none are passed', async () => {
    mockFetchOnce(RUN_STEPS_OK);
    const client = new MobileRunnerClient();
    await client.runSteps('sess-1', steps, { screenshotEachStep: true });

    expect(getRequestBody()).not.toHaveProperty('triggers');
  });

  it('omits triggers from the body when an empty array is passed', async () => {
    mockFetchOnce(RUN_STEPS_OK);
    const client = new MobileRunnerClient();
    await client.runSteps('sess-1', steps, { triggers: [] });

    expect(getRequestBody()).not.toHaveProperty('triggers');
  });
});
