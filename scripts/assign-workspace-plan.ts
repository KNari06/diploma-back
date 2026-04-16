/**
 * Assign a B2B plan to a workspace by user email.
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
import { WorkspaceCreditsService } from '../src/services/core/workspace-credits.service';
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

  // 2. Find workspace for user
  const { data: workspace, error: wsError } = await supabaseAdmin
    .from('workspaces')
    .select('id, name')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (wsError || !workspace) {
    logger.error('[ASSIGN_PLAN] Workspace not found', { userId: user.id, error: wsError?.message });
    throw new Error(`No workspace found for user ${EMAIL}`);
  }

  logger.info('[ASSIGN_PLAN] Found workspace', { workspaceId: workspace.id, name: workspace.name });

  // 3. Get current credits state
  const before = await WorkspaceCreditsService.getOrCreateWorkspaceCredits(workspace.id);
  logger.info('[ASSIGN_PLAN] Current state', {
    balance: before.credits_balance,
    plan: before.subscription_plan,
    graceLimit: before.grace_limit,
  });

  // 4. Assign plan
  let result;
  if (PLAN === 'pilot') {
    result = await WorkspaceCreditsService.assignPilot(workspace.id);
  } else {
    result = await WorkspaceCreditsService.upgradeToPlan(workspace.id, PLAN);
  }

  if (!result) {
    throw new Error('Failed to assign plan');
  }

  // 5. Verify
  logger.info('[ASSIGN_PLAN] ✅ Plan assigned!', {
    email: EMAIL,
    workspace: workspace.name,
    plan: PLAN,
    newBalance: result.credits_balance,
    graceLimit: result.grace_limit,
    status: result.subscription_status,
  });

  // Also add credits to user_credits so the user isn't blocked by the free-user overlay
  const { UserCreditsService } = await import('../src/services/core/user-credits.service');
  const userCredits = await UserCreditsService.getOrCreateUserCredits(user.id);
  if (userCredits.credits_balance <= 0) {
    await UserCreditsService.addCredits(user.id, 100, 'bonus', `B2B plan (${PLAN}) — user credit top-up`);
    logger.info('[ASSIGN_PLAN] Also topped up user_credits to avoid free-user block');
  }

  console.log('\n✅ Done!');
  console.log(`   Email:     ${EMAIL}`);
  console.log(`   Workspace: ${workspace.name}`);
  console.log(`   Plan:      ${PLAN}`);
  console.log(`   Balance:   ${result.credits_balance} credits`);
  console.log(`   Grace:     ${result.grace_limit} credits`);
}

assignPlan()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
