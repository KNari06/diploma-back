import crypto from 'crypto';
import type { Socket } from 'socket.io';
import { logger } from '@/utils/core/logger';

// How long to keep the userId→socket binding alive after a companion drop
// before cleaning up the registry entry. Long enough for a laptop-sleep /
// USB re-plug reconnect, short enough not to hold a stale entry forever.
const GRACE_MS = 30_000;

// Timeout waiting for a companion to reply to a runner:http:request.
const RPC_TIMEOUT_MS = 60_000;

// Cap on how many times one request is re-delivered across companion reconnects.
// Re-delivery recovers a response lost to a mid-flight relay drop, but if a
// response is structurally UNdeliverable (e.g. it exceeds maxHttpBufferSize and
// closes the socket on every send), unbounded re-emit becomes a tight
// connect→drop→re-emit loop. After this many attempts we fail the RPC fast so
// the caller retries cleanly instead of the relay flapping forever.
const MAX_REDELIVERIES = 3;

export interface CompanionEntry {
  socket: Socket;
  userId: string;
  connectedAt: Date;
}

export interface RunnerProxyResponse {
  status: number;
  body: unknown;
  ok: boolean;
}

interface RunnerProxyRequest {
  requestId: string;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  bodyEncoding?: 'json' | 'base64-file';
}

interface PendingRpc {
  userId: string;
  request: RunnerProxyRequest;
  resolve: (res: RunnerProxyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  emitted: boolean;
  // How many times this request has been emitted/re-emitted to a companion
  // socket. Bounded by MAX_REDELIVERIES so an undeliverable response can't loop.
  deliveries: number;
}

class CompanionRegistry {
  private readonly entries = new Map<string, CompanionEntry>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, PendingRpc>();
  // Latest device snapshot the companion forwarded, per user. Lets the web
  // client bootstrap its device picker via REST without waiting for the next
  // live `devices:snapshot` relay event.
  private readonly deviceSnapshots = new Map<string, unknown>();

  register(userId: string, socket: Socket): void {
    const existing = this.graceTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.graceTimers.delete(userId);
      logger.info('[CompanionRegistry] Companion reconnected within grace period', { userId: userId.substring(0, 8) });
    }
    this.entries.set(userId, { socket, userId, connectedAt: new Date() });
    this.flushQueuedRequests(userId, socket);
    logger.info('[CompanionRegistry] Companion registered', {
      userId: userId.substring(0, 8),
      socketId: socket.id,
    });
  }

