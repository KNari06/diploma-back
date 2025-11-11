/**
 * WebSocket Authentication Middleware
 * Validates JWT tokens and extracts user information
 */

import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import * as AuthService from '@/services/auth/auth.service';
import { SocketData } from './types';

/**
 * Authenticate WebSocket connection
 * Checks for JWT token in auth.token or query.token
 */
export const authenticateSocket = async (
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> => {
  try {
    // Get token from auth handshake or query params
    const token =
      (socket.handshake.auth?.token as string) ||
      (socket.handshake.query?.token as string);

    if (!token) {
      // Allow anonymous connections
      logger.info('[WebSocket] Anonymous connection', {
        socketId: socket.id,
      });

      const socketData: SocketData = {
        isAnonymous: true,
        authenticatedAt: new Date().toISOString(),
      };

      socket.data = socketData;
      return next();
    }

    // Verify token
    logger.info('[WebSocket] Authenticating connection', {
      socketId: socket.id,
    });

    const user = await AuthService.verifyToken(token);

    if (!user) {
      logger.debug('[WebSocket] Invalid token', {
        socketId: socket.id,
      });
      return next(new Error('Authentication failed'));
    }

    // Store user info in socket data
    const socketData: SocketData = {
      userId: user.id,
      isAnonymous: false,
      authenticatedAt: new Date().toISOString(),
    };

    socket.data = socketData;

    logger.info('[WebSocket] Authentication successful', {
      socketId: socket.id,
      userId: user.id,
    });

    next();
  } catch (error) {
    // Log as debug to avoid noise - auth errors are expected
    logger.debug('[WebSocket] Authentication error', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
    });

    // Don't crash - just reject the connection gracefully
    const authError = new Error('Authentication failed');
    authError.name = 'AuthenticationError';
    next(authError);
  }
};

/**
 * Check if socket is authenticated (not anonymous)
 */
export const isAuthenticated = (socket: Socket): boolean => {
  const socketData = socket.data as SocketData;
  return !socketData.isAnonymous && !!socketData.userId;
};

/**
 * Get userId from socket (returns undefined for anonymous)
 */
export const getUserId = (socket: Socket): string | undefined => {
  const socketData = socket.data as SocketData;
  return socketData.userId;
};

/**
 * Require authentication middleware for specific events
 */
export const requireAuth = (
  socket: Socket,
  next: (err?: Error) => void
): void => {
  if (!isAuthenticated(socket)) {
    logger.warn('[WebSocket] Unauthorized access attempt', {
      socketId: socket.id,
    });
    next(new Error('Authentication required'));
    return;
  }
  next();
};
