/**
 * Tests for the disconnect-cleanup in-flight guard.
 *
 * The bug this pins (2026-07-31, session `…_h5vegt`): a mobile editor run is
 * driven over REST, but the session's lifetime is governed by the WebSocket.
 * A Socket.IO `ping timeout` — the most common teardown cause in `trace_files`,
 * 59 occurrences between 2026-06-23 and 2026-07-31 — killed the socket while
 * the REST run was healthy. `performDisconnectCleanup` then destroyed the
 * session the in-flight apply was executing against, so nothing could answer
 * that request: it hung ~7 minutes and the browser reported a bare
 * `TypeError: Failed to fetch`, which the UI blamed on a step that had passed.
 *
 * Contract:
 *   - a session with work in flight is NOT destroyed;
 *   - the per-USER Redis keys / idle timers are held back too, since wiping
 *     them would strip the warmup binding out from under the live run;
 *   - the cleanup is re-scheduled, so a genuinely departed user is still
 *     reclaimed once the work finishes (deferred, not skipped);
 *   - an idle session is destroyed immediately, as before.
 *
 * Driven through the real `handleConnection` + `disconnect` event rather than a
 * private export, so the wiring is covered too. Timers are faked to step the
 * grace window.
 */

jest.mock('@/config/environment/env', () => ({ env: {} }));
jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {}, QueueManager: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {}, supabase: {} }));
jest.mock('../heartbeat.handler', () => ({ handleHeartbeat: jest.fn() }));
jest.mock('../preview.handler', () => ({ handlePreviewEvents: jest.fn() }));
jest.mock('../subscription.handler', () => ({ handleSubscriptions: jest.fn() }));
jest.mock('../../middleware/middleware', () => ({ getUserId: () => 'user-1' }));
jest.mock('@/services/mobile/mobile-idle.service', () => ({
  cancelIdle: jest.fn(),
  deleteUserMobileKeys: jest.fn().mockResolvedValue(3),
  getUserWarmupSessionIds: jest.fn(),
}));
jest.mock('@/services/testing/ui/preview/preview-idle.service', () => ({ cancelIdle: jest.fn() }));
jest.mock('@/services/mobile/session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));
jest.mock('@/services/testing/ui/preview/editor-trace.service', () => ({
  EditorTraceService: {
    getOrCreate: jest.fn(() => ({ writeMobileSessionTeardown: jest.fn() })),
    close: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('@/services/testing/ui/preview/editor-trace-upload', () => ({ uploadEditorTrace: jest.fn() }));

import { handleConnection } from '../connection.handler';
import { getUserWarmupSessionIds, deleteUserMobileKeys, cancelIdle } from '@/services/mobile/mobile-idle.service';
import { getMobileRunnerClientForSession } from '@/services/mobile/session-runner-routing';
import { track, __resetForTests } from '@/services/mobile/session-inflight.registry';

const getSessionsMock = getUserWarmupSessionIds as jest.Mock;
const getClientMock = getMobileRunnerClientForSession as jest.Mock;
const deleteKeysMock = deleteUserMobileKeys as jest.Mock;
const cancelIdleMock = cancelIdle as jest.Mock;

const GRACE_MS = 15_000;

let destroySession: jest.Mock;
let disconnectHandler: ((reason: string) => Promise<void>) | undefined;

function makeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const socket: any = {
    id: 'socket-1',
    data: { userId: 'user-1' },
    handshake: { auth: {}, query: {} },
    conn: { transport: { name: 'websocket' } },
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((evt: string, cb: (...args: unknown[]) => unknown) => { handlers.set(evt, cb); }),
    nsp: { in: () => ({ fetchSockets: jest.fn().mockResolvedValue([]) }) },
  };
  socket.__handlers = handlers;
  return socket;
}

/** Connect a socket and return its registered `disconnect` handler. */
async function connectAndGetDisconnect() {
  const socket = makeSocket();
  await handleConnection(socket);
  return socket.__handlers.get('disconnect') as (reason: string) => Promise<void>;
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetForTests();
  jest.useFakeTimers();
  destroySession = jest.fn().mockResolvedValue(undefined);
  getClientMock.mockResolvedValue({ destroySession });
  getSessionsMock.mockResolvedValue(['sess-busy']);
  disconnectHandler = await connectAndGetDisconnect();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('disconnect cleanup — in-flight guard', () => {
  it('does NOT destroy a session that has work in flight', async () => {
    let release: () => void = () => {};
    const pending = track('sess-busy', () => new Promise<void>((r) => { release = r; }));

    await disconnectHandler!('ping timeout');
    await jest.advanceTimersByTimeAsync(GRACE_MS + 100);

    expect(destroySession).not.toHaveBeenCalled();

    release();
    await pending;
  });

  it('holds back the per-user Redis keys and idle timers while deferred', async () => {
    // These are per-USER, so wiping them would strip the warmup binding out
    // from under the still-running session and defeat the deferral.
    let release: () => void = () => {};
    const pending = track('sess-busy', () => new Promise<void>((r) => { release = r; }));

    await disconnectHandler!('ping timeout');
    await jest.advanceTimersByTimeAsync(GRACE_MS + 100);

    expect(deleteKeysMock).not.toHaveBeenCalled();
    expect(cancelIdleMock).not.toHaveBeenCalled();

    release();
    await pending;
  });

  it('destroys the session on the retry once the work finishes (deferred, not skipped)', async () => {
    let release: () => void = () => {};
    const pending = track('sess-busy', () => new Promise<void>((r) => { release = r; }));

    await disconnectHandler!('ping timeout');
    await jest.advanceTimersByTimeAsync(GRACE_MS + 100);
    expect(destroySession).not.toHaveBeenCalled();

    // The run finishes; the user is still gone.
    release();
    await pending;

    await jest.advanceTimersByTimeAsync(GRACE_MS + 100);
    expect(destroySession).toHaveBeenCalledWith('sess-busy', { userId: 'user-1' });
    expect(deleteKeysMock).toHaveBeenCalled();
  });

  it('destroys an idle session immediately — unchanged behaviour', async () => {
    await disconnectHandler!('ping timeout');
    await jest.advanceTimersByTimeAsync(GRACE_MS + 100);

    expect(destroySession).toHaveBeenCalledWith('sess-busy', { userId: 'user-1' });
    expect(deleteKeysMock).toHaveBeenCalled();
    expect(cancelIdleMock).toHaveBeenCalled();
  });

  it('destroys idle sessions while sparing the busy one in the same sweep', async () => {
    getSessionsMock.mockResolvedValue(['sess-busy', 'sess-idle']);
    let release: () => void = () => {};
    const pending = track('sess-busy', () => new Promise<void>((r) => { release = r; }));

    await disconnectHandler!('ping timeout');
    await jest.advanceTimersByTimeAsync(GRACE_MS + 100);

    const destroyed = destroySession.mock.calls.map((c) => c[0]);
    expect(destroyed).toContain('sess-idle');
    expect(destroyed).not.toContain('sess-busy');

    release();
    await pending;
  });
});
