import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { WorkspaceAuditService, AUDIT_EVENTS } from './workspace-audit.service';

// ============================================================================
// WORKSPACE CREDITS INTERFACE
// ============================================================================

export interface WorkspaceCredits {
  id: string;
  workspace_id: string;
  credits_balance: number;
  total_purchased: number;
  total_used: number;
  subscription_plan: 'free' | 'basic' | 'pro' | 'enterprise' | 'business';
  subscription_status: 'active' | 'inactive' | 'expired';
  subscription_expires_at: string | null;
  last_credit_usage: string | null;
  credits_purchased_at: string | null;
  monthly_credit_limit: number | null;
  credits_used_this_period: number;
  period_start_date: string | null;
  warning_80_sent: boolean;
  warning_95_sent: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceCreditTransaction {
  id: string;
  workspace_id: string;
  user_id: string | null;
  amount: number;
  balance_after: number;
  transaction_type: 'purchase' | 'usage' | 'refund' | 'bonus' | 'migration';
  description: string;
  metadata: Record<string, any>;
  tokens_used: number | null;
  cost_usd: number | null;
  credits_calculated: number | null;
  test_type: string | null;
  created_at: string;
}

// ============================================================================
// WORKSPACE CREDITS SERVICE
// ============================================================================

export class WorkspaceCreditsService {
  /**
   * Get workspace credits info
   */
  static async getWorkspaceCredits(workspaceId: string): Promise<WorkspaceCredits | null> {
    try {
      if (!workspaceId || typeof workspaceId !== 'string') {
        logger.warn('[WORKSPACE_CREDITS] Invalid workspaceId in getWorkspaceCredits', { workspaceId });
        return null;
      }

      const { data, error } = await supabaseAdmin
        .from('workspace_credits')
        .select('*')
        .eq('workspace_id', workspaceId)
        .maybeSingle();

      if (error) {
        logger.error('[WORKSPACE_CREDITS] Error getting workspace credits', {
          error: error.message,
          code: error.code,
          workspaceId,
        });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Exception in getWorkspaceCredits', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return null;
    }
  }

  /**
   * Get or create workspace credits record
   */
  static async getOrCreateWorkspaceCredits(workspaceId: string): Promise<WorkspaceCredits> {
    if (!workspaceId || typeof workspaceId !== 'string') {
      logger.error('[WORKSPACE_CREDITS] Invalid workspaceId in getOrCreateWorkspaceCredits', {
        workspaceId,
      });
      throw new Error('Invalid workspaceId');
    }

    const existingCredits = await this.getWorkspaceCredits(workspaceId);

    if (existingCredits) {
      return existingCredits;
    }

    // Create new credits record with 0 balance
    const { data, error } = await supabaseAdmin
      .from('workspace_credits')
      .upsert(
        {
          workspace_id: workspaceId,
          credits_balance: 0,
          subscription_plan: 'free',
          subscription_status: 'inactive',
        },
        {
          onConflict: 'workspace_id',
        }
      )
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[WORKSPACE_CREDITS] Error creating workspace credits', {
        error: error.message,
        code: error.code,
        workspaceId,
      });
      throw new Error('Failed to create workspace credits');
    }

    if (!data) {
      // Try to fetch again in case of race condition
      const retryCredits = await this.getWorkspaceCredits(workspaceId);
      if (retryCredits) {
        return retryCredits;
      }
      throw new Error('Failed to create workspace credits: no data returned');
    }

    logger.info('[WORKSPACE_CREDITS] Created workspace credits', {
      workspaceId,
      balance: data.credits_balance,
    });

