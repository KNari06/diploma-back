/**
 * Per-session runner routing helpers.
 *
 * Phase 1 of per-workspace runner routing: when a session is born on a
 * dedicated runner (workspace_dedicated_device.runner_url set), we store a
 * short-lived binding in Redis so every subsequent call that only has a
 * sessionId can resolve the correct MobileRunnerClient without going back
 * to the DB.
 *
 * Redis key: mobile_session_runner:<sessionId>
 * TTL: matches the warmup session TTL (900 s / 15 min).
 *
 * getMobileRunnerClientForSession is a provable superset of
 * getMobileRunnerClient: when no binding exists (the common case — shared
 * pool), it falls back to the env-singleton. Callers need not change their
 * logic.
 */

import { redisConnection } from '@/config/infrastructure/queues';
import { getMobileRunnerClient, MobileRunnerClient, type IMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { CompanionRunnerClient } from '@/services/mobile/companion/companion-runner-client';

export const SESSION_RUNNER_PREFIX = 'mobile_session_runner:';

/** Convert an HTTP(S) runner URL to its WebSocket equivalent. */
export function runnerUrlToSocketUrl(url: string): string {
  return url.replace(/^http/, 'ws').replace(/\/$/, '');
}

export interface DirectSessionRunnerBinding {
  kind?: 'direct';
  runnerUrl: string | null;
  runnerApiKey: string | null;
}

export interface CompanionSessionRunnerBinding {
  kind: 'companion';
  userId: string;
}

export type SessionRunnerBinding = DirectSessionRunnerBinding | CompanionSessionRunnerBinding;

export async function storeSessionRunnerBinding(
  sessionId: string,
  binding: SessionRunnerBinding,
  ttlSeconds: number,
): Promise<void> {
  await redisConnection.set(
    `${SESSION_RUNNER_PREFIX}${sessionId}`,
    JSON.stringify(binding),
    'EX',
    ttlSeconds,
  );
}

export async function clearSessionRunnerBinding(sessionId: string): Promise<void> {
  await redisConnection.del(`${SESSION_RUNNER_PREFIX}${sessionId}`).catch(() => {});
}

/**
 * Read the raw per-session runner binding (or null when none/blip/malformed).
 *
 * Callers that need to KNOW the binding kind — e.g. a worker job deciding
 * whether to swap its env-runner client for a companion/dedicated one without
 * mutating the shared singleton — use this instead of
 * getMobileRunnerClientForSession, which hides the kind behind a fallback.
 */
export async function getSessionRunnerBinding(
  sessionId: string,
): Promise<SessionRunnerBinding | null> {
  try {
    const raw = await redisConnection.get(`${SESSION_RUNNER_PREFIX}${sessionId}`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionRunnerBinding;
  } catch {
    return null;
  }
}

/**
 * Resolve the MobileRunnerClient for a given session.
 *
 * Reads the per-session runner binding stored at warmup/auto-boot time.
 * Falls back to the env-singleton (today's behaviour) when the session has
 * no binding or the binding has no custom runnerUrl. This keeps the change
 * provably backward-compatible: a session without a dedicated runner behaves
 * exactly as before.
 */
export async function getMobileRunnerClientForSession(
  sessionId: string,
): Promise<IMobileRunnerClient> {
  try {
    const raw = await redisConnection.get(`${SESSION_RUNNER_PREFIX}${sessionId}`);
    if (raw) {
      const binding: SessionRunnerBinding = JSON.parse(raw);
      if (binding.kind === 'companion') {
        return new CompanionRunnerClient(binding.userId);
      }
      if (binding.runnerUrl) {
        return new MobileRunnerClient({ baseUrl: binding.runnerUrl, apiKey: binding.runnerApiKey ?? '' });
      }
    }
  } catch {
    // Non-fatal: Redis blip → fall back to singleton so the session still works.
  }
  return getMobileRunnerClient();
}
