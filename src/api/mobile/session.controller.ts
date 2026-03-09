/**
 * Mobile Emulator Session Controller
 *
 * Provides eager warm-up of mobile emulator sessions.
 * When a user opens the editor for a mobile flow, the frontend calls
 * POST /warmup → backend creates a session on the runner and stores
 * the mapping in Redis. Later, when a test runs, the job can reuse
 * the warmed session instead of cold-starting a new one.
 *
 * Redis key: mobile_warmup:{projectId}:{userId} → { sessionId, runnerUrl, createdAt }
 * TTL: 15 minutes (session reclaimed if no test starts)
 */

import { env } from '@/config/environment/env';
import { redisConnection } from '@/config/infrastructure/queues';
import { MobileRunnerClient, getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// ── Constants ────────────────────────────────────────────────────────

const WARMUP_PREFIX = 'mobile_warmup:';
const WARMUP_TTL = 900; // 15 minutes

export interface WarmupData {
  sessionId: string;
  runnerUrl: string;
  runnerSocketUrl: string;
  platform: MobilePlatform;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// WARM-UP SESSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/mobile/sessions/warmup
 *
 * Create an eager emulator session so it's ready when the user runs a test.
 * Body: { projectId, platform: 'android' | 'ios' }
 * Returns: { sessionId, runnerSocketUrl }
 */
export async function warmupSession(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId, platform: rawPlatform } = req.body as {
    projectId?: string;
    platform?: string;
  };

  if (!projectId) {
    res.status(400).json({ success: false, error: 'projectId is required' });
    return;
  }

  const platform: MobilePlatform = rawPlatform === 'ios' ? 'ios' : 'android';

  try {
    // Feature flag check
    if (!env.MOBILE_RUNNER_ENABLED) {
      res.status(503).json({
        success: false,
        error: 'Mobile testing is not enabled',
      });
      return;
    }

    // Check if there's already a warmed session for this project+user
    const existingRaw = await redisConnection.get(`${WARMUP_PREFIX}${projectId}:${userId}`);
    if (existingRaw) {
      const existing: WarmupData = JSON.parse(existingRaw);
      logger.debug('[MOBILE_SESSION] Reusing existing warmed session', {
        projectId,
        userId,
        sessionId: existing.sessionId,
      });

      res.json({
        success: true,
        sessionId: existing.sessionId,
        runnerSocketUrl: existing.runnerSocketUrl,
        platform: existing.platform,
        reused: true,
      });
      return;
    }

    // Health check
    const client = getMobileRunnerClient();
    const healthy = await client.isHealthy();
    if (!healthy) {
      res.status(503).json({
        success: false,
        error: 'Mobile runner is unavailable',
      });
      return;
    }

    // Create session on runner
    const session = await client.createSession(platform);

    // Derive socket URL from runner URL
    const runnerSocketUrl = env.MOBILE_RUNNER_URL.replace(/^http/, 'ws').replace(/\/$/, '');

    // Store mapping in Redis
    const warmupData: WarmupData = {
      sessionId: session.id,
      runnerUrl: env.MOBILE_RUNNER_URL,
      runnerSocketUrl,
      platform,
      createdAt: new Date().toISOString(),
    };

    await redisConnection.set(
      `${WARMUP_PREFIX}${projectId}:${userId}`,
      JSON.stringify(warmupData),
      'EX',
      WARMUP_TTL,
    );

    logger.info('[MOBILE_SESSION] Emulator warmed up', {
      projectId,
      userId,
      sessionId: session.id,
      platform,
    });

    res.status(201).json({
      success: true,
      sessionId: session.id,
      runnerSocketUrl,
      platform,
      reused: false,
    });
  } catch (error) {
    logger.error('[MOBILE_SESSION] Warmup failed', {
      projectId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to warm up emulator session',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DESTROY SESSION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/mobile/sessions/:sessionId
 *
 * Destroy a warmed emulator session (e.g., user leaves the editor).
 */
export async function destroySession(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  const { projectId } = req.query as { projectId?: string };

  if (!sessionId) {
    res.status(400).json({ success: false, error: 'sessionId is required' });
    return;
  }

  try {
    // Destroy on runner
    const client = getMobileRunnerClient();
    try {
      await client.destroySession(sessionId);
    } catch (err) {
      // Session may already be expired/destroyed on runner — non-fatal
      logger.warn('[MOBILE_SESSION] Runner destroy returned error (may be expired)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Remove Redis mapping (best effort — might not match exactly)
    if (projectId) {
      await redisConnection.del(`${WARMUP_PREFIX}${projectId}:${userId}`);
    }

    logger.info('[MOBILE_SESSION] Session destroyed', { sessionId, userId, projectId });

    res.json({ success: true, message: 'Session destroyed' });
  } catch (error) {
    logger.error('[MOBILE_SESSION] Destroy failed', {
      sessionId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to destroy session',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER: Claim warmed session (used by mobile-test-run.job.ts)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Claim a warmed session from Redis for use in a test run.
 * Atomically reads + deletes the key so no other job can reuse it.
 *
 * Returns WarmupData if a warmed session exists, null otherwise.
 */
export async function claimWarmedSession(
  projectId: string,
  userId: string,
): Promise<WarmupData | null> {
  const key = `${WARMUP_PREFIX}${projectId}:${userId}`;

  try {
    const raw = await redisConnection.get(key);
    if (!raw) return null;

    // Atomically delete so no other job can claim
    await redisConnection.del(key);

    const data = JSON.parse(raw) as WarmupData;

    logger.info('[MOBILE_SESSION] Claimed warmed session for test run', {
      projectId,
      userId,
      sessionId: data.sessionId,
    });

    return data;
  } catch (err) {
    logger.warn('[MOBILE_SESSION] Failed to claim warmed session', {
      projectId,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
