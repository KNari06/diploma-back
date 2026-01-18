/**
 * WebSocket Authentication Middleware
 * Validates JWT tokens and extracts user information
 */

import * as AuthService from '@/services/auth/auth.service';
import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { SocketData } from '../types/types';

/**
 * Authenticate WebSocket connection
 * Requires valid JWT token in auth.token or query.token
 */
export const authenticateSocket = async (
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> => {
  try {
    // Get token from auth handshake or query params
    const authToken = socket.handshake.auth?.token as string | undefined;
    const queryToken = socket.handshake.query?.token as string | undefined;
    const headerAuth = socket.handshake.headers?.authorization as string | undefined;
    const headerToken =
      headerAuth && typeof headerAuth === 'string' && headerAuth.startsWith('Bearer ')
        ? headerAuth.replace('Bearer ', '')
        : undefined;

    const token = authToken || queryToken || headerToken;

    // Validate token exists and is a string
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      logger.warn('[WebSocket] No token provided', {
        socketId: socket.id,
        hasAuthToken: !!authToken,
        hasQueryToken: !!queryToken,
        hasHeaderToken: !!headerToken,
        origin: socket.handshake.headers?.origin,
        userAgent: socket.handshake.headers?.['user-agent'],
      });
      return next(new Error('Authentication required'));
    }

    // Verify token
    logger.info('[WebSocket] Authenticating connection', {
      socketId: socket.id,
      tokenLength: token.length,
    });

    const user = await AuthService.verifyToken(token.trim());

    if (!user) {
      logger.warn('[WebSocket] Invalid token', {
        socketId: socket.id,
        tokenLength: token.length,
      });
      return next(new Error('Authentication failed'));
    }

    // Validate user has required fields
    if (!user.id || typeof user.id !== 'string') {
      logger.warn('[WebSocket] User missing required id field', {
        socketId: socket.id,
        user,
      });
      return next(new Error('Authentication failed: invalid user data'));
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
    // Log auth errors to identify issues
    logger.warn('[WebSocket] Authentication error', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      origin: socket.handshake.headers?.origin,
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
  if (!socket || !socket.data) {
    return false;
  }

  const socketData = socket.data as SocketData;
  return !socketData.isAnonymous && !!socketData.userId && typeof socketData.userId === 'string';
};

/**
 * Get userId from socket
 * @throws Error if socket is not authenticated or userId is missing
 */
export const getUserId = (socket: Socket): string => {
  if (!socket || !socket.data) {
    throw new Error('Socket data not available');
  }

  const socketData = socket.data as SocketData;

  if (!socketData.userId || typeof socketData.userId !== 'string') {
    throw new Error('Socket is not authenticated or userId is missing');
  }

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
