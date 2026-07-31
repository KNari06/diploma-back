/**
 * WebSocket Server
 * Main Socket.IO server configuration and setup
 */

import { isDevelopment, env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { handleConnection } from '../handlers/connection.handler';
import { initCompanionNamespace } from '../handlers/companion.handler';
import { authenticateSocket } from '../middleware/middleware';
import { refreshIdle } from '@/services/mobile/mobile-idle.service';
import { refreshIdle as refreshPreviewIdle } from '@/services/testing/ui/preview/preview-idle.service';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types/types';

/**
 * Events that are background/heartbeat traffic and should NOT count as
 * "user activity" for the mobile-editor idle timer. The latency `ping`
 * fires every 10s from the frontend while a preview session is open;
 * counting it as activity would prevent the idle timer from ever firing.
 */
const IDLE_BACKGROUND_EVENTS = new Set<string>([
  'ping', // app-level latency probe — see socketClient.startLatencyPing()
  // NOTE: `mobile:keepalive` is deliberately NOT listed here. It is the
  // counterpart to `ping` — an explicit "user is interacting with the mobile
  // runner" signal that MUST refresh the idle timers. See ClientToServerEvents
  // in ../types/types.ts and heartbeat.handler.ts.
]);

let io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData> | null = null;

/**
 * Initialize WebSocket server
 */
export const initializeWebSocket = (httpServer: HTTPServer): SocketIOServer => {
  logger.debug('[WebSocket] Initializing WebSocket server...');

  const devAllowedOrigins = [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];

  // Parse CORS origins
  let corsOrigin: boolean | string[] = false;
  if (isDevelopment) {
    corsOrigin = true;
  } else if (process.env.ALLOWED_ORIGINS) {
    try {
      const origins = process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
      if (origins.length > 0) {
        corsOrigin = Array.from(new Set([...origins, ...devAllowedOrigins]));
      }
    } catch (error) {
      logger.warn('[WebSocket] Failed to parse ALLOWED_ORIGINS, disabling CORS', {
        error: error instanceof Error ? error.message : String(error),
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      });
    }
  } else if (process.env.FRONTEND_URL && process.env.FRONTEND_URL.trim().length > 0) {
    // Safe fallback: allow a single configured frontend origin if provided explicitly
    corsOrigin = Array.from(new Set([process.env.FRONTEND_URL.trim(), ...devAllowedOrigins]));
  } else {
    /**
     * IMPORTANT:
     * If ALLOWED_ORIGINS is not configured in production, blocking all origins will break Socket.IO handshake
     * for any cross-origin frontend deployments (e.g. app subdomain → api root domain).
     *
     * Since we enforce JWT auth at the Socket.IO middleware level, allowing all origins here is acceptable
     * as a resilience default; set ALLOWED_ORIGINS to tighten it.
     */
    corsOrigin = true;
    logger.warn('[WebSocket] ALLOWED_ORIGINS not set; allowing all origins for Socket.IO', {
      note: 'Set ALLOWED_ORIGINS (comma-separated) to restrict CORS in production',
    });
  }

  // Optimize transport configuration:
  // - In production: prefer websocket (more efficient, fewer HTTP requests)
  // - In development: allow both (easier debugging)
  // - Increase pingInterval to reduce polling frequency (important for polling transport)
  const transports: ('websocket' | 'polling')[] = ['websocket', 'polling']; // websocket first (preferred), polling as fallback

  // Create Socket.IO server with typed events
  io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData>(
    httpServer,
    {
      cors: {
        origin: corsOrigin,
        credentials: true,
        methods: ['GET', 'POST'],
      },
      // Connection options
      // ⚠️ pingInterval affects polling frequency. Lower = more requests
      // (~6/min/client) but faster dead-connection detection.
      // Fast detection matters because the editor's session-cleanup logic
      // (destroy the mobile emulator on browser close, with 15s grace) and the
      // per-user idle timer key off the disconnect.
      //
      // `pingTimeout` is back at Socket.IO's 20s default. At 10s a QA engineer
      // on mobile tethering or a VPN tripped it routinely: a lapsed heartbeat
      // declared the socket dead, and 15s later the grace cleanup destroyed a
      // live emulator session. That was the most common teardown cause in
      // `trace_files` — 59 `ping timeout` events between 2026-06-23 and
      // 2026-07-31, 13 on 2026-07-30 alone.
      //
      // The correctness risk that motivated the tighter window (destroying a
      // session mid-step) is now handled properly by the in-flight guard in
      // `connection.handler.ts` — a busy session is deferred, not destroyed —
      // so this only needs to be forgiving of a flaky network, not a backstop.
      // `pingInterval` stays at 10s: the heartbeat cadence drives polling
      // frequency, and only the tolerance for a MISSED pong needed widening.
      pingTimeout: 20000, // 20s — disconnect window after a missed pong
      pingInterval: 10000, // 10s — heartbeat cadence
      connectTimeout: 45000, // 45 seconds
      // Transport options
      // Order matters: first transport is preferred
      transports,
      allowUpgrades: true, // Allow upgrade from polling to websocket
      // Additional polling optimization
      httpCompression: true, // Compress polling responses
      // Max single-message size. Browser video frames are ~900KB, but the
      // COMPANION relay carries full runner HTTP responses end-to-end —
      // a per-step apply result includes a base64 device SCREENSHOT (a rich
      // phone screen PNG is several MB) + the a11y/inspector tree. At 2MB those
      // exceeded the buffer, so engine.io closed the companion socket the moment
      // it sent the response (client saw `transport close`) — and the relay then
      // flapped as the lost response was re-delivered. 16MB carries a
      // screenshot-bearing response with headroom; env-tunable for larger screens.
      maxHttpBufferSize: env.WS_MAX_HTTP_BUFFER_SIZE,
    }
  );

  // Apply authentication middleware
  io.use(authenticateSocket);

  // Handle connection errors (transport-level errors)
  io.engine.on('connection_error', (error) => {
    // Log transport errors with full context
    logger.warn('[WebSocket] Connection error', {
      message: error.message || 'Unknown error',
      code: error.code,
      type: error.type,
      context: error.context,
      req: error.req ? {
        url: error.req.url,
        method: error.req.method,
        headers: {
          origin: error.req.headers?.origin,
          'user-agent': error.req.headers?.['user-agent'],
        },
      } : undefined,
    });
  });

  // Handle connections
  io.on('connection', (socket) => {
    // Log initial transport type (important for debugging polling vs websocket)
    const transport = socket.conn.transport.name;
    logger.info('[WebSocket] New connection established', {
      socketId: socket.id,
      transport, // 'polling' or 'websocket'
      // Warn if using polling in production (less efficient)
      ...(transport === 'polling' && !isDevelopment ? {
        warning: 'Using polling transport - consider checking firewall/proxy settings for websocket support'
      } : {}),
    });

    // Track transport upgrades reliably per-socket (polling → websocket)
    // Engine.IO emits 'upgrade' on the connection when transport changes.
    socket.conn.on('upgrade', (newTransport: any) => {
      const upgradedTo = newTransport?.name || 'unknown';
      logger.info('[WebSocket] Transport upgraded', {
        socketId: socket.id,
        from: transport,
        to: upgradedTo,
      });
    });

    // Per-socket activity middleware: any inbound event from this user
    // refreshes the mobile-editor AND web-preview idle timers — except for
    // background heartbeats. The frontend's `startLatencyPing()` sends `ping`
    // every 10s while a preview session is active, which would otherwise
    // reset the timer indefinitely and the idle expiry would never fire.
    // Both timers share the same activity signal because the user is the
    // same person regardless of which editor they're using.
    // See `services/mobile/mobile-idle.service.ts` and
    //     `services/testing/ui/preview/preview-idle.service.ts`.
    socket.use(([event], next) => {
      const userId = socket.data?.userId;
      if (userId && !IDLE_BACKGROUND_EVENTS.has(event)) {
        const typedIo = io as SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
        refreshIdle(userId, typedIo, `socket-event:${event}`);
        refreshPreviewIdle(userId, typedIo, `socket-event:${event}`);
      }
      next();
    });

    // Handle async connection handler
    handleConnection(socket).catch((error) => {
      logger.error('[WebSocket] Error handling connection', {
        socketId: socket.id,
        transport,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Disconnect the socket if there's an error
      socket.disconnect(true);
    });
  });

  // Companion relay namespace — companions connect here with their HMAC access
  // token. Requires COMPANION_ENABLED=true; no-op otherwise.
  initCompanionNamespace(io);

  logger.debug('[WebSocket] WebSocket server initialized successfully');

  return io;
};

/**
 * Get Socket.IO server instance
 */
export const getIO = (): SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData> => {
  if (!io) {
    throw new Error('[WebSocket] Socket.IO not initialized. Call initializeWebSocket first.');
  }
  return io;
};

/**
 * Check if WebSocket server is initialized
 */
export const isWebSocketInitialized = (): boolean => {
  return io !== null;
};

/**
 * Graceful shutdown
 * Closes WebSocket server and cleanup Redis connections
 */
export const shutdownWebSocket = async (): Promise<void> => {
  if (!io) {
    logger.debug('[WebSocket] WebSocket server already closed or not initialized');
    return;
  }

  logger.info('[WebSocket] Shutting down WebSocket server...');

  // Cleanup catchup Redis client
  try {
    const { cleanupCatchupRedis } = await import('../handlers/subscription.handler');
    await cleanupCatchupRedis();
  } catch (error) {
    logger.debug('[WebSocket] Error cleaning up catchup Redis', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Save reference to avoid null check issues in callback
  const serverInstance = io;

  return new Promise((resolve, reject) => {
    // Double-check server instance exists
    if (!serverInstance) {
      logger.debug('[WebSocket] Server instance is null, resolving immediately');
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      logger.warn('[WebSocket] WebSocket shutdown timeout, forcing close');
      io = null;
      reject(new Error('WebSocket shutdown timeout'));
    }, 10000); // 10 second timeout

    try {
      serverInstance.close(() => {
        clearTimeout(timeout);
        logger.info('[WebSocket] WebSocket server closed');
        io = null;
        resolve();
      });
    } catch (error) {
      clearTimeout(timeout);
      logger.error('[WebSocket] Error during shutdown', {
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      io = null;
      reject(error);
    }
  });
};
