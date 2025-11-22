/**
 * Script to check user credits directly from database
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/check-user-credits.ts <email>
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/logger';

const EMAIL = process.argv[2] || 'baukaa@gmail.com';

async function checkUserCredits(): Promise<void> {
  try {
    logger.info('[CHECK_CREDITS] Checking credits for user...', { email: EMAIL });

    // Step 1: Find user by email
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('id, email, credits')
      .eq('email', EMAIL)
      .single();

    if (userError || !user) {
      logger.error('[CHECK_CREDITS] User not found', { error: userError?.message, email: EMAIL });
      throw new Error(`User ${EMAIL} not found`);
    }

    logger.info('[CHECK_CREDITS] User from users table', {
      userId: user.id,
      email: user.email,
      credits_in_users_table: user.credits,
    });

    // Step 2: Check user_credits table directly
    const { data: userCredits, error: creditsError } = await supabaseAdmin
      .from('user_credits')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (creditsError) {
      if (creditsError.code === 'PGRST116') {
        logger.warn('[CHECK_CREDITS] No user_credits record found', { userId: user.id });
        logger.info('[CHECK_CREDITS] Creating user_credits record...');

        // Create record
        const { data: newCredits, error: createError } = await supabaseAdmin
          .from('user_credits')
          .insert({
            user_id: user.id,
            credits_balance: 1000,
            total_purchased: 0,
            total_used: 0,
            subscription_plan: 'free',
            subscription_status: 'inactive',
          })
          .select()
          .single();

        if (createError) {
          logger.error('[CHECK_CREDITS] Failed to create user_credits', {
            error: createError.message,
            code: createError.code,
          });
          throw createError;
        }

        logger.info('[CHECK_CREDITS] ✅ Created user_credits record', {
          balance: newCredits.credits_balance,
          plan: newCredits.subscription_plan,
        });
        return;
      }
      throw creditsError;
    }

    logger.info('[CHECK_CREDITS] ✅ User credits from user_credits table', {
      id: userCredits.id,
      user_id: userCredits.user_id,
      credits_balance: userCredits.credits_balance,
      total_purchased: userCredits.total_purchased,
      total_used: userCredits.total_used,
      subscription_plan: userCredits.subscription_plan,
      subscription_status: userCredits.subscription_status,
      created_at: userCredits.created_at,
      updated_at: userCredits.updated_at,
    });

    // Step 3: Check recent transactions
    const { data: transactions, error: transError } = await supabaseAdmin
      .from('credit_transactions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5);

    if (!transError && transactions) {
      logger.info('[CHECK_CREDITS] Recent transactions', {
        count: transactions.length,
        transactions: transactions.map(t => ({
          amount: t.amount,
          type: t.transaction_type,
          balance_after: t.balance_after,
          description: t.description,
          created_at: t.created_at,
        })),
      });
    }

    // Step 4: If balance is 0, add credits directly
    if (userCredits.credits_balance === 0) {
      logger.info('[CHECK_CREDITS] Balance is 0, adding 1000 credits directly...');

      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update({
          credits_balance: 1000,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id);

      if (updateError) {
        logger.error('[CHECK_CREDITS] Failed to update credits', {
          error: updateError.message,
          code: updateError.code,
        });
        throw updateError;
      }

      // Record transaction
      await supabaseAdmin.from('credit_transactions').insert({
        user_id: user.id,
        amount: 1000,
        balance_after: 1000,
        transaction_type: 'bonus',
        description: 'Added 1000 credits via direct update',
        metadata: {},
      });

      logger.info('[CHECK_CREDITS] ✅ Updated credits to 1000');
    }

  } catch (error) {
    logger.error('[CHECK_CREDITS] Failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Run script
checkUserCredits()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[CHECK_CREDITS] Script failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
