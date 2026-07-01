import crypto from 'crypto';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { redisConnection } from '@/config/infrastructure/queues';
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

// ─── Cross-replica coordination (prod runs the API on N Container-App replicas) ───
// A companion's WebSocket lives on exactly ONE replica, but warmup/run HTTP
// requests and browser sockets land on ANY replica (no session affinity). So
// presence, the request/response RPC, and device-event fan-out are carried over
// Redis so any replica can reach a companion socketed on another one. Each
// replica has a random instance id (injectable for tests) and a dedicated
// subscriber connection.
const PRESENCE_PREFIX = 'companion:presence:'; // userId → instance id holding the socket
const SNAPSHOT_PREFIX = 'companion:snapshot:'; // userId → latest devices:snapshot (JSON)
const DEV_CHANNEL = 'companion:dev';           // {userId,event,data} → every replica re-emits to user:<id>
const reqChannel = (inst: string) => `companion:req:${inst}`;    // proxy request → the socket-holding replica
const resChannel = (inst: string) => `companion:res:${inst}`;    // proxy response → the request-origin replica
const cancelChannel = (inst: string) => `companion:cancel:${inst}`;
const PRESENCE_TTL_S = 60;          // stale presence self-heals if a replica dies
const PRESENCE_REFRESH_MS = 25_000; // re-stamp live companions well within the TTL
const SNAPSHOT_TTL_S = 3600;

// A socket migrating replicas (deploy / scale-in) makes an in-flight request land
// on a replica that no longer holds the socket → RELAY_MOVED. Re-look up presence
// and re-route a bounded number of times so the handoff is transparent.
const RELAY_MOVED_CODE = 'RELAY_MOVED';
const MAX_RELAY_RETRIES = 3;
const RELAY_RETRY_DELAY_MS = 250;

// Bound the lifetime of a relayed-request bookkeeping entry on the socket-holding
// replica so a request that times out on the origin (no response ever sent back)
// can't leak the entry until the companion disconnects.
const RELAYED_TTL_MS = 2 * RPC_TIMEOUT_MS;

// Device events / snapshots are small metadata, but guard the pub/sub the same
// way the shared WS bridge does so an oversized frame can't overload Redis or
// evict the subscriber. (Reusing redisWebSocketBridge for this fan-out is a
// worthwhile follow-up; kept bespoke here to avoid its central-callback wiring.)
const MAX_DEV_PAYLOAD_BYTES = 1_000_000;
// A cross-replica RPC response carries the runner's body incl. a base64
// screenshot. Redis pub/sub has strict client-output-buffer limits, so above
// this size we transfer the body OUT OF BAND: SET it under a short-lived key and
// publish only a small pointer. Regular GET/SET has no such buffer limit.
const MAX_PUBSUB_INLINE_BYTES = 256_000;
const RESBODY_PREFIX = 'companion:resbody:';
const RESBODY_TTL_S = 60;

// Atomic compare-and-delete (mirrors src/scheduler/leader.ts RELEASE_IF_OWNER):
// only release presence + snapshot if THIS instance still owns presence, so a
// reconnect that already re-claimed it on another replica isn't clobbered.
const RELEASE_IF_OWNER = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('del', KEYS[1])
  redis.call('del', KEYS[2])
  return 1
