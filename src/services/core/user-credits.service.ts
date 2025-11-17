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
   * @param userId - User ID
   * @returns User credits or null if not found/error
   */
  static async getUserCredits(userId: string): Promise<UserCredits | null> {
    try {
      // Validate input
      if (!userId || typeof userId !== 'string') {
        logger.warn('[USER_CREDITS] Invalid userId in getUserCredits', { userId });
        return null;
      }

      const { data, error } = await supabaseAdmin
        .from('user_credits')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        logger.error('[USER_CREDITS] Error getting user credits', {
          error: error.message,
          code: error.code,
          userId,
        });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in getUserCredits', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      return null;
    }
  }

  /**
   * Get or create user credits record
   * @param userId - User ID
   * @returns User credits record
   * @throws Error if userId is invalid or creation fails
   */
  static async getOrCreateUserCredits(userId: string): Promise<UserCredits> {
    // Validate input
    if (!userId || typeof userId !== 'string') {
      logger.error('[USER_CREDITS] Invalid userId in getOrCreateUserCredits', { userId });
      throw new Error('Invalid userId');
    }

    const existingCredits = await this.getUserCredits(userId);

    if (existingCredits) {
      return existingCredits;
    }

    // Create new credits record with 0 balance
    // Use upsert to avoid race condition if user is created concurrently
    const { data, error } = await supabaseAdmin
      .from('user_credits')
      .upsert(
        {
          user_id: userId,
          credits_balance: 0,
          subscription_plan: 'free',
          subscription_status: 'inactive',
        },
        {
          onConflict: 'user_id',
        }
      )
      .select()
      .maybeSingle();

    if (error) {
      logger.error('[USER_CREDITS] Error creating user credits', {
        error: error.message,
        code: error.code,
        userId,
      });
      throw new Error('Failed to create user credits');
    }

    if (!data) {
      // Try to fetch again in case of race condition
      const retryCredits = await this.getUserCredits(userId);
      if (retryCredits) {
        return retryCredits;
      }
      throw new Error('Failed to create user credits: no data returned');
    }

    logger.info('[USER_CREDITS] Created new user credits', { userId });
    return data;
  }

  /**
   * Check if user has enough credits
   * @param userId - User ID
   * @param amount - Required amount (default: 1)
   * @returns True if user has enough credits
   */
  static async hasCredits(userId: string, amount: number = 1): Promise<boolean> {
    // Validate inputs
    if (!userId || typeof userId !== 'string') {
      return false;
    }

    if (!Number.isFinite(amount) || amount < 0) {
      return false;
    }

    const credits = await this.getUserCredits(userId);
    const balance = Number.isFinite(credits?.credits_balance)
      ? (credits?.credits_balance || 0)
      : 0;

    return balance >= amount;
  }

  /**
   * Deduct credits from user balance
   * IMPORTANT: Now supports DECIMAL credits (e.g., 0.5, 1.23, 20.45)
   * @param userId - User ID
   * @param amount - Amount to deduct (must be >= 0)
   * @param description - Transaction description
   * @param metadata - Additional metadata
   * @returns Success status and new balance
   */
  static async deductCredits(
    userId: string,
    amount: number,
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.error('[USER_CREDITS] Invalid userId in deductCredits', { userId });
        return { success: false, newBalance: 0 };
      }

      if (!Number.isFinite(amount) || amount < 0) {
        logger.error('[USER_CREDITS] Invalid amount in deductCredits', { userId, amount });
        return { success: false, newBalance: 0 };
      }

      if (!description || typeof description !== 'string') {
        logger.error('[USER_CREDITS] Description is required in deductCredits', { userId });
        return { success: false, newBalance: 0 };
      }

      const credits = await this.getOrCreateUserCredits(userId);

      // Round amount to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;

      const currentBalance = Number.isFinite(credits.credits_balance)
        ? (credits.credits_balance || 0)
        : 0;

      if (currentBalance < roundedAmount) {
        logger.warn('[USER_CREDITS] Insufficient credits', {
          userId,
          required: roundedAmount,
          available: currentBalance,
        });
        return { success: false, newBalance: currentBalance };
      }

      const newBalance = Math.round((currentBalance - roundedAmount) * 100) / 100;

      // Update balance
      const previousTotalUsed = Number.isFinite(credits.total_used)
        ? (credits.total_used || 0)
        : 0;

      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update({
          credits_balance: newBalance,
          total_used: Math.round((previousTotalUsed + roundedAmount) * 100) / 100,
          last_credit_usage: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (updateError) {
        logger.error('[USER_CREDITS] Error updating credits', {
          error: updateError.message,
          code: updateError.code,
          userId,
        });
        return { success: false, newBalance: currentBalance };
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
   * @param userId - User ID
   * @param amount - Amount to add (must be >= 0)
   * @param type - Transaction type
   * @param description - Transaction description
   * @param metadata - Additional metadata
   * @returns Success status and new balance
   */
  static async addCredits(
    userId: string,
    amount: number,
    type: 'purchase' | 'bonus' | 'refund',
    description: string,
    metadata: Record<string, any> = {}
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.error('[USER_CREDITS] Invalid userId in addCredits', { userId });
        return { success: false, newBalance: 0 };
      }

      if (!Number.isFinite(amount) || amount < 0) {
        logger.error('[USER_CREDITS] Invalid amount in addCredits', { userId, amount });
        return { success: false, newBalance: 0 };
      }

      if (!['purchase', 'bonus', 'refund'].includes(type)) {
        logger.error('[USER_CREDITS] Invalid type in addCredits', { userId, type });
        return { success: false, newBalance: 0 };
      }

      if (!description || typeof description !== 'string') {
        logger.error('[USER_CREDITS] Description is required in addCredits', { userId });
        return { success: false, newBalance: 0 };
      }

      const credits = await this.getOrCreateUserCredits(userId);

      // Round amount to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;

      const currentBalance = Number.isFinite(credits.credits_balance)
        ? (credits.credits_balance || 0)
        : 0;

      const newBalance = Math.round((currentBalance + roundedAmount) * 100) / 100;

      // Update balance
      const updateData: any = {
        credits_balance: newBalance,
        updated_at: new Date().toISOString(),
      };

      if (type === 'purchase') {
        const previousTotalPurchased = Number.isFinite(credits.total_purchased)
          ? (credits.total_purchased || 0)
          : 0;
        updateData.total_purchased = Math.round((previousTotalPurchased + roundedAmount) * 100) / 100;
        updateData.credits_purchased_at = new Date().toISOString();
      }

      const { error: updateError } = await supabaseAdmin
        .from('user_credits')
        .update(updateData)
        .eq('user_id', userId);

      if (updateError) {
        logger.error('[USER_CREDITS] Error adding credits', {
          error: updateError.message,
          code: updateError.code,
          userId,
        });
        return { success: false, newBalance: currentBalance };
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
   * @param userId - User ID
   * @param limit - Maximum number of transactions (default: 50, max: 1000)
   * @returns Array of transactions
   */
  static async getTransactionHistory(
    userId: string,
    limit: number = 50
  ): Promise<CreditTransaction[]> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.warn('[USER_CREDITS] Invalid userId in getTransactionHistory', { userId });
        return [];
      }

      // Clamp limit between 1 and 1000
      const validLimit = Math.max(1, Math.min(1000, Math.floor(limit || 50)));

      const { data, error } = await supabaseAdmin
        .from('credit_transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(validLimit);

      if (error) {
        logger.error('[USER_CREDITS] Error getting transaction history', {
          error: error.message,
          code: error.code,
          userId,
        });
        return [];
      }

      return data || [];
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in getTransactionHistory', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      return [];
    }
  }

  /**
   * Update user subscription
   * @param userId - User ID
   * @param plan - Subscription plan
   * @param status - Subscription status
   * @param expiresAt - Expiration date (optional)
   * @returns True if successful
   */
  static async updateSubscription(
    userId: string,
    plan: 'free' | 'basic' | 'pro' | 'enterprise',
    status: 'active' | 'inactive' | 'expired',
    expiresAt: string | null = null
  ): Promise<boolean> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.error('[USER_CREDITS] Invalid userId in updateSubscription', { userId });
        return false;
      }

      const validPlans = ['free', 'basic', 'pro', 'enterprise'];
      if (!validPlans.includes(plan)) {
        logger.error('[USER_CREDITS] Invalid plan in updateSubscription', { userId, plan });
        return false;
      }

      const validStatuses = ['active', 'inactive', 'expired'];
      if (!validStatuses.includes(status)) {
        logger.error('[USER_CREDITS] Invalid status in updateSubscription', { userId, status });
        return false;
      }

      const updateData: any = {
        subscription_plan: plan,
        subscription_status: status,
        updated_at: new Date().toISOString(),
      };

      if (expiresAt !== null) {
        if (typeof expiresAt === 'string' && expiresAt.length > 0) {
          updateData.subscription_expires_at = expiresAt;
        } else {
          updateData.subscription_expires_at = null;
        }
      }

      const { error } = await supabaseAdmin
        .from('user_credits')
        .update(updateData)
        .eq('user_id', userId);

      if (error) {
        logger.error('[USER_CREDITS] Error updating subscription', {
          error: error.message,
          code: error.code,
          userId,
          plan,
          status,
        });
        return false;
      }

      logger.info('[USER_CREDITS] Subscription updated', { userId, plan, status });
      return true;
    } catch (error) {
      logger.error('[USER_CREDITS] Exception in updateSubscription', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
      return false;
    }
  }
}
