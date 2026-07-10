import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';
import { EmailService } from '@/services/core/email.service';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ProjectService } from '@/services/core/project.service';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { cache } from '@/utils/core/redis-cache';
import {
  approvePendingUser,
  fetchUserStatus,
  userHasAnyWorkspace,
} from '@/services/core/db/self-serve.db';

/**
 * Self-serve PLG provisioning.
 *
 * Called on the user's first successful authentication (email verification
 * or OAuth completion). Gated entirely behind AUTO_APPROVE_SIGNUP — when the
 * flag is off this is a no-op and the B2B onboarding/approval flow is intact.
 *
 * Idempotent and best-effort: a partial failure must never break the auth
 * response. The user still gets their session; provisioning retries on the
 * next auth call (every collaborator here is idempotent).
 */
export class SelfServeProvisioningService {
  private static readonly DEFAULT_PROJECT_NAME = 'My Project';

  /**
   * Provision a self-serve user: approve them and ensure they have a
   * workspace + default project, so they land straight on /home and can
   * run their first test without the onboarding wizard.
   *
   * No-op when AUTO_APPROVE_SIGNUP is false. Never throws. Returns true when
   * the caller may safely report the user as approved (approval write
   * succeeded, or they were already approved); false on any failure or when
   * the flag is off — so the auth response reflects real DB state rather than
   * optimistically claiming approval after a silent provisioning failure.
   */
  static async provision(userId: string): Promise<boolean> {
    if (!env.AUTO_APPROVE_SIGNUP) return false;
    if (!userId) return false;

    let approved = false;
    try {
      approved = await this.approveUser(userId);
      // Don't provision a workspace/project for a user who is not approved
      // (e.g. a manually 'rejected' account hitting auth again).
      if (!approved) return false;
    } catch (error) {
      // Best-effort: log and swallow. The next auth call retries. `approved`
      // keeps whatever the approval step returned before the failure.
      logger.warn('[SELF_SERVE] Approval failed (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      return approved;
    }

    // Trial credits + plan come FIRST and in their own guard. An approved user
    // lands on /home immediately; if the workspace/project steps below throw,
    // the credit grant must already have happened — otherwise the user is
    // approved with a 0 balance and the frontend walls them with a bogus
    // "trial exhausted" screen despite never spending anything. Credits don't
    // depend on a workspace, so there's no ordering reason to grant them last.
    try {
      await this.ensureTrialCreditsAndPlan(userId);
    } catch (error) {
      logger.warn('[SELF_SERVE] Trial credit provisioning failed (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }

    // Workspace + project provisioning, separately guarded so a failure here
    // cannot roll back or skip the credit grant above.
    try {
      const workspaceId = await this.ensureWorkspace(userId);
      if (workspaceId) {
        await this.ensureDefaultProject(userId, workspaceId);
      }
    } catch (error) {
      logger.warn('[SELF_SERVE] Workspace/project provisioning failed (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }

    return approved;
  }

  /**
   * Approve a freshly-signed-up user, overriding the users.status column
   * default of 'pending_approval'. Scoped to pending rows only (in the db
   * layer) so a manual 'rejected' decision is never reversed. Returns true
   * when the user is approved afterwards — either we just flipped a pending
   * row, or it was already approved (0 rows updated, but not rejected).
   */
  private static async approveUser(userId: string): Promise<boolean> {
    const approvedRow = await approvePendingUser(userId);
    if (approvedRow) {
      logger.info('[SELF_SERVE] User auto-approved', { userId });
      // Send the "You're in!" email exactly once, on the pending→approved
      // transition. Fire-and-forget: a mail failure must never break auth or
      // provisioning. The admin PATCH path is the OTHER place this email is
      // sent — auto-approved users would otherwise never receive it.
      if (approvedRow.email) {
        void EmailService.sendApprovalEmail({
          recipientEmail: approvedRow.email,
          recipientName: approvedRow.name || undefined,
          frontendUrl: env.FRONTEND_URL,
        }).then((result) => {
          if (!result.success) {
            logger.error('[SELF_SERVE] Approval email not sent', {
              userId,
              email: approvedRow.email,
              error: result.error,
            });
          }
        }).catch((err) =>
          logger.error('[SELF_SERVE] Approval email threw', {
            userId,
            email: approvedRow.email,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
      return true;
    }
    // No row updated → either already approved or rejected. Re-read to tell
    // them apart so we never report a rejected user as approved.
    const status = await fetchUserStatus(userId);
    return status === 'approved';
  }

  /**
   * Ensure the user has a workspace. checkOrCreateWorkspace is idempotent —
   * it resolves an existing active workspace or creates one.
   *
   * We deliberately do NOT mark onboarding as completed here: self-serve users
   * are approved immediately, but must still pass the onboarding wizard (pick
   * web/mobile, enter a URL, etc.) before landing on /home. The wizard sets
   * onboarding_completed via saveOnboarding when the user finishes it. Marking
   * it done here would skip the wizard entirely.
   */
  private static async ensureWorkspace(userId: string): Promise<string | null> {
    const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);
    return workspace_id;
  }

  /**
   * Ensure the user has at least one project in the workspace. Exploration
   * and test runs both require a projectId, so a self-serve user needs one
   * before they can do anything useful.
   */
  private static async ensureDefaultProject(userId: string, workspaceId: string): Promise<void> {
    const existing = await ProjectContextService.getDefaultProject(workspaceId, userId);
    if (existing) return;

    await ProjectService.createProject(userId, {
      name: this.DEFAULT_PROJECT_NAME,
      workspace_id: workspaceId,
    });
    logger.info('[SELF_SERVE] Default project created', { userId, workspaceId });
  }

  /** Redis key marking a user as recently self-heal-checked (skip the DB probe). */
  private static healCheckedKey(userId: string): string {
    return `qait:selfheal:checked:${userId}`;
  }
  /** How long a "checked, has workspace" verdict stays cached. */
  private static readonly HEAL_CHECK_TTL_SECONDS = 6 * 60 * 60; // 6h

  /**
   * Last-resort safety net, called from GET /auth/me (which the frontend hits
   * on every load). Guarantees an APPROVED user is never left without a
   * workspace — no matter HOW they became approved or which auth endpoint they
   * came through (repeat OAuth login, direct Supabase session, legacy account,
   * or a flag that was off at signup time).
   *
   * Cheap by design: a Redis flag short-circuits the common case (already
   * healthy) so we hit the DB at most once per HEAL_CHECK_TTL per user. Only
   * runs the (idempotent) full provisioning when the user is approved AND has
   * no workspace. Never throws — a self-heal failure must not break /auth/me.
   *
   * Independent of AUTO_APPROVE_SIGNUP: this heals users who are ALREADY
   * approved; it never approves anyone (that's provision()'s job at signup).
   */
  static async selfHealIfApproved(userId: string, status?: string | null): Promise<void> {
    if (!userId) return;
    try {
      // Fast path: we verified this user has a workspace recently.
      if (await cache.get<boolean>(this.healCheckedKey(userId))) return;

      // Only heal approved users. If status wasn't passed in, read it once.
      const effectiveStatus = status ?? (await fetchUserStatus(userId));
      if (effectiveStatus !== 'approved') return;

      if (await userHasAnyWorkspace(userId)) {
        // Healthy — cache the verdict so we skip the probe for a while.
        await cache.set(this.healCheckedKey(userId), true, this.HEAL_CHECK_TTL_SECONDS);
        return;
      }

      logger.warn('[SELF_SERVE] Approved user without workspace — self-healing', { userId });
      await this.ensureFullyProvisioned(userId);
      await cache.set(this.healCheckedKey(userId), true, this.HEAL_CHECK_TTL_SECONDS);
    } catch (error) {
      logger.warn('[SELF_SERVE] selfHealIfApproved failed (non-critical)', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }
  }

  /**
   * Ensure an ALREADY-APPROVED user has everything needed to use the app:
   * free plan + welcome credits + workspace + default project. Unlike
   * `provision()` this does NOT gate on AUTO_APPROVE_SIGNUP and does NOT run
   * the approval step — the caller has already established the user is approved
   * (admin PATCH, or a backfill of legacy users). Every step is idempotent and
   * independently guarded, mirroring provision()'s ordering (credits before
   * workspace) so a partial failure still leaves the user usable.
   *
   * This is the shared "make the user whole" routine. Use it anywhere a user
   * becomes approved OUTSIDE the self-serve auth flow, so they never land on
   * an infinite loading shimmer (empty workspace list → null currentWorkspace).
   */
  static async ensureFullyProvisioned(userId: string): Promise<void> {
    if (!userId) return;

    try {
      await this.ensureTrialCreditsAndPlan(userId);
    } catch (error) {
      logger.warn('[SELF_SERVE] ensureFullyProvisioned: credits/plan failed', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }

    try {
      const workspaceId = await this.ensureWorkspace(userId);
      if (workspaceId) {
        await this.ensureDefaultProject(userId, workspaceId);
      }
    } catch (error) {
      logger.warn('[SELF_SERVE] ensureFullyProvisioned: workspace/project failed', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }

    logger.info('[SELF_SERVE] User fully provisioned (out-of-band)', { userId });
  }

  /**
   * Assign the free plan and materialise the user_credits row so the 50-credit
   * welcome bonus is granted up-front. Both steps are idempotent:
   *   - assignPlanToUser is a plain update to users.plan_id
   *   - getOrCreateUserCredits only grants the bonus once (free/null plan AND
   *     balance 0); on a returning user the row exists and it's a no-op
   * Plan is assigned BEFORE credits so the bonus check sees a 'free' plan.
   */
  private static async ensureTrialCreditsAndPlan(userId: string): Promise<void> {
    await PricingPlansService.assignPlanToUser(userId, 'free');
    await UserCreditsService.getOrCreateUserCredits(userId);
    logger.info('[SELF_SERVE] Trial plan + credits ensured', { userId });
  }
}
