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
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types/types';

let io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData> | null = null;

/**
 * Initialize WebSocket server
 */
export const initializeWebSocket = (httpServer: HTTPServer): SocketIOServer => {
  logger.info('[WebSocket] Initializing WebSocket server...');

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
      // ⚠️ CRITICAL: pingInterval affects polling frequency
      // - Lower value = more frequent HTTP requests when using polling
      // - Higher value = fewer requests but slower to detect dead connections
      // - 60s is a good balance: ~1 request/minute with polling, still detects dead connections quickly
      pingTimeout: 120000, // 120 seconds - time to wait for pong before considering connection dead
      pingInterval: 60000, // 60 seconds - interval between pings (was 25s, too frequent for polling)
      connectTimeout: 45000, // 45 seconds
      // Transport options
      // Order matters: first transport is preferred
      transports,
      allowUpgrades: true, // Allow upgrade from polling to websocket
      // Additional polling optimization
      httpCompression: true, // Compress polling responses
      maxHttpBufferSize: 1e6, // 1MB max message size
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

  logger.info('[WebSocket] WebSocket server initialized successfully', {
    transports,
    pingInterval: '60s',
    pingTimeout: '120s',
    cors: isDevelopment ? 'enabled (development)' : 'configured',
    note: 'Polling transport will create HTTP requests every ~60s. WebSocket is preferred for better performance.',
  });

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
