/**
 * Tests for the System Logs broadcaster — live-tails Winston entries to the
 * System Logs UI over WebSocket, gated to authorized users only.
 *
 * The security-relevant property: ONLY users with show_logs=true or role=admin
 * receive log entries (logs can contain operational detail). A broadcast bug
 * that emits to everyone is an info-disclosure issue. Also: a DB refresh error
 * or a per-user emit failure must never break the broadcast loop.
 *
 * supabaseAdmin, the log ring buffer, and the WS service are mocked; the
 * broadcast callback registered with logBuffer.subscribe is captured so the
 * test can drive a synthetic log entry through it.
 */

import {
  initSystemLogsBroadcaster,
  stopSystemLogsBroadcaster,
} from '../system-logs-broadcaster';
import { supabaseAdmin } from '@/db/supabase';
import { logBuffer } from '@/utils/core/log-buffer';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { BufferedLogEntry } from '@/utils/core/log-buffer';

let capturedBroadcast: ((e: BufferedLogEntry) => void) | null = null;
const unsubscribeSpy = jest.fn();

jest.mock('@/db/supabase', () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock('@/utils/core/log-buffer', () => ({
  logBuffer: {
    subscribe: jest.fn(),
  },
}));
jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: { emitToUser: jest.fn() },
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFrom = supabaseAdmin.from as jest.Mock;
const mockSubscribe = logBuffer.subscribe as jest.Mock;
const mockEmitToUser = webSocketService.emitToUser as jest.Mock;

/** users.select('id').or(...) → awaited {data,error}. */
function mockUsersQuery(result: { data: unknown; error: unknown }) {
  const chain = {
    select: jest.fn(() => chain),
    or: jest.fn(() => Promise.resolve(result)),
  } as { select: jest.Mock; or: jest.Mock };
  mockFrom.mockReturnValue(chain);
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const entry = { level: 'info', message: 'hi', timestamp: '2026-06-27' } as unknown as BufferedLogEntry;

beforeEach(() => {
  jest.clearAllMocks();
  capturedBroadcast = null;
  mockSubscribe.mockImplementation((cb: (e: BufferedLogEntry) => void) => {
    capturedBroadcast = cb;
    return unsubscribeSpy;
  });
});

afterEach(() => {
  stopSystemLogsBroadcaster(); // reset module state (initialised flag + timer)
});

describe('initSystemLogsBroadcaster', () => {
  it('subscribes to the log buffer and emits new entries to authorized users only', async () => {
    mockUsersQuery({ data: [{ id: 'u1' }, { id: 'u2' }], error: null });
    initSystemLogsBroadcaster();
    await flush(); // let the fire-and-forget refresh resolve

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    capturedBroadcast!(entry);

    expect(mockEmitToUser).toHaveBeenCalledTimes(2);
    expect(mockEmitToUser).toHaveBeenCalledWith('u1', 'system:log:new', entry);
    expect(mockEmitToUser).toHaveBeenCalledWith('u2', 'system:log:new', entry);
  });

  it('emits to no one when there are no authorized users', async () => {
    mockUsersQuery({ data: [], error: null });
    initSystemLogsBroadcaster();
    await flush();
    capturedBroadcast!(entry);
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  it('does not crash the loop, and skips broadcasting, when the refresh query errors', async () => {
    mockUsersQuery({ data: null, error: { message: 'db down' } });
    initSystemLogsBroadcaster();
    await flush();
    capturedBroadcast!(entry);
    expect(mockEmitToUser).not.toHaveBeenCalled(); // authorized set stayed empty
  });

  it('continues to remaining users if one emit throws', async () => {
    mockUsersQuery({ data: [{ id: 'u1' }, { id: 'u2' }], error: null });
    mockEmitToUser.mockImplementationOnce(() => {
      throw new Error('socket gone');
    });
    initSystemLogsBroadcaster();
    await flush();
    capturedBroadcast!(entry);
    expect(mockEmitToUser).toHaveBeenCalledTimes(2); // first threw, second still attempted
  });

  it('is idempotent — a second init does not re-subscribe', async () => {
    mockUsersQuery({ data: [{ id: 'u1' }], error: null });
    initSystemLogsBroadcaster();
    initSystemLogsBroadcaster();
    await flush();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('stopSystemLogsBroadcaster', () => {
  it('unsubscribes from the log buffer', async () => {
    mockUsersQuery({ data: [{ id: 'u1' }], error: null });
    initSystemLogsBroadcaster();
    await flush();
    stopSystemLogsBroadcaster();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it('allows re-init after stop (resets the idempotency flag)', async () => {
    mockUsersQuery({ data: [{ id: 'u1' }], error: null });
    initSystemLogsBroadcaster();
    await flush();
    stopSystemLogsBroadcaster();
    initSystemLogsBroadcaster();
    await flush();
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
  });
});
