/**
 * Mobile Idle Timer Service
 *
 * Per-user idle timer that fires when the user has been inactive in the
 * mobile editor for IDLE_TTL_MS. Refreshed on every Socket.IO event from
 * any of the user's sockets via a `socket.use(...)` middleware (see
 * `websocket/core/server.ts`). Fired via setTimeout — no Redis keyspace
 * notifications required.
 *
 * Behaviour on fire:
 *   - Delete the user's `mobile_warmup:*:{userId}` key(s) from Redis (so
 *     the editor's session binding is gone and re-opening warmup is fresh).
 *   - Emit `mobile:session:expired` to the user's room.
 *   - Do NOT call `client.destroySession()` — the runner emulator stays
 *     warm so the user's "reopen test case" is fast. The runner's own
 *     25-min idle TTL eventually reclaims it if the user never returns.
 *
 * Coordinated with the connection-handler grace-period destroy (Fix A.2)
 * via `cancelIdle()` which is called when the emulator is being torn down
 * on browser-close.
 */

import type { Server as SocketIOServer } from 'socket.io';
import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

/**
 * Kept in lockstep with `WARMUP_TTL` in session.controller.ts. If the
 * two drift, an active user can be bounced when Redis expires its
 * warmup mapping before the in-memory idle timer fires (or vice versa).
 */
export const IDLE_TTL_MS = 15 * 60 * 1000;

const WARMUP_PREFIX = 'mobile_warmup:';
const PENDING_INSTALL_PREFIX = 'mobile_pending_install:';

/** userId → pending fire timer. */
const idleTimers = new Map<string, NodeJS.Timeout>();

/**
 * Reset (or start) the idle timer for a user.
 * Called from a `socket.use(...)` middleware on every event from any of
 * the user's sockets, and once explicitly after a successful warmup.
 */
export function refreshIdle(userId: string, io: SocketIOServer, source?: string): void {
  if (!userId) return;

  const existing = idleTimers.get(userId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    idleTimers.delete(userId);
    logger.info('[MOBILE_IDLE] Timer fired — running cleanup', {
      userId: userId.substring(0, 8) + '...',
      idleTtlMs: IDLE_TTL_MS,
    });
    void onIdleFire(userId, io);
  }, IDLE_TTL_MS);

  idleTimers.set(userId, timer);

  logger.debug('[MOBILE_IDLE] refreshed', {
    userId: userId.substring(0, 8) + '...',
    source: source || 'unknown',
    idleTtlMs: IDLE_TTL_MS,
  });
}

/**
 * Cancel a pending idle timer without firing.
 * Used by the FE↔BE-disconnect cleanup path so we don't double-fire after
 * the emulator has already been destroyed.
 */
export function cancelIdle(userId: string): void {
  if (!userId) return;
  const t = idleTimers.get(userId);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(userId);
  }
}

/**
 * Whether a user has a pending idle timer (test/debug aid).
 */
export function hasIdle(userId: string): boolean {
  return idleTimers.has(userId);
}

/**
 * Fired when a user has been idle past IDLE_TTL_MS.
 * Drops the Redis warmup binding (so the editor re-warms cleanly next time)
 * and pushes `mobile:session:expired` to the user's room. The runner
 * emulator session is intentionally NOT destroyed.
 */
async function onIdleFire(userId: string, io: SocketIOServer): Promise<void> {
  try {
    const deletedKeys = await deleteUserMobileKeys(userId);

    // Notify all of the user's sockets in the personal room. The frontend
    // closes the editor, shows a toast, and bounces back to Repository.
    io.to(`user:${userId}`).emit('mobile:session:expired', { reason: 'idle' });

    logger.info('[MOBILE_IDLE] Fired for user — emulator preserved, Redis binding cleared', {
      userId: userId.substring(0, 8) + '...',
      deletedKeys,
    });
  } catch (error) {
    logger.error('[MOBILE_IDLE] onIdleFire failed', {
      userId: userId.substring(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * SCAN + DEL for the user's mobile-related keys. Returns deleted-key count.
 * Shared with the FE↔BE-disconnect grace cleanup.
 */
export async function deleteUserMobileKeys(userId: string): Promise<number> {
  if (!userId) return 0;

  // Match either `mobile_warmup:{anything}:{userId}` or the pending-install
  // counterpart. We can't anchor ":{userId}" in Redis MATCH (no $-anchor),
  // so we glob-then-filter in JS.
  const patterns = [`${WARMUP_PREFIX}*`, `${PENDING_INSTALL_PREFIX}*`];
  const targetSuffix = `:${userId}`;
  const lockSuffix = `:${userId}:lock`; // also includes the warmup lock if present
  let total = 0;

  for (const pattern of patterns) {
    const stream = redisConnection.scanStream({ match: pattern, count: 200 });
    const toDelete: string[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (keys: string[]) => {
        for (const k of keys) {
          if (k.endsWith(targetSuffix) || k.endsWith(lockSuffix)) toDelete.push(k);
        }
      });
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    if (toDelete.length > 0) {
      await redisConnection.del(...toDelete);
      total += toDelete.length;
    }
  }

  return total;
}

/**
 * Read sessionIds out of the user's warmup keys before deletion. Used by
 * the FE↔BE-disconnect grace cleanup so the runner emulator can be
 * destroyed via `client.destroySession(sessionId)`.
 */
export async function getUserWarmupSessionIds(userId: string): Promise<string[]> {
  if (!userId) return [];
  const targetSuffix = `:${userId}`;
  const matchedKeys: string[] = [];
  const stream = redisConnection.scanStream({ match: `${WARMUP_PREFIX}*`, count: 200 });

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (keys: string[]) => {
      for (const k of keys) {
        if (k.endsWith(targetSuffix)) matchedKeys.push(k);
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
  });

  if (matchedKeys.length === 0) return [];

  const values = await Promise.all(matchedKeys.map((k) => redisConnection.get(k)));
  const ids: string[] = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { sessionId?: string };
      if (parsed?.sessionId) ids.push(parsed.sessionId);
    } catch {
      /* swallow — best-effort */
    }
  }
  return ids;
}