  deregister(userId: string, socketId: string): void {
    const entry = this.entries.get(userId);
    if (!entry || entry.socket.id !== socketId) {
      logger.info('[CompanionRegistry] Ignored stale companion disconnect', {
        userId: userId.substring(0, 8),
        socketId,
        currentSocketId: entry?.socket.id,
      });
      return;
    }

    const existing = this.graceTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      const current = this.entries.get(userId);
      if (!current || current.socket.id !== socketId) {
        this.graceTimers.delete(userId);
        return;
      }

      this.entries.delete(userId);
      this.graceTimers.delete(userId);
      this.deviceSnapshots.delete(userId);
      this.rejectPendingForUser(userId, new Error('Companion disconnected'));
      logger.info('[CompanionRegistry] Companion entry expired after grace period', {
        userId: userId.substring(0, 8),
      });
    }, GRACE_MS);
    this.graceTimers.set(userId, timer);
    logger.info('[CompanionRegistry] Companion disconnected, grace period started', {
      userId: userId.substring(0, 8),
      graceMs: GRACE_MS,
    });
  }

  get(userId: string): CompanionEntry | undefined {
    return this.entries.get(userId);
  }

  isConnected(userId: string): boolean {
    const entry = this.entries.get(userId);
    return !!entry && entry.socket.connected;
  }

  // Cache the latest device snapshot the companion pushed up so a freshly
  // opened web client can fetch the current device list over REST.
  setDeviceSnapshot(userId: string, snapshot: unknown): void {
    this.deviceSnapshots.set(userId, snapshot);
  }

  getDeviceSnapshot(userId: string): unknown {
    return this.deviceSnapshots.get(userId) ?? null;
  }

  // Resolve a pending RPC when the companion sends runner:http:response.
  // fromUserId must match the RPC's owner — prevents companion A from resolving B's request.
  resolveRpc(requestId: string, fromUserId: string, response: RunnerProxyResponse): void {
    const rpc = this.pending.get(requestId);
    if (!rpc || rpc.userId !== fromUserId) return;
    clearTimeout(rpc.timer);
    this.pending.delete(requestId);
    rpc.resolve(response);
  }

  // Send a runner REST call through the companion's socket and await a response.
  // The companion handles runner:http:request by calling its local runner HTTP server.
  async proxyRequest(
    userId: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    opts?: { timeoutMs?: number; signal?: AbortSignal; bodyEncoding?: 'json' | 'base64-file' },
  ): Promise<RunnerProxyResponse> {
    const entry = this.get(userId);
    if (!entry) {
      throw new Error(`No connected companion for user ${userId.substring(0, 8)}`);
    }
    if (opts?.signal?.aborted) {
      throw new Error(`Runner proxy request aborted before send: ${method} ${path}`);
    }

    const requestId = `${userId}:${crypto.randomBytes(8).toString('hex')}`;
    return new Promise<RunnerProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        opts?.signal?.removeEventListener('abort', abort);
        reject(new Error(`Runner proxy request timed out after ${opts?.timeoutMs ?? RPC_TIMEOUT_MS}ms`));
      }, opts?.timeoutMs ?? RPC_TIMEOUT_MS);

      const abort = () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        const current = this.entries.get(userId);
        if (pending.emitted && current?.socket.connected) {
          current.socket.emit('runner:http:cancel', { requestId });
        }
        reject(new Error(`Runner proxy request aborted: ${method} ${path}`));
      };
      opts?.signal?.addEventListener('abort', abort, { once: true });

      const settle = (fn: () => void) => {
        opts?.signal?.removeEventListener('abort', abort);
        fn();
      };

      const request = { requestId, method, path, body, headers, bodyEncoding: opts?.bodyEncoding };
      if (entry.socket.connected) {
        this.pending.set(requestId, {
          userId,
          request,
          resolve: (res) => settle(() => resolve(res)),
          reject: (err) => settle(() => reject(err)),
          timer,
          emitted: true,
          deliveries: 1,
        });
        entry.socket.emit('runner:http:request', request);
        return;
      }

      if (this.graceTimers.has(userId)) {
        this.pending.set(requestId, {
          userId,
          request,
          resolve: (res) => settle(() => resolve(res)),
          reject: (err) => settle(() => reject(err)),
          timer,
          emitted: false,
          deliveries: 0,
        });
        return;
      }

      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', abort);
      reject(new Error(`No connected companion for user ${userId.substring(0, 8)}`));
    });
  }

  private flushQueuedRequests(userId: string, socket: Socket): void {
    for (const [reqId, rpc] of this.pending) {
      if (rpc.userId !== userId) continue;
      // Bound re-delivery: recovering a response lost to a mid-flight drop is the
      // goal, but if the response is structurally undeliverable (e.g. it exceeds
      // maxHttpBufferSize and closes the socket on every send), unbounded re-emit
      // becomes a connect→drop→re-emit flap. Fail the RPC fast after the cap so
      // the caller retries cleanly instead of the relay looping forever.
      if (rpc.deliveries >= MAX_REDELIVERIES) {
        clearTimeout(rpc.timer);
        this.pending.delete(reqId);
        logger.warn('[CompanionRegistry] RPC exceeded re-delivery cap — failing fast', {
          userId: userId.substring(0, 8),
          path: rpc.request.path,
          deliveries: rpc.deliveries,
        });
        rpc.reject(new Error(
          `Companion response undeliverable after ${rpc.deliveries} attempts (likely exceeds the relay message-size limit): ${rpc.request.method} ${rpc.request.path}`,
        ));
        continue;
      }
      // Re-emit EVERY remaining pending request for this (re)connected companion —
      // including ones already emitted on the previous socket. A mid-flight relay
      // drop loses the `runner:http:response`, so the RPC would otherwise hang
      // until its timeout even though the companion reconnected within grace. The
      // runner de-dupes by requestId (cached response, no re-execution), so
      // re-delivery is safe and recovers the lost response in ~1s.
      rpc.emitted = true;
      rpc.deliveries += 1;
      socket.emit('runner:http:request', rpc.request);
    }
  }

  private rejectPendingForUser(userId: string, err: Error): void {
    for (const [reqId, rpc] of this.pending) {
      if (rpc.userId !== userId) continue;
      clearTimeout(rpc.timer);
      rpc.reject(err);
      this.pending.delete(reqId);
    }
  }
}

// Singleton — shared by the companion namespace handler and any service
// that needs to route through the companion.
export const companionRegistry = new CompanionRegistry();
