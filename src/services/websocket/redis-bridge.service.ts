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
    // Per-test-case chat surface. When set, the main-process subscriber
    // dual-broadcasts the event to BOTH `chat:<sessionId>` AND
    // `chat:tc:<testCaseId>` rooms, so a frontend that subscribed
    // before the session was created (lazy-create model) still gets
    // the event. Optional — legacy call sites omit it.
    testCaseId?: string;
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
        this.publisher.on('error', (
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          _error
        ) => {
          // ✅ REMOVED: REDIS_BRIDGE logs
        });

        this.publisher.on('connect', () => {
          // ✅ REMOVED: REDIS_BRIDGE logs
        });

        this.publisher.on('ready', () => {
          logger.info('[REDIS_BRIDGE] Publisher connected/reconnected');
        });

        this.publisher.on('close', () => {
          logger.warn('[REDIS_BRIDGE] Publisher connection closed, ioredis will auto-reconnect');
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
   * @param target - Optional target identifiers (testId, userId, sessionId, testCaseId)
   */
  async publishEvent(
    event: string,
    payload: any,
    target?: { testId?: string; userId?: string; sessionId?: string; testCaseId?: string }
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

      // Guard: keep published messages below 1 MB to prevent Redis overload.
      // We NEVER truncate JSON mid-string (that would break JSON.parse on the subscriber side).
      // Instead we build a structurally valid replacement payload:
      //   - For video frame events the base64 `data` field is the bulk; drop it and emit
      //     a metadata-only marker so the subscriber can skip the frame gracefully.
      //   - For all other events strip any string-valued field whose length exceeds 50 KB,
      //     attach a `_truncated` map listing which fields were dropped, and re-check size.
      //   - If the stripped message is still >= 1 MB, drop the event entirely and log a warning.
      if (serialized.length > 1_000_000) {
        logger.warn('[REDIS_BRIDGE] Oversized event payload — building safe fallback', {
          event,
          originalSize: serialized.length,
        });

        let fallbackPayload: Record<string, unknown>;

        if (event === 'test:video:frame') {
          // Video frame: drop the large base64 data field, keep only metadata so downstream
          // subscribers can track seq/timing without receiving a corrupt partial image.
          const { data: _droppedData, ...meta } = payload as Record<string, unknown>;
          fallbackPayload = {
            ...meta,
            _dropped: true,
            _droppedFields: ['data'],
            _originalSize: serialized.length,
          };
        } else {
          // Generic fallback: strip string fields that individually exceed 50 KB.
          const FIELD_SIZE_LIMIT = 50_000;
          const droppedFields: string[] = [];
          const strippedPayload: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
            if (typeof value === 'string' && value.length > FIELD_SIZE_LIMIT) {
              droppedFields.push(key);
            } else {
              strippedPayload[key] = value;
            }
          }

          fallbackPayload = {
            ...strippedPayload,
            _truncated: true,
            _droppedFields: droppedFields,
            _originalSize: serialized.length,
          };
        }

        const fallbackMessage: WebSocketEventMessage = {
          event,
          payload: fallbackPayload,
          target,
          timestamp: Date.now(),
        };
        const fallbackSerialized = JSON.stringify(fallbackMessage);

        if (fallbackSerialized.length >= 1_000_000) {
          // Even the stripped version is too large — drop entirely rather than send garbage.
          logger.warn('[REDIS_BRIDGE] Fallback payload still oversized — dropping event', {
            event,
            fallbackSize: fallbackSerialized.length,
          });
          return;
        }

        await publisher.publish(WEBSOCKET_EVENTS_CHANNEL, fallbackSerialized);
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

          this.subscriber.on('error', (
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            _error
          ) => {
            // ✅ REMOVED: REDIS_BRIDGE logs
          });

          this.subscriber.on('connect', () => {
            // ✅ REMOVED: REDIS_BRIDGE logs
          });

          this.subscriber.on('ready', () => {
            logger.info('[REDIS_BRIDGE] Subscriber connected/reconnected');
          });

          this.subscriber.on('close', () => {
            logger.warn('[REDIS_BRIDGE] Subscriber connection closed, ioredis will auto-reconnect');
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
