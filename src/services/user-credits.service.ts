import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

export interface UserCredits {
  id: string;
  user_id: string;
  credits_balance: number;
  total_purchased: number;
  total_used: number;
  subscription_plan: 'free' | 'basic' | 'pro' | 'enterprise';
  subscription_status: 'active' | 'inactive' | 'expired';
  subscription_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  transaction_type: 'purchase' | 'usage' | 'refund' | 'bonus';
  description: string;
  metadata: Record<string, any>;
  created_at: string;
}

/**
 * Service for managing user credits and subscriptions
 */
export class UserCreditsService {
  /**
   * Get user credits info
   */
  static async getUserCredits(userId: string): Promise<UserCredits | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('user_credits')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[USER_CREDITS] Error getting user credits', { error, userId });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in getUserCredits', { error, userId });
      return null;
    }
  }

  /**
   * Get or create user credits record
   */
  static async getOrCreateUserCredits(userId: string): Promise<UserCredits> {
    const existingCredits = await this.getUserCredits(userId);

    if (existingCredits) {
      return existingCredits;
    }

    // Create new credits record with 0 balance
    const { data, error } = await supabaseAdmin
      .from('user_credits')
      .insert({
        user_id: userId,
        credits_balance: 0,
        subscription_plan: 'free',
        subscription_status: 'inactive',
      })
      .select()
      .single();

    if (error) {
      logger.error('[USER_CREDITS] Error creating user credits', { error, userId });
      throw new Error('Failed to create user credits');
    }

    if (!data) {
      throw new Error('Failed to create user credits: no data returned');
    }

    logger.info('[USER_CREDITS] Created new user credits', { userId });
    return data;
  }

  /**
   * Check if user has enough credits
   */
  static async hasCredits(userId: string, amount: number = 1): Promise<boolean> {
    const credits = await this.getUserCredits(userId);
    return credits ? credits.credits_balance >= amount : false;
  }

  /**
   * Deduct credits from user balance
   * IMPORTANT: Now supports DECIMAL credits (e.g., 0.5, 1.23, 20.45)
   */
  static async deductCredits(
    userId: string,
    amount: number,
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      const credits = await this.getOrCreateUserCredits(userId);

      // Round amount to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;

      if (credits.credits_balance < roundedAmount) {
        logger.warn('[USER_CREDITS] Insufficient credits', {
          userId,
          required: roundedAmount,
          available: credits.credits_balance,
        });
        return { success: false, newBalance: credits.credits_balance };
      }

      const newBalance = Math.round((credits.credits_balance - roundedAmount) * 100) / 100;

      // Update balance
      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update({
          credits_balance: newBalance,
          total_used: Math.round((credits.total_used + roundedAmount) * 100) / 100,
          last_credit_usage: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (updateError) {
        logger.error('[USER_CREDITS] Error updating credits', { error: updateError, userId });
        return { success: false, newBalance: credits.credits_balance };
      }

      // Record transaction (with token tracking if provided)
      await this.recordTransaction(userId, -roundedAmount, newBalance, 'usage', description, metadata);

      logger.info('[USER_CREDITS] Credits deducted', {
        userId,
        amount: roundedAmount,
        newBalance,
        description,
        tokensUsed: metadata.tokens_used || 'N/A',
      });

      return { success: true, newBalance };
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in deductCredits', { error, userId, amount });
      return { success: false, newBalance: 0 };
    }
  }

  /**
   * Add credits to user balance (purchase, bonus, refund)
   * IMPORTANT: Now supports DECIMAL credits with 2 decimal places
   */
  static async addCredits(
    userId: string,
    amount: number,
    type: 'purchase' | 'bonus' | 'refund',
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      const credits = await this.getOrCreateUserCredits(userId);

      // Round amount to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;
      const newBalance = Math.round((credits.credits_balance + roundedAmount) * 100) / 100;

      // Update balance
      const updateData: any = {
        credits_balance: newBalance,
        updated_at: new Date().toISOString(),
      };

      if (type === 'purchase') {
        updateData.total_purchased = Math.round((credits.total_purchased + roundedAmount) * 100) / 100;
        updateData.credits_purchased_at = new Date().toISOString();
      }

      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update(updateData)
        .eq('user_id', userId);

      if (updateError) {
        logger.error('[USER_CREDITS] Error adding credits', { error: updateError, userId });
        return { success: false, newBalance: credits.credits_balance };
      }

      // Record transaction
      await this.recordTransaction(userId, roundedAmount, newBalance, type, description, metadata);

      logger.info('[USER_CREDITS] Credits added', {
        userId,
        amount: roundedAmount,
        type,
        newBalance,
        description,
      });

      return { success: true, newBalance };
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in addCredits', { error, userId, amount });
      return { success: false, newBalance: 0 };
    }
  }

  /**
   * Record credit transaction (with token tracking support)
   */
  private static async recordTransaction(
    userId: string,
    amount: number,
    balanceAfter: number,
    type: 'purchase' | 'usage' | 'refund' | 'bonus',
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    try {
      // Round values to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;
      const roundedBalance = Math.round(balanceAfter * 100) / 100;

      // Prepare transaction data
      const transactionData: any = {
        user_id: userId,
        amount: roundedAmount,
        balance_after: roundedBalance,
        transaction_type: type,
        description,
        metadata,
      };

      // Add token tracking fields if present in metadata
      if (metadata.tokens_used) {
        transactionData.tokens_used = metadata.tokens_used;
      }

      if (metadata.cost_usd !== undefined) {
        transactionData.cost_usd = metadata.cost_usd;
      }

      if (metadata.credits_calculated !== undefined) {
        transactionData.credits_calculated = metadata.credits_calculated;
      }

      if (metadata.test_type) {
        transactionData.test_type = metadata.test_type;
      }

      const { error } = await supabaseAdmin.from('credit_transactions').insert(transactionData);

      if (error) {
        logger.error('[USER_CREDITS] Error recording transaction', { error, userId });
      } else {
        logger.debug('[USER_CREDITS] Transaction recorded', {
          userId,
          type,
          amount: roundedAmount,
          balanceAfter: roundedBalance,
          testType: metadata.test_type || 'N/A',
        });
      }
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in recordTransaction', { error, userId });
    }
  }

  /**
   * Get user transaction history
   */
  static async getTransactionHistory(
    userId: string,
    limit: number = 50
  ): Promise<CreditTransaction[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('credit_transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('[USER_CREDITS] Error getting transaction history', { error, userId });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in getTransactionHistory', { error, userId });
      return [];
    }
  }

  /**
   * Update user subscription
   */
  static async updateSubscription(
    userId: string,
    plan: 'free' | 'basic' | 'pro' | 'enterprise',
    status: 'active' | 'inactive' | 'expired',
    expiresAt: string | null = null
  ): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('user_credits')
        .update({
          subscription_plan: plan,
          subscription_status: status,
          subscription_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (error) {
        logger.error('[USER_CREDITS] Error updating subscription', { error, userId });
        return false;
      }

      logger.info('[USER_CREDITS] Subscription updated', { userId, plan, status });
      return true;
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in updateSubscription', { error, userId });
      return false;
    }
  }
}
