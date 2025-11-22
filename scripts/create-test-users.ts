/**
 * Script to create 10 test users with authentication
 *
 * This script:
 * 1. Creates users in auth.users via Supabase Admin API
 * 2. Trigger automatically syncs to public.users
 * 3. Updates public.users with correct credits and subscription
 *
 * Usage:
 *   npm run ts-node scripts/create-test-users.ts
 *
 * Or compile and run:
 *   npm run build
 *   node dist/scripts/create-test-users.js
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/logger';
import { UserCreditsService } from '../src/services/core/user-credits.service';
import { WorkspaceService } from '../src/services/core/workspace.service';

// Test users configuration
// All users have: professional plan, 1000 credits
const TEST_USERS = [
  {
    email: 'test1@qai-test.local',
    password: 'test123456',
    name: 'Test User 1',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test2@qai-test.local',
    password: 'test123456',
    name: 'Test User 2',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test3@qai-test.local',
    password: 'test123456',
    name: 'Test User 3',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test4@qai-test.local',
    password: 'test123456',
    name: 'Test User 4',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test5@qai-test.local',
    password: 'test123456',
    name: 'Test User 5',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test6@qai-test.local',
    password: 'test123456',
    name: 'Test User 6',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'admin@qai-test.local',
    password: 'test123456',
    name: 'Test Admin User',
    role: 'admin' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test8@qai-test.local',
    password: 'test123456',
    name: 'Test User 8',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test9@qai-test.local',
    password: 'test123456',
    name: 'Test User 9',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
  {
    email: 'test10@qai-test.local',
    password: 'test123456',
    name: 'Test User 10',
    role: 'user' as const,
    credits: 1000,
    subscription: { plan: 'professional', status: 'active', credits_included: 500 },
  },
];

/**
 * Create a test user in auth.users and update public.users
 */
