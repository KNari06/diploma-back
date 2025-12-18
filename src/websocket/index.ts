/**
 * WebSocket Module
 * Central exports for WebSocket functionality
 */

// Core
export { getIO, initializeWebSocket, isWebSocketInitialized } from './core/server';
export { webSocketService } from './core/websocket.service';

// Infrastructure
export { webSocketRedisSubscriber } from './infrastructure/redis-subscriber';

// Middleware
export { authenticateSocket, getUserId } from './middleware/middleware';

// Types
export * from './types/types';
