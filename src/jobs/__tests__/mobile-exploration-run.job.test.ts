/**
 * Stage 3, Slice 3 — tests for MobileExplorationRunJobHandler.
 *
 * The job drives the runner via the brokered client, holds a relay for
 * the run, and persists the outcome. We mock the client, the relay, the
 * storage service, the websocket emitters and chat so we can assert the
 * orchestration: record → start → await relay → persist (complete/fail) →
 * always stop the relay.
 */

const startExploration = jest.fn();
const getExplorationResult = jest.fn();
jest.mock('@/services/mobile/mobile-runner-client', () => ({
  getMobileRunnerClient: () => ({ startExploration, getExplorationResult }),
}));

const relayStart = jest.fn();
const relayStop = jest.fn();
const waitUntilDone = jest.fn();
let lastRelayParams: Record<string, unknown>;
jest.mock('@/services/mobile/mobile-exploration-relay', () => ({
  MobileExplorationRelay: jest.fn().mockImplementation((params: Record<string, unknown>) => {
    lastRelayParams = params;
    return { start: relayStart, stop: relayStop, waitUntilDone };
  }),
}));

const createRun = jest.fn();
const completeMobileRun = jest.fn();
const failRun = jest.fn();
const saveMobileTestCasesFromSnapshot = jest.fn();
jest.mock('@/services/testing/exploration/exploration-storage.service', () => ({
  ExplorationStorageService: { createRun, completeMobileRun, failRun, saveMobileTestCasesFromSnapshot },
}));

const emitExplorationCompleted = jest.fn();
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitExplorationCompleted },
}));

const saveChatMessages = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services/utils/chat.service', () => ({
  ChatService: { saveChatMessages },
}));

import { MobileExplorationRunJobHandler } from '../mobile-exploration-run.job';

function makeJob() {
  return {
    id: 'job-1',
    data: {
      explorationId: 'expl-1',
      runnerSessionId: 'sess-1',
      runnerSocketUrl: 'ws://runner:4100',
      appId: 'com.demo.app',
      platform: 'android' as const,
      projectId: 'p-1',
      userId: 'u-1',
      chatSessionId: 'chat-1',
      goal: 'checkout',
    },
  } as unknown as Parameters<typeof MobileExplorationRunJobHandler.process>[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  createRun.mockResolvedValue({ id: 'row-1' });
  startExploration.mockResolvedValue({ runId: 'runner-run-9', status: 'running' });
  getExplorationResult.mockResolvedValue({ flows: [], summary: { coverageScore: 70 } });
  saveMobileTestCasesFromSnapshot.mockResolvedValue([]);
});

describe('MobileExplorationRunJobHandler', () => {
  it('records the run with mobile fields in config and the app id as entry', async () => {
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 2, summary: {}, reason: 'completed' });
    await MobileExplorationRunJobHandler.process(makeJob());

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      explorationId: 'expl-1',
      entryUrl: 'com.demo.app',
      config: expect.objectContaining({ surface: 'mobile', platform: 'android', appId: 'com.demo.app' }),
    }));
  });

  it('starts the runner exploration and relays under our explorationId', async () => {
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    await MobileExplorationRunJobHandler.process(makeJob());

    expect(startExploration).toHaveBeenCalledWith('sess-1', { appId: 'com.demo.app', goal: 'checkout', budget: undefined }, { userId: 'u-1' });
    // Relay subscribes to the runner's runId but re-labels to our id.
    expect(lastRelayParams).toEqual(expect.objectContaining({ runId: 'runner-run-9', explorationId: 'expl-1' }));
    expect(relayStart).toHaveBeenCalled();
  });

  it('fetches the result, saves discovered cases, and persists the REAL count', async () => {
    // Relay completion carries no count; the snapshot does.
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockResolvedValue({
      flows: [{ name: 'login', mobile: { cases: [{ name: 'happy', intentSteps: [{ a: 1 }] }] } }],
      summary: { coverageScore: 88 },
    });
    saveMobileTestCasesFromSnapshot.mockResolvedValue(['tc-1', 'tc-2', 'tc-3']);

    await MobileExplorationRunJobHandler.process(makeJob());

    expect(getExplorationResult).toHaveBeenCalledWith('runner-run-9', { userId: 'u-1' });
    expect(saveMobileTestCasesFromSnapshot).toHaveBeenCalledWith(
      [{ name: 'login', mobile: { cases: [{ name: 'happy', intentSteps: [{ a: 1 }] }] } }],
      'p-1', 'u-1', 'android',
    );
    // Count comes from saved ids, not the relay outcome.
    expect(completeMobileRun).toHaveBeenCalledWith('expl-1', expect.objectContaining({ testCasesCount: 3 }));
    expect(saveChatMessages).toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
    expect(relayStop).toHaveBeenCalled();
  });

  it('still completes the run (count 0) if fetching the result throws', async () => {
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockRejectedValue(new Error('409 not finished'));
    await MobileExplorationRunJobHandler.process(makeJob());
    // A successful crawl must not be flipped to failed by a result-fetch miss.
    expect(completeMobileRun).toHaveBeenCalledWith('expl-1', expect.objectContaining({ testCasesCount: 0 }));
    expect(failRun).not.toHaveBeenCalled();
  });

  it('fails the run + emits failed on a non-completed outcome', async () => {
    waitUntilDone.mockResolvedValue({ status: 'failed', errorMessage: 'runner gone', testCasesCount: 0, summary: {}, reason: 'timeout' });
    await MobileExplorationRunJobHandler.process(makeJob());

    expect(failRun).toHaveBeenCalledWith('expl-1', 'runner gone');
    expect(emitExplorationCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', explorationId: 'expl-1' }));
    expect(completeMobileRun).not.toHaveBeenCalled();
    expect(relayStop).toHaveBeenCalled();
  });

  it('fails the run and rethrows if starting the runner throws (relay never constructed)', async () => {
    startExploration.mockRejectedValue(new Error('start boom'));
    await expect(MobileExplorationRunJobHandler.process(makeJob())).rejects.toThrow('start boom');
    expect(failRun).toHaveBeenCalledWith('expl-1', 'start boom');
    // The relay is created AFTER start succeeds, so there's nothing to stop.
    expect(relayStart).not.toHaveBeenCalled();
    expect(relayStop).not.toHaveBeenCalled();
  });

  it('stops the relay when the run errors AFTER the relay started', async () => {
    // start ok → relay starts → waitUntilDone throws → finally must stop it.
    waitUntilDone.mockRejectedValue(new Error('relay blew up'));
    await expect(MobileExplorationRunJobHandler.process(makeJob())).rejects.toThrow('relay blew up');
    expect(relayStart).toHaveBeenCalled();
    expect(relayStop).toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledWith('expl-1', 'relay blew up');
  });

  it('throws if the run record cannot be created', async () => {
    createRun.mockResolvedValue(null);
    await expect(MobileExplorationRunJobHandler.process(makeJob())).rejects.toThrow(/create mobile exploration run/);
    expect(startExploration).not.toHaveBeenCalled();
  });
});