async function createTestUser(userConfig: typeof TEST_USERS[0]): Promise<void> {
  try {
    logger.info(`[CREATE_USER] Creating user: ${userConfig.email}`);

    // Step 1: Create user in auth.users via Admin API
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: userConfig.email,
      password: userConfig.password,
      email_confirm: true, // Auto-confirm email (no verification needed for test users)
      user_metadata: {
        name: userConfig.name,
      },
    });

    if (authError) {
      // If user already exists, try to get existing user
      if (authError.message.includes('already registered') || authError.message.includes('already exists')) {
        logger.warn(`[CREATE_USER] User ${userConfig.email} already exists, fetching existing user`);

        const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = existingUsers?.users.find(u => u.email === userConfig.email);

        if (!existingUser) {
          // ✅ FIX: User might exist in public.users but not in auth.users
          // Check public.users first
          const { data: publicUser } = await supabaseAdmin
            .from('users')
            .select('id, email')
            .eq('email', userConfig.email)
            .single();

          if (publicUser) {
            logger.warn(`[CREATE_USER] User exists in public.users but NOT in auth.users! Recreating in auth...`);
            // User exists in public.users but not in auth.users - need to recreate
            // This can happen if auth.users was cleared but public.users wasn't
            // We'll need to delete from public.users first, then recreate
            await supabaseAdmin.from('users').delete().eq('id', publicUser.id);
            logger.info(`[CREATE_USER] Deleted orphaned user from public.users, will recreate...`);
            // Retry creation (will go through normal flow)
            return createTestUser(userConfig);
          }

          throw new Error(`User ${userConfig.email} already exists but could not be found in auth.users or public.users`);
        }

        // ✅ FIX: Reset password to ensure access (CRITICAL for session recovery)
        const { error: passwordResetError } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
          password: userConfig.password, // Reset password to known value: test123456
          user_metadata: {
            name: userConfig.name,
          },
        });

        if (passwordResetError) {
          logger.error(`[CREATE_USER] Failed to reset password for ${userConfig.email}`, {
            error: passwordResetError.message,
          });
          // Don't throw - continue with other updates
        } else {
          logger.info(`[CREATE_USER] ✅ Password reset for existing user: ${userConfig.email} (password: ${userConfig.password})`);
        }

        // Step 2: Wait a bit for trigger to sync (if needed)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Step 3: Update public.users (without credits - they're in user_credits now)
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            name: userConfig.name,
            role: userConfig.role,
            subscription: userConfig.subscription,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingUser.id);

        if (updateError) {
          // ✅ FIX: If update fails, user might not exist in public.users - create it
          if (updateError.code === 'PGRST116' || updateError.message.includes('No rows')) {
            logger.warn(`[CREATE_USER] User not found in public.users, creating...`);
            const { error: insertError } = await supabaseAdmin
              .from('users')
              .insert({
                id: existingUser.id,
                email: existingUser.email,
                name: userConfig.name,
                role: userConfig.role,
                subscription: userConfig.subscription,
                created_at: existingUser.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });

            if (insertError) {
              logger.error(`[CREATE_USER] Failed to create user in public.users`, {
                error: insertError.message,
              });
              throw insertError;
            }
            logger.info(`[CREATE_USER] ✅ Created user in public.users: ${userConfig.email}`);
          } else {
            logger.error(`[CREATE_USER] Failed to update public.users for ${userConfig.email}`, {
              error: updateError.message,
            });
            throw updateError;
          }
        } else {
          logger.info(`[CREATE_USER] ✅ Updated existing user: ${userConfig.email} (${existingUser.id})`);
        }

        // Step 4: Create/update user_credits
        await UserCreditsService.getOrCreateUserCredits(existingUser.id);
        const userCredits = await UserCreditsService.getUserCredits(existingUser.id);
        if (userCredits && userCredits.credits_balance === 0) {
          await UserCreditsService.addCredits(
            existingUser.id,
            userConfig.credits,
            'bonus',
            'Initial credits for test user',
            {}
          );
        }
        await UserCreditsService.updateSubscription(
          existingUser.id,
          userConfig.subscription.plan === 'professional' ? 'pro' : 'free',
          userConfig.subscription.status === 'active' ? 'active' : 'inactive',
          null
        );

        // Step 5: Create workspace
        await WorkspaceService.checkOrCreateWorkspace(existingUser.id);

        return;
      }

      throw authError;
    }

    if (!authUser?.user) {
      throw new Error(`Failed to create user ${userConfig.email}: no user returned`);
    }

    logger.info(`[CREATE_USER] User created in auth.users: ${authUser.user.id}`);

    // Step 2: Wait a bit for trigger to sync auth.users → public.users
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Update public.users (without credits - they're in user_credits now)
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        name: userConfig.name,
        role: userConfig.role,
        subscription: userConfig.subscription,
        updated_at: new Date().toISOString(),
      })
      .eq('id', authUser.user.id);

    if (updateError) {
      logger.error(`[CREATE_USER] Failed to update public.users for ${userConfig.email}`, {
        error: updateError.message,
        userId: authUser.user.id,
      });
      throw updateError;
    }

    // Step 4: Create user_credits with initial credits
    await UserCreditsService.getOrCreateUserCredits(authUser.user.id);
    await UserCreditsService.addCredits(
      authUser.user.id,
      userConfig.credits,
      'bonus',
      'Initial credits for test user',
      {}
    );
    await UserCreditsService.updateSubscription(
      authUser.user.id,
      userConfig.subscription.plan === 'professional' ? 'pro' : 'free',
      userConfig.subscription.status === 'active' ? 'active' : 'inactive',
      null
    );

    // Step 5: Create workspace
    await WorkspaceService.checkOrCreateWorkspace(authUser.user.id);

    logger.info(`[CREATE_USER] ✅ User created successfully: ${userConfig.email} (${authUser.user.id})`);
  } catch (error) {
    logger.error(`[CREATE_USER] Failed to create user ${userConfig.email}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  logger.info('[CREATE_TEST_USERS] Starting test users creation...');

  const results = {
    success: 0,
    failed: 0,
    errors: [] as string[],
  };

  for (const userConfig of TEST_USERS) {
    try {
      await createTestUser(userConfig);
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push(`${userConfig.email}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Summary
  logger.info('[CREATE_TEST_USERS] Summary:', {
    total: TEST_USERS.length,
    success: results.success,
    failed: results.failed,
  });

  if (results.errors.length > 0) {
    logger.error('[CREATE_TEST_USERS] Errors:', results.errors);
  }

  // Verify users
  logger.info('[CREATE_TEST_USERS] Verifying created users...');
  const { data: users, error: verifyError } = await supabaseAdmin
    .from('users')
    .select('id, email, name, role, subscription')
    .in('email', TEST_USERS.map(u => u.email))
    .order('email');

  if (verifyError) {
    logger.error('[CREATE_TEST_USERS] Failed to verify users', { error: verifyError.message });
  } else {
    logger.info(`[CREATE_TEST_USERS] ✅ Verified ${users?.length || 0} users in public.users`);
    for (const user of users || []) {
      const userCredits = await UserCreditsService.getUserCredits(user.id);
      const creditsBalance = userCredits ? userCredits.credits_balance : 0;
      logger.info(`  - ${user.email}: ${creditsBalance} credits, role: ${user.role}`);
    }
  }

  logger.info('[CREATE_TEST_USERS] ✅ Done!');
  logger.info('');
  logger.info('📋 Test Users Credentials:');
  logger.info('   All users have password: test123456');
  logger.info('');
  TEST_USERS.forEach(user => {
    logger.info(`   ${user.email} (${user.role})`);
  });
  logger.info('');
  logger.info('💡 You can now login with these credentials!');
}

// Run script
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[CREATE_TEST_USERS] Script failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
