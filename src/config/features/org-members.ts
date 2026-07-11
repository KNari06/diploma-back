import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

/**
 * Feature flags for B2B organization/members functionality
 *
 * Staged rollout:
 * 1. FEATURE_ORG_MEMBERS_ENABLED=true - enables membership-based access
 * 2. FEATURE_ORG_CREDITS_ENABLED - legacy/no-op. Credits belong to the user
 *    account only; there is no workspace-level credits pool in the run path.
 *
 * Both default to true, set to 'false' in env to disable during rollback.
 */
export const OrgMembersFeature = {
  /**
   * Check if org members feature is enabled
   * When enabled, access checks use workspace_members table instead of workspaces.user_id
   */
  isEnabled(): boolean {
    return env.FEATURE_ORG_MEMBERS_ENABLED;
  },

  /**
   * Legacy org-credits flag. Credits belong to the USER account only —
   * requireCredits and every run path deduct from `user_credits`, never a
   * workspace pool. This flag no longer gates any credit behavior; kept only to
   * avoid an env-schema change and surfaced in the status log below.
   */
  isOrgCreditsEnabled(): boolean {
    return env.FEATURE_ORG_CREDITS_ENABLED;
  },

  /**
   * Log feature status on startup
   */
  logStatus(): void {
    logger.info('[FEATURE] B2B Organization Members feature status', {
      orgMembersEnabled: this.isEnabled(),
      orgCreditsEnabled: this.isOrgCreditsEnabled(),
    });
  },

  /**
   * Monitoring: log access check result
   */
  logAccessCheck(params: {
    userId: string;
    workspaceId: string;
    action: string;
    allowed: boolean;
    role?: string | null;
    source: 'membership' | 'legacy_owner';
  }): void {
    logger.debug('[ORG_ACCESS] Access check', {
      ...params,
      featureEnabled: this.isEnabled(),
    });
  },

  /**
   * Monitoring: log credit check result
   */
  logCreditCheck(params: {
    userId: string;
    workspaceId?: string;
    creditSource: 'workspace' | 'user';
    balance: number;
    required: number;
    allowed: boolean;
  }): void {
    logger.debug('[ORG_CREDITS] Credit check', {
      ...params,
      featureEnabled: this.isOrgCreditsEnabled(),
    });
  },
};

// Log status on module load
OrgMembersFeature.logStatus();
