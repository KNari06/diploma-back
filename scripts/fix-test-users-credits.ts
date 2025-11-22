/**
 * Script to fix test users credits
 * Creates user_credits records for all test users
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/fix-test-users-credits.ts
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/logger';
import { UserCreditsService } from '../src/services/core/user-credits.service';
import { WorkspaceService } from '../src/services/core/workspace.service';

const TEST_USER_EMAILS = [
  'test1@qai-test.local',
  'test2@qai-test.local',
  'test3@qai-test.local',
  'test4@qai-test.local',
  'test5@qai-test.local',
  'test6@qai-test.local',
  'admin@qai-test.local',
  'test8@qai-test.local',
  'test9@qai-test.local',
  'test10@qai-test.local',
];

const CREDITS_AMOUNT = 1000;

async function fixTestUsersCredits(): Promise<void> {
  try {
    logger.info('[FIX_TEST_USERS] Starting fix for test users credits...');

    const results = {
      fixed: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const email of TEST_USER_EMAILS) {
      try {
        // Find user
        const { data: user, error: userError } = await supabaseAdmin
          .from('users')
          .select('id, email, name')
          .eq('email', email)
          .single();

        if (userError || !user) {
          logger.warn(`[FIX_TEST_USERS] User not found: ${email}`);
          results.skipped++;
          continue;
        }

        logger.info(`[FIX_TEST_USERS] Processing user: ${email} (${user.id})`);

        // Get or create user_credits
        const userCredits = await UserCreditsService.getOrCreateUserCredits(user.id);

        // Add credits if balance is 0
        if (userCredits.credits_balance === 0) {
          logger.info(`[FIX_TEST_USERS] Adding ${CREDITS_AMOUNT} credits to ${email}...`);
          const result = await UserCreditsService.addCredits(
            user.id,
            CREDITS_AMOUNT,
            'bonus',
            'Initial credits for test user',
            {}
          );

          if (result.success) {
            logger.info(`[FIX_TEST_USERS] ✅ Added credits to ${email}, new balance: ${result.newBalance}`);
          } else {
            logger.error(`[FIX_TEST_USERS] Failed to add credits to ${email}`);
            results.errors.push(`${email}: Failed to add credits`);
            continue;
          }
        } else {
          logger.info(`[FIX_TEST_USERS] User ${email} already has ${userCredits.credits_balance} credits, skipping`);
        }

        // Update subscription to professional
        await UserCreditsService.updateSubscription(user.id, 'pro', 'active', null);

        // Create workspace if not exists
        await WorkspaceService.checkOrCreateWorkspace(user.id);

        results.fixed++;
      } catch (error) {
        logger.error(`[FIX_TEST_USERS] Error processing ${email}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        results.errors.push(`${email}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    logger.info('[FIX_TEST_USERS] ✅ Done!');
    logger.info(`  Fixed: ${results.fixed}`);
    logger.info(`  Skipped: ${results.skipped}`);
    if (results.errors.length > 0) {
      logger.error(`  Errors: ${results.errors.length}`);
      results.errors.forEach(err => logger.error(`    - ${err}`));
    }
  } catch (error) {
    logger.error('[FIX_TEST_USERS] Script failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Run script
fixTestUsersCredits()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[FIX_TEST_USERS] Script failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
