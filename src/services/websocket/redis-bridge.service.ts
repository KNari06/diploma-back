/**
 * Redis WebSocket Bridge Service
 * Enables WebSocket event transmission from worker processes via Redis Pub/Sub
 *
 * Architecture:
 * Worker Process → Redis Pub/Sub → Main Process → WebSocket → Client
 *
 * Usage:
 * - Worker: publishes events to Redis channel
 * - Main: subscribes to Redis channel and emits via WebSocket
 */

import { connection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';
import Redis from 'ioredis';

// Redis channel for WebSocket events
const WEBSOCKET_EVENTS_CHANNEL = 'websocket:events';

/**
 * Event message structure for Redis Pub/Sub
 */
interface WebSocketEventMessage {
  event: string; // Event name (e.g., 'test:progress')
  payload: any; // Event payload
  target?: {
    testId?: string;
    userId?: string;
    sessionId?: string;
  };
  timestamp: number;
}

/**
 * Redis WebSocket Bridge
 * Singleton service for Redis Pub/Sub communication
 */
class RedisWebSocketBridge {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private isSubscribed = false;

  /**
   * Get or create Redis publisher client
   * Lazy initialization to avoid connection issues during import
   */
  private getPublisher(): Redis {
    if (!this.publisher) {
      try {
        this.publisher = new Redis(connection as any);

        // Error handler - DON'T throw, just log
        this.publisher.on('error', (error) => {
          // ✅ REMOVED: REDIS_BRIDGE logs
        });

        this.publisher.on('connect', () => {
          // ✅ REMOVED: REDIS_BRIDGE logs
        });

        // ✅ FIX: Handle ready event for connection tracking
        this.publisher.on('ready', () => {
          // ✅ REMOVED: REDIS_BRIDGE logs
        });

        // ✅ FIX: Handle close event for graceful shutdown
        this.publisher.on('close', () => {
          // ✅ REMOVED: REDIS_BRIDGE logs
        });
      } catch (error) {
        // ✅ REMOVED: REDIS_BRIDGE logs
        logger.error('Failed to create publisher client', {
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
          } : String(error),
        });
        // Re-throw - this is critical, can't continue without publisher
        throw error;
      }
    }
    return this.publisher;
  }

  /**
   * Publish WebSocket event to Redis
   * Called by worker processes when WebSocket is not available
   *
   * @param event - Event name (e.g., 'test:progress', 'test:started')
   * @param payload - Event payload data
   * @param target - Optional target identifiers (testId, userId, sessionId)
   */
  async publishEvent(
    event: string,
    payload: any,
    target?: { testId?: string; userId?: string; sessionId?: string }
  ): Promise<void> {
    try {
      const publisher = this.getPublisher();

      // ✅ FIX: Wait for publisher to be ready (with timeout)
      const currentStatus = publisher.status as string;
      if (currentStatus !== 'ready') {
        // ✅ REMOVED: REDIS_BRIDGE logs

        // Wait up to 2 seconds for connection
        const timeout = 2000;
        const startTime = Date.now();
        while ((publisher.status as string) !== 'ready' && (Date.now() - startTime) < timeout) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if ((publisher.status as string) !== 'ready') {
          // ✅ REMOVED: REDIS_BRIDGE logs
          return;
        }
      }

      const message: WebSocketEventMessage = {
        event,
        payload,
        target,
        timestamp: Date.now(),
      };

      const serialized = JSON.stringify(message);

      // ✅ FIX: Limit payload size (1MB max) to prevent Redis overload
      if (serialized.length > 1000000) {
        // ✅ REMOVED: REDIS_BRIDGE logs
        // Truncate payload (keep only first 1MB)
        const truncatedPayload = {
          ...payload,
          _truncated: true,
          _originalSize: serialized.length,
        };
        const truncatedMessage: WebSocketEventMessage = {
          event,
          payload: truncatedPayload,
          target,
          timestamp: Date.now(),
        };
        await publisher.publish(WEBSOCKET_EVENTS_CHANNEL, JSON.stringify(truncatedMessage).substring(0, 1000000));
      } else {
        await publisher.publish(WEBSOCKET_EVENTS_CHANNEL, serialized);
      }

      // ✅ REMOVED: REDIS_BRIDGE logs
    } catch (error) {
      // ✅ REMOVED: REDIS_BRIDGE logs
      // Don't throw - events can be lost in worker, but don't crash the process
    }
  }

  /**
   * Subscribe to WebSocket events from Redis
   * Called by main process to receive events from workers
   *
   * @param callback - Function to handle received events
   */
  async subscribe(
    callback: (event: string, payload: any, target?: any) => void
  ): Promise<void> {
    if (this.isSubscribed) {
      // ✅ REMOVED: REDIS_BRIDGE logs
      return;
    }

    try {
      // Create subscriber client (separate from publisher)
      if (!this.subscriber) {
        try {
          this.subscriber = new Redis(connection as any);

          this.subscriber.on('error', (error) => {
            // ✅ REMOVED: REDIS_BRIDGE logs
          });

          this.subscriber.on('connect', () => {
            // ✅ REMOVED: REDIS_BRIDGE logs
          });

          this.subscriber.on('ready', () => {
            // ✅ REMOVED: REDIS_BRIDGE logs
          });
        } catch (error) {
          // ✅ REMOVED: REDIS_BRIDGE logs
          logger.error('Failed to create subscriber client', {
            error: error instanceof Error ? {
              message: error.message,
              name: error.name,
              stack: error.stack,
            } : String(error),
          });
          throw error; // Re-throw - can't subscribe without subscriber
        }
      }

      // ✅ FIX #3: Register message handler BEFORE subscribing (prevent race condition)
      // This ensures we don't lose any messages that arrive immediately after subscribe
      this.subscriber.on('message', (channel, message) => {
        if (channel !== WEBSOCKET_EVENTS_CHANNEL) {
          return;
        }

        try {
          const parsed: WebSocketEventMessage = JSON.parse(message);
          const { event, payload, target, timestamp } = parsed;

          // Calculate message age (for monitoring)
          const age = Date.now() - timestamp;
          if (age > 1000) {
            // ✅ REMOVED: REDIS_BRIDGE logs
          }

          // ✅ REMOVED: REDIS_BRIDGE logs

          // ✅ FIX: Wrap callback in try-catch to prevent subscriber crash
          try {
            callback(event, payload, target);
          } catch (callbackError) {
            // ✅ REMOVED: REDIS_BRIDGE logs
          }
        } catch (parseError) {
          // ✅ REMOVED: REDIS_BRIDGE logs
        }
      });

      // Subscribe to channel AFTER registering handler
      await this.subscriber.subscribe(WEBSOCKET_EVENTS_CHANNEL);
      this.isSubscribed = true;

      // ✅ REMOVED: REDIS_BRIDGE logs
    } catch (error) {
      // ✅ REMOVED: REDIS_BRIDGE logs
      logger.error('Failed to subscribe', {
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });
      throw error;
    }
  }

  /**
   * Unsubscribe and cleanup connections
   * Called during graceful shutdown
   */
  async unsubscribe(): Promise<void> {
    const errors: Error[] = [];

    // Unsubscribe from channel
    if (this.subscriber && this.isSubscribed) {
      try {
        await this.subscriber.unsubscribe(WEBSOCKET_EVENTS_CHANNEL);
        await this.subscriber.quit();
        this.subscriber = null;
        this.isSubscribed = false;
        // ✅ REMOVED: REDIS_BRIDGE logs
      } catch (error) {
        errors.push(error as Error);
        // ✅ REMOVED: REDIS_BRIDGE logs
      }
    }

    // Close publisher connection
    if (this.publisher) {
      try {
        await this.publisher.quit();
        this.publisher = null;
        // ✅ REMOVED: REDIS_BRIDGE logs
      } catch (error) {
        errors.push(error as Error);
        // ✅ REMOVED: REDIS_BRIDGE logs
      }
    }

    if (errors.length > 0) {
      throw new Error(`Failed to cleanup Redis connections: ${errors.map(e => e.message).join(', ')}`);
    }
  }

  /**
   * Check if subscriber is active
   */
  isSubscriberActive(): boolean {
    return this.isSubscribed && this.subscriber !== null;
  }

  /**
   * Get connection status for monitoring
   */
  getStatus(): { publisher: boolean; subscriber: boolean; subscribed: boolean } {
    try {
      return {
        publisher: this.publisher !== null && (this.publisher.status as string) === 'ready',
        subscriber: this.subscriber !== null && (this.subscriber.status as string) === 'ready',
        subscribed: this.isSubscribed,
      };
    } catch (error) {
      // ✅ REMOVED: REDIS_BRIDGE logs
      // Return safe defaults on error
      return {
        publisher: false,
        subscriber: false,
        subscribed: false,
      };
    }
  }
}

// Export singleton instance
export const redisWebSocketBridge = new RedisWebSocketBridge();