    return data;
  }

  /**
   * Check if workspace has enough credits
   */
  static async hasCredits(workspaceId: string, requiredCredits: number): Promise<boolean> {
    try {
      const credits = await this.getWorkspaceCredits(workspaceId);

      if (!credits) {
        return false;
      }

      const balance = Number.isFinite(credits.credits_balance) ? credits.credits_balance : 0;
      return balance >= requiredCredits;
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Error checking credits', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        requiredCredits,
      });
      return false;
    }
  }

  /**
   * Get current balance
   */
  static async getBalance(workspaceId: string): Promise<number> {
    try {
      const credits = await this.getWorkspaceCredits(workspaceId);

      if (!credits) {
        return 0;
      }

      return Number.isFinite(credits.credits_balance) ? credits.credits_balance : 0;
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Error getting balance', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return 0;
    }
  }

  /**
   * Deduct credits from workspace
   * @param workspaceId - Workspace ID
   * @param amount - Amount to deduct (positive number)
   * @param description - Description of the usage
   * @param userId - User who triggered the usage (optional, for audit)
   * @param metadata - Additional metadata
   * @returns Updated credits or null if failed
   */
  static async deductCredits(
    workspaceId: string,
    amount: number,
    description: string,
    userId?: string,
    metadata?: Record<string, any>
  ): Promise<WorkspaceCredits | null> {
    try {
      if (amount <= 0) {
        logger.warn('[WORKSPACE_CREDITS] Invalid deduction amount', { workspaceId, amount });
        return null;
      }

      // Get current credits
      const credits = await this.getOrCreateWorkspaceCredits(workspaceId);
      const currentBalance = Number.isFinite(credits.credits_balance) ? credits.credits_balance : 0;

      if (currentBalance < amount) {
        logger.warn('[WORKSPACE_CREDITS] Insufficient credits for deduction', {
          workspaceId,
          currentBalance,
          requiredAmount: amount,
        });
        return null;
      }

      // Check monthly credit limit (Business plan cap)
      const monthlyLimit = credits.monthly_credit_limit;
      const usedThisPeriod = credits.credits_used_this_period || 0;

      if (monthlyLimit != null && usedThisPeriod + amount > monthlyLimit) {
        logger.warn('[WORKSPACE_CREDITS] Monthly credit limit exceeded', {
          workspaceId,
          monthlyLimit,
          usedThisPeriod,
          requestedAmount: amount,
        });
        return null;
      }

      const newBalance = currentBalance - amount;
      const newTotalUsed = (credits.total_used || 0) + amount;
      const newUsedThisPeriod = usedThisPeriod + amount;

      // Update credits (including period usage tracking)
      const { data: updatedCredits, error: updateError } = await supabaseAdmin
        .from('workspace_credits')
        .update({
          credits_balance: newBalance,
          total_used: newTotalUsed,
          credits_used_this_period: newUsedThisPeriod,
          last_credit_usage: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId)
        .select()
        .single();

      if (updateError) {
        logger.error('[WORKSPACE_CREDITS] Error deducting credits', {
          error: updateError.message,
          workspaceId,
          amount,
        });
        return null;
      }

      // Record transaction
      const { error: txError } = await supabaseAdmin.from('workspace_credit_transactions').insert({
        workspace_id: workspaceId,
        user_id: userId || null,
        amount: -amount,
        balance_after: newBalance,
        transaction_type: 'usage',
        description,
        metadata: metadata || {},
        test_type: metadata?.test_type || null,
        tokens_used: metadata?.tokens_used || null,
        cost_usd: metadata?.cost_usd || null,
        credits_calculated: amount,
      });

      if (txError) {
        logger.error('[WORKSPACE_CREDITS] Error recording credit transaction', {
          error: txError.message,
          workspaceId,
        });
        // Don't fail the operation if transaction recording fails
      }

      // Log audit event
      if (userId) {
        await WorkspaceAuditService.logCreditsUsed({
          workspaceId,
          userId,
          amount,
          balanceAfter: newBalance,
          description,
          testType: metadata?.test_type,
        });
      }

      logger.info('[WORKSPACE_CREDITS] Credits deducted', {
        workspaceId,
        amount,
        previousBalance: currentBalance,
        newBalance,
        usedThisPeriod: newUsedThisPeriod,
        userId,
      });

      // Check usage thresholds and send notifications (fire-and-forget)
      if (monthlyLimit != null && monthlyLimit > 0) {
        this.checkUsageThresholds(workspaceId, newUsedThisPeriod, monthlyLimit, credits).catch(
          (err) => {
            logger.error('[WORKSPACE_CREDITS] Error checking usage thresholds', {
              error: err instanceof Error ? err.message : String(err),
              workspaceId,
            });
          }
        );
      }

      return updatedCredits;
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Exception deducting credits', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        amount,
      });
      return null;
    }
  }

  /**
   * Check usage thresholds and send warning notifications to workspace owner
   */
  private static async checkUsageThresholds(
    workspaceId: string,
    usedThisPeriod: number,
    monthlyLimit: number,
    credits: WorkspaceCredits
  ): Promise<void> {
    const usagePercent = usedThisPeriod / monthlyLimit;

    // 95% threshold (28,500 of 30,000)
    if (usagePercent >= 0.95 && !credits.warning_95_sent) {
      await supabaseAdmin
        .from('workspace_credits')
        .update({ warning_95_sent: true, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);

      await this.sendUsageWarning(workspaceId, 95, usedThisPeriod, monthlyLimit);
    }
    // 80% threshold (24,000 of 30,000)
    else if (usagePercent >= 0.8 && !credits.warning_80_sent) {
      await supabaseAdmin
        .from('workspace_credits')
        .update({ warning_80_sent: true, updated_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId);

      await this.sendUsageWarning(workspaceId, 80, usedThisPeriod, monthlyLimit);
    }
  }

  /**
   * Send a usage warning notification to the workspace owner
   */
  private static async sendUsageWarning(
    workspaceId: string,
    thresholdPercent: number,
    used: number,
    limit: number
  ): Promise<void> {
    try {
      const { WorkspaceAccessService } = await import('./workspace-access.service');
      const { NotificationService } = await import('../notifications/notification.service');

      const owner = await WorkspaceAccessService.getOwner(workspaceId);
      if (!owner) {
        logger.warn('[WORKSPACE_CREDITS] No owner found for usage warning', { workspaceId });
        return;
      }

      const remaining = Math.max(0, limit - used);
      const title =
        thresholdPercent >= 95
          ? 'Credit usage critical'
          : 'Credit usage warning';
      const message =
        thresholdPercent >= 95
          ? `Your workspace has used ${thresholdPercent}% of its monthly credits (${Math.round(used).toLocaleString()} / ${limit.toLocaleString()}). Only ${Math.round(remaining).toLocaleString()} credits remaining.`
          : `Your workspace has used ${thresholdPercent}% of its monthly credits (${Math.round(used).toLocaleString()} / ${limit.toLocaleString()}). ${Math.round(remaining).toLocaleString()} credits remaining.`;

      await NotificationService.createNotification({
        userId: owner.user_id,
        type: 'personal',
        category: 'billing',
        title,
        message,
        metadata: {
          workspaceId,
          thresholdPercent,
          creditsUsed: used,
          creditsLimit: limit,
          creditsRemaining: remaining,
          dedupeKey: `workspace-credits:${workspaceId}:warning-${thresholdPercent}`,
        },
      });

      logger.info('[WORKSPACE_CREDITS] Usage warning sent', {
        workspaceId,
        ownerId: owner.user_id,
        thresholdPercent,
        used,
        limit,
      });
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Error sending usage warning', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        thresholdPercent,
      });
    }
  }

  /**
   * Add credits to workspace
   * @param workspaceId - Workspace ID
   * @param amount - Amount to add (positive number)
   * @param description - Description
   * @param transactionType - Type of transaction
   * @param metadata - Additional metadata
   */
  static async addCredits(
    workspaceId: string,
    amount: number,
    description: string,
    transactionType: 'purchase' | 'bonus' | 'refund' | 'migration' = 'purchase',
    metadata?: Record<string, any>
  ): Promise<WorkspaceCredits | null> {
    try {
      if (amount <= 0) {
        logger.warn('[WORKSPACE_CREDITS] Invalid add amount', { workspaceId, amount });
        return null;
      }

      // Get current credits
      const credits = await this.getOrCreateWorkspaceCredits(workspaceId);
      const currentBalance = Number.isFinite(credits.credits_balance) ? credits.credits_balance : 0;

      const newBalance = currentBalance + amount;
      const newTotalPurchased =
        transactionType === 'purchase'
          ? (credits.total_purchased || 0) + amount
          : credits.total_purchased;

      // Update credits
      const { data: updatedCredits, error: updateError } = await supabaseAdmin
        .from('workspace_credits')
        .update({
          credits_balance: newBalance,
          total_purchased: newTotalPurchased,
          credits_purchased_at:
            transactionType === 'purchase' ? new Date().toISOString() : credits.credits_purchased_at,
          updated_at: new Date().toISOString(),
        })
        .eq('workspace_id', workspaceId)
        .select()
        .single();

      if (updateError) {
        logger.error('[WORKSPACE_CREDITS] Error adding credits', {
          error: updateError.message,
          workspaceId,
          amount,
        });
        return null;
      }

      // Record transaction
      await supabaseAdmin.from('workspace_credit_transactions').insert({
        workspace_id: workspaceId,
        amount,
        balance_after: newBalance,
        transaction_type: transactionType,
        description,
        metadata: metadata || {},
      });

      logger.info('[WORKSPACE_CREDITS] Credits added', {
        workspaceId,
        amount,
        transactionType,
        previousBalance: currentBalance,
        newBalance,
      });

      return updatedCredits;
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Exception adding credits', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
        amount,
      });
      return null;
    }
  }

  /**
   * Get credit transactions for workspace
   */
  static async getTransactions(
    workspaceId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<WorkspaceCreditTransaction[]> {
    try {
      const { limit = 50, offset = 0 } = options;

      const { data, error } = await supabaseAdmin
        .from('workspace_credit_transactions')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        logger.error('[WORKSPACE_CREDITS] Error getting transactions', {
          error: error.message,
          workspaceId,
        });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Exception getting transactions', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return [];
    }
  }

  /**
   * Get monthly usage for the current billing period
   */
  static async getMonthlyUsage(workspaceId: string): Promise<{
    used: number;
    limit: number | null;
    periodStart: string | null;
    percentUsed: number | null;
  }> {
    try {
      const credits = await this.getWorkspaceCredits(workspaceId);
      if (!credits) {
        return { used: 0, limit: null, periodStart: null, percentUsed: null };
      }

      const used = credits.credits_used_this_period || 0;
      const limit = credits.monthly_credit_limit;
      const percentUsed = limit != null && limit > 0 ? (used / limit) * 100 : null;

      return {
        used,
        limit,
        periodStart: credits.period_start_date,
        percentUsed: percentUsed != null ? Math.round(percentUsed * 100) / 100 : null,
      };
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Error getting monthly usage', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return { used: 0, limit: null, periodStart: null, percentUsed: null };
    }
  }

  /**
   * Reset monthly usage for a workspace (called on billing cycle renewal)
   * - Resets credits_used_this_period to 0
   * - Resets warning flags
   * - Sets credits_balance to exactly monthly_credit_limit (no rollover)
   * - Records a 'purchase' transaction for the replenishment
   */
  static async resetMonthlyUsage(workspaceId: string): Promise<WorkspaceCredits | null> {
    try {
      const credits = await this.getWorkspaceCredits(workspaceId);
      if (!credits) {
        logger.warn('[WORKSPACE_CREDITS] Workspace not found for monthly reset', { workspaceId });
        return null;
      }

      const monthlyLimit = credits.monthly_credit_limit;
      if (monthlyLimit == null || monthlyLimit <= 0) {
        logger.warn('[WORKSPACE_CREDITS] No monthly limit set, skipping reset', { workspaceId });
        return null;
      }

      const now = new Date();

      // Reset balance to exactly the monthly limit (no rollover)
      const { data: updatedCredits, error: updateError } = await supabaseAdmin
        .from('workspace_credits')
        .update({
          credits_balance: monthlyLimit,
          credits_used_this_period: 0,
          period_start_date: now.toISOString().split('T')[0],
          warning_80_sent: false,
          warning_95_sent: false,
          credits_purchased_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('workspace_id', workspaceId)
        .select()
        .single();

      if (updateError) {
        logger.error('[WORKSPACE_CREDITS] Error resetting monthly usage', {
          error: updateError.message,
          workspaceId,
        });
        return null;
      }

      // Record replenishment transaction
      await supabaseAdmin.from('workspace_credit_transactions').insert({
        workspace_id: workspaceId,
        amount: monthlyLimit,
        balance_after: monthlyLimit,
        transaction_type: 'purchase',
        description: `Monthly credit replenishment - ${credits.subscription_plan} plan`,
        metadata: {
          type: 'monthly_reset',
          previous_balance: credits.credits_balance,
          previous_used: credits.credits_used_this_period,
          monthly_limit: monthlyLimit,
        },
      });

      logger.info('[WORKSPACE_CREDITS] Monthly usage reset', {
        workspaceId,
        previousBalance: credits.credits_balance,
        previousUsed: credits.credits_used_this_period,
        newBalance: monthlyLimit,
        plan: credits.subscription_plan,
      });

      return updatedCredits;
    } catch (error) {
      logger.error('[WORKSPACE_CREDITS] Exception resetting monthly usage', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      return null;
    }
  }
}
