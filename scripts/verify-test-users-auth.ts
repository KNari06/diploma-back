/**
 * Script to verify test users can authenticate
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/verify-test-users-auth.ts
 */

import { supabaseAdmin, supabase } from '../src/db/supabase';
import { logger } from '../src/utils/logger';
import { UserCreditsService } from '../src/services/core/user-credits.service';

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

const TEST_PASSWORD = 'test123456';

async function verifyTestUsersAuth(): Promise<void> {
  try {
    logger.info('[VERIFY_AUTH] Starting verification of test users authentication...');

    const results = {
      canAuth: 0,
      cannotAuth: 0,
      errors: [] as string[],
    };

    for (const email of TEST_USER_EMAILS) {
      try {
        logger.info(`[VERIFY_AUTH] Testing authentication for: ${email}`);

        // Step 1: Check if user exists in auth.users
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
        const authUser = authUsers?.users.find(u => u.email === email);

        if (!authUser) {
          logger.warn(`[VERIFY_AUTH] ⚠️ User ${email} not found in auth.users`);
          results.cannotAuth++;
          results.errors.push(`${email}: Not found in auth.users`);
          continue;
        }

        logger.info(`[VERIFY_AUTH] ✅ User found in auth.users: ${authUser.id}`);

        // Step 2: Check if user exists in public.users
        const { data: publicUser } = await supabaseAdmin
          .from('users')
          .select('id, email, name, role')
          .eq('email', email)
          .single();

        if (!publicUser) {
          logger.warn(`[VERIFY_AUTH] ⚠️ User ${email} not found in public.users`);
          results.cannotAuth++;
          results.errors.push(`${email}: Not found in public.users`);
          continue;
        }

        logger.info(`[VERIFY_AUTH] ✅ User found in public.users: ${publicUser.id}`);

        // Step 3: Check user_credits
        const userCredits = await UserCreditsService.getUserCredits(publicUser.id);
        if (!userCredits) {
          logger.warn(`[VERIFY_AUTH] ⚠️ User ${email} has no user_credits record`);
          results.cannotAuth++;
          results.errors.push(`${email}: No user_credits record`);
          continue;
        }

        logger.info(`[VERIFY_AUTH] ✅ User has credits: ${userCredits.credits_balance}`);

        // Step 4: Try to sign in (test authentication)
        const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password: TEST_PASSWORD,
        });

        if (signInError) {
          logger.warn(`[VERIFY_AUTH] ⚠️ Cannot sign in as ${email}`, {
            error: signInError.message,
          });
          results.cannotAuth++;
          results.errors.push(`${email}: Sign in failed - ${signInError.message}`);
          continue;
        }

        if (signInData?.user) {
          logger.info(`[VERIFY_AUTH] ✅ Successfully signed in as ${email}`);
          results.canAuth++;

          // Sign out after test
          await supabase.auth.signOut();
        } else {
          logger.warn(`[VERIFY_AUTH] ⚠️ Sign in returned no user for ${email}`);
          results.cannotAuth++;
          results.errors.push(`${email}: Sign in returned no user`);
        }
      } catch (error) {
        logger.error(`[VERIFY_AUTH] Error testing ${email}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        results.cannotAuth++;
        results.errors.push(`${email}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    logger.info('[VERIFY_AUTH] ✅ Verification complete!');
    logger.info(`  Can authenticate: ${results.canAuth}/${TEST_USER_EMAILS.length}`);
    logger.info(`  Cannot authenticate: ${results.cannotAuth}/${TEST_USER_EMAILS.length}`);

    if (results.errors.length > 0) {
      logger.warn('[VERIFY_AUTH] Errors found:');
      results.errors.forEach(err => logger.warn(`  - ${err}`));
    }

    if (results.canAuth === TEST_USER_EMAILS.length) {
      logger.info('');
      logger.info('✅ All test users can authenticate!');
      logger.info('📋 Credentials:');
      logger.info(`   Password: ${TEST_PASSWORD}`);
      logger.info('');
      TEST_USER_EMAILS.forEach(email => {
        logger.info(`   ✅ ${email}`);
      });
    } else {
      logger.warn('');
      logger.warn('⚠️ Some users cannot authenticate. Check errors above.');
    }
  } catch (error) {
    logger.error('[VERIFY_AUTH] Script failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Run script
verifyTestUsersAuth()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[VERIFY_AUTH] Script failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
