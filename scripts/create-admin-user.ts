/**
 * Script to create an admin user with authentication
 *
 * This script:
 * 1. Creates user in auth.users via Supabase Admin API
 * 2. Trigger automatically syncs to public.users
 * 3. Updates public.users with admin role and subscription
 * 4. Creates user_credits and workspace
 *
 * Usage:
 *   npm run ts-node scripts/create-admin-user.ts
 *   npm run ts-node scripts/create-admin-user.ts admin@qait.dev SecurePassword123
 *
 * Or compile and run:
 *   npm run build
 *   node dist/scripts/create-admin-user.js
 */

import { supabaseAdmin } from '../src/db/supabase';
import { logger } from '../src/utils/logger';
import { UserCreditsService } from '../src/services/core/user-credits.service';
import { WorkspaceService } from '../src/services/core/workspace.service';

// Get email and password from command line arguments or use defaults
const email = process.argv[2] || 'admin@qait.dev';
const password = process.argv[3] || 'Admin@Qait123!';
const name = process.argv[4] || 'Admin User';

/**
 * Create an admin user in auth.users and update public.users
 */
async function createAdminUser(): Promise<void> {
  try {
    logger.info(`[CREATE_ADMIN] Creating admin user: ${email}`);

    // Step 1: Create user in auth.users via Admin API
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true, // Auto-confirm email (no verification needed for admin)
      user_metadata: {
        name: name,
      },
    });

    if (authError) {
      // If user already exists, try to get existing user
      const errorMessage = authError.message.toLowerCase();
      const isUserExistsError =
        errorMessage.includes('already registered') ||
        errorMessage.includes('already exists') ||
        errorMessage.includes('has already been registered') ||
        errorMessage.includes('user already exists') ||
        authError.status === 422; // 422 often means user exists

      if (isUserExistsError) {
        logger.warn(`[CREATE_ADMIN] User ${email} already exists, updating to admin role...`);

        const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = existingUsers?.users.find(u => u.email === email);

        if (!existingUser) {
          // Check public.users first
          const { data: publicUser } = await supabaseAdmin
            .from('users')
            .select('id, email')
            .eq('email', email)
            .single();

          if (publicUser) {
            logger.warn(`[CREATE_ADMIN] User exists in public.users but NOT in auth.users! Recreating in auth...`);
            await supabaseAdmin.from('users').delete().eq('id', publicUser.id);
            logger.info(`[CREATE_ADMIN] Deleted orphaned user from public.users, will recreate...`);
            return createAdminUser();
          }

          throw new Error(`User ${email} already exists but could not be found in auth.users or public.users`);
        }

        // Reset password to ensure access
        const { error: passwordResetError } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
          password: password,
          user_metadata: {
            name: name,
          },
        });

        if (passwordResetError) {
          logger.error(`[CREATE_ADMIN] Failed to reset password for ${email}`, {
            error: passwordResetError.message,
          });
        } else {
          logger.info(`[CREATE_ADMIN] ✅ Password reset for existing user: ${email}`);
        }

        // Wait for trigger to sync
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Update public.users with admin role
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            name: name,
            role: 'admin',
            subscription: { plan: 'enterprise', status: 'active', credits_included: 10000 },
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingUser.id);

        if (updateError) {
          // If update fails, user might not exist in public.users - create it
          if (updateError.code === 'PGRST116' || updateError.message.includes('No rows')) {
            logger.warn(`[CREATE_ADMIN] User not found in public.users, creating...`);
            const { error: insertError } = await supabaseAdmin
              .from('users')
              .insert({
                id: existingUser.id,
                email: existingUser.email,
                name: name,
                role: 'admin',
                subscription: { plan: 'enterprise', status: 'active', credits_included: 10000 },
                created_at: existingUser.created_at || new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });

            if (insertError) {
              logger.error(`[CREATE_ADMIN] Failed to create user in public.users`, {
                error: insertError.message,
              });
              throw insertError;
            }
            logger.info(`[CREATE_ADMIN] ✅ Created user in public.users: ${email}`);
          } else {
            logger.error(`[CREATE_ADMIN] Failed to update public.users for ${email}`, {
              error: updateError.message,
            });
            throw updateError;
          }
        } else {
          logger.info(`[CREATE_ADMIN] ✅ Updated existing user to admin: ${email} (${existingUser.id})`);
        }

        // Create/update user_credits
        await UserCreditsService.getOrCreateUserCredits(existingUser.id);
        const userCredits = await UserCreditsService.getUserCredits(existingUser.id);
        if (userCredits && userCredits.credits_balance === 0) {
          await UserCreditsService.addCredits(
            existingUser.id,
            10000,
            'bonus',
            'Initial credits for admin user',
            {}
          );
        }
        await UserCreditsService.updateSubscription(
          existingUser.id,
          'enterprise',
          'active',
          null
        );

        // Create workspace
        await WorkspaceService.checkOrCreateWorkspace(existingUser.id);

        logger.info(`[CREATE_ADMIN] ✅ Admin user updated successfully: ${email}`);
        return;
      }

      throw authError;
    }

    if (!authUser?.user) {
      throw new Error(`Failed to create user ${email}: no user returned`);
    }

    logger.info(`[CREATE_ADMIN] User created in auth.users: ${authUser.user.id}`);

    // Step 2: Wait a bit for trigger to sync auth.users → public.users
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Update public.users with admin role
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        name: name,
        role: 'admin',
        subscription: { plan: 'enterprise', status: 'active', credits_included: 10000 },
        updated_at: new Date().toISOString(),
      })
      .eq('id', authUser.user.id);

    if (updateError) {
      logger.error(`[CREATE_ADMIN] Failed to update public.users for ${email}`, {
        error: updateError.message,
        userId: authUser.user.id,
      });
      throw updateError;
    }

    // Step 4: Create user_credits with initial credits
    await UserCreditsService.getOrCreateUserCredits(authUser.user.id);
    await UserCreditsService.addCredits(
      authUser.user.id,
      10000,
      'bonus',
      'Initial credits for admin user',
      {}
    );
    await UserCreditsService.updateSubscription(
      authUser.user.id,
      'enterprise',
      'active',
      null
    );

    // Step 5: Create workspace
    await WorkspaceService.checkOrCreateWorkspace(authUser.user.id);

    logger.info(`[CREATE_ADMIN] ✅ Admin user created successfully: ${email} (${authUser.user.id})`);
  } catch (error) {
    logger.error(`[CREATE_ADMIN] Failed to create admin user ${email}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Verify admin user was created correctly
 */
async function verifyAdminUser(): Promise<void> {
  logger.info('[CREATE_ADMIN] Verifying admin user...');

  const { data: user, error: verifyError } = await supabaseAdmin
    .from('users')
    .select('id, email, name, role, subscription')
    .eq('email', email)
    .single();

  if (verifyError) {
    logger.error('[CREATE_ADMIN] Failed to verify user', { error: verifyError.message });
    return;
  }

  if (!user) {
    logger.error('[CREATE_ADMIN] User not found after creation');
    return;
  }

  const userCredits = await UserCreditsService.getUserCredits(user.id);
  const creditsBalance = userCredits ? userCredits.credits_balance : 0;

  logger.info(`[CREATE_ADMIN] ✅ Verified admin user:`);
  logger.info(`  - Email: ${user.email}`);
  logger.info(`  - Name: ${user.name}`);
  logger.info(`  - Role: ${user.role}`);
  logger.info(`  - Credits: ${creditsBalance}`);
  logger.info(`  - Subscription: ${JSON.stringify(user.subscription)}`);

  if (user.role !== 'admin') {
    logger.error(`[CREATE_ADMIN] ⚠️  WARNING: User role is '${user.role}' instead of 'admin'!`);
  }
}

/**
 * Main function
 */
async function main() {
  logger.info('[CREATE_ADMIN] Starting admin user creation...');
  logger.info(`[CREATE_ADMIN] Email: ${email}`);
  logger.info(`[CREATE_ADMIN] Name: ${name}`);

  try {
    await createAdminUser();
    await verifyAdminUser();

    logger.info('');
    logger.info('[CREATE_ADMIN] ✅ Done!');
    logger.info('');
    logger.info('📋 Admin User Credentials:');
    logger.info(`   Email: ${email}`);
    logger.info(`   Password: ${password}`);
    logger.info(`   Role: admin`);
    logger.info('');
    logger.info('💡 You can now login with these credentials on admin.qait.dev!');
  } catch (error) {
    logger.error('[CREATE_ADMIN] Script failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Run script
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('[CREATE_ADMIN] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
