import type { Server as SocketIOServer, Socket } from 'socket.io';
import { CompanionAuthService } from '@/services/mobile/companion/companion-auth.service';
import { companionRegistry, type RunnerProxyResponse } from '@/services/mobile/companion/companion-registry';
import { CompanionFeature } from '@/config/features/companion';
import { logger } from '@/utils/core/logger';

// Events the companion pushes up to the relay that we forward to the browser
// under the user's `user:<userId>` room so the device picker stays live.
const DEVICE_EVENTS = [
  'devices:snapshot',
  'device:connected',
  'device:disconnected',
  'device:state',
] as const;

function authenticateCompanion(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  if (!CompanionFeature.isEnabled()) {
    return next(new Error('Companion feature is not enabled'));
  }

  const token = socket.handshake.auth?.token as string | undefined;
  if (!token || typeof token !== 'string') {
    logger.warn('[CompanionHandler] Missing access token', { socketId: socket.id });
    return next(new Error('Authentication required'));
  }

  const result = CompanionAuthService.verifyAccessToken(token);
  if (!result) {
    logger.warn('[CompanionHandler] Invalid or expired access token', { socketId: socket.id });
    return next(new Error('Authentication failed'));
  }

  socket.data.userId = result.userId;
  next();
}

export function initCompanionNamespace(io: SocketIOServer): void {
  if (!CompanionFeature.isEnabled()) {
    return;
  }

  // Wire the registry's cross-replica coordination (Redis pub/sub + presence)
  // to this Socket.IO server so a companion socketed on one replica is reachable
  // from any replica handling the browser / warmup / run requests.
  companionRegistry.init(io);

  const companion = io.of('/companion');
  companion.use(authenticateCompanion);

  companion.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    companionRegistry.register(userId, socket);

    // Forward device events from the companion to all browser sockets in the
    // user's room — via Redis fan-out so browsers on OTHER replicas get them too,
    // and cache snapshots in Redis so a later browser bootstraps over REST.
    for (const event of DEVICE_EVENTS) {
      socket.on(event, (data: unknown) => {
        companionRegistry.forwardDeviceEvent(userId, event, data);
        logger.debug('[CompanionHandler] Forwarded device event to user room', {
          event,
          userId: userId.substring(0, 8),
        });
      });
    }

    // The companion sends back responses for HTTP proxy requests made via
    // runner:http:request. Each response includes the requestId emitted in the
    // original request so we can match it to the waiting Promise.
    socket.on('runner:http:response', (data: unknown) => {
      if (!data || typeof data !== 'object' || !('requestId' in data)) return;
      const d = data as RunnerProxyResponse & { requestId: string };
      companionRegistry.resolveRpc(d.requestId, userId, {
        status: d.status,
        body: d.body,
        ok: d.ok,
      });
    });

    socket.on('disconnect', (reason: string) => {
      logger.info('[CompanionHandler] Companion disconnected', {
        userId: userId.substring(0, 8),
        reason,
      });
      companionRegistry.deregister(userId, socket.id);
    });

    socket.on('error', (err: Error) => {
      logger.warn('[CompanionHandler] Companion socket error', {
        userId: userId.substring(0, 8),
        error: err.message,
      });
    });
  });

  logger.info('[CompanionHandler] /companion namespace initialized');
}
