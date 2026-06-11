/**
 * Manually confirm an already-signed-up user (bypass broken email delivery).
 *
 * Use when a user completed signup (row exists in auth.users) but never received
 * the confirmation email, so email_confirmed_at is null and they can't log in.
 *
 * This script:
 *   1. Finds the user in auth.users by email
 *   2. Sets email_confirm=true (confirms the email) — DOES NOT touch the password,
 *      so the user logs in with the password they chose at signup
 *   3. Syncs public.users (keeps role 'user', sets enterprise plan)
 *   4. Ensures user_credits + enterprise subscription + workspace exist
 *
 * Usage:
 *   npm run confirm-user -- qa@janapost.kz
 *   npm run confirm-user -- qa@janapost.kz user        # explicit role
 *   npm run confirm-user -- qa@janapost.kz user enterprise
 */

import { supabaseAdmin } from '../src/db/supabase';
import { UserCreditsService } from '../src/services/core/user-credits.service';
import { WorkspaceService } from '../src/services/core/workspace.service';
import { logger } from '../src/utils/core/logger';

const email = (process.argv[2] || '').trim().toLowerCase();
const role = (process.argv[3] || 'user') as 'user' | 'admin';
const plan = (process.argv[4] || 'enterprise') as
  | 'free'
  | 'basic'
  | 'pro'
  | 'ultra'
  | 'enterprise'
  | 'business';

const ENTERPRISE_CREDITS = 10000;

async function findAuthUserByEmail(targetEmail: string) {
  // listUsers is paginated (default 50/page); walk pages until found.
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const found = data.users.find(u => u.email?.toLowerCase() === targetEmail);
    if (found) return found;
    if (data.users.length < perPage) return null; // last page
    page += 1;
  }
}

async function confirmUser(): Promise<void> {
  if (!email || !email.includes('@')) {
    throw new Error('Usage: npm run confirm-user -- <email> [role] [plan]');
  }

  logger.info(`[CONFIRM_USER] Looking up auth user: ${email}`);
  const authUser = await findAuthUserByEmail(email);

  if (!authUser) {
    throw new Error(
      `User ${email} not found in auth.users. They must complete signup first (or use create-admin-user to create from scratch).`
    );
  }

  logger.info(`[CONFIRM_USER] Found user ${email} (${authUser.id})`, {
    emailConfirmedAt: authUser.email_confirmed_at ?? null,
  });

  // Step 1: confirm email WITHOUT touching the password.
  if (authUser.email_confirmed_at) {
    logger.info(`[CONFIRM_USER] Email already confirmed — skipping confirm step`);
  } else {
    const { error: confirmError } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      email_confirm: true,
    });
    if (confirmError) {
      logger.error(`[CONFIRM_USER] Failed to confirm email`, { error: confirmError.message });
      throw confirmError;
    }
    logger.info(`[CONFIRM_USER] ✅ Email confirmed (password untouched)`);
  }

  // Wait for the auth.users → public.users trigger to settle.
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Step 2: sync public.users (role + plan). Update first, insert if missing.
  const subscription = { plan, status: 'active', credits_included: ENTERPRISE_CREDITS };
  const { error: updateError, count } = await supabaseAdmin
    .from('users')
    .update({ role, subscription, updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', authUser.id);

  if (updateError) {
    logger.error(`[CONFIRM_USER] Failed to update public.users`, { error: updateError.message });
    throw updateError;
  }

  if (!count) {
    logger.warn(`[CONFIRM_USER] No public.users row yet — inserting`);
    const { error: insertError } = await supabaseAdmin.from('users').insert({
      id: authUser.id,
      email: authUser.email,
      name: authUser.user_metadata?.name || authUser.email?.split('@')[0],
      role,
      subscription,
      created_at: authUser.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (insertError) {
      logger.error(`[CONFIRM_USER] Failed to insert public.users`, { error: insertError.message });
      throw insertError;
    }
    logger.info(`[CONFIRM_USER] ✅ Inserted public.users row`);
  } else {
    logger.info(`[CONFIRM_USER] ✅ Synced public.users (role=${role}, plan=${plan})`);
  }

  // Step 3: credits — only seed if balance is empty, never overwrite existing.
  await UserCreditsService.getOrCreateUserCredits(authUser.id);
  const credits = await UserCreditsService.getUserCredits(authUser.id);
  if (credits && credits.credits_balance === 0) {
    await UserCreditsService.addCredits(
      authUser.id,
      ENTERPRISE_CREDITS,
      'bonus',
      'Initial enterprise credits (manual confirm)',
      {}
    );
    logger.info(`[CONFIRM_USER] ✅ Seeded ${ENTERPRISE_CREDITS} credits`);
  } else {
    logger.info(`[CONFIRM_USER] Credits balance non-zero — left untouched`, {
      balance: credits?.credits_balance,
    });
  }

  await UserCreditsService.updateSubscription(authUser.id, plan, 'active', null);

  // Step 4: workspace.
  await WorkspaceService.checkOrCreateWorkspace(authUser.id);

  logger.info(`[CONFIRM_USER] ✅ Done — ${email} can now log in with their signup password`);
}

confirmUser()
  .then(() => process.exit(0))
  .catch(error => {
    logger.error('[CONFIRM_USER] Script failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
