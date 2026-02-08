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
  subscription_plan: 'free' | 'basic' | 'pro' | 'enterprise';
  subscription_status: 'active' | 'inactive' | 'expired';
  subscription_expires_at: string | null;
  last_credit_usage: string | null;
  credits_purchased_at: string | null;
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

      const newBalance = currentBalance - amount;
      const newTotalUsed = (credits.total_used || 0) + amount;

      // Update credits
      const { data: updatedCredits, error: updateError } = await supabaseAdmin
        .from('workspace_credits')
        .update({
          credits_balance: newBalance,
          total_used: newTotalUsed,
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
        userId,
      });

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
}
