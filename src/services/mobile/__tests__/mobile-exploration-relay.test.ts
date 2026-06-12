/**
 * Stage 3, Slice 2 — tests for MobileExplorationRelay.
 *
 * The relay is the keystone of backend-brokered mobile exploration: it
 * connects to the runner socket with the SERVER-held key, subscribes to
 * one run, and forwards the runner's web-contract envelopes onto the
 * backend's own emitters (stamped with chatSessionId + userId). These
 * tests mock socket.io-client and the websocket service to assert the
 * wiring, the routing stamp, and the teardown lifecycle.
 */

// Fake socket: records listeners + emits, lets the test drive events.
class FakeSocket {
  handlers: Record<string, (arg?: unknown) => void> = {};
  emitted: Array<{ event: string; arg: unknown }> = [];
  removeAllListeners = jest.fn();
  disconnect = jest.fn();
  on = (event: string, cb: (arg?: unknown) => void) => {
    this.handlers[event] = cb;
    return this;
  };
  emit = (event: string, arg?: unknown) => {
    this.emitted.push({ event, arg });
    return this;
  };
  fire(event: string, arg?: unknown) {
    this.handlers[event]?.(arg);
  }
}

let lastSocket: FakeSocket;
let lastIoArgs: { url: string; opts: Record<string, unknown> };
jest.mock('socket.io-client', () => ({
  io: (url: string, opts: Record<string, unknown>) => {
    lastSocket = new FakeSocket();
    lastIoArgs = { url, opts };
    return lastSocket;
  },
}));

const emitProgress = jest.fn();
const emitCompleted = jest.fn();
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: {
    emitExplorationProgress: (p: unknown) => emitProgress(p),
    emitExplorationCompleted: (p: unknown) => emitCompleted(p),
  },
}));

jest.mock('@/config/environment/env', () => ({
  env: { MOBILE_RUNNER_API_KEY: 'server-key' },
}));

import { MobileExplorationRelay } from '../mobile-exploration-relay';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

function makeRelay(over: Partial<ConstructorParameters<typeof MobileExplorationRelay>[0]> = {}) {
  return new MobileExplorationRelay({
    runnerSocketUrl: 'ws://runner:4100',
    runId: 'expl-1',
    chatSessionId: 'chat-1',
    userId: 'user-1',
    budgetMs: 600000,
    ...over,
  });
}

describe('MobileExplorationRelay', () => {
  it('connects with the server-held key and normalises ws:// to http://', () => {
    makeRelay().start();
    expect(lastIoArgs.url).toBe('http://runner:4100');
    expect(lastIoArgs.opts.auth).toEqual({ apiKey: 'server-key' });
  });

  it('subscribes to the run on connect', () => {
    makeRelay().start();
    lastSocket.fire('connect');
    expect(lastSocket.emitted).toContainEqual({ event: 'subscribe:explorer', arg: { runId: 'expl-1' } });
  });

  it('forwards progress envelopes stamped with chatSessionId + userId', () => {
    makeRelay().start();
    lastSocket.fire('exploration:progress', {
      explorationId: 'expl-1', phase: 'survey', event: 'page_found', progressPercent: 20, data: { url: '/x' },
    });
    expect(emitProgress).toHaveBeenCalledWith(expect.objectContaining({
      explorationId: 'expl-1',
      phase: 'survey',
      progressPercent: 20,
      chatSessionId: 'chat-1',
      userId: 'user-1',
      budgetMs: 600000,
    }));
  });

  it('forwards completion and tears down the socket', () => {
    makeRelay().start();
    lastSocket.fire('exploration:completed', {
      explorationId: 'expl-1', status: 'completed', testCasesCount: 4, summary: { coverageScore: 80 },
    });
    expect(emitCompleted).toHaveBeenCalledWith(expect.objectContaining({
      explorationId: 'expl-1', status: 'completed', testCasesCount: 4, chatSessionId: 'chat-1',
    }));
    // Teardown ran.
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('normalises a non-failed status to completed', () => {
    makeRelay().start();
    lastSocket.fire('exploration:completed', { explorationId: 'expl-1', status: 'cancelled' });
    expect(emitCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('passes a failed status through', () => {
    makeRelay().start();
    lastSocket.fire('exploration:completed', { explorationId: 'expl-1', status: 'failed', errorMessage: 'boom' });
    expect(emitCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorMessage: 'boom' }));
  });

  it('stop() is idempotent and clears the lifetime timer', () => {
    const relay = makeRelay();
    relay.start();
    relay.stop();
    relay.stop(); // second call must not double-disconnect
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1);
    // Advancing past the cap must not throw or re-disconnect.
    jest.advanceTimersByTime(25 * 60 * 1000);
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('self-disconnects when the lifetime cap is hit without completion', () => {
    makeRelay({ maxLifetimeMs: 1000 }).start();
    jest.advanceTimersByTime(1001);
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('waitUntilDone resolves with the completion outcome', async () => {
    const relay = makeRelay();
    relay.start();
    lastSocket.fire('exploration:completed', {
      explorationId: 'expl-1', status: 'completed', testCasesCount: 3, summary: { coverageScore: 70 },
    });
    await expect(relay.waitUntilDone()).resolves.toEqual(expect.objectContaining({
      status: 'completed', reason: 'completed', testCasesCount: 3, summary: { coverageScore: 70 },
    }));
  });

  it('waitUntilDone resolves failed when the cap fires without completion', async () => {
    const relay = makeRelay({ maxLifetimeMs: 1000 });
    relay.start();
    jest.advanceTimersByTime(1001);
    const outcome = await relay.waitUntilDone();
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('timeout');
  });

  it('waitUntilDone resolves failed on a bare stop() (cancel)', async () => {
    const relay = makeRelay();
    relay.start();
    relay.stop();
    const outcome = await relay.waitUntilDone();
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('stopped');
  });

  it('synthesises completion from a replayed explorer:event kind=finished', async () => {
    // Fast-run race: the run finished before we subscribed, so the only
    // signal is a replayed raw explorer:event — not an envelope.
    const relay = makeRelay();
    relay.start();
    lastSocket.fire('explorer:event', { kind: 'finished', terminalStatus: 'finished' });
    expect(emitCompleted).toHaveBeenCalledWith(expect.objectContaining({ explorationId: 'expl-1', status: 'completed' }));
    await expect(relay.waitUntilDone()).resolves.toEqual(expect.objectContaining({ reason: 'completed' }));
  });

  it('maps a failed terminalStatus on the replayed finished event', async () => {
    const relay = makeRelay();
    relay.start();
    lastSocket.fire('explorer:event', { kind: 'finished', terminalStatus: 'failed', error: 'crash' });
    expect(emitCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorMessage: 'crash' }));
  });

  it('does not double-complete if a real completed envelope already arrived', async () => {
    const relay = makeRelay();
    relay.start();
    lastSocket.fire('exploration:completed', { explorationId: 'expl-1', status: 'completed', testCasesCount: 2 });
    lastSocket.fire('explorer:event', { kind: 'finished', terminalStatus: 'finished' }); // late replay
    expect(emitCompleted).toHaveBeenCalledTimes(1);
  });

  it('fails fast on reconnect_failed instead of hanging until the cap', async () => {
    const relay = makeRelay();
    relay.start();
    lastSocket.fire('reconnect_failed');
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1);
    const outcome = await relay.waitUntilDone();
    expect(outcome.status).toBe('failed');
  });
});
