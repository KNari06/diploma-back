/**
 * Script to add credits to a user
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/add-credits-to-user.ts <email> <amount>
 *   npx ts-node -r tsconfig-paths/register scripts/add-credits-to-user.ts baukaa@gmail.com 1000
 */

import { supabaseAdmin } from '../src/db/supabase';
import { UserCreditsService } from '../src/services/core/user-credits.service';
import { logger } from '../src/utils/core/logger';

const EMAIL = process.argv[2] || 'baukaa@gmail.com';
const AMOUNT = parseInt(process.argv[3] || '1000', 10);

async function addCreditsToUser(): Promise<void> {
  try {
    logger.info('[ADD_CREDITS] Starting...', { email: EMAIL, amount: AMOUNT });

    // Step 1: Find user by email
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email')
      .eq('email', EMAIL)
      .single();

    if (userError || !user) {
      logger.error('[ADD_CREDITS] User not found', { error: userError?.message, email: EMAIL });
      throw new Error(`User ${EMAIL} not found`);
    }

    logger.info('[ADD_CREDITS] Found user', { userId: user.id, email: user.email });

    // Step 2: Get or create user_credits record
    const userCredits = await UserCreditsService.getOrCreateUserCredits(user.id);

    logger.info('[ADD_CREDITS] Current credits state', {
      balance: userCredits.credits_balance,
      plan: userCredits.subscription_plan,
      status: userCredits.subscription_status,
    });

    // Step 3: Add credits
    logger.info(`[ADD_CREDITS] Adding ${AMOUNT} credits...`);
    const result = await UserCreditsService.addCredits(
      user.id,
      AMOUNT,
      'bonus',
      `Added ${AMOUNT} credits via script`,
      {}
    );

    if (!result.success) {
      throw new Error('Failed to add credits');
    }

    logger.info('[ADD_CREDITS] Credits added', { newBalance: result.newBalance });

    // Step 4: Verify final state
    const finalCredits = await UserCreditsService.getUserCredits(user.id);
    if (!finalCredits) {
      throw new Error('Failed to verify credits after update');
    }

    logger.info('[ADD_CREDITS] ✅ Final credits state', {
      balance: finalCredits.credits_balance,
      plan: finalCredits.subscription_plan,
      status: finalCredits.subscription_status,
      totalPurchased: finalCredits.total_purchased,
      totalUsed: finalCredits.total_used,
    });

    logger.info('[ADD_CREDITS] ✅ Done!');
    logger.info(`   Email: ${EMAIL}`);
    logger.info(`   Added: ${AMOUNT} credits`);
    logger.info(`   New Balance: ${finalCredits.credits_balance} credits`);
  } catch (error) {
    logger.error('[ADD_CREDITS] Failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Run script
addCreditsToUser()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[ADD_CREDITS] Script failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
