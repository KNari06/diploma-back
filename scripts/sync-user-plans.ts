/**
 * Script to sync subscription_plan in user_credits with plan_id in users table
 *
 * This script fixes the issue where users have a plan assigned in users.plan_id
 * but user_credits.subscription_plan is still 'free'
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/sync-user-plans.ts
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/logger';
import { UserCreditsService } from '../src/services/core/user-credits.service';

// Map pricing_plans slug to user_credits subscription_plan values
const PLAN_MAPPING: Record<string, 'free' | 'basic' | 'pro' | 'enterprise'> = {
  'free': 'free',
  'pro': 'pro',
  'ultra': 'enterprise',
  'team': 'enterprise',
};

async function syncUserPlans(): Promise<void> {
  try {
    logger.info('[SYNC_USER_PLANS] Starting sync...');

    // Get all users with plan_id assigned
    const { data: users, error: usersError } = await supabaseAdmin
      .from('users')
      .select(`
        id,
        plan_id,
        pricing_plans!plan_id (
          slug
        )
      `)
      .not('plan_id', 'is', null);

    if (usersError) {
      logger.error('[SYNC_USER_PLANS] Error fetching users', { error: usersError.message });
      throw usersError;
    }

    if (!users || users.length === 0) {
      logger.info('[SYNC_USER_PLANS] No users with plans found');
      return;
    }

    logger.info(`[SYNC_USER_PLANS] Found ${users.length} users with plans`);

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    for (const user of users) {
      try {
        const plan = Array.isArray(user.pricing_plans)
          ? user.pricing_plans[0]
          : user.pricing_plans;

        if (!plan || !plan.slug) {
          logger.warn('[SYNC_USER_PLANS] User has plan_id but plan not found', {
            userId: user.id.substring(0, 8) + '...',
            planId: user.plan_id,
          });
          skipped++;
          continue;
        }

        const subscriptionPlan = PLAN_MAPPING[plan.slug] || 'free';

        // Get current user_credits
        const userCredits = await UserCreditsService.getUserCredits(user.id);

        if (!userCredits) {
          logger.warn('[SYNC_USER_PLANS] User credits not found, creating...', {
            userId: user.id.substring(0, 8) + '...',
          });
          await UserCreditsService.getOrCreateUserCredits(user.id);
        }

        // Check if sync is needed
        if (userCredits && userCredits.subscription_plan === subscriptionPlan) {
          logger.debug('[SYNC_USER_PLANS] Plan already synced', {
            userId: user.id.substring(0, 8) + '...',
            plan: subscriptionPlan,
          });
          skipped++;
          continue;
        }

        // Update subscription_plan
        const updated = await UserCreditsService.updateSubscription(
          user.id,
          subscriptionPlan,
          'active',
          null
        );

        if (updated) {
          logger.info('[SYNC_USER_PLANS] Plan synced', {
            userId: user.id.substring(0, 8) + '...',
            planSlug: plan.slug,
            subscriptionPlan,
            oldPlan: userCredits?.subscription_plan || 'none',
          });
          synced++;
        } else {
          logger.error('[SYNC_USER_PLANS] Failed to sync plan', {
            userId: user.id.substring(0, 8) + '...',
            planSlug: plan.slug,
          });
          errors++;
        }
      } catch (error) {
        logger.error('[SYNC_USER_PLANS] Error syncing user', {
          userId: user.id.substring(0, 8) + '...',
          error: error instanceof Error ? error.message : String(error),
        });
        errors++;
      }
    }

    logger.info('[SYNC_USER_PLANS] Sync completed', {
      total: users.length,
      synced,
      skipped,
      errors,
    });

  } catch (error) {
    logger.error('[SYNC_USER_PLANS] Fatal error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  try {
    await syncUserPlans();
    process.exit(0);
  } catch (error) {
    logger.error('[SYNC_USER_PLANS] Script failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
