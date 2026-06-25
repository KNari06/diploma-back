/**
 * WebSocket Server
 * Main Socket.IO server configuration and setup
 */

import { isDevelopment } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { handleConnection } from '../handlers/connection.handler';
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
      // pingTimeout widened to 25s (June 2026): a backgrounded tab, a brief
      // event-loop stall, or a wedged host that misses one heartbeat no longer
      // drops the socket at all — that spurious drop was tripping the mobile
      // editor's disconnect cleanup and surfacing "session expired". Paired
      // with the wider 60s disconnect-grace (connection.handler), a transient
      // drop+reconnect now cancels cleanup and keeps its warm session instead
      // of being torn down.
      pingTimeout: 25000, // 25s — disconnect window after a missed pong
      pingInterval: 10000, // 10s — heartbeat cadence
      connectTimeout: 45000, // 45 seconds
      // Transport options
      // Order matters: first transport is preferred
      transports,
      allowUpgrades: true, // Allow upgrade from polling to websocket
      // Additional polling optimization
      httpCompression: true, // Compress polling responses
      maxHttpBufferSize: 2e6, // 2MB max message size (base64 video frames can reach ~900KB + JSON envelope)
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
