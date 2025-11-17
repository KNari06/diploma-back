/**
 * WebSocket Server
 * Main Socket.IO server configuration and setup
 */

import { isDevelopment } from '@/config/env';
import { logger } from '@/utils/logger';
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { handleConnection } from './handlers/connection.handler';
import { authenticateSocket } from './middleware';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from './types';

let io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData> | null = null;

/**
 * Initialize WebSocket server
 */
export const initializeWebSocket = (httpServer: HTTPServer): SocketIOServer => {
  logger.info('[WebSocket] Initializing WebSocket server...');

  // Parse CORS origins
  let corsOrigin: boolean | string[] = false;
  if (isDevelopment) {
    corsOrigin = true;
  } else if (process.env.ALLOWED_ORIGINS) {
    try {
      const origins = process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
      if (origins.length > 0) {
        corsOrigin = origins;
      }
    } catch (error) {
      logger.warn('[WebSocket] Failed to parse ALLOWED_ORIGINS, disabling CORS', {
        error: error instanceof Error ? error.message : String(error),
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
      });
    }
  }

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
      pingTimeout: 60000, // 60 seconds
      pingInterval: 25000, // 25 seconds
      connectTimeout: 45000, // 45 seconds
      // Transport options
      transports: ['websocket', 'polling'],
      allowUpgrades: true,
    }
  );

  // Apply authentication middleware
  io.use(authenticateSocket);

  // Handle connection errors (transport-level errors)
  io.engine.on('connection_error', (error) => {
    // Log transport errors but don't crash
    logger.warn('[WebSocket] Connection error', {
      error: error.message,
      // Don't log full stack for connection errors
    });
  });

  // Handle connections
  io.on('connection', (socket) => {
    try {
      handleConnection(socket);
    } catch (error) {
      logger.error('[WebSocket] Error handling connection', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Disconnect the socket if there's an error
      socket.disconnect(true);
    }
  });

  logger.info('[WebSocket] WebSocket server initialized successfully', {
    transports: ['websocket', 'polling'],
    cors: isDevelopment ? 'enabled (development)' : 'configured',
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
 */
export const shutdownWebSocket = async (): Promise<void> => {
  if (!io) {
    logger.debug('[WebSocket] WebSocket server already closed or not initialized');
    return;
  }

  logger.info('[WebSocket] Shutting down WebSocket server...');

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
