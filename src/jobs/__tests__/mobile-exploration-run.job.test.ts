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
// Polled on every non-completed outcome to tell a user cancel from a crash.
const isRunCancelled = jest.fn();
jest.mock('@/services/testing/exploration/exploration-storage.service', () => ({
  ExplorationStorageService: { createRun, completeMobileRun, failRun, saveMobileTestCasesFromSnapshot, isRunCancelled },
}));

const mergeRunIntoSkeleton = jest.fn();
jest.mock('@/services/testing/exploration/app-skeleton.service', () => ({
  AppSkeletonService: { mergeRunIntoSkeleton },
}));

const deductCreditsForTest = jest.fn();
jest.mock('@/services/core/credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductCreditsForTest },
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
  // The runner's result snapshot has NO top-level `summary` — the graph + its
  // rollups (fingerprintVersion, coverageScore) ride on the `mobile` header.
  getExplorationResult.mockResolvedValue({ flows: [] });
  saveMobileTestCasesFromSnapshot.mockResolvedValue([]);
  isRunCancelled.mockResolvedValue(false);
  mergeRunIntoSkeleton.mockResolvedValue(undefined);
  deductCreditsForTest.mockResolvedValue(undefined);
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
    });
    saveMobileTestCasesFromSnapshot.mockResolvedValue(['tc-1', 'tc-2', 'tc-3']);

    await MobileExplorationRunJobHandler.process(makeJob());

    expect(getExplorationResult).toHaveBeenCalledWith('runner-run-9', { userId: 'u-1' });
    expect(saveMobileTestCasesFromSnapshot).toHaveBeenCalledWith(
      [{ name: 'login', mobile: { cases: [{ name: 'happy', intentSteps: [{ a: 1 }] }] } }],
      // explorationId is passed so the rows carry it — without the stamp,
      // /explorations/:id/test-cases returns nothing for a mobile run.
      'p-1', 'u-1', 'android', 'expl-1',
    );
    // Count comes from saved ids, not the relay outcome.
    expect(completeMobileRun).toHaveBeenCalledWith('expl-1', expect.objectContaining({ testCasesCount: 3 }));
    expect(saveChatMessages).toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
    expect(relayStop).toHaveBeenCalled();
  });

  it('merges the screen graph into the app skeleton, reading coverage from the mobile header', async () => {
    // Regression for BUG-A/BUG-B: the graph + rollups live on `mobile`, NOT a
    // top-level `summary`. The job must forward graph, rootFingerprint,
    // fingerprintVersion, domainGuess and coverageScore (from the header) and
    // map the bare platform → the skeleton enum form.
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockResolvedValue({
      flows: [],
      mobile: {
        graph: { nodes: [{ mobile: { fingerprint: 'fp1' } }], edges: [] },
        rootFingerprint: 'fp1',
        fingerprintVersion: 1,
        domainGuess: 'shopping',
        coverageScore: 63,
      },
    });

    await MobileExplorationRunJobHandler.process(makeJob());

    expect(mergeRunIntoSkeleton).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p-1',
      platform: 'mobile_android', // bare 'android' → enum form
      packageName: 'com.demo.app',
      fingerprintVersion: 1,
      rootFingerprint: 'fp1',
      domainGuess: 'shopping',
      coverageScore: 63, // from mobile header, not summary
      runId: 'runner-run-9',
      graph: expect.objectContaining({ nodes: expect.any(Array) }),
    }));
  });

  it('hoists mobile.coverageScore to summary.coverageScore for completeMobileRun (C3)', async () => {
    // The frontend history view reads summary.coverageScore, but the runner
    // only puts it at summary.mobile.coverageScore → it was always null for
    // mobile. The job must lift it to the top level.
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockResolvedValue({
      flows: [],
      mobile: { graph: { nodes: [{ mobile: { fingerprint: 'fp1' } }], edges: [] }, rootFingerprint: 'fp1', coverageScore: 63 },
    });

    await MobileExplorationRunJobHandler.process(makeJob());

    expect(completeMobileRun).toHaveBeenCalledWith('expl-1', expect.objectContaining({
      summary: expect.objectContaining({ coverageScore: 63 }),
    }));
  });

  it('sets summary.coverageScore null when the snapshot has no coverage (C3)', async () => {
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockResolvedValue({ flows: [] }); // no mobile header
    await MobileExplorationRunJobHandler.process(makeJob());
    expect(completeMobileRun).toHaveBeenCalledWith('expl-1', expect.objectContaining({
      summary: expect.objectContaining({ coverageScore: null }),
    }));
  });

  it('skips the skeleton merge when the snapshot carries no graph', async () => {
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockResolvedValue({ flows: [] }); // no `mobile`
    await MobileExplorationRunJobHandler.process(makeJob());
    expect(mergeRunIntoSkeleton).not.toHaveBeenCalled();
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

  it('reports a user cancel as cancelled, not failed', async () => {
    // The relay ends as `stopped` for BOTH a user cancel and a crash, so the
    // job asks the run row — which the cancel endpoint already flipped.
    // Calling failRun here would bury a deliberate stop in failure metrics.
    waitUntilDone.mockResolvedValue({ status: 'failed', errorMessage: 'stopped', testCasesCount: 0, summary: {}, reason: 'stopped' });
    isRunCancelled.mockResolvedValue(true);

    await MobileExplorationRunJobHandler.process(makeJob());

    expect(failRun).not.toHaveBeenCalled();
    expect(completeMobileRun).not.toHaveBeenCalled();
    expect(emitExplorationCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', explorationId: 'expl-1' }),
    );
  });

  it('attaches chat actions so the finished message is not a dead end', async () => {
    // The mobile live panel is component state: closing it removes every route
    // back to the run unless the message carries its own buttons.
    waitUntilDone.mockResolvedValue({ status: 'completed', testCasesCount: 0, summary: {}, reason: 'completed' });
    getExplorationResult.mockResolvedValue({ flows: [] });
    saveMobileTestCasesFromSnapshot.mockResolvedValue(['tc-1']);

    await MobileExplorationRunJobHandler.process(makeJob());

    expect(saveChatMessages).toHaveBeenCalledWith(
      'chat-1',
      [expect.objectContaining({
        metadata: expect.objectContaining({
          savedTestCaseIds: ['tc-1'],
          actions: expect.arrayContaining([
            expect.objectContaining({ kind: 'navigate', url: '/explorations/expl-1' }),
          ]),
        }),
      })],
    );
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
