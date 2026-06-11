import { io, type Socket } from 'socket.io-client';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import type {
  ExplorationProgressPayload,
  ExplorationCompletedPayload,
} from '@/websocket/types/types';

/**
 * Mobile exploration relay (Stage 3, Slice 2).
 *
 * Bridges one runner exploration run onto the backend's own Socket.IO so
 * the browser never connects to the runner directly (the runner API key
 * stays server-side). The runner ALREADY emits the web-contract
 * `exploration:progress` / `exploration:completed` envelopes (see
 * qait-mobile-runner explorer-ws.ts), so this relay forwards them
 * verbatim — only stamping the `chatSessionId` + `userId` the runner
 * doesn't know, which the backend emitters use to target rooms.
 *
 * Lifecycle: one Socket per run. `start()` connects + subscribes;
 * the relay tears itself down on `exploration:completed`, on a terminal
 * `explorer:event`, or via `stop()` (cancel / job cleanup). A safety
 * timeout disconnects a relay whose run never reports completion so a
 * crashed runner can't leak a socket forever.
 */

export interface MobileExplorationRelayParams {
  /** Runner Socket.IO base URL, e.g. ws://runner:4100 (http(s):// also ok). */
  runnerSocketUrl: string;
  /** The runner's run id — also the explorationId on the wire. */
  runId: string;
  /** Routing: which chat session + user the backend emits to. */
  chatSessionId?: string;
  userId?: string;
  /** Total budget for the timer display; forwarded if the runner omits it. */
  budgetMs?: number;
  /** Hard cap before the relay self-disconnects (default 20 min). */
  maxLifetimeMs?: number;
}

const DEFAULT_MAX_LIFETIME_MS = 20 * 60 * 1000;

export class MobileExplorationRelay {
  private socket: Socket | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly params: MobileExplorationRelayParams) {}

  /** Connect to the runner, subscribe to the run, begin forwarding. */
  start(): void {
    const { runnerSocketUrl, runId } = this.params;
    // socket.io-client accepts http(s):// and ws(s):// — normalise to http
    // since the runner mounts the default namespace on the HTTP server.
    const url = runnerSocketUrl.replace(/^ws/, 'http');

    const socket = io(url, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      // Server-held key — injected here, never sent to the browser.
      auth: env.MOBILE_RUNNER_API_KEY ? { apiKey: env.MOBILE_RUNNER_API_KEY } : undefined,
    });
    this.socket = socket;

    socket.on('connect', () => {
      logger.info('[mobile-exploration-relay] connected', { runId });
      socket.emit('subscribe:explorer', { runId });
    });

    socket.on('exploration:progress', (envelope: Partial<ExplorationProgressPayload>) => {
      this.forwardProgress(envelope);
    });

    socket.on('exploration:completed', (envelope: Partial<ExplorationCompletedPayload>) => {
      this.forwardCompleted(envelope);
      // Terminal — tear down once the completion is forwarded.
      this.stop('completed');
    });

    socket.on('connect_error', (err: Error) => {
      logger.warn('[mobile-exploration-relay] connect_error', {
        runId,
        err: err?.message,
      });
    });

    socket.on('error', (err: unknown) => {
      logger.warn('[mobile-exploration-relay] runner socket error', {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    });

    // Safety: never let a relay outlive its run if completion is missed.
    this.lifetimeTimer = setTimeout(() => {
      logger.warn('[mobile-exploration-relay] lifetime cap hit — disconnecting', { runId });
      this.stop('timeout');
    }, this.params.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS);
  }

  /** Disconnect + clear timers. Idempotent. */
  stop(reason: string = 'manual'): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.emit('unsubscribe:explorer', { runId: this.params.runId });
      } catch { /* socket may already be down */ }
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    logger.info('[mobile-exploration-relay] stopped', { runId: this.params.runId, reason });
  }

  private forwardProgress(envelope: Partial<ExplorationProgressPayload>): void {
    const payload: ExplorationProgressPayload = {
      explorationId: envelope.explorationId ?? this.params.runId,
      phase: envelope.phase ?? 'flow',
      event: envelope.event ?? 'progress',
      progressPercent: envelope.progressPercent ?? 0,
      data: envelope.data ?? {},
      timestamp: envelope.timestamp ?? new Date().toISOString(),
      budgetMs: envelope.budgetMs ?? this.params.budgetMs,
      // Stamp routing the runner can't know.
      chatSessionId: this.params.chatSessionId,
      userId: this.params.userId,
    };
    webSocketService.emitExplorationProgress(payload);
  }

  private forwardCompleted(envelope: Partial<ExplorationCompletedPayload>): void {
    const payload: ExplorationCompletedPayload = {
      explorationId: envelope.explorationId ?? this.params.runId,
      testCasesCount: envelope.testCasesCount ?? 0,
      summary: envelope.summary ?? {},
      status: envelope.status === 'failed' ? 'failed' : 'completed',
      errorMessage: envelope.errorMessage,
      timestamp: envelope.timestamp ?? new Date().toISOString(),
      chatSessionId: this.params.chatSessionId,
      userId: this.params.userId,
    };
    webSocketService.emitExplorationCompleted(payload);
  }
}
