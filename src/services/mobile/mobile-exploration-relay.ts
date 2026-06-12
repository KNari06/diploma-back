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
  /** The runner's run id — what we subscribe to on the runner socket. */
  runId: string;
  /**
   * Our backend exploration id, used to RE-LABEL forwarded events. The
   * runner mints its own runId; the frontend keys off explorationId. When
   * omitted we fall back to runId (they're the same on the web path).
   */
  explorationId?: string;
  /** Routing: which chat session + user the backend emits to. */
  chatSessionId?: string;
  userId?: string;
  /** Total budget for the timer display; forwarded if the runner omits it. */
  budgetMs?: number;
  /** Hard cap before the relay self-disconnects (default 20 min). */
  maxLifetimeMs?: number;
}

const DEFAULT_MAX_LIFETIME_MS = 20 * 60 * 1000;

/** Terminal outcome resolved by waitUntilDone(). */
export interface MobileExplorationRelayOutcome {
  status: 'completed' | 'failed';
  errorMessage?: string;
  testCasesCount: number;
  summary: Record<string, unknown>;
  /** Why the relay ended: a forwarded completion, a stop(), or the cap. */
  reason: 'completed' | 'stopped' | 'timeout';
}

export class MobileExplorationRelay {
  private socket: Socket | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  // Resolved once the run terminates (completion / stop / cap). Lets the
  // owning job hold the relay for the run's duration, then persist + emit.
  private donePromise: Promise<MobileExplorationRelayOutcome>;
  private resolveDone!: (o: MobileExplorationRelayOutcome) => void;
  private lastCompleted: Partial<ExplorationCompletedPayload> | null = null;

  constructor(private readonly params: MobileExplorationRelayParams) {
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Await the run's terminal outcome (job holds the relay until this resolves). */
  waitUntilDone(): Promise<MobileExplorationRelayOutcome> {
    return this.donePromise;
  }

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
      this.lastCompleted = envelope;
      this.forwardCompleted(envelope);
      // Terminal — tear down once the completion is forwarded.
      this.stop('completed');
    });

    // The runner replays buffered events on subscribe as RAW `explorer:event`,
    // NOT as the web-contract envelopes above. For a run that finished
    // between startExploration() and our subscribe (fast runs), the only
    // signal we get is a replayed `explorer:event` with kind 'finished'.
    // Recognise it and synthesise a completion so the job never hangs.
    socket.on('explorer:event', (event: { kind?: string; terminalStatus?: string; error?: string } | undefined) => {
      if (event?.kind === 'finished' && !this.lastCompleted) {
        const terminal = event.terminalStatus;
        const status: ExplorationCompletedPayload['status'] = terminal === 'failed' ? 'failed' : 'completed';
        const synth: Partial<ExplorationCompletedPayload> = {
          explorationId: this.params.explorationId ?? this.params.runId,
          status,
          errorMessage: event.error,
        };
        this.lastCompleted = synth;
        this.forwardCompleted(synth);
        this.stop('completed');
      }
    });

    socket.on('connect_error', (err: Error) => {
      logger.warn('[mobile-exploration-relay] connect_error', {
        runId,
        err: err?.message,
      });
    });

    // After 5 reconnect attempts socket.io-client gives up silently. Without
    // this the job's waitUntilDone() would hang until the lifetime cap (20
    // min). Fail fast instead so the run is marked failed promptly.
    socket.on('reconnect_failed', () => {
      logger.error('[mobile-exploration-relay] reconnect attempts exhausted', { runId });
      this.stop('connect_failed');
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

    // Resolve the owning job's await exactly once. A forwarded completion
    // carries the real status/summary; a stop()/timeout without one is a
    // failed outcome (the run never reported done).
    const c = this.lastCompleted;
    const outcomeReason: MobileExplorationRelayOutcome['reason'] =
      reason === 'completed' ? 'completed' : reason === 'timeout' ? 'timeout' : 'stopped';
    this.resolveDone({
      status: c ? (c.status === 'failed' ? 'failed' : 'completed') : 'failed',
      errorMessage: c?.errorMessage ?? (c ? undefined : `relay ended without completion (${reason})`),
      testCasesCount: c?.testCasesCount ?? 0,
      summary: c?.summary ?? {},
      reason: outcomeReason,
    });
  }

  private forwardProgress(envelope: Partial<ExplorationProgressPayload>): void {
    const payload: ExplorationProgressPayload = {
      explorationId: this.params.explorationId ?? envelope.explorationId ?? this.params.runId,
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
      explorationId: this.params.explorationId ?? envelope.explorationId ?? this.params.runId,
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
