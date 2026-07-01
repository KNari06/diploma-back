// Two CompanionRegistry instances (distinct instance ids) share ONE fake Redis
// whose pub/sub actually DELIVERS — so this exercises the real cross-replica
// round-trip a multi-replica API relies on: a request originated on replica B
// reaching a companion socketed on replica A, and the response routing home.
jest.mock('@/config/infrastructure/queues', () => {
  const store = new Map<string, string>();
  interface Sub { channels: Set<string>; handler: (ch: string, msg: string) => void }
  const subs: Sub[] = [];
  const redisConnection = {
    __store: store,
    __subs: subs,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    set: (k: string, v: string) => { store.set(k, v); return Promise.resolve('OK'); },
    del: (k: string) => { store.delete(k); return Promise.resolve(1); },
    eval: (_s: string, _n: number, pKey: string, sKey: string, owner: string) => {
      if (store.get(pKey) === owner) { store.delete(pKey); store.delete(sKey); return Promise.resolve(1); }
      return Promise.resolve(0);
    },
    publish: (channel: string, message: string) => {
      for (const s of subs) if (s.channels.has(channel)) queueMicrotask(() => s.handler(channel, message));
      return Promise.resolve(1);
    },
    duplicate: () => {
      const sub: Sub & { on: (e: string, h: (ch: string, msg: string) => void) => void; subscribe: (...c: string[]) => Promise<number> } = {
        channels: new Set<string>(),
        handler: () => {},
        on: (ev, h) => { if (ev === 'message') sub.handler = h; },
        subscribe: (...chs: string[]) => { for (const c of chs) sub.channels.add(c); return Promise.resolve(chs.length); },
      };
      subs.push(sub);
      return sub;
    },
  };
  return { redisConnection };
});

import { CompanionRegistry } from '../companion-registry';

const { redisConnection } = require('@/config/infrastructure/queues') as {
  redisConnection: { __store: Map<string, string>; __subs: unknown[] };
};

type FakeSocket = import('socket.io').Socket & { connected: boolean; emit: jest.Mock };
function makeSocket(connected = true): FakeSocket {
  return { id: Math.random().toString(36).slice(2), connected, emit: jest.fn() } as unknown as FakeSocket;
}
function makeIo() {
  const emit = jest.fn();
  const io = { emit, to: jest.fn(() => ({ emit })) };
  return io as unknown as import('socket.io').Server & { emit: jest.Mock; to: jest.Mock };
}
// Let queued microtasks (pub/sub delivery) + setImmediate callbacks drain.
const drain = () => new Promise((r) => setImmediate(r));

describe('CompanionRegistry cross-replica (two instances, one shared Redis)', () => {
  beforeEach(() => {
    redisConnection.__store.clear();
    redisConnection.__subs.length = 0;
  });

  it('routes a request originated on replica B to the companion socketed on replica A, and back', async () => {
    const regA = new CompanionRegistry('inst-A');
    const regB = new CompanionRegistry('inst-B');
    regA.init(makeIo());
    regB.init(makeIo());
    await drain();

    const userId = 'user-x';
    const socket = makeSocket();
    // When the relayed request lands on A's socket, the companion answers.
    socket.emit.mockImplementation((event: string, req: { requestId: string }) => {
      if (event === 'runner:http:request') {
        setImmediate(() => regA.resolveRpc(req.requestId, userId, { status: 200, ok: true, body: { pong: true } }));
      }
    });
    regA.register(userId, socket); // presence → inst-A, socket held by A
    await drain();

    // B has no local socket; it must relay through Redis to A and get the answer back.
    const res = await regB.proxyRequest(userId, 'GET', '/api/health');

    expect(res).toEqual({ status: 200, ok: true, body: { pong: true } });
    expect(socket.emit).toHaveBeenCalledWith('runner:http:request', expect.objectContaining({ path: '/api/health' }));
  });

  it('fans a device event from A out to a browser room on B, and B can read the snapshot', async () => {
    const regA = new CompanionRegistry('inst-A');
    const regB = new CompanionRegistry('inst-B');
    regA.init(makeIo());
    const ioB = makeIo();
    regB.init(ioB);
    await drain();

    regA.forwardDeviceEvent('user-y', 'devices:snapshot', { devices: [{ id: 'd1' }] });
    await drain();

    expect(ioB.to).toHaveBeenCalledWith('user:user-y');
    expect(ioB.emit).toHaveBeenCalledWith('devices:snapshot', { devices: [{ id: 'd1' }] });
    expect(await regB.getDeviceSnapshot('user-y')).toEqual({ devices: [{ id: 'd1' }] });
  });

  it('replies RELAY_MOVED (then exhausts retries) when the target replica no longer holds the socket', async () => {
    const regA = new CompanionRegistry('inst-A');
    const regB = new CompanionRegistry('inst-B');
    regA.init(makeIo());
    regB.init(makeIo());
    await drain();

    // Presence points at A, but A holds no socket for this user (already migrated away).
    redisConnection.__store.set('companion:presence:user-z', 'inst-A');

    const res = await regB.proxyRequest('user-z', 'GET', '/x', undefined, undefined, { timeoutMs: 3000 });
    expect(res.ok).toBe(false);
    expect((res.body as { code?: string }).code).toBe('RELAY_MOVED');
  });

  it('transfers a large (>256KB) response out-of-band via a Redis key, not inline over pub/sub', async () => {
    const regA = new CompanionRegistry('inst-A');
    const regB = new CompanionRegistry('inst-B');
    regA.init(makeIo());
    regB.init(makeIo());
    await drain();

    const userId = 'user-big';
    const socket = makeSocket();
    const bigBody = { screenshot: 'x'.repeat(300_000) }; // exceeds MAX_PUBSUB_INLINE_BYTES
    socket.emit.mockImplementation((event: string, req: { requestId: string }) => {
      if (event === 'runner:http:request') {
        setImmediate(() => regA.resolveRpc(req.requestId, userId, { status: 200, ok: true, body: bigBody }));
      }
    });
    regA.register(userId, socket);
    await drain();

    const res = await regB.proxyRequest(userId, 'POST', '/step');
    expect(res).toEqual({ status: 200, ok: true, body: bigBody });
    // The out-of-band body key is deleted after the origin reads it.
    expect([...redisConnection.__store.keys()].some((k) => k.startsWith('companion:resbody:'))).toBe(false);
  });
});
