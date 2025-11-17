import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

export interface PricingPlan {
  id: string;
  name: string;
  slug: 'free' | 'pro' | 'team';
  description: string;
  price: number | null; // NULL for free plan
  credits_per_month: number; // -1 for unlimited
  credits_per_day: number | null; // NULL if no daily limit
  features: string[];
  limitations: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserPlanInfo {
  user_id: string;
  plan: PricingPlan;
  plan_started_at: string;
  credits_used_today: number;
  credits_used_this_month: number;
  last_credit_reset_date: string;
  monthly_reset_date: string;
  daily_remaining: number; // -1 for unlimited
  monthly_remaining: number; // -1 for unlimited
}

export interface CreditUsageResult {
  success: boolean;
  message: string;
  daily_remaining: number;
  monthly_remaining: number;
}

export interface CreditCheckResult {
  can_use_credits: boolean;
  reason: string;
  daily_remaining: number;
  monthly_remaining: number;
}

/**
 * Service for managing pricing plans and user credit limits
 */
export class PricingPlansService {
  /**
   * Get all active pricing plans
   */
  static async getAllPlans(): Promise<PricingPlan[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('pricing_plans')
        .select('*')
        .eq('is_active', true)
        .order('price', { ascending: true, nullsFirst: true });

      if (error) {
        logger.error('[PRICING_PLANS] Error getting plans', { error: error.message });
        throw new Error(`Failed to get pricing plans: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in getAllPlans', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get pricing plan by slug
   */
  static async getPlanBySlug(slug: string): Promise<PricingPlan | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('pricing_plans')
        .select('*')
        .eq('slug', slug)
        .eq('is_active', true)
        .maybeSingle();

      if (error) {
        logger.error('[PRICING_PLANS] Error getting plan by slug', {
          error: error.message,
          slug
        });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in getPlanBySlug', {
        error: error instanceof Error ? error.message : String(error),
        slug,
      });
      return null;
    }
  }

  /**
   * Get user's current plan info with credit usage
   */
  static async getUserPlanInfo(userId: string): Promise<UserPlanInfo | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('users')
        .select(`
          id,
          plan_id,
          plan_started_at,
          credits_used_today,
          credits_used_this_month,
          last_credit_reset_date,
          monthly_reset_date,
          pricing_plans!plan_id (*)
        `)
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[PRICING_PLANS] Error getting user plan info', {
          error: error.message,
          userId: userId.substring(0, 8) + '...',
        });
        return null;
      }

      if (!data || !data.pricing_plans) {
        logger.warn('[PRICING_PLANS] User has no plan assigned', {
          userId: userId.substring(0, 8) + '...',
        });
        return null;
      }

      const plan = Array.isArray(data.pricing_plans)
        ? data.pricing_plans[0] as PricingPlan
        : data.pricing_plans as PricingPlan;

      // Calculate remaining credits
      const dailyRemaining = plan.credits_per_day
        ? Math.max(0, plan.credits_per_day - (data.credits_used_today || 0))
        : -1; // unlimited

      const monthlyRemaining = plan.credits_per_month === -1
        ? -1 // unlimited
        : Math.max(0, plan.credits_per_month - (data.credits_used_this_month || 0));

      return {
        user_id: data.id,
        plan,
        plan_started_at: data.plan_started_at,
        credits_used_today: data.credits_used_today || 0,
        credits_used_this_month: data.credits_used_this_month || 0,
        last_credit_reset_date: data.last_credit_reset_date,
        monthly_reset_date: data.monthly_reset_date,
        daily_remaining: dailyRemaining,
        monthly_remaining: monthlyRemaining,
      };
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in getUserPlanInfo', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
      });
      return null;
    }
  }

  /**
   * Check if user can use specified amount of credits
   */
  static async checkUserCredits(userId: string, creditsToUse: number = 1): Promise<CreditCheckResult> {
    try {
      const { data, error } = await supabaseAdmin.rpc('check_user_credit_limits', {
        user_id: userId,
        credits_to_use: creditsToUse,
      });

      if (error) {
        logger.error('[PRICING_PLANS] Error checking user credits', {
          error: error.message,
          userId: userId.substring(0, 8) + '...',
          creditsToUse,
        });
        return {
          can_use_credits: false,
          reason: 'Error checking credits',
          daily_remaining: 0,
          monthly_remaining: 0,
        };
      }

      const result = data[0];
      return {
        can_use_credits: result.can_use_credits,
        reason: result.reason,
        daily_remaining: result.daily_remaining,
        monthly_remaining: result.monthly_remaining,
      };
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in checkUserCredits', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
        creditsToUse,
      });
      return {
        can_use_credits: false,
        reason: 'Exception checking credits',
        daily_remaining: 0,
        monthly_remaining: 0,
      };
    }
  }

  /**
   * Use credits for a user (with automatic limit checking)
   */
  static async useUserCredits(userId: string, creditsAmount: number = 1): Promise<CreditUsageResult> {
    try {
      const { data, error } = await supabaseAdmin.rpc('use_user_credits', {
        user_id: userId,
        credits_amount: creditsAmount,
      });

      if (error) {
        logger.error('[PRICING_PLANS] Error using user credits', {
          error: error.message,
          userId: userId.substring(0, 8) + '...',
          creditsAmount,
        });
        return {
          success: false,
          message: 'Error using credits',
          daily_remaining: 0,
          monthly_remaining: 0,
        };
      }

      const result = data[0];

      if (result.success) {
        logger.info('[PRICING_PLANS] Credits used successfully', {
          userId: userId.substring(0, 8) + '...',
          creditsAmount,
          dailyRemaining: result.daily_remaining,
          monthlyRemaining: result.monthly_remaining,
        });
      } else {
        logger.warn('[PRICING_PLANS] Credit usage failed', {
          userId: userId.substring(0, 8) + '...',
          creditsAmount,
          reason: result.message,
        });
      }

      return {
        success: result.success,
        message: result.message,
        daily_remaining: result.daily_remaining,
        monthly_remaining: result.monthly_remaining,
      };
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in useUserCredits', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
        creditsAmount,
      });
      return {
        success: false,
        message: 'Exception using credits',
        daily_remaining: 0,
        monthly_remaining: 0,
      };
    }
  }

  /**
   * Assign plan to user
   */
  static async assignPlanToUser(userId: string, planSlug: string): Promise<boolean> {
    try {
      // Get plan by slug
      const plan = await this.getPlanBySlug(planSlug);
      if (!plan) {
        logger.error('[PRICING_PLANS] Plan not found', { planSlug });
        return false;
      }

      // Update user's plan
      const { error } = await supabaseAdmin
        .from('users')
        .update({
          plan_id: plan.id,
          plan_started_at: new Date().toISOString(),
          credits_used_today: 0,
          credits_used_this_month: 0,
          last_credit_reset_date: new Date().toISOString().split('T')[0],
          monthly_reset_date: new Date().toISOString().split('T')[0],
        })
        .eq('id', userId);

      if (error) {
        logger.error('[PRICING_PLANS] Error assigning plan to user', {
          error: error.message,
          userId: userId.substring(0, 8) + '...',
          planSlug,
        });
        return false;
      }

      logger.info('[PRICING_PLANS] Plan assigned successfully', {
        userId: userId.substring(0, 8) + '...',
        planSlug,
        planName: plan.name,
      });

      return true;
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in assignPlanToUser', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
        planSlug,
      });
      return false;
    }
  }

  /**
   * Reset daily credits for all users (should be called daily via cron)
   */
  static async resetDailyCredits(): Promise<void> {
    try {
      const { error } = await supabaseAdmin.rpc('reset_daily_credits');

      if (error) {
        logger.error('[PRICING_PLANS] Error resetting daily credits', { error: error.message });
        throw new Error(`Failed to reset daily credits: ${error.message}`);
      }

      logger.info('[PRICING_PLANS] Daily credits reset completed');
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in resetDailyCredits', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Reset monthly credits for all users (should be called monthly via cron)
   */
  static async resetMonthlyCredits(): Promise<void> {
    try {
      const { error } = await supabaseAdmin.rpc('reset_monthly_credits');

      if (error) {
        logger.error('[PRICING_PLANS] Error resetting monthly credits', { error: error.message });
        throw new Error(`Failed to reset monthly credits: ${error.message}`);
      }

      logger.info('[PRICING_PLANS] Monthly credits reset completed');
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in resetMonthlyCredits', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get pricing plans formatted for API response (similar to old format)
   */
  static async getPlansForAPI(): Promise<{
    plans: any[];
    metadata: {
      count: number;
      currency_options: string[];
      billing_periods: string[];
      last_updated: string;
    };
  }> {
    try {
      const plans = await this.getAllPlans();

      // Transform to API format
      const formattedPlans = plans.map(plan => ({
        id: plan.slug,
        name: plan.name,
        description: plan.description,
        type: plan.slug === 'free' ? 'free' : (plan.slug === 'team' ? 'custom' : 'paid'),
        popular: plan.slug === 'pro',
        discount: 0,
        currency: 'USD',
        features: plan.features,
        limitations: plan.limitations,
        credit_options: plan.slug === 'team' ? [
          {
            credits: 5000,
            price: 159,
            price_per_credit: 0.032,
            is_default: true,
            billing_period: 'monthly',
            description: '5,000 credits - Team starter',
            savings: 20,
          },
          {
            credits: 10000,
            price: 299,
            price_per_credit: 0.030,
            is_default: false,
            billing_period: 'monthly',
            description: '10,000 credits - Team standard',
            savings: 25,
          },
          {
            credits: 15000,
            price: 399,
            price_per_credit: 0.027,
            is_default: false,
            billing_period: 'monthly',
            description: '15,000 credits - Team premium',
            savings: 35,
          },
          {
            credits: 25000,
            price: 599,
            price_per_credit: 0.024,
            is_default: false,
            billing_period: 'monthly',
            description: '25,000 credits - Enterprise ready',
            savings: 45,
          },
        ] : [{
          credits: plan.credits_per_month,
          price: plan.price || 0,
          price_per_credit: plan.price && plan.credits_per_month > 0
            ? Math.round((plan.price / plan.credits_per_month) * 1000) / 1000
            : 0,
          is_default: true,
          billing_period: 'monthly',
          description: plan.credits_per_month === -1
            ? 'Unlimited credits'
            : `${plan.credits_per_month} credits monthly${plan.credits_per_day ? ` (${plan.credits_per_day} per day)` : ''}`,
          savings: 0,
        }],
        contact_required: false,
        contact_info: undefined,
      }));

      return {
        plans: formattedPlans,
        metadata: {
          count: formattedPlans.length,
          currency_options: ['USD'],
          billing_periods: ['monthly'],
          last_updated: new Date().toISOString(),
        },
      };
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in getPlansForAPI', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
