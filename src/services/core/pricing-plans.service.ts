import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { PlanService } from '@/services/core/plan.service';
import { WORKSPACE_PLANS } from '@/services/core/token-calculator.service';

type B2bPlanSlug = keyof typeof WORKSPACE_PLANS;

/**
 * Build a synthetic PricingPlan for a B2B tier (which has no pricing_plans row).
 * Credits reflect the user's actual granted allotment (from user_credits) so an
 * admin discount is honored, falling back to the tier's config credits.
 */
function syntheticB2bPlan(slug: B2bPlanSlug, grantedCredits: number | null): PricingPlan {
  const cfg = WORKSPACE_PLANS[slug];
  const name = slug
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return {
    id: `b2b:${slug}`,
    name,
    slug,
    description: `${name} plan`,
    price: cfg.price,
    credits_per_month: grantedCredits != null && Number.isFinite(grantedCredits) ? grantedCredits : cfg.credits,
    credits_per_day: null,
    features: [],
    limitations: [],
    is_active: true,
    created_at: '',
    updated_at: '',
  };
}

export interface PricingPlan {
  id: string;
  name: string;
  // Individual pricing_plans slugs, plus the B2B tiers which have NO
  // pricing_plans row — for those, getUserPlanInfo returns a synthetic plan
  // built from WORKSPACE_PLANS so paid B2B users aren't reported as "no plan".
  slug: 'free' | 'pro' | 'ultra' | 'pilot' | 'small_business' | 'middle_business' | 'enterprise';
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

