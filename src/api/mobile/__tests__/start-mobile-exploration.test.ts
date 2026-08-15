/**
 * Stage 3, Slice 4 — tests for the startMobileExploration controller.
 *
 * It mints an explorationId and enqueues the brokered job. We assert
 * auth, validation, the enqueue payload (server-derived runner socket
 * URL, not the client hint), and the success/error responses. The queue
 * module is mocked so nothing touches Redis.
 */

const addMobileExplorationJob = jest.fn();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {},
  QueueManager: { addMobileExplorationJob: (...a: unknown[]) => addMobileExplorationJob(...a) },
}));

// currentRunnerSocketUrl reads env.MOBILE_RUNNER_URL — pin it. Keep the
// Supabase keys the db client validates at import time (session.controller
// transitively imports it), so the suite loads.
jest.mock('@/config/environment/env', () => ({
  env: {
    MOBILE_RUNNER_URL: 'http://runner:4100',
    MOBILE_RUNNER_ENABLED: true,
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    SUPABASE_BUCKET_NAME: 'test-bucket',
  },
}));
// The db client itself isn't exercised by this controller — stub it so the
// import chain doesn't open a real connection.
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {}, supabase: {} }));

jest.mock('@/services/core/project.service', () => ({
  ProjectService: { getProject: jest.fn() },
}));

import { startMobileExploration } from '../session.controller';
import { ProjectService } from '@/services/core/project.service';

const TEST_PROJECT_ID = 'c1b7587e-12d4-4b85-a2da-1be1b0e56a44';
const TEST_USER_ID = 'ee6e06a7-fbac-4d5e-9e2e-884d8ca0bfa9';
const mockGetProject = ProjectService.getProject as jest.Mock;

function mockRes() {
  const res: Record<string, jest.Mock> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

function mockReq(over: { user?: unknown; params?: unknown; body?: unknown } = {}) {
  return {
    user: 'user' in over ? over.user : { id: TEST_USER_ID },
    params: over.params ?? { projectId: TEST_PROJECT_ID },
    body: over.body ?? { platform: 'android', appId: 'com.demo.app', runnerSessionId: 'sess-1', goal: 'checkout' },
  } as unknown as import('express').Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  addMobileExplorationJob.mockResolvedValue({ id: 'job-1' });
  mockGetProject.mockResolvedValue({ id: TEST_PROJECT_ID });
});

describe('startMobileExploration', () => {
  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await startMobileExploration(mockReq({ user: undefined }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(addMobileExplorationJob).not.toHaveBeenCalled();
  });

  it('400s when appId or runnerSessionId is missing', async () => {
    const res = mockRes();
    await startMobileExploration(mockReq({ body: { platform: 'android', appId: 'com.demo.app' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(addMobileExplorationJob).not.toHaveBeenCalled();
  });

  it('enqueues with the SERVER-derived runner socket url (ws://) and returns explorationId', async () => {
    const res = mockRes();
    await startMobileExploration(
      // Client sends a bogus runnerSocketUrl hint — must be ignored.
      mockReq({ body: { platform: 'android', appId: 'com.demo.app', runnerSessionId: 'sess-1', runnerSocketUrl: 'ws://evil:9999' } }),
      res,
    );

    expect(addMobileExplorationJob).toHaveBeenCalledWith(expect.objectContaining({
      runnerSessionId: 'sess-1',
      appId: 'com.demo.app',
      platform: 'android',
      projectId: TEST_PROJECT_ID,
      userId: TEST_USER_ID,
      runnerSocketUrl: 'ws://runner:4100', // from env, not the client hint
    }));
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.explorationId).toMatch(/^mexpl-/);
  });

  it('defaults an unknown platform to android', async () => {
    const res = mockRes();
    await startMobileExploration(mockReq({ body: { platform: 'windows', appId: 'a', runnerSessionId: 's' } }), res);
    expect(addMobileExplorationJob).toHaveBeenCalledWith(expect.objectContaining({ platform: 'android' }));
  });

  it('500s when the enqueue throws', async () => {
    addMobileExplorationJob.mockRejectedValue(new Error('redis down'));
    const res = mockRes();
    await startMobileExploration(mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('enqueues a NORMALIZED briefing — strips credential-ish fields [Block D security]', async () => {
    // The controller must run req.body.briefing through normalizeMobileBriefing
    // before enqueue, so a smuggled credential can never reach the runner/LLM.
    // Guards against a future refactor that spreads req.body into the job.
    const res = mockRes();
    await startMobileExploration(
      mockReq({
        body: {
          platform: 'android', appId: 'com.demo.app', runnerSessionId: 'sess-1',
          briefing: {
            description: '  a shopping app  ',
            region: 'KZ',
            keyFlows: ['checkout'],
            password: 'hunter2',
            token: 'eyJ.abc.def',
            testCredentials: { user: 'a', pass: 'b' },
          },
        },
      }),
      res,
    );
    expect(addMobileExplorationJob).toHaveBeenCalledWith(expect.objectContaining({
      briefing: { description: 'a shopping app', region: 'KZ', keyFlows: ['checkout'] },
    }));
    // Belt: the enqueued payload contains none of the credential values.
    const enqueued = JSON.stringify(addMobileExplorationJob.mock.calls[0][0]);
    expect(enqueued).not.toContain('hunter2');
    expect(enqueued).not.toContain('eyJ.abc.def');
  });

  it('enqueues briefing:undefined when none is provided', async () => {
    const res = mockRes();
    await startMobileExploration(
      mockReq({ body: { platform: 'android', appId: 'a', runnerSessionId: 's' } }),
      res,
    );
    expect(addMobileExplorationJob).toHaveBeenCalledWith(
      expect.objectContaining({ briefing: undefined }),
    );
  });
});
