/**
 * Assign a B2B plan to a user by email.
 *
 * Credits belong to the USER account only — this grants the plan's full credit
 * allotment + grace to the user's `user_credits` (same path as the Stripe B2B
 * webhook via UserCreditsService.grantBusinessPlan), NOT a workspace pool.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/assign-workspace-plan.ts <email> <plan>
 *
 * Plans: pilot | small_business | middle_business | enterprise
 *
 * Examples:
 *   npx ts-node -r tsconfig-paths/register scripts/assign-workspace-plan.ts client@company.com pilot
 *   npx ts-node -r tsconfig-paths/register scripts/assign-workspace-plan.ts client@company.com small_business
 */

import { supabaseAdmin } from '../src/db/supabase';
import { UserCreditsService } from '../src/services/core/user-credits.service';
import { WORKSPACE_PLANS } from '../src/services/core/token-calculator.service';
import { logger } from '../src/utils/core/logger';

const EMAIL = process.argv[2];
const PLAN = process.argv[3] as 'pilot' | 'small_business' | 'middle_business' | 'enterprise';

const VALID_PLANS = ['pilot', 'small_business', 'middle_business', 'enterprise'] as const;

async function assignPlan(): Promise<void> {
  if (!EMAIL || !PLAN) {
    console.log('Usage: npx ts-node -r tsconfig-paths/register scripts/assign-workspace-plan.ts <email> <plan>');
    console.log('Plans: pilot | small_business | middle_business | enterprise');
    process.exit(1);
  }

  if (!VALID_PLANS.includes(PLAN as any)) {
    console.error(`Invalid plan: ${PLAN}. Must be one of: ${VALID_PLANS.join(', ')}`);
    process.exit(1);
  }

  logger.info('[ASSIGN_PLAN] Starting...', { email: EMAIL, plan: PLAN });

  // 1. Find user by email
  const { data: user, error: userError } = await supabaseAdmin
    .from('users')
    .select('id, email')
    .eq('email', EMAIL)
    .single();

  if (userError || !user) {
    logger.error('[ASSIGN_PLAN] User not found', { email: EMAIL, error: userError?.message });
    throw new Error(`User ${EMAIL} not found`);
  }

  logger.info('[ASSIGN_PLAN] Found user', { userId: user.id, email: user.email });

  // 2. Current credit state
  const before = await UserCreditsService.getOrCreateUserCredits(user.id);
  logger.info('[ASSIGN_PLAN] Current state', {
    balance: before.credits_balance,
    plan: before.subscription_plan,
    graceLimit: before.grace_limit,
  });

  // 3. Grant the plan's full allotment + grace to the USER account (upgrade =
  //    ADD, same as a first B2B Stripe charge). Credits belong to the user.
  const planConfig = WORKSPACE_PLANS[PLAN];
  const result = await UserCreditsService.grantBusinessPlan(
    user.id,
    PLAN,
    planConfig.credits,
    planConfig.graceLimit,
    'upgrade',
    `B2B plan (${PLAN}) assigned via ops script`,
    { source: 'assign-workspace-plan.ts' }
  );

  if (!result.success) {
    throw new Error('Failed to assign plan');
  }

  logger.info('[ASSIGN_PLAN] ✅ Plan assigned!', {
    email: EMAIL,
    plan: PLAN,
    newBalance: result.newBalance,
    graceLimit: planConfig.graceLimit,
  });

  console.log('\n✅ Done!');
  console.log(`   Email:     ${EMAIL}`);
  console.log(`   Plan:      ${PLAN}`);
  console.log(`   Balance:   ${result.newBalance} credits`);
  console.log(`   Grace:     ${planConfig.graceLimit} credits`);
}

assignPlan()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
