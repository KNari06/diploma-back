/**
 * Script to verify credits directly via SQL query
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/logger';

const EMAIL = process.argv[2] || 'baukaa@gmail.com';

async function verifyCredits(): Promise<void> {
  try {
    logger.info('[VERIFY] Checking credits for...', { email: EMAIL });

    // Direct SQL query to check user_credits
    const { data: creditsData, error: creditsError } = await supabaseAdmin
      .rpc('exec_sql', {
        query: `
          SELECT
            u.id as user_id,
            u.email,
            u.credits as users_table_credits,
            uc.id as user_credits_id,
            uc.credits_balance,
            uc.total_purchased,
            uc.total_used,
            uc.subscription_plan,
            uc.subscription_status,
            uc.updated_at
          FROM users u
          LEFT JOIN user_credits uc ON uc.user_id = u.id
          WHERE u.email = '${EMAIL}'
        `
      });

    // Alternative: use direct select
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, email, credits')
      .eq('email', EMAIL)
      .single();

    if (!user) {
      throw new Error('User not found');
    }

    const { data: userCredits } = await supabaseAdmin
      .from('user_credits')
      .select('*')
      .eq('user_id', user.id)
      .single();

    logger.info('[VERIFY] ✅ Direct database check:', {
      users_table: {
        id: user.id,
        email: user.email,
        credits_field: user.credits, // This might be 0, but system uses user_credits
      },
      user_credits_table: userCredits ? {
        id: userCredits.id,
        credits_balance: userCredits.credits_balance,
        total_purchased: userCredits.total_purchased,
        total_used: userCredits.total_used,
        subscription_plan: userCredits.subscription_plan,
        subscription_status: userCredits.subscription_status,
        updated_at: userCredits.updated_at,
      } : 'NOT FOUND',
    });

    if (!userCredits) {
      logger.warn('[VERIFY] ⚠️ user_credits record not found! Creating...');

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
        throw createError;
      }

      logger.info('[VERIFY] ✅ Created user_credits with 1000 credits');
    } else if (userCredits.credits_balance === 0) {
      logger.warn('[VERIFY] ⚠️ Balance is 0, updating to 1000...');

      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update({
          credits_balance: 1000,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id);

      if (updateError) {
        throw updateError;
      }

      logger.info('[VERIFY] ✅ Updated balance to 1000');
    } else {
      logger.info('[VERIFY] ✅ Credits are correct:', {
        balance: userCredits.credits_balance,
      });
    }

  } catch (error) {
    logger.error('[VERIFY] Failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

verifyCredits()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('[VERIFY] Script failed', { error });
    process.exit(1);
  });