end
return 0`;

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
  // When the companion socket is on ANOTHER replica, the instance id it's on —
  // so abort routes a cancel to that replica instead of a local socket.
  crossReplica: string | null;
}

export class CompanionRegistry {
  // Injectable so tests can spin up multiple instances against one (fake) Redis
  // to exercise the real cross-replica round-trip; prod uses the random default.
  constructor(private readonly instanceId: string = crypto.randomBytes(6).toString('hex')) {}

  private readonly entries = new Map<string, CompanionEntry>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Pending RPCs THIS replica originated (awaiting a response), keyed by requestId.
  private readonly pending = new Map<string, PendingRpc>();
  // requestId → {origin instance, expiry}, for requests THIS replica is relaying
  // to its local socket on behalf of another replica (so the response routes home).
  private readonly relayedOrigins = new Map<string, { origin: string; expiresAt: number }>();

  private io: SocketIOServer | null = null;
  private sub: ReturnType<typeof redisConnection.duplicate> | null = null;
  private subReady: Promise<void> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  // Attach the Socket.IO server so device events fan out to browser rooms.
  // Called once from the companion namespace init (API process only). The
  // cross-replica Redis subscriber is set up separately (see ensureSubscriber)
  // so processes WITHOUT an io — the worker, which also originates proxy
  // requests — still receive their responses.
  init(io: SocketIOServer): void {
    this.io = io;
    void this.ensureSubscriber();
  }

  // Idempotently create the Redis pub/sub subscriber + presence heartbeat and
  // return a promise that resolves once the SUBSCRIBE has taken effect. Callers
  // that publish cross-replica MUST await this first, or the response on
  // resChannel(this.instanceId) can arrive before the channel is subscribed and be
  // dropped. Triggered by init() (API) AND proxyRequest() (worker/any origin).
  private ensureSubscriber(): Promise<void> {
    if (this.subReady) return this.subReady;
    const sub = redisConnection.duplicate();
    this.sub = sub;
    sub.on('message', (channel: string, message: string) => {
      this.onRedisMessage(channel, message).catch((err) => {
        logger.warn('[CompanionRegistry] cross-replica message handling failed', {
          channel, error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    this.subReady = sub.subscribe(
      reqChannel(this.instanceId),
      resChannel(this.instanceId),
      cancelChannel(this.instanceId),
      DEV_CHANNEL,
    ).then(() => undefined).catch((err) => {
      // Reset so a later call retries the subscribe rather than assuming success.
      this.subReady = null;
      logger.error('[CompanionRegistry] failed to subscribe to Redis channels', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.presenceTimer = setInterval(() => this.onHeartbeat(), PRESENCE_REFRESH_MS);
    this.presenceTimer.unref?.();
    logger.info('[CompanionRegistry] cross-replica coordination initialized', { instanceId: this.instanceId });
    return this.subReady;
  }

  register(userId: string, socket: Socket): void {
    const existing = this.graceTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.graceTimers.delete(userId);
      logger.info('[CompanionRegistry] Companion reconnected within grace period', { userId: userId.substring(0, 8) });
    }
    this.entries.set(userId, { socket, userId, connectedAt: new Date() });
    // Claim presence for THIS replica (overwrites a stale entry if the companion
    // moved here from another instance).
    redisConnection.set(`${PRESENCE_PREFIX}${userId}`, this.instanceId, 'EX', PRESENCE_TTL_S).catch(() => {});
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
      // Release presence + snapshot atomically, ONLY if we still own presence —
      // a reconnect on another replica has already re-claimed it and must not be
      // clobbered (a non-atomic get-then-del would race at the TTL boundary).
      redisConnection.eval(
        RELEASE_IF_OWNER, 2,
        `${PRESENCE_PREFIX}${userId}`, `${SNAPSHOT_PREFIX}${userId}`, this.instanceId,
      ).catch(() => {});
      this.clearRelayedForUser(userId);
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

  // Cross-replica: true if this user's companion is connected on ANY replica.
  async isConnected(userId: string): Promise<boolean> {
    const entry = this.entries.get(userId);
    if (entry && entry.socket.connected) return true;
    try {
      return !!(await redisConnection.get(`${PRESENCE_PREFIX}${userId}`));
    } catch {
      // Degrade to "not connected" → shared-runner fallback when Redis is down.
      return false;
    }
  }

  // Cache + fan out a device event the companion pushed up. The snapshot is
  // stored in Redis so a browser on ANY replica can bootstrap over REST, and the
  // event is published so every replica re-emits it to its local `user:<id>`
  // room (browsers may be socketed on a different replica than the companion).
  forwardDeviceEvent(userId: string, event: string, data: unknown): void {
    const envelope = JSON.stringify({ userId, event, data });
    if (envelope.length > MAX_DEV_PAYLOAD_BYTES) {
      logger.warn('[CompanionRegistry] dropping oversized device event', {
        userId: userId.substring(0, 8), event, bytes: envelope.length,
      });
      return;
    }
    if (event === 'devices:snapshot') {
      redisConnection.set(`${SNAPSHOT_PREFIX}${userId}`, JSON.stringify(data ?? null), 'EX', SNAPSHOT_TTL_S).catch(() => {});
    }
    redisConnection.publish(DEV_CHANNEL, envelope).catch(() => {});
  }

  async getDeviceSnapshot(userId: string): Promise<unknown> {
    try {
      const raw = await redisConnection.get(`${SNAPSHOT_PREFIX}${userId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // Resolve a pending RPC when the companion sends runner:http:response.
  // fromUserId must match the RPC's owner — prevents companion A from resolving B's request.
  resolveRpc(requestId: string, fromUserId: string, response: RunnerProxyResponse): void {
    // Origin is THIS replica → resolve the local promise.
    if (this.resolveLocalPending(requestId, fromUserId, response)) return;
    // We only relayed this request to our local socket for another replica →
    // route the response home over Redis.
    const relayed = this.relayedOrigins.get(requestId);
    if (relayed) {
      this.relayedOrigins.delete(requestId);
      this.publishResponse(relayed.origin, requestId, fromUserId, response);
    }
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
    if (opts?.signal?.aborted) {
      throw new Error(`Runner proxy request aborted before send: ${method} ${path}`);
    }
    return this.proxyAttempt(userId, method, path, body, headers, opts, 0);
  }

  private async proxyAttempt(
    userId: string,
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> | undefined,
    opts: { timeoutMs?: number; signal?: AbortSignal; bodyEncoding?: 'json' | 'base64-file' } | undefined,
    attempt: number,
  ): Promise<RunnerProxyResponse> {
    if (opts?.signal?.aborted) {
      throw new Error(`Runner proxy request aborted before send: ${method} ${path}`);
    }
    const requestId = `${userId}:${crypto.randomBytes(8).toString('hex')}`;
    const request: RunnerProxyRequest = { requestId, method, path, body, headers, bodyEncoding: opts?.bodyEncoding };

    // FAST PATH — companion socketed on THIS replica.
    const local = this.entries.get(userId);
    if (local?.socket.connected) {
      return this.createPending(userId, request, opts, () => local.socket.emit('runner:http:request', request), null);
    }

    // Presence decides the rest: it may point here (socket in grace → queue for a
    // local reconnect), to another replica (relay), or nowhere (no companion).
    let targetInstance: string | null;
    try {
      targetInstance = await redisConnection.get(`${PRESENCE_PREFIX}${userId}`);
    } catch {
      targetInstance = null;
    }
    // The caller may have aborted during the async presence lookup, before any
    // pending (and its abort listener) exists — honour it here.
    if (opts?.signal?.aborted) {
      throw new Error(`Runner proxy request aborted before send: ${method} ${path}`);
    }
    // The companion may have (re)connected on THIS replica during the async
    // lookup (a reconnect racing the request) — take the fast path now.
    const reLocal = this.entries.get(userId);
    if (reLocal?.socket.connected) {
      return this.createPending(userId, request, opts, () => reLocal.socket.emit('runner:http:request', request), null);
    }

    // Socket dropped but may reconnect HERE within grace — queue for flush. Only
    // when presence is ours or unknown; if it points elsewhere the companion has
    // already moved, so fall through to the relay instead of waiting locally.
    if (this.graceTimers.has(userId) && (targetInstance === this.instanceId || !targetInstance)) {
      return this.createPending(userId, request, opts, null, null);
    }
    if (!targetInstance || targetInstance === this.instanceId) {
      throw new Error(`No connected companion for user ${userId.substring(0, 8)}`);
    }

    // CROSS-REPLICA — relay to the socket-holding replica. Subscribe (and wait
    // for it) BEFORE publishing so a fast response on our res-channel isn't
    // dropped as not-yet-subscribed. (The local fast path above needs no
    // subscriber — its response comes back over the socket, not Redis.)
    await this.ensureSubscriber();
    const res = await this.createPending(userId, request, opts, () => {
      redisConnection.publish(
        reqChannel(targetInstance as string),
        JSON.stringify({ requestId, originInstance: this.instanceId, userId, request }),
      ).catch(() => {});
    }, targetInstance);

    // The socket migrated replicas between our presence read and delivery →
    // re-look up presence and retry a bounded number of times so a normal
    // deploy/scale handoff is transparent instead of a terminal failure.
    if (this.isRelayMoved(res) && attempt < MAX_RELAY_RETRIES && !opts?.signal?.aborted) {
      await new Promise((r) => setTimeout(r, RELAY_RETRY_DELAY_MS));
      return this.proxyAttempt(userId, method, path, body, headers, opts, attempt + 1);
    }
    return res;
  }

  private isRelayMoved(res: RunnerProxyResponse): boolean {
    return !res.ok
      && !!res.body
      && typeof res.body === 'object'
      && (res.body as { code?: string }).code === RELAY_MOVED_CODE;
  }

  // Builds the awaited promise + timer + abort + pending entry shared by the
  // local and cross-replica paths. `onEmit` sends the request (null = queued for
  // a within-grace reconnect); `crossReplica` is the socket-holding instance id.
  private createPending(
    userId: string,
    request: RunnerProxyRequest,
    opts: { timeoutMs?: number; signal?: AbortSignal } | undefined,
    onEmit: (() => void) | null,
    crossReplica: string | null,
  ): Promise<RunnerProxyResponse> {
    const { requestId } = request;
    return new Promise<RunnerProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        opts?.signal?.removeEventListener('abort', abort);
        reject(new Error(`Runner proxy request timed out after ${opts?.timeoutMs ?? RPC_TIMEOUT_MS}ms`));
      }, opts?.timeoutMs ?? RPC_TIMEOUT_MS);

      const abort = () => {
        const p = this.pending.get(requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        if (p.emitted) {
          if (p.crossReplica) {
            redisConnection.publish(cancelChannel(p.crossReplica), JSON.stringify({ requestId })).catch(() => {});
          } else {
            const current = this.entries.get(userId);
            if (current?.socket.connected) current.socket.emit('runner:http:cancel', { requestId });
          }
        }
        reject(new Error(`Runner proxy request aborted: ${request.method} ${request.path}`));
      };
      opts?.signal?.addEventListener('abort', abort, { once: true });
      const settle = (fn: () => void) => {
        opts?.signal?.removeEventListener('abort', abort);
        fn();
      };

      this.pending.set(requestId, {
        userId,
        request,
        resolve: (res) => settle(() => resolve(res)),
        reject: (err) => settle(() => reject(err)),
        timer,
        emitted: onEmit != null,
        deliveries: onEmit != null ? 1 : 0,
        crossReplica,
      });
      if (onEmit) onEmit();
    });
  }

  // Dispatch a cross-replica Redis message. Channels are per-instance so a
  // message only reaches the replica it concerns (except DEV_CHANNEL, fan-out).
  private async onRedisMessage(channel: string, message: string): Promise<void> {
    if (channel === DEV_CHANNEL) {
      const { userId, event, data } = JSON.parse(message) as { userId: string; event: string; data: unknown };
      this.io?.to(`user:${userId}`).emit(event, data);
      return;
    }
    if (channel === reqChannel(this.instanceId)) {
      // A proxy request for a companion socketed on THIS replica.
      const { requestId, originInstance, userId, request } =
        JSON.parse(message) as { requestId: string; originInstance: string; userId: string; request: RunnerProxyRequest };
      const entry = this.entries.get(userId);
      if (!entry?.socket.connected) {
        // We no longer hold the socket (it moved). Tell the origin fast so it retries.
        this.publishResponse(originInstance, requestId, userId, {
          status: 0, ok: false, body: { error: 'Companion socket not on target replica', code: RELAY_MOVED_CODE },
        });
        return;
      }
      this.relayedOrigins.set(requestId, { origin: originInstance, expiresAt: Date.now() + RELAYED_TTL_MS });
      entry.socket.emit('runner:http:request', request);
      return;
    }
    if (channel === resChannel(this.instanceId)) {
      // A response for a request THIS replica originated. It's either inline or
      // an out-of-band pointer (bodyKey) for a large body — fetch + delete it.
      const parsed = JSON.parse(message) as
        { requestId: string; userId: string; response?: RunnerProxyResponse; bodyKey?: string };
      if (parsed.bodyKey) {
        const raw = await redisConnection.get(parsed.bodyKey).catch(() => null);
        redisConnection.del(parsed.bodyKey).catch(() => {});
        if (raw) this.resolveLocalPending(parsed.requestId, parsed.userId, JSON.parse(raw) as RunnerProxyResponse);
        // If the body key expired/lost, leave the pending to time out (rare).
        return;
      }
      if (parsed.response) this.resolveLocalPending(parsed.requestId, parsed.userId, parsed.response);
      return;
    }
    if (channel === cancelChannel(this.instanceId)) {
      const { requestId } = JSON.parse(message) as { requestId: string };
      const relayed = this.relayedOrigins.get(requestId);
      this.relayedOrigins.delete(requestId);
      if (relayed) {
        const userId = requestId.slice(0, requestId.lastIndexOf(':'));
        const entry = this.entries.get(userId);
        if (entry?.socket.connected) entry.socket.emit('runner:http:cancel', { requestId });
      }
      return;
    }
  }

  private publishResponse(originInstance: string, requestId: string, userId: string, response: RunnerProxyResponse): void {
    const inline = JSON.stringify({ requestId, userId, response });
    if (inline.length <= MAX_PUBSUB_INLINE_BYTES) {
      redisConnection.publish(resChannel(originInstance), inline).catch(() => {});
      return;
    }
    // Large response (e.g. a step result with a base64 screenshot): stash the
    // body under a short-lived key and publish only a pointer, keeping big
    // payloads off pub/sub (which has strict client-output-buffer limits).
    const bodyKey = `${RESBODY_PREFIX}${requestId}`;
    redisConnection.set(bodyKey, JSON.stringify(response), 'EX', RESBODY_TTL_S)
      .then(() => redisConnection.publish(resChannel(originInstance), JSON.stringify({ requestId, userId, bodyKey })))
      .catch(() => {});
  }

  private resolveLocalPending(requestId: string, fromUserId: string, response: RunnerProxyResponse): boolean {
    const rpc = this.pending.get(requestId);
    if (!rpc || rpc.userId !== fromUserId) return false;
    clearTimeout(rpc.timer);
    this.pending.delete(requestId);
    rpc.resolve(response);
    return true;
  }

  private clearRelayedForUser(userId: string): void {
    for (const reqId of this.relayedOrigins.keys()) {
      if (reqId.startsWith(`${userId}:`)) this.relayedOrigins.delete(reqId);
    }
  }

  // Heartbeat: re-stamp presence for CONNECTED local sockets only (a grace-period
  // entry whose socket dropped must not re-claim presence a reconnect-elsewhere
  // already took), and sweep expired relayed-request bookkeeping.
  private onHeartbeat(): void {
    for (const [userId, entry] of this.entries) {
      if (!entry.socket.connected) continue;
      redisConnection.set(`${PRESENCE_PREFIX}${userId}`, this.instanceId, 'EX', PRESENCE_TTL_S).catch(() => {});
    }
    const now = Date.now();
    for (const [reqId, v] of this.relayedOrigins) {
      if (v.expiresAt <= now) this.relayedOrigins.delete(reqId);
    }
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
      // re-delivery is safe and recovers the lost response in ~1s. The companion
      // now being local, a previously cross-replica pending is served directly.
      rpc.emitted = true;
      rpc.deliveries += 1;
      rpc.crossReplica = null;
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
