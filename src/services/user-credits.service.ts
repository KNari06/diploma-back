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
   */
  static async deductCredits(
    userId: string,
    amount: number,
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      const credits = await this.getOrCreateUserCredits(userId);

      if (credits.credits_balance < amount) {
        logger.warn('[USER_CREDITS] Insufficient credits', {
          userId,
          required: amount,
          available: credits.credits_balance,
        });
        return { success: false, newBalance: credits.credits_balance };
      }

      const newBalance = credits.credits_balance - amount;

      // Update balance
      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update({
          credits_balance: newBalance,
          total_used: credits.total_used + amount,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (updateError) {
        logger.error('[USER_CREDITS] Error updating credits', { error: updateError, userId });
        return { success: false, newBalance: credits.credits_balance };
      }

      // Record transaction
      await this.recordTransaction(userId, -amount, newBalance, 'usage', description, metadata);

      logger.info('[USER_CREDITS] Credits deducted', {
        userId,
        amount,
        newBalance,
        description,
      });

      return { success: true, newBalance };
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in deductCredits', { error, userId, amount });
      return { success: false, newBalance: 0 };
    }
  }

  /**
   * Add credits to user balance (purchase, bonus, refund)
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
      const newBalance = credits.credits_balance + amount;

      // Update balance
      const updateData: any = {
        credits_balance: newBalance,
        updated_at: new Date().toISOString(),
      };

      if (type === 'purchase') {
        updateData.total_purchased = credits.total_purchased + amount;
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
      await this.recordTransaction(userId, amount, newBalance, type, description, metadata);

      logger.info('[USER_CREDITS] Credits added', {
        userId,
        amount,
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
   * Record credit transaction
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
      const { error } = await supabaseAdmin.from('credit_transactions').insert({
        user_id: userId,
        amount,
        balance_after: balanceAfter,
        transaction_type: type,
        description,
        metadata,
      });

      if (error) {
        logger.error('[USER_CREDITS] Error recording transaction', { error, userId });
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
