/**
 * The Regression Doctor job runs in the WORKER process, so the only way its
 * `regression:doctor:ready` event reaches a browser is this bridge subscriber.
 * The case was missing for the whole life of the feature and nothing caught it:
 * the findings landed in the database, the panel kept spinning on "Analyzing…",
 * and the only trace was a generic "Unknown event type" warning in the API log.
 *
 * The controller's own emits (apply / dismiss) run in the API process and never
 * pass through here, which is exactly why the gap stayed invisible.
 */

const emitToUser = jest.fn();
const subscribeMock = jest.fn();

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: {
    emitToUser: (...args: unknown[]) => emitToUser(...args),
  },
}));

jest.mock('@/services/websocket/redis-bridge.service', () => ({
  redisWebSocketBridge: {
    subscribe: (cb: unknown) => subscribeMock(cb),
    unsubscribe: jest.fn(),
    getStatus: jest.fn(),
  },
}));

jest.mock('@/services/ai/logging/ai-log-buffer', () => ({
  aiLogBuffer: { pushExisting: jest.fn() },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { webSocketRedisSubscriber } from '../redis-subscriber';
import { logger } from '@/utils/core/logger';

type BridgeHandler = (event: string, payload: unknown, target?: unknown) => void;

async function startAndCaptureHandler(): Promise<BridgeHandler> {
  let captured: BridgeHandler | undefined;
  subscribeMock.mockImplementation((cb: BridgeHandler) => {
    captured = cb;
    return Promise.resolve();
  });
  await webSocketRedisSubscriber.start();
  if (!captured) throw new Error('subscriber never registered a bridge handler');
  return captured;
}

describe('WebSocket Redis subscriber — regression:doctor:ready', () => {
  let handle: BridgeHandler;

  beforeAll(async () => {
    handle = await startAndCaptureHandler();
  });

  beforeEach(() => {
    emitToUser.mockClear();
    (logger.warn as jest.Mock).mockClear();
  });

  it('forwards a worker-published finding notification to the owning user', () => {
    const payload = { runId: 'run-1', findingsCount: 2, timestamp: '2026-08-16T12:00:00.000Z' };

    handle('regression:doctor:ready', payload, { userId: 'user-1' });

    expect(emitToUser).toHaveBeenCalledWith('user-1', 'regression:doctor:ready', payload);
  });

  it('is a known event — it never falls through to the unknown-event branch', () => {
    handle('regression:doctor:ready', { runId: 'run-1', findingsCount: 0 }, { userId: 'user-1' });

    const warned = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(warned).not.toContain('[WS_REDIS_SUB] Unknown event type received');
  });

  it('warns instead of emitting when the event carries no target user', () => {
    handle('regression:doctor:ready', { runId: 'run-1', findingsCount: 1 }, {});

    expect(emitToUser).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[WS_REDIS_SUB] regression:doctor:ready without a target userId',
      expect.objectContaining({ runId: 'run-1' }),
    );
  });
});
