/**
 * Rules Reload Controller
 *
 * Endpoint for reloading AI response rules cache
 */

import { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import { RulesCacheService } from '@/services/kb/rules-cache.service';

/**
 * Reload rules cache for specific language or all languages
 */
export async function reloadRules(req: Request, res: Response): Promise<void> {
  try {
    const { language } = req.body as { language?: 'en' | 'ru' };

    logger.info('[RULES_RELOAD] Reload requested', {
      language: language || 'all',
      userId: req.user?.id,
    });

    const startTime = Date.now();

    // Reload rules
    await RulesCacheService.reloadRules(language);

    const duration = Date.now() - startTime;

    // Get updated stats
    const stats = RulesCacheService.getStats();

    logger.info('[RULES_RELOAD] Reload completed', {
      language: language || 'all',
      duration: `${duration}ms`,
      stats,
    });

    res.json({
      success: true,
      message: language
        ? `Rules reloaded for ${language}`
        : 'Rules reloaded for all languages',
      duration: `${duration}ms`,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[RULES_RELOAD] Failed to reload rules', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to reload rules',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get rules cache statistics
 */
export async function getRulesCacheStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = RulesCacheService.getStats();

    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[RULES_CACHE_STATS] Failed to get stats', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get cache stats',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}