      // No pricing_plans row. This is either a genuine free/no-plan user OR a
      // paid B2B user (pilot/small_business/middle_business/enterprise have no
      // pricing_plans row and their users.plan_id is null). Check the credit-side
      // tier before concluding "no plan", so a paying B2B customer gets real plan
      // info instead of a 404.
      if (!data || !data.pricing_plans) {
        const { data: credits } = await supabaseAdmin
          .from('user_credits')
          .select('subscription_plan, subscription_status, credits_balance')
          .eq('user_id', userId)
          .maybeSingle();

        const slug = credits?.subscription_plan as string | undefined;
        if (
          slug &&
          credits?.subscription_status === 'active' &&
          (slug in WORKSPACE_PLANS)
        ) {
          const plan = syntheticB2bPlan(slug as B2bPlanSlug, Number(credits?.credits_balance));
          const monthlyRemaining =
            plan.credits_per_month === -1
              ? -1
              : Math.max(0, plan.credits_per_month - (data?.credits_used_this_month || 0));
          return {
            user_id: userId,
            plan,
            plan_started_at: data?.plan_started_at,
            credits_used_today: data?.credits_used_today || 0,
            credits_used_this_month: data?.credits_used_this_month || 0,
            last_credit_reset_date: data?.last_credit_reset_date,
            monthly_reset_date: data?.monthly_reset_date,
            daily_remaining: -1,
            monthly_remaining: monthlyRemaining,
          };
        }

        logger.debug('[PRICING_PLANS] User has no plan assigned (free tier)', {
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
   * Assign plan to user.
   *
   * Thin wrapper kept for existing callers (self-serve provisioning, admin
   * grant). The real write — keeping users.{plan_id,plan,plan_status} and
   * user_credits.{subscription_plan,subscription_status,grace_limit} in sync —
   * is owned by the single funnel {@link PlanService.setUserPlan}. The
   * "never silently downgrade a paid plan to free" guard now lives there.
   */
  static async assignPlanToUser(userId: string, planSlug: string): Promise<boolean> {
    // Real plan grant (admin / self-serve) → reset per-period usage counters,
    // matching the legacy assignPlanToUser behavior. Stripe mirror-sync calls
    // go through setUserPlan directly and deliberately do NOT reset counters.
    return PlanService.setUserPlan(userId, planSlug, {
      source: 'assignPlanToUser',
      resetUsageCounters: true,
    });
  }

  /**
   * Reset daily credits for all users (should be called daily via cron)
   *
   * For FREE plan users:
   * - If user used 0 credits yesterday → no credits added
   * - If user used 1-5 credits yesterday → adds back what they used (to restore to 5)
   *
   * For other plans (pro, ultra):
   * - Just resets the daily usage counter
   */
  static async resetDailyCredits(): Promise<void> {
    try {
      const { error } = await supabaseAdmin.rpc('reset_daily_credits');

      if (error) {
        logger.error('[PRICING_PLANS] Error resetting daily credits', { error: error.message });
        throw new Error(`Failed to reset daily credits: ${error.message}`);
      }

      logger.info('[PRICING_PLANS] Daily credits reset and replenishment completed');
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
   * Get credit options for a plan from database
   */
  private static async getPlanCreditOptions(planId: string, planSlug: string): Promise<any[]> {
    try {
      if (planSlug === 'pro') {
        const { data, error } = await supabaseAdmin
          .from('pro_plan_options')
          .select('*')
          .eq('plan_id', planId)
          .order('credits', { ascending: true });

        if (error) {
          logger.error('[PRICING_PLANS] Error getting pro plan options', {
            error: error.message,
            planId,
            planSlug,
          });
          return [];
        }

        if (!data || data.length === 0) {
          logger.warn('[PRICING_PLANS] No pro plan options found in database', { planId });
          return [];
        }

        logger.info('[PRICING_PLANS] Found pro plan options', {
          count: data.length,
          planId,
        });

        // Map each credit volume to its Stripe checkout code via the `plans`
        // table (plans.credits_per_period ↔ option.credits). Lets the
        // frontend pass the right plan_code to /billing/checkout without
        // hardcoding the credits→code mapping.
        const { data: planCodes } = await supabaseAdmin
          .from('plans')
          .select('code, credits_per_period')
          .eq('plan_id', planId);
        const codeByCredits = new Map<number, string>(
          (planCodes || []).map(p => [p.credits_per_period, p.code])
        );

        return (data || []).map(opt => ({
          credits: opt.credits,
          price: Number(opt.price),
          price_per_credit: Number(opt.price_per_credit),
          is_default: opt.is_default,
          billing_period: 'monthly',
          description: opt.description,
          savings: opt.savings || 0,
          plan_code: codeByCredits.get(opt.credits) ?? null,
        }));
      }

      if (planSlug === 'ultra') {
        logger.info('[PRICING_PLANS] Fetching ultra plan options', {
          planId,
          planIdType: typeof planId,
          planSlug,
        });

        // First, verify the plan exists
        const { data: planCheck } = await supabaseAdmin
          .from('pricing_plans')
          .select('id, slug, name')
          .eq('slug', 'ultra')
          .eq('is_active', true)
          .maybeSingle();

        if (planCheck) {
          logger.info('[PRICING_PLANS] Ultra plan found in DB', {
            dbPlanId: planCheck.id,
            requestedPlanId: planId,
            match: planCheck.id === planId,
          });
        }

        const { data, error } = await supabaseAdmin
          .from('ultra_plan_options')
          .select('*')
          .eq('plan_id', planId)
          .order('credits', { ascending: true });

        if (error) {
          logger.error('[PRICING_PLANS] Error getting ultra plan options', {
            error: error.message,
            errorCode: error.code,
            planId,
            planSlug,
          });
          return [];
        }

        if (!data || data.length === 0) {
          logger.warn('[PRICING_PLANS] No ultra plan options found in database', {
            planId,
            planSlug,
            queryResult: data,
          });

          // Try to find any ultra plan options (for debugging)
          const { data: allUltraOptions } = await supabaseAdmin
            .from('ultra_plan_options')
            .select('plan_id, credits, price');

          logger.warn('[PRICING_PLANS] All ultra_plan_options in DB', {
            allOptions: allUltraOptions,
            searchingForPlanId: planId,
            planIdType: typeof planId,
          });

          // Try alternative: find by plan slug via join
          const { data: optionsBySlug } = await supabaseAdmin
            .from('ultra_plan_options')
            .select(`
              *,
              pricing_plans!inner(id, slug, name)
            `)
            .eq('pricing_plans.slug', 'ultra')
            .eq('pricing_plans.is_active', true)
            .order('credits', { ascending: true });

          if (optionsBySlug && optionsBySlug.length > 0) {
            logger.warn('[PRICING_PLANS] Found options via join query', {
              count: optionsBySlug.length,
              firstOption: optionsBySlug[0],
            });
            // Use the found options
            return (optionsBySlug || []).map((opt: any) => ({
              credits: opt.credits,
              price: Number(opt.price),
              price_per_credit: Number(opt.price_per_credit),
              is_default: opt.is_default,
              billing_period: 'monthly',
              description: opt.description,
              savings: opt.savings || 0,
            }));
          }

          return [];
        }

        logger.info('[PRICING_PLANS] Found ultra plan options', {
          count: data.length,
          planId,
        });

        return (data || []).map(opt => ({
          credits: opt.credits,
          price: Number(opt.price),
          price_per_credit: Number(opt.price_per_credit),
          is_default: opt.is_default,
          billing_period: 'monthly',
          description: opt.description,
          savings: opt.savings || 0,
        }));
      }

      return [];
    } catch (error) {
      logger.error('[PRICING_PLANS] Exception in getPlanCreditOptions', {
        error: error instanceof Error ? error.message : String(error),
        planId,
        planSlug,
      });
      return [];
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
      const formattedPlans = await Promise.all(
        plans
          .map(async plan => {
            // Get credit options from database for pro and ultra plans
            let creditOptions: any[];

            if (plan.slug === 'pro') {
              logger.info('[PRICING_PLANS] Loading credit options for plan', {
                planSlug: plan.slug,
                planId: plan.id,
                planName: plan.name,
              });

              creditOptions = await this.getPlanCreditOptions(plan.id, plan.slug);

              logger.info('[PRICING_PLANS] Credit options loaded', {
                planSlug: plan.slug,
                planId: plan.id,
                optionsCount: creditOptions?.length || 0,
              });

              // Fallback: if no options found, create default from plan
              if (!creditOptions || creditOptions.length === 0) {
                logger.warn('[PRICING_PLANS] No credit options found for plan, using fallback', {
                  planSlug: plan.slug,
                  planId: plan.id,
                  planName: plan.name,
                });
                creditOptions = [{
                  credits: plan.credits_per_month,
                  price: plan.price || 0,
                  price_per_credit: plan.price && plan.credits_per_month > 0
                    ? Math.round((plan.price / plan.credits_per_month) * 10000) / 10000
                    : 0,
                  is_default: true,
                  billing_period: 'monthly',
                  description: `${plan.credits_per_month} credits monthly`,
                  savings: 0,
                }];
              }
            } else if (plan.slug === 'ultra') {
              // Ultra/Business is contact_required — no credit_options needed
              creditOptions = [];
            } else {
              // For free plan, use default option
              creditOptions = [{
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
              }];
            }

            return {
              id: plan.slug,
              name: plan.name,
              description: plan.description,
              type: plan.slug === 'free' ? 'free' : (plan.slug === 'ultra' ? 'custom' : 'paid'),
              popular: plan.slug === 'pro',
              discount: 0,
              currency: 'USD',
              features: plan.features,
              limitations: plan.limitations,
              credit_options: creditOptions,
              contact_required: plan.slug === 'ultra' ? true : false,
              contact_info: undefined,
            };
          })
      );

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
