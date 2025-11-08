import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

/**
 * Service for managing anonymous user rate limits
 */
export class AnonymousLimiterService {
  private static readonly MAX_REQUESTS = 3;
  private static readonly RESET_PERIOD_HOURS = 24;

  /**
   * Get current request count for anonymous user
   */
  static async getRequestCount(anonymousId: string): Promise<number> {
    try {
      const { data, error } = await supabaseAdmin
        .from('anonymous_usage_limits')
        .select('request_count, first_request_at')
        .eq('anonymous_id', anonymousId)
        .maybeSingle();

      if (error) {
        logger.error('[ANON_LIMITER] Error getting request count', { error, anonymousId });
        return 0;
      }

      if (!data) {
        return 0;
      }

      // Check if limit should be reset (older than 24 hours)
      const firstRequest = new Date(data.first_request_at);
      const now = new Date();
      const hoursSinceFirst = (now.getTime() - firstRequest.getTime()) / (1000 * 60 * 60);

      if (hoursSinceFirst >= this.RESET_PERIOD_HOURS) {
        // Reset count
        await this.resetRequestCount(anonymousId);
        return 0;
      }

      return data.request_count || 0;
    } catch (error) {
      logger.error('[ANON_LIMITER] Exception in getRequestCount', { error, anonymousId });
      return 0;
    }
  }

  /**
   * Increment request count for anonymous user
   */
  static async incrementRequestCount(anonymousId: string): Promise<number> {
    try {
      // Try to get existing record
      const { data: existing } = await supabaseAdmin
        .from('anonymous_usage_limits')
        .select('*')
        .eq('anonymous_id', anonymousId)
        .maybeSingle();

      if (existing) {
        // Update existing record
        const newCount = (existing.request_count || 0) + 1;

        const { error } = await supabaseAdmin
          .from('anonymous_usage_limits')
          .update({
            request_count: newCount,
            last_request_at: new Date().toISOString(),
          })
          .eq('anonymous_id', anonymousId);

        if (error) {
          logger.error('[ANON_LIMITER] Error incrementing count', { error, anonymousId });
        }

        logger.info('[ANON_LIMITER] Request count incremented', {
          anonymousId,
          count: newCount,
          remaining: this.MAX_REQUESTS - newCount,
        });

        return newCount;
      } else {
        // Create new record
        const { error } = await supabaseAdmin
          .from('anonymous_usage_limits')
          .insert({
            anonymous_id: anonymousId,
            request_count: 1,
            first_request_at: new Date().toISOString(),
            last_request_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (error) {
          logger.error('[ANON_LIMITER] Error creating limit record', { error, anonymousId });
          return 1;
        }

        logger.info('[ANON_LIMITER] New anonymous user tracked', {
          anonymousId,
          count: 1,
          remaining: this.MAX_REQUESTS - 1,
        });

        return 1;
      }
    } catch (error) {
      logger.error('[ANON_LIMITER] Exception in incrementRequestCount', { error, anonymousId });
      return 0;
    }
  }

  /**
   * Reset request count for anonymous user
   */
  static async resetRequestCount(anonymousId: string): Promise<void> {
    try {
      const { error } = await supabaseAdmin
        .from('anonymous_usage_limits')
        .delete()
        .eq('anonymous_id', anonymousId);

      if (error) {
        logger.error('[ANON_LIMITER] Error resetting count', { error, anonymousId });
      } else {
        logger.info('[ANON_LIMITER] Request count reset', { anonymousId });
      }
    } catch (error) {
      logger.error('[ANON_LIMITER] Exception in resetRequestCount', { error, anonymousId });
    }
  }

  /**
   * Get remaining requests for anonymous user
   */
  static async getRemainingRequests(anonymousId: string): Promise<number> {
    const currentCount = await this.getRequestCount(anonymousId);
    return Math.max(0, this.MAX_REQUESTS - currentCount);
  }

  /**
   * Check if anonymous user has reached limit
   */
  static async hasReachedLimit(anonymousId: string): Promise<boolean> {
    const currentCount = await this.getRequestCount(anonymousId);
    return currentCount >= this.MAX_REQUESTS;
  }

  /**
   * Get limit info for response
   */
  static async getLimitInfo(anonymousId: string): Promise<{
    limit: number;
    current: number;
    remaining: number;
    isLimitReached: boolean;
  }> {
    const currentCount = await this.getRequestCount(anonymousId);
    const remaining = Math.max(0, this.MAX_REQUESTS - currentCount);

    return {
      limit: this.MAX_REQUESTS,
      current: currentCount,
      remaining,
      isLimitReached: currentCount >= this.MAX_REQUESTS,
    };
  }
}
