/**
 * System Logs Broadcaster — pushes every Winston entry that lands in the
 * ring buffer to the System Logs UI in real time over WebSocket, replacing
 * the previous 1.5s REST polling loop.
 *
 * Permission gate: server-side only. We maintain a cached set of user ids
 * with `users.show_logs = true` and refresh it every REFRESH_INTERVAL_MS.
 * That avoids querying the DB on every log entry (logs are high-frequency).
 *
 * Newly-flagged users start receiving entries within at most REFRESH_INTERVAL_MS.
 *
 * Lives on the API process only (where the WebSocket server runs). The
 * worker/scheduler logs already feed into the API ring buffer via the Redis
 * log bridge, so registering on `logBuffer` here covers all sources.
 */

import { supabaseAdmin } from '@/db/supabase';
import { type BufferedLogEntry, logBuffer } from '@/utils/core/log-buffer';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';

const REFRESH_INTERVAL_MS = 30_000;

let authorizedUserIds = new Set<string>();
let refreshTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let initialised = false;

async function refreshAuthorizedUsers(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id')
      .or('show_logs.eq.true,role.eq.admin');

    if (error) {
      logger.warn('[SYSTEM_LOGS_BROADCAST] Failed to refresh authorized users', {
        message: error.message,
      });
      return;
    }
    const next = new Set<string>();
    for (const row of data ?? []) {
      if (row?.id) next.add(String(row.id));
    }
    authorizedUserIds = next;
  } catch (err) {
    logger.warn('[SYSTEM_LOGS_BROADCAST] DB error refreshing authorized users', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function broadcast(entry: BufferedLogEntry): void {
  if (authorizedUserIds.size === 0) return;
  for (const userId of authorizedUserIds) {
    try {
      webSocketService.emitToUser(userId, 'system:log:new', entry);
    } catch {
      // emitToUser already handles its own errors; ignore here.
    }
  }
}

/**
 * Initialise the broadcaster. Idempotent. Call once at API startup, after
 * the WebSocket server is up.
 */
export function initSystemLogsBroadcaster(): void {
  if (initialised) return;
  initialised = true;

  // Don't await — server startup must not block on telemetry.
  void refreshAuthorizedUsers();
  refreshTimer = setInterval(() => {
    void refreshAuthorizedUsers();
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();

  unsubscribe = logBuffer.subscribe(broadcast);

  logger.info('[SYSTEM_LOGS_BROADCAST] Started — live tail over WebSocket enabled');
}

/**
 * Test/shutdown hook — releases the listener and timer.
 */
export function stopSystemLogsBroadcaster(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  initialised = false;
}
