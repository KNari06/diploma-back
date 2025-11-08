import { Request, Response, NextFunction } from 'express';
import { AnonymousLimiterService } from '@/services/anonymous-limiter.service';
import { UserCreditsService } from '@/services/user-credits.service';
import { logger } from '@/utils/logger';
import { getClientIp, normalizeIpForAnonymousId } from '@/utils/ip-helper';

/**
 * Check if user is authenticated (has valid UUID)
 */
function isAuthenticatedUser(userId: string | undefined): boolean {
  if (!userId) return false;
  // Check if userId is a valid UUID
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
}

/**
 * Middleware to check anonymous user rate limit
 * Allows authenticated users unlimited requests
 * Limits anonymous users to 3 requests per 24 hours
 */
export const checkAnonymousLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Get userId from auth or body
    const userId = req.user?.id || req.body?.userId;

    // If user is authenticated, check credits instead of rate limit
    if (isAuthenticatedUser(userId)) {
      logger.debug('[RATE_LIMITER] Authenticated user, checking credits', { userId });

      const hasCredits = await UserCreditsService.hasCredits(userId, 1);

      if (!hasCredits) {
        logger.warn('[RATE_LIMITER] User has insufficient credits', { userId });

        const userCredits = await UserCreditsService.getUserCredits(userId);

        res.status(402).json({
          success: false,
          error: 'Insufficient credits',
          message: '💳 У вас недостаточно кредитов. Пожалуйста, купите кредиты для продолжения.',
          credits: {
            balance: userCredits?.credits_balance || 0,
            required: 1,
          },
          requiresPurchase: true,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // User has credits, continue
      next();
      return;
    }

    // For anonymous users, use IP address as identifier
    const clientIp = getClientIp(req);
    const anonymousId = normalizeIpForAnonymousId(clientIp);

    logger.info('[RATE_LIMITER] Checking anonymous limit', { anonymousId, clientIp });

    // Check if limit is reached
    const hasReachedLimit = await AnonymousLimiterService.hasReachedLimit(anonymousId);

    if (hasReachedLimit) {
      logger.warn('[RATE_LIMITER] Anonymous user reached limit', { anonymousId });

      const limitInfo = await AnonymousLimiterService.getLimitInfo(anonymousId);

      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        message: '🔒 Вы достигли лимита в 3 сообщения для анонимных пользователей.\n\n✨ Авторизуйтесь для неограниченного доступа к чату!',
        rateLimitInfo: {
          limit: limitInfo.limit,
          current: limitInfo.current,
          remaining: 0,
          requiresAuth: true,
          authMessage: 'Войдите или зарегистрируйтесь, чтобы продолжить использование QAIT',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Increment counter and continue
    const newCount = await AnonymousLimiterService.incrementRequestCount(anonymousId);
    const remaining = await AnonymousLimiterService.getRemainingRequests(anonymousId);

    // Add rate limit info to request for use in controller
    (req as any).rateLimitInfo = {
      isAnonymous: true,
      limit: 3,
      current: newCount,
      remaining,
      anonymousId,
    };

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', '3');
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Date.now() + 24 * 60 * 60 * 1000)); // 24 hours from now

    logger.info('[RATE_LIMITER] Request allowed', {
      anonymousId,
      count: newCount,
      remaining,
    });

    next();
  } catch (error) {
    logger.error('[RATE_LIMITER] Error in rate limiter middleware', { error });
    // On error, allow request but log it
    next();
  }
};
