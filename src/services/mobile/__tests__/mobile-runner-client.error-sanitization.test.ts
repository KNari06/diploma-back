/**
 * MobileRunnerClient.request — sanitizes the runner's zod validation
 * `details` (internal schema field paths, e.g.
 * `body.steps[3].options.linkTestCase.linkedTestCaseId: Required`) out of
 * the user-facing error message. Those paths are implementation detail no
 * end user has context for, but they used to flow verbatim into
 * `MobileRunnerError.message` and from there into user-facing failure copy
 * (mobile-error-mapper.ts, mobile-test-run.job.ts). They're still logged
 * server-side so root-causing a rejection doesn't need a blind reproduction.
 *
 * Mocks global `fetch` (the transport boundary), per testing.md.
 */

import { MobileRunnerClient } from '../mobile-runner-client';
import { MobileRunnerError } from '../mobile-runner.types';
import type { MobileIntentStep } from '../mobile-runner.types';

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

const steps: MobileIntentStep[] = [
  { id: 's1', type: 'tap', description: 'Tap login' } as unknown as MobileIntentStep,
];

async function runAndCatch(client: MobileRunnerClient): Promise<unknown> {
  try {
    await client.runSteps('sess-1', steps);
    throw new Error('expected runSteps to reject');
  } catch (err) {
    return err;
  }
}

describe('MobileRunnerClient — sanitizes zod validation details out of user-facing errors', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaces internal schema field paths with a generic, actionable message', async () => {
    mockFetchOnce(
      {
        error: 'Validation failed',
        details: [
          { path: 'body.steps[3].options.linkTestCase.linkedTestCaseId', message: 'Required' },
        ],
      },
      400,
    );
    const client = new MobileRunnerClient();

    const err = await runAndCatch(client);

    expect(err).toBeInstanceOf(MobileRunnerError);
    const message = (err as Error).message;
    // no internal schema path leaks through
    expect(message).not.toContain('linkTestCase');
    expect(message).not.toContain('body.steps');
    expect(message).not.toContain('Required');
    // still informative, and still carries the runner's own top-level text
    expect(message).toContain('Validation failed');
    expect(message.toLowerCase()).toContain('invalid step configuration');
  });

  it('produces a generic message even with no top-level `error` text, and handles multiple details without leaking any of them', async () => {
    mockFetchOnce(
      {
        details: [
          { path: 'body.steps[0].type', message: 'Invalid enum value' },
          { path: 'body.steps[2].options.timeout', message: 'Expected number' },
        ],
      },
      400,
    );
    const client = new MobileRunnerClient();

    const err = await runAndCatch(client);

    const message = (err as Error).message;
    expect(message).not.toContain('body.steps');
    expect(message).not.toContain('Invalid enum value');
    expect(message.toLowerCase()).toContain('invalid step configuration');
  });

  it('leaves non-validation runner errors (no details array) untouched', async () => {
    mockFetchOnce({ error: 'Session not found' }, 404);
    const client = new MobileRunnerClient();

    const err = await runAndCatch(client);

    expect((err as Error).message).toContain('Session not found');
  });
});
