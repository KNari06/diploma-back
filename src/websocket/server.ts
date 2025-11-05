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

  // Create Socket.IO server with typed events
  io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, object, SocketData>(
    httpServer,
    {
      cors: {
        origin: isDevelopment ? true : process.env.ALLOWED_ORIGINS?.split(',') || false,
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

  // Handle connections
  io.on('connection', (socket) => {
    handleConnection(socket);
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
    return;
  }

  logger.info('[WebSocket] Shutting down WebSocket server...');

  return new Promise((resolve) => {
    io!.close(() => {
      logger.info('[WebSocket] WebSocket server closed');
      io = null;
      resolve();
    });
  });
};
