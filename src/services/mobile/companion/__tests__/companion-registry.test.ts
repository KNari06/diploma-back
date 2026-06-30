import { companionRegistry } from '../companion-registry';

type FakeSocket = import('socket.io').Socket & {
  connected: boolean;
  emit: jest.Mock;
};

// Fake Socket.IO socket — enough surface for the registry tests.
function makeSocket(connected = true): FakeSocket {
  return {
    id: Math.random().toString(36).slice(2),
    connected,
    emit: jest.fn(),
  } as unknown as FakeSocket;
}

beforeEach(() => {
  // Each test gets a clean registry state by using unique user IDs.
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CompanionRegistry', () => {
  it('reports isConnected after register', () => {
    const userId = 'user-reg-1';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);
    expect(companionRegistry.isConnected(userId)).toBe(true);
  });

  it('returns the entry via get after register', () => {
    const userId = 'user-reg-2';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);
    expect(companionRegistry.get(userId)?.socket).toBe(socket);
    expect(companionRegistry.get(userId)?.userId).toBe(userId);
  });

  it('keeps entry alive during grace period after deregister', () => {
    const userId = 'user-grace-1';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);
    socket.connected = false;
    companionRegistry.deregister(userId, socket.id);
    // Entry still present immediately after deregister.
    expect(companionRegistry.get(userId)).toBeDefined();
  });

  it('removes entry after grace period expires', () => {
    const userId = 'user-grace-2';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);
    socket.connected = false;
    companionRegistry.deregister(userId, socket.id);
    jest.advanceTimersByTime(30_001);
    expect(companionRegistry.get(userId)).toBeUndefined();
  });

  it('cancels grace timer when companion reconnects within grace', () => {
    const userId = 'user-reconnect-1';
    const socket1 = makeSocket();
    const socket2 = makeSocket();
    companionRegistry.register(userId, socket1);
    socket1.connected = false;
    companionRegistry.deregister(userId, socket1.id);
    // Reconnect before grace expires.
    companionRegistry.register(userId, socket2);
    // Advance past old grace window — entry must still be present.
    jest.advanceTimersByTime(30_001);
    expect(companionRegistry.get(userId)).toBeDefined();
    expect(companionRegistry.get(userId)?.socket).toBe(socket2);
  });

  it('ignores a stale disconnect after a newer socket registers', () => {
    const userId = 'user-reconnect-2';
    const socket1 = makeSocket();
    const socket2 = makeSocket();
    companionRegistry.register(userId, socket1);
    companionRegistry.register(userId, socket2);

    socket1.connected = false;
    companionRegistry.deregister(userId, socket1.id);
    jest.advanceTimersByTime(30_001);

    expect(companionRegistry.get(userId)?.socket).toBe(socket2);
    expect(companionRegistry.isConnected(userId)).toBe(true);
  });

  describe('device snapshot cache', () => {
    it('returns null snapshot before any is set', () => {
      expect(companionRegistry.getDeviceSnapshot('user-snap-0')).toBeNull();
    });

    it('stores and returns the latest device snapshot for a user', () => {
      const userId = 'user-snap-1';
      const snap = { timestamp: 't1', devices: [{ id: 'd1', source: 'local-physical' }] };
      companionRegistry.setDeviceSnapshot(userId, snap);
      expect(companionRegistry.getDeviceSnapshot(userId)).toEqual(snap);
    });

    it('overwrites an older snapshot with a newer one', () => {
      const userId = 'user-snap-2';
      companionRegistry.setDeviceSnapshot(userId, { timestamp: 't1', devices: [] });
      const newer = { timestamp: 't2', devices: [{ id: 'd2' }] };
      companionRegistry.setDeviceSnapshot(userId, newer);
      expect(companionRegistry.getDeviceSnapshot(userId)).toEqual(newer);
    });

    it('isolates snapshots per user', () => {
      companionRegistry.setDeviceSnapshot('user-snap-a', { timestamp: 'ta', devices: [] });
      expect(companionRegistry.getDeviceSnapshot('user-snap-b')).toBeNull();
    });

    it('clears the snapshot when the companion fully disconnects after grace', () => {
      const userId = 'user-snap-3';
      const socket = makeSocket();
      companionRegistry.register(userId, socket);
      companionRegistry.setDeviceSnapshot(userId, { timestamp: 't1', devices: [{ id: 'd1' }] });
      socket.connected = false;
      companionRegistry.deregister(userId, socket.id);
      jest.advanceTimersByTime(30_001);
      expect(companionRegistry.getDeviceSnapshot(userId)).toBeNull();
    });

    it('keeps the snapshot through a within-grace reconnect', () => {
      const userId = 'user-snap-4';
      const socket1 = makeSocket();
      const socket2 = makeSocket();
      companionRegistry.register(userId, socket1);
      companionRegistry.setDeviceSnapshot(userId, { timestamp: 't1', devices: [{ id: 'd1' }] });
      socket1.connected = false;
      companionRegistry.deregister(userId, socket1.id);
      companionRegistry.register(userId, socket2);
      jest.advanceTimersByTime(30_001);
      expect(companionRegistry.getDeviceSnapshot(userId)).toEqual({ timestamp: 't1', devices: [{ id: 'd1' }] });
    });
  });

  it('proxyRequest emits runner:http:request to the companion socket', async () => {
    const userId = 'user-proxy-1';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);

    const responsePromise = companionRegistry.proxyRequest(userId, 'GET', '/api/health');

    // Extract the requestId from the emitted event.
    expect(socket.emit).toHaveBeenCalledWith(
      'runner:http:request',
      expect.objectContaining({ method: 'GET', path: '/api/health' }),
    );
    const [, { requestId }] = (socket.emit as jest.Mock).mock.calls[0] as [string, { requestId: string }];

    // Simulate companion response.
    companionRegistry.resolveRpc(requestId, userId, { status: 200, body: { ok: true }, ok: true });
    const result = await responsePromise;
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
  });

  it('proxyRequest rejects after RPC timeout', async () => {
    const userId = 'user-proxy-2';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);

    const responsePromise = companionRegistry.proxyRequest(userId, 'POST', '/api/sessions', {});
    jest.advanceTimersByTime(60_001);
    await expect(responsePromise).rejects.toThrow(/timed out/i);
  });

  it('proxyRequest throws immediately when no companion is connected', async () => {
    await expect(
      companionRegistry.proxyRequest('user-not-connected', 'GET', '/api/health'),
    ).rejects.toThrow(/No connected companion/i);
  });

  it('rejects in-flight RPCs when grace period expires after disconnect', async () => {
    const userId = 'user-rpc-drop-1';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);

    const responsePromise = companionRegistry.proxyRequest(userId, 'GET', '/api/health');
    socket.connected = false;
    companionRegistry.deregister(userId, socket.id);
    jest.advanceTimersByTime(30_001);

    await expect(responsePromise).rejects.toThrow(/Companion disconnected/i);
  });

  it('queues new proxy requests during grace and sends them after reconnect', async () => {
    const userId = 'user-rpc-reconnect-1';
    const socket1 = makeSocket();
    const socket2 = makeSocket();
    companionRegistry.register(userId, socket1);

    socket1.connected = false;
    companionRegistry.deregister(userId, socket1.id);

    const responsePromise = companionRegistry.proxyRequest(userId, 'GET', '/api/health');
    expect(socket1.emit).not.toHaveBeenCalled();

    companionRegistry.register(userId, socket2);
    expect(socket2.emit).toHaveBeenCalledWith(
      'runner:http:request',
      expect.objectContaining({ method: 'GET', path: '/api/health' }),
    );

    const [, { requestId }] = socket2.emit.mock.calls[0] as [string, { requestId: string }];
    companionRegistry.resolveRpc(requestId, userId, { status: 200, body: { ok: true }, ok: true });

    await expect(responsePromise).resolves.toEqual({ status: 200, body: { ok: true }, ok: true });
  });

  // Regression: a relay drop AFTER a request was emitted loses the response, so
  // on reconnect within grace the registry must RE-emit the already-emitted
  // request to the new socket (the runner de-dupes by requestId). Without this
  // the RPC hung until its full timeout — froze a companion run for ~180s on a
  // single mid-step relay blip.
  it('re-emits an already-emitted in-flight request to the new socket on reconnect', async () => {
    const userId = 'user-rpc-reemit-1';
    const socket1 = makeSocket();
    const socket2 = makeSocket();
    companionRegistry.register(userId, socket1);

    // Request emitted on socket1 (connected) — emitted:true.
    const responsePromise = companionRegistry.proxyRequest(userId, 'POST', '/api/runs/s1/run-steps', {});
    expect(socket1.emit).toHaveBeenCalledTimes(1);
    const [, sent] = socket1.emit.mock.calls[0] as [string, { requestId: string }];

    // Relay drops mid-flight, then reconnects within grace on a fresh socket.
    socket1.connected = false;
    companionRegistry.deregister(userId, socket1.id);
    companionRegistry.register(userId, socket2);

    // The SAME request must be re-delivered on socket2 so the lost response recovers.
    expect(socket2.emit).toHaveBeenCalledWith(
      'runner:http:request',
      expect.objectContaining({ requestId: sent.requestId, path: '/api/runs/s1/run-steps' }),
    );

    companionRegistry.resolveRpc(sent.requestId, userId, { status: 200, body: { ok: true }, ok: true });
    await expect(responsePromise).resolves.toEqual({ status: 200, body: { ok: true }, ok: true });
  });

  // Guards the re-emit fix from becoming a tight loop: an undeliverable response
  // (e.g. one exceeding the relay message-size limit, which drops the socket on
  // every send) must NOT be re-emitted forever — after the cap the RPC fails fast.
  it('fails an RPC fast after exceeding the re-delivery cap instead of looping', async () => {
    const userId = 'user-rpc-cap-1';
    let socket = makeSocket();
    companionRegistry.register(userId, socket);

    const responsePromise = companionRegistry.proxyRequest(userId, 'POST', '/api/runs/s1/run-steps', {});
    // Swallow the eventual rejection so it doesn't surface as unhandled while we drive reconnects.
    responsePromise.catch(() => {});
    expect(socket.emit).toHaveBeenCalledTimes(1); // delivery #1

    // Simulate repeated drop→reconnect within grace (response never makes it back).
    for (let i = 0; i < 5; i++) {
      socket.connected = false;
      companionRegistry.deregister(userId, socket.id);
      socket = makeSocket();
      companionRegistry.register(userId, socket); // flushQueuedRequests re-emits or caps
    }

    await expect(responsePromise).rejects.toThrow(/undeliverable after .* attempts/i);
  });

  it('rejects queued proxy requests when grace expires without reconnect', async () => {
    const userId = 'user-rpc-drop-2';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);

    socket.connected = false;
    companionRegistry.deregister(userId, socket.id);

    const responsePromise = companionRegistry.proxyRequest(userId, 'GET', '/api/health');
    expect(socket.emit).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_001);
    await expect(responsePromise).rejects.toThrow(/Companion disconnected/i);
  });

  it('cancels an emitted proxy request when the caller aborts', async () => {
    const userId = 'user-rpc-abort-1';
    const socket = makeSocket();
    const controller = new AbortController();
    companionRegistry.register(userId, socket);

    const responsePromise = companionRegistry.proxyRequest(
      userId,
      'POST',
      '/api/runs/sess-1/run-steps',
      {},
      {},
      { signal: controller.signal, timeoutMs: 300_000 },
    );
    const [, { requestId }] = socket.emit.mock.calls[0] as [string, { requestId: string }];

    controller.abort();

    await expect(responsePromise).rejects.toThrow(/aborted/i);
    expect(socket.emit).toHaveBeenCalledWith('runner:http:cancel', { requestId });

    companionRegistry.resolveRpc(requestId, userId, { status: 200, body: { ok: true }, ok: true });
    await expect(responsePromise).rejects.toThrow(/aborted/i);
  });

  it('drops a queued proxy request on abort without emitting cancel', async () => {
    const userId = 'user-rpc-abort-2';
    const socket = makeSocket();
    const controller = new AbortController();
    companionRegistry.register(userId, socket);
    socket.connected = false;
    companionRegistry.deregister(userId, socket.id);

    const responsePromise = companionRegistry.proxyRequest(
      userId,
      'POST',
      '/api/runs/sess-1/run-steps',
      {},
      {},
      { signal: controller.signal, timeoutMs: 300_000 },
    );

    controller.abort();

    await expect(responsePromise).rejects.toThrow(/aborted/i);
    expect(socket.emit).not.toHaveBeenCalledWith('runner:http:cancel', expect.anything());
  });
});
