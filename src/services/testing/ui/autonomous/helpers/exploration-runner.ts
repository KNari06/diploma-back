import { exploreProduct } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { getCachedExploration, saveExplorationToCache } from '@/services/testing/plans/exploration-cache.service';
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

  // Add timeout for exploration (5 minutes max)
  const EXPLORATION_TIMEOUT = 5 * 60 * 1000;
  const explorationPromise = exploreProduct({
    url,
    scope,
    credentials,
    needsAuth,
    sessionId,
    userMessage,
  });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error('Exploration timeout after 5 minutes')),
      EXPLORATION_TIMEOUT
    )
  );

  emitProgress('analyzing', '🔍 Analyzing page (this may take 1-2 minutes)...', 35);

  const exploration = await Promise.race([explorationPromise, timeoutPromise]) as any;

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
