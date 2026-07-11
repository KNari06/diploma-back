const mockRefreshWarmupTtl = jest.fn().mockResolvedValue(undefined);
const mockTouchRunnerSessions = jest.fn().mockResolvedValue(undefined);

jest.mock('@/services/mobile/mobile-idle.service', () => ({
  refreshWarmupTtl: (...args: unknown[]) => mockRefreshWarmupTtl(...args),
  touchRunnerSessions: (...args: unknown[]) => mockTouchRunnerSessions(...args),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { handleHeartbeat } from '../heartbeat.handler';

const USER = 'user-abc123';

/**
 * Minimal socket fake that keeps incoming (on/trigger) separate from
 * outgoing (emit spy), mirroring Socket.IO's real split.
 */
function makeSocket(userId?: string) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    id: 'socket-1',
    connected: true,
    data: userId ? { userId } : {},
    on(event: string, fn: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(fn);
      return this;
    },
    emit: jest.fn(),
    /** Simulate an incoming event from the client. */
    trigger(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach(fn => fn(...args));
    },
  } as unknown as Parameters<typeof handleHeartbeat>[0] & { trigger(...args: unknown[]): void };
}

describe('handleHeartbeat — mobile:keepalive', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls refreshWarmupTtl and touchRunnerSessions with the userId', () => {
    const socket = makeSocket(USER);
    handleHeartbeat(socket);
    (socket as unknown as { trigger(...a: unknown[]): void }).trigger('mobile:keepalive');

    expect(mockRefreshWarmupTtl).toHaveBeenCalledTimes(1);
    expect(mockRefreshWarmupTtl).toHaveBeenCalledWith(USER);
    expect(mockTouchRunnerSessions).toHaveBeenCalledTimes(1);
    expect(mockTouchRunnerSessions).toHaveBeenCalledWith(USER);
  });

  it('does not call either when the socket has no userId', () => {
    const socket = makeSocket(); // unauthenticated
    handleHeartbeat(socket);
    (socket as unknown as { trigger(...a: unknown[]): void }).trigger('mobile:keepalive');

    expect(mockRefreshWarmupTtl).not.toHaveBeenCalled();
    expect(mockTouchRunnerSessions).not.toHaveBeenCalled();
  });

  it('calls both on every keepalive (throttling is the service\'s concern, not the handler)', () => {
    const socket = makeSocket(USER);
    const trigger = (socket as unknown as { trigger(...a: unknown[]): void }).trigger.bind(socket);
    handleHeartbeat(socket);
    trigger('mobile:keepalive');
    trigger('mobile:keepalive');

    expect(mockRefreshWarmupTtl).toHaveBeenCalledTimes(2);
    expect(mockTouchRunnerSessions).toHaveBeenCalledTimes(2);
  });
});

describe('handleHeartbeat — ping/pong', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits pong with the client timestamp', () => {
    const socket = makeSocket(USER);
    handleHeartbeat(socket);
    (socket as unknown as { trigger(...a: unknown[]): void }).trigger('ping', 1234567890);

    expect(socket.emit).toHaveBeenCalledWith('pong', { t: 1234567890 });
  });

  it('emits pong with undefined t when no timestamp provided', () => {
    const socket = makeSocket(USER);
    handleHeartbeat(socket);
    (socket as unknown as { trigger(...a: unknown[]): void }).trigger('ping');

    expect(socket.emit).toHaveBeenCalledWith('pong', { t: undefined });
  });

  it('emits pong with undefined t for a non-numeric timestamp', () => {
    const socket = makeSocket(USER);
    handleHeartbeat(socket);
    (socket as unknown as { trigger(...a: unknown[]): void }).trigger('ping', 'not-a-number');

    expect(socket.emit).toHaveBeenCalledWith('pong', { t: undefined });
  });
});
