import { logger } from '@/utils/core/logger';
import { PlanService } from '@/services/core/plan.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { writeUserBusinessPlanMirror } from '@/services/core/db/plan.db';
import { WORKSPACE_PLANS } from '@/services/core/token-calculator.service';

/**
 * Admin-driven plan grant — the single entry point the admin panel uses to set a
 * user's plan, so ALL plan state stays consistent (unlike the old admin path
 * that wrote `user_credits` directly and left `users.plan` stale).
 *
 * Two shapes:
 *  - Individual plans ('free' | 'pro') → PlanService.setUserPlan (the funnel
 *    that keeps users.{plan_id,plan,plan_status} + user_credits in sync).
 *  - B2B tiers ('pilot' | 'small_business' | 'middle_business' | 'enterprise')
 *    → UserCreditsService.grantBusinessPlan (credits/grace/price) + a users
 *    mirror write (plan text/status) so the row stops drifting. B2B tiers have
 *    no pricing_plans row, so plan_id stays null and the paid-gate passes via
 *    the secondary user_credits check (userHasPaidBusinessPlan).
 *
 * Credits and price are optional overrides — omitted values fall back to the
 * tier preset (WORKSPACE_PLANS), which lets an admin apply a discount while
 * still recording the real charged price to credit_transactions.cost_usd.
 */

export const INDIVIDUAL_GRANT_SLUGS = ['free', 'pro'] as const;
export type IndividualGrantSlug = (typeof INDIVIDUAL_GRANT_SLUGS)[number];

export const B2B_GRANT_SLUGS = [
  'pilot',
  'small_business',
  'middle_business',
  'enterprise',
] as const;
export type B2bGrantSlug = (typeof B2B_GRANT_SLUGS)[number];

export type AdminGrantSlug = IndividualGrantSlug | B2bGrantSlug;

export function isB2bGrantSlug(slug: string): slug is B2bGrantSlug {
  return (B2B_GRANT_SLUGS as readonly string[]).includes(slug);
}

export function isIndividualGrantSlug(slug: string): slug is IndividualGrantSlug {
  return (INDIVIDUAL_GRANT_SLUGS as readonly string[]).includes(slug);
}

export function isAdminGrantSlug(slug: string): slug is AdminGrantSlug {
  return isB2bGrantSlug(slug) || isIndividualGrantSlug(slug);
}

/** The full set of assignable slugs, for validation error messages. */
export const ALL_ADMIN_GRANT_SLUGS: readonly AdminGrantSlug[] = [
  ...INDIVIDUAL_GRANT_SLUGS,
  ...B2B_GRANT_SLUGS,
];

export interface AdminGrantParams {
  userId: string;
  planSlug: AdminGrantSlug;
  /** Override the tier's preset credit allotment (B2B only). */
  creditsOverride?: number;
  /** Real price charged, USD — recorded for reporting (B2B only). */
  priceUsd?: number;
  /** Admin's user id, for the audit trail. */
  grantedByAdminId: string;
}

export interface AdminGrantResult {
  success: boolean;
  planSlug: AdminGrantSlug;
  /** Credits granted (B2B) or null for individual plans (funnel-managed). */
  creditsGranted: number | null;
  /** Price recorded (B2B), or null. */
  priceUsd: number | null;
  error?: string;
}

export class AdminPlanGrantService {
  /**
   * Preset credits + price for a tier (before any admin override). B2B tiers
   * read WORKSPACE_PLANS; individual plans are funnel-managed (credits come from
   * the pricing config, not this endpoint), so they return null presets.
   */
  static presetFor(planSlug: AdminGrantSlug): { credits: number; graceLimit: number; price: number } | null {
    if (isB2bGrantSlug(planSlug)) {
      const cfg = WORKSPACE_PLANS[planSlug];
      return { credits: cfg.credits, graceLimit: cfg.graceLimit, price: cfg.price };
    }
    return null;
  }

  static async grant(params: AdminGrantParams): Promise<AdminGrantResult> {
    const { userId, planSlug, creditsOverride, priceUsd, grantedByAdminId } = params;

    if (!isAdminGrantSlug(planSlug)) {
      return {
        success: false,
        planSlug,
        creditsGranted: null,
        priceUsd: null,
        error: `Invalid plan slug. Must be one of: ${ALL_ADMIN_GRANT_SLUGS.join(', ')}`,
      };
    }

    // Ensure a user_credits row exists BEFORE any grant. PlanService.setUserPlan
    // mirrors the plan onto user_credits via an UPDATE (not upsert) — for a user
    // who has never materialized a credits row (e.g. freshly created, never hit
    // the credits endpoint) that UPDATE touches 0 rows and the credit-side plan
    // silently stays null, so the paid-gate (which reads user_credits) would not
    // see the grant. grantBusinessPlan already getOrCreates, but the individual
    // path does not — guarantee it here so admin grants are always consistent.
    await UserCreditsService.getOrCreateUserCredits(userId);

    // Individual plans → the funnel. Credits/price overrides don't apply here
    // (individual credit amounts are owned by the pricing config, not admin).
    // skipDowngradeGuard: an admin selecting "Free" is an EXPLICIT downgrade and
    // must actually take effect — without this, setUserPlan's guard (which exists
    // to stop self-serve re-login from clobbering a paid plan) would no-op a
    // pro→free admin change yet still return success, silently ignoring the admin.
    if (isIndividualGrantSlug(planSlug)) {
      const ok = await PlanService.setUserPlan(userId, planSlug, {
        source: 'admin-grant',
        resetUsageCounters: true,
        skipDowngradeGuard: true,
      });
      return {
        success: ok,
        planSlug,
        creditsGranted: null,
        priceUsd: null,
        error: ok ? undefined : 'Failed to set individual plan',
      };
    }

    // B2B tier → grant credits/grace/price, then mirror the plan onto users.
    const preset = WORKSPACE_PLANS[planSlug];
    const credits =
      typeof creditsOverride === 'number' && Number.isFinite(creditsOverride) && creditsOverride >= 0
        ? creditsOverride
        : preset.credits;
    const price =
      typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd >= 0
        ? priceUsd
        : preset.price;

    const grant = await UserCreditsService.grantBusinessPlan(
      userId,
      planSlug,
      credits,
      preset.graceLimit,
      // Admin grant SETS the balance to the granted amount (a fresh allotment),
      // not add-on-top — 'renew' mirrors that semantics.
      'renew',
      `Admin ${planSlug} grant`,
      {
        source: 'admin-plan-grant',
        admin_granted_by: grantedByAdminId,
        custom_credits: credits !== preset.credits,
        custom_price: price !== preset.price,
      },
      price,
    );

    if (!grant.success) {
      return {
        success: false,
        planSlug,
        creditsGranted: null,
        priceUsd: null,
        error: 'Failed to grant B2B plan credits',
      };
    }

    // Keep users.{plan,plan_status} in sync with the credit-side B2B tier so the
    // admin list / product don't show a stale plan (the pilot split-brain).
    const mirrored = await writeUserBusinessPlanMirror({
      userId,
      planSlug,
      resetUsageCounters: true,
    });
    if (!mirrored) {
      // Credits were granted; the users mirror failed. Surface it but don't
      // pretend the whole grant failed — the paid-gate still passes via
      // user_credits. Log loudly so it can be reconciled.
      logger.error('[ADMIN_PLAN_GRANT] Credits granted but users mirror write failed', {
        userId: userId.substring(0, 8) + '...',
        planSlug,
      });
    }

    return {
      success: true,
      planSlug,
      creditsGranted: credits,
      priceUsd: price,
    };
  }
}
