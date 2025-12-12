import { getCachedExploration, saveExplorationToCache } from '@/services/testing/plans/exploration-cache.service';
import { exploreProduct } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { logger } from '@/utils/logger';

/**
 * Run exploration (from cache or fresh)
 */
export async function runExploration(params: {
  url: string;
  scope: string;
  credentials?: { email?: string; username?: string; password: string };
  needsAuth?: boolean;
  sessionId?: string;
  userMessage: string;
  userId: string;
  projectId: string;
  emitProgress: (step: string, message: string, progress: number) => void;
}): Promise<{ exploration: any; explorationId?: string }> {
  const {
    url,
    scope,
    credentials,
    needsAuth,
    sessionId,
    userMessage,
    userId,
    projectId,
    emitProgress,
  } = params;

  // Check cache first
  logger.info('[AUTONOMOUS] Checking cache');
  emitProgress('analyzing', '📦 Checking cache...', 15);
  const cached = await getCachedExploration(url, projectId);

  if (cached) {
    logger.info('Using cached exploration', { url });
    emitProgress('analyzing', '✅ Using cached data', 20);
    return { exploration: cached };
  }

  // Run fresh exploration
  logger.info('[AUTONOMOUS] Running fresh exploration');
  emitProgress('analyzing', '🚀 Launching browser...', 20);
  emitProgress('analyzing', '🌐 Opening page...', 30);

  // ✅ IMPROVED: Configurable timeout for exploration (default: 5 minutes, max: 5 minutes)
  // NOTE: This is ONLY for page exploration/analysis, NOT for actual test execution
  // Test execution happens later and has its own timeout settings
  const MAX_EXPLORATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes maximum
  const requestedTimeout = process.env.EXPLORATION_TIMEOUT_MS
    ? parseInt(process.env.EXPLORATION_TIMEOUT_MS, 10)
    : MAX_EXPLORATION_TIMEOUT;

  // ✅ FIX: Enforce maximum timeout of 5 minutes
  const EXPLORATION_TIMEOUT = Math.min(requestedTimeout, MAX_EXPLORATION_TIMEOUT);

  if (requestedTimeout > MAX_EXPLORATION_TIMEOUT) {
    logger.warn('Exploration timeout exceeds maximum, capping at 5 minutes', {
      requested: requestedTimeout,
      max: MAX_EXPLORATION_TIMEOUT,
      using: EXPLORATION_TIMEOUT,
    });
  }

  if (EXPLORATION_TIMEOUT < 60000) {
    logger.warn('Exploration timeout is less than 1 minute, this may be too short', {
      timeout: EXPLORATION_TIMEOUT,
    });
  }

  logger.info('[AUTONOMOUS] Starting exploration with timeout', {
    timeoutMs: EXPLORATION_TIMEOUT,
    timeoutMinutes: Math.round(EXPLORATION_TIMEOUT / 60000),
  });

  const explorationPromise = exploreProduct({
    url,
    scope,
    credentials,
    needsAuth,
    sessionId,
    userMessage,
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Exploration timeout after ${Math.round(EXPLORATION_TIMEOUT / 60000)} minutes`)),
      EXPLORATION_TIMEOUT
    )
  );

  emitProgress('analyzing', '🔍 Analyzing page (this may take 1-2 minutes)...', 35);

  let exploration: any;
  try {
    exploration = await Promise.race([explorationPromise, timeoutPromise]);
  } catch (error) {
    // ✅ IMPROVED: Better error handling for timeout
    if (error instanceof Error && error.message.includes('timeout')) {
      logger.error('[AUTONOMOUS] Exploration timed out', {
        timeout: EXPLORATION_TIMEOUT,
        url,
        note: 'This timeout is only for page exploration/analysis, not for test execution',
      });
      emitProgress('analyzing', '⏱️ Analysis timed out - page may be too complex or slow', 50);
      throw new Error(
        `Page exploration timed out after ${Math.round(EXPLORATION_TIMEOUT / 60000)} minutes (maximum allowed). ` +
        'The page may be too complex, slow to load, or have many iframes/Shadow DOM. ' +
        'Try simplifying the page or breaking it into smaller parts.'
      );
    }
    throw error; // Re-throw other errors
  }

  logger.info('[AUTONOMOUS] Exploration completed successfully');
  emitProgress('analyzing', '✅ Analysis completed successfully!', 50);

  // Save to cache
  emitProgress('analyzing', '💾 Saving results to cache...', 52);
  const cacheResult = await saveExplorationToCache(exploration, userId, projectId);

  return {
    exploration,
    explorationId: cacheResult.id,
  };
}
