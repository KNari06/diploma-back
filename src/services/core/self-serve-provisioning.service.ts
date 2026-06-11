import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';
import { WorkspaceService } from '@/services/core/workspace.service';
import { ProjectService } from '@/services/core/project.service';
import { ProjectContextService } from '@/services/utils/project-context.service';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import {
  approvePendingUser,
  fetchUserStatus,
  markWorkspaceOnboardingCompleted,
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

      const workspaceId = await this.ensureWorkspace(userId);
      if (workspaceId) {
        await this.ensureDefaultProject(userId, workspaceId);
      }

      // Trial credits + plan: a self-serve user must see a usable balance the
      // moment they land, not lazily on their first paid action (otherwise
      // /auth/me reports 0 and the exploration credit-gate would reject them).
      await this.ensureTrialCreditsAndPlan(userId);
    } catch (error) {
      // Best-effort: log and swallow. The next auth call retries. `approved`
      // keeps whatever the approval step returned before the failure.
      logger.warn('[SELF_SERVE] Provisioning failed (non-critical)', {
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
    const updated = await approvePendingUser(userId);
    if (updated > 0) {
      logger.info('[SELF_SERVE] User auto-approved', { userId });
      return true;
    }
    // 0 rows updated → either already approved or rejected. Re-read to tell
    // them apart so we never report a rejected user as approved.
    const status = await fetchUserStatus(userId);
    return status === 'approved';
  }

  /**
   * Ensure the user has a workspace. checkOrCreateWorkspace is idempotent —
   * it resolves an existing active workspace or creates one. We also mark
   * onboarding as completed on a freshly created workspace so ProtectedRoute
   * sends the user to /home instead of the wizard.
   */
  private static async ensureWorkspace(userId: string): Promise<string | null> {
    const { workspace_id, is_new } = await WorkspaceService.checkOrCreateWorkspace(userId);

    if (is_new && workspace_id) {
      await markWorkspaceOnboardingCompleted(workspace_id);
    }

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
