// In-memory Redis stub so the cross-replica layer (presence / snapshot / pub-sub)
// round-trips without a real Redis. Local-socket tests exercise the fast path;
// presence/relay tests read+assert against this store.
jest.mock('@/config/infrastructure/queues', () => {
  const store = new Map<string, string>();
  return {
    redisConnection: {
      __store: store,
      get: jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      set: jest.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve('OK'); }),
      del: jest.fn((k: string) => { store.delete(k); return Promise.resolve(1); }),
      publish: jest.fn(() => Promise.resolve(1)),
      // Atomic RELEASE_IF_OWNER used on grace expiry: del presence+snapshot if owned.
      eval: jest.fn((_script: string, _numKeys: number, presenceKey: string, snapKey: string, owner: string) => {
        if (store.get(presenceKey) === owner) { store.delete(presenceKey); store.delete(snapKey); return Promise.resolve(1); }
        return Promise.resolve(0);
      }),
      duplicate: () => ({ on: jest.fn(), subscribe: jest.fn(() => Promise.resolve(undefined)) }),
    },
  };
});

import { companionRegistry } from '../companion-registry';

const { redisConnection } = require('@/config/infrastructure/queues') as {
  redisConnection: { __store: Map<string, string>; get: jest.Mock; set: jest.Mock; del: jest.Mock; publish: jest.Mock; eval: jest.Mock };
};

// Flush pending microtasks (real timers stay fake) so awaited Redis-mock promises settle.
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

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
  redisConnection.__store.clear();
  redisConnection.publish.mockClear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('CompanionRegistry', () => {
  it('reports isConnected after register', async () => {
    const userId = 'user-reg-1';
    const socket = makeSocket();
    companionRegistry.register(userId, socket);
    expect(await companionRegistry.isConnected(userId)).toBe(true);
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

  it('ignores a stale disconnect after a newer socket registers', async () => {
    const userId = 'user-reconnect-2';
    const socket1 = makeSocket();
    const socket2 = makeSocket();
    companionRegistry.register(userId, socket1);
    companionRegistry.register(userId, socket2);

    socket1.connected = false;
    companionRegistry.deregister(userId, socket1.id);
    jest.advanceTimersByTime(30_001);

    expect(companionRegistry.get(userId)?.socket).toBe(socket2);
    expect(await companionRegistry.isConnected(userId)).toBe(true);
  });

  describe('device snapshot cache (Redis-backed, cross-replica)', () => {
    it('returns null snapshot before any is set', async () => {
      expect(await companionRegistry.getDeviceSnapshot('user-snap-0')).toBeNull();
    });

    it('caches the latest snapshot via forwardDeviceEvent and returns it', async () => {
      const userId = 'user-snap-1';
      const snap = { timestamp: 't1', devices: [{ id: 'd1', source: 'local-physical' }] };
      companionRegistry.forwardDeviceEvent(userId, 'devices:snapshot', snap);
      expect(await companionRegistry.getDeviceSnapshot(userId)).toEqual(snap);
    });

    it('overwrites an older snapshot with a newer one', async () => {
      const userId = 'user-snap-2';
      companionRegistry.forwardDeviceEvent(userId, 'devices:snapshot', { timestamp: 't1', devices: [] });
      const newer = { timestamp: 't2', devices: [{ id: 'd2' }] };
      companionRegistry.forwardDeviceEvent(userId, 'devices:snapshot', newer);
      expect(await companionRegistry.getDeviceSnapshot(userId)).toEqual(newer);
    });

    it('isolates snapshots per user', async () => {
      companionRegistry.forwardDeviceEvent('user-snap-a', 'devices:snapshot', { timestamp: 'ta', devices: [] });
      expect(await companionRegistry.getDeviceSnapshot('user-snap-b')).toBeNull();
    });

    it('does NOT cache non-snapshot device events, but does fan them out', async () => {
      const userId = 'user-snap-5';
      companionRegistry.forwardDeviceEvent(userId, 'device:connected', { id: 'd9' });
      expect(await companionRegistry.getDeviceSnapshot(userId)).toBeNull();
      // Every device event is published for cross-replica room fan-out.
      expect(redisConnection.publish).toHaveBeenCalledWith(
        'companion:dev',
        expect.stringContaining('device:connected'),
      );
    });
  });

  describe('cross-replica routing', () => {
    it('isConnected reflects presence a companion set on ANOTHER replica', async () => {
      // No local socket; presence written by a different instance.
      redisConnection.__store.set('companion:presence:user-remote-1', 'other-instance-id');
      expect(await companionRegistry.isConnected('user-remote-1')).toBe(true);
      expect(await companionRegistry.isConnected('user-remote-none')).toBe(false);
    });

    it('relays proxyRequest to the socket-holding replica when the companion is remote', async () => {
      const userId = 'user-remote-2';
      // Companion socketed on another replica → presence points there, no local entry.
      redisConnection.__store.set(`companion:presence:${userId}`, 'replica-B');

      const p = companionRegistry.proxyRequest(userId, 'POST', '/api/runs/s1/run-steps', { a: 1 });
      p.catch(() => {}); // it will time out here (no subscriber to answer) — we only assert the relay

      // Let ensureSubscriber + the async presence lookup + publish run.
      await flush();

      expect(redisConnection.publish).toHaveBeenCalledWith(
        'companion:req:replica-B',
        expect.stringContaining('"originInstance"'),
      );
      const call = redisConnection.publish.mock.calls.find((c) => c[0] === 'companion:req:replica-B');
      expect(JSON.parse(call![1] as string)).toMatchObject({
        userId,
        request: { method: 'POST', path: '/api/runs/s1/run-steps' },
      });
    });

    // Regression: a socket migrating replicas mid-run must be transparent, not a
    // terminal failure. RELAY_MOVED → re-look up presence + re-relay (bounded).
    it('retries a cross-replica request when the target replies RELAY_MOVED', async () => {
      const userId = 'user-remote-3';
      redisConnection.__store.set(`companion:presence:${userId}`, 'replica-X');

      const p = companionRegistry.proxyRequest(userId, 'POST', '/api/runs/s1/run-steps', {});
      p.catch(() => {});
      await flush();

      // First relay went out; grab its requestId and simulate a RELAY_MOVED reply.
      const first = redisConnection.publish.mock.calls.find((c) => c[0] === 'companion:req:replica-X');
      const req1 = JSON.parse(first![1] as string) as { requestId: string };
      companionRegistry.resolveRpc(req1.requestId, userId, {
        status: 0, ok: false, body: { code: 'RELAY_MOVED' },
      });

      // Retry waits RELAY_RETRY_DELAY_MS (250) then re-relays a NEW request.
      await flush();
      jest.advanceTimersByTime(300);
      await flush();

      const relayCalls = redisConnection.publish.mock.calls.filter((c) => c[0] === 'companion:req:replica-X');
      expect(relayCalls.length).toBeGreaterThanOrEqual(2); // re-relayed, not surfaced as terminal
      const req2 = JSON.parse(relayCalls[relayCalls.length - 1][1] as string) as { requestId: string };
      expect(req2.requestId).not.toBe(req1.requestId); // fresh request on retry

      // Second attempt succeeds → proxyRequest resolves with it.
      companionRegistry.resolveRpc(req2.requestId, userId, { status: 200, ok: true, body: { ok: true } });
      await expect(p).resolves.toEqual({ status: 200, ok: true, body: { ok: true } });
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
    await flush(); // the queued pending is established after the async presence lookup
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
    await flush(); // establish the queued pending before grace expires
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
