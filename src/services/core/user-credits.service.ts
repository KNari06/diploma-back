import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface UserCredits {
  id: string;
  user_id: string;
  credits_balance: number;
  total_purchased: number;
  total_used: number;
  subscription_plan: 'free' | 'basic' | 'pro' | 'ultra' | 'enterprise' | 'business';
  subscription_status: 'active' | 'inactive' | 'expired';
  subscription_expires_at: string | null;
  /** V16: Grace period — max negative balance allowed (plan-dependent) */
  grace_limit: number;
  /** V16: Accumulated overage when balance < 0 (cleared on purchase) */
  overage_balance: number;
  /** V16: When grace period started (null = not in grace) */
  grace_started_at: string | null;
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
 * Coerce one value to a finite number, defaulting to 0.
 *
 * Postgres NUMERIC columns are serialized by PostgREST/supabase-js as JSON
 * STRINGS (e.g. "50.00"), even though our TS interfaces type them as `number`.
 * Calling `Number.isFinite` on the raw value is therefore always false, and
 * arithmetic concatenates strings. Normalize every NUMERIC field through this
 * at the data-access boundary so the rest of the codebase can trust the types.
 */
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a raw user_credits row's NUMERIC columns to real numbers.
 * Returns null untouched. Non-numeric columns pass through unchanged.
 */
function normalizeUserCredits(row: any): UserCredits | null {
  if (!row) return null;
  return {
    ...row,
    credits_balance: toNum(row.credits_balance),
    total_purchased: toNum(row.total_purchased),
    total_used: toNum(row.total_used),
    grace_limit: toNum(row.grace_limit),
    overage_balance: toNum(row.overage_balance),
  };
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

      return normalizeUserCredits(data);
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
      // The welcome bonus is idempotent and gated on a durable column, NOT on
      // "the row was just created". An existing row may never have been granted
      // the bonus (created at balance 0 by the /credits endpoint, the
      // credit-check middleware, or a deduct/add path before provisioning ran;
      // or a prior grant attempt failed). Re-evaluate every time so the grant
      // self-heals instead of leaving the user stuck at 0 forever.
      return await this.grantInitialBonusIfEligible(existingCredits);
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
          grace_limit: 0, // V16: Free plan has no grace period
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
        return await this.grantInitialBonusIfEligible(retryCredits);
      }
      throw new Error('Failed to create user credits: no data returned');
    }

    logger.info('[USER_CREDITS] Created new user credits', { userId });
    return await this.grantInitialBonusIfEligible(normalizeUserCredits(data) as UserCredits);
  }

  /**
   * Idempotently grant the one-time 50-credit welcome bonus to a free-plan user.
   *
   * Safe to call on every getOrCreateUserCredits path. Gated on a DURABLE marker
   * — the presence of a `credit_transactions` row tagged metadata.is_initial_bonus
   * — NOT on "the row was just created" or on balance. So a user whose row was
   * materialized at 0 by some other caller (the /credits endpoint, the
   * credit-check middleware, a deduct/add path) before provisioning ran still
   * gets the bonus, and a prior attempt that failed before recording the
   * transaction self-heals on the next call. No schema change required — it
   * reuses the is_initial_bonus marker addCredits already writes.
   *
   * Concurrency note: two simultaneous first-time calls could both find no
   * marker and both grant (a rare double-grant on signup races — the same
   * exposure the previous non-idempotent code had). The common stuck-at-0 path
   * this fixes is sequential (a later auth/credits call after a 0 row already
   * exists), which the marker check resolves. A fully race-proof variant needs a
   * uniqueness guard on the bonus transaction; deferred deliberately.
   *
   * @param credits - the user's current credits row
   * @returns the (possibly updated) credits row — never throws; on any failure
   *          it logs and returns the freshest row so callers are unaffected.
   */
  private static async grantInitialBonusIfEligible(credits: UserCredits): Promise<UserCredits> {
    const userId = credits.user_id;
    try {
      // Durable idempotency: if a welcome-bonus transaction already exists, the
      // bonus was granted (now or in the past) — nothing to do.
      const { data: existingBonus, error: bonusLookupError } = await supabaseAdmin
        .from('credit_transactions')
        .select('id')
        .eq('user_id', userId)
        .eq('metadata->>is_initial_bonus', 'true')
        .limit(1)
        .maybeSingle();

      if (bonusLookupError) {
        // Can't confirm idempotency — do NOT grant (avoid accidental double-grant).
        logger.warn('[USER_CREDITS] Could not check welcome-bonus marker; skipping grant', {
          error: bonusLookupError.message,
          userId,
        });
        return credits;
      }
      if (existingBonus) {
        return credits;
      }

      // Only free / no-plan users get the welcome bonus.
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('plan_id, pricing_plans!plan_id(slug)')
        .eq('id', userId)
        .maybeSingle();

      let planSlug: string | null = null;
      if (userData?.pricing_plans) {
        const plan = Array.isArray(userData.pricing_plans)
          ? userData.pricing_plans[0]
          : userData.pricing_plans;
        planSlug = plan?.slug || null;
      }
      const isFreePlan = !planSlug || planSlug === 'free';
      if (!isFreePlan) {
        return credits;
      }

      logger.info('[USER_CREDITS] Granting initial 50-credit welcome bonus', { userId });
      const result = await this.addCredits(
        userId,
        50,
        'bonus',
        'Welcome bonus: Initial free credits for new user',
        { is_initial_bonus: true }
      );

      // addCredits returns {success:false} instead of throwing on a transient
      // failure. On failure the is_initial_bonus transaction is NOT written, so
      // the marker check above will fail again next time and the grant retries —
      // the user is never stuck at 0.
      if (!result.success) {
        logger.warn('[USER_CREDITS] Welcome bonus add failed; leaving eligible for retry', {
          userId,
        });
        return (await this.getUserCredits(userId)) ?? credits;
      }

      return (await this.getUserCredits(userId)) ?? credits;
    } catch (bonusError) {
      // Best-effort: never break credit resolution because of the bonus.
      logger.warn('[USER_CREDITS] Failed to grant welcome bonus (non-critical)', {
        error: bonusError instanceof Error ? bonusError.message : String(bonusError),
        userId: credits.user_id,
      });
      return credits;
    }
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

    // V16: Grace period — user can go negative up to grace_limit
    const graceLimit = Number.isFinite(credits?.grace_limit) ? (credits?.grace_limit || 0) : 0;
    return (balance + graceLimit) >= amount;
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

      // Ensure the row (and welcome bonus) exist before deducting. We read the
      // pre-deduction balance only to flag grace transitions and to report the
      // unchanged balance on an "insufficient" result — the actual deduction is
      // atomic in the DB, NOT computed from this value.
      const credits = await this.getOrCreateUserCredits(userId);

      // Round amount to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;
      const currentBalance = toNum(credits.credits_balance);
      const wasAlreadyInGrace = currentBalance < 0;

      // Atomic deduction with grace-floor enforcement. The DB applies the
      // balance check and the write in one statement under a row lock, so
      // concurrent deductions serialize and cannot double-spend (was a
      // read-modify-write race). No row returned => the deduction would breach
      // the grace floor => insufficient credits.
      const { data: updatedRow, error: rpcError } = await supabaseAdmin.rpc('deduct_user_credits', {
        p_user_id: userId,
        p_amount: roundedAmount,
      });

      if (rpcError) {
        logger.error('[USER_CREDITS] Error deducting credits (rpc)', {
          error: rpcError.message,
          code: rpcError.code,
          userId,
        });
        return { success: false, newBalance: currentBalance };
      }

      // supabase rpc returning a row type may surface as an array or single object.
      const deducted = Array.isArray(updatedRow) ? updatedRow[0] : updatedRow;
      if (!deducted) {
        logger.warn('[USER_CREDITS] Insufficient credits (grace limit exceeded)', {
          userId,
          required: roundedAmount,
          available: currentBalance,
          graceLimit: toNum(credits.grace_limit),
        });
        return { success: false, newBalance: currentBalance };
      }

      const newBalance = toNum(deducted.credits_balance);
      const isGraceDeduction = newBalance < 0;

      // Record transaction (with grace flag)
      await this.recordTransaction(userId, -roundedAmount, newBalance, 'usage', description, {
        ...metadata,
        ...(isGraceDeduction ? { is_grace_deduction: true } : {}),
      });

      if (isGraceDeduction && !wasAlreadyInGrace) {
        logger.info('[USER_CREDITS] Grace period started', {
          userId,
          balance: newBalance,
          graceLimit: toNum(credits.grace_limit),
          overageBalance: Math.abs(newBalance),
        });
      }

      logger.info('[USER_CREDITS] Credits deducted', {
        userId,
        amount: roundedAmount,
        newBalance,
        description,
        grace: isGraceDeduction || undefined,
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
      logger.info('[USER_CREDITS] addCredits', { userId, amount, type, description, metadata });
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
      logger.info('[USER_CREDITS] credits', { credits });
      // Round amount to 2 decimal places to match NUMERIC(10,2) in DB
      const roundedAmount = Math.round(amount * 100) / 100;
      logger.info('[USER_CREDITS] roundedAmount', { roundedAmount });
      const currentBalance = Number.isFinite(credits.credits_balance)
        ? (credits.credits_balance || 0)
        : 0;
      logger.info('[USER_CREDITS] currentBalance', { currentBalance });
      const newBalance = Math.round((currentBalance + roundedAmount) * 100) / 100;
      logger.info('[USER_CREDITS] newBalance', { newBalance });
      // Update balance
      const updateData: any = {
        credits_balance: newBalance,
        updated_at: new Date().toISOString(),
      };
      logger.info('[USER_CREDITS] updateData', { updateData });
      if (type === 'purchase') {
        const previousTotalPurchased = Number.isFinite(credits.total_purchased)
          ? (credits.total_purchased || 0)
          : 0;
        updateData.total_purchased = Math.round((previousTotalPurchased + roundedAmount) * 100) / 100;
        updateData.credits_purchased_at = new Date().toISOString();
      }

      // V16: Clear grace period state when credits are added (purchase/bonus/refund)
      if (newBalance >= 0 && credits.grace_started_at) {
        updateData.overage_balance = 0;
        updateData.grace_started_at = null;
        logger.info('[USER_CREDITS] Grace period cleared on credit addition', {
          userId,
          type,
          newBalance,
          previousOverage: credits.overage_balance,
        });
      }
      logger.info('[USER_CREDITS] updateData', { updateData });
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
    plan: 'free' | 'basic' | 'pro' | 'ultra' | 'enterprise' | 'business',
    status: 'active' | 'inactive' | 'expired',
    expiresAt: string | null = null
  ): Promise<boolean> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.error('[USER_CREDITS] Invalid userId in updateSubscription', { userId });
        return false;
      }

      const validPlans = ['free', 'basic', 'pro', 'ultra', 'enterprise', 'business'];
      if (!validPlans.includes(plan)) {
        logger.error('[USER_CREDITS] Invalid plan in updateSubscription', { userId, plan });
        return false;
      }

      const validStatuses = ['active', 'inactive', 'expired'];
      if (!validStatuses.includes(status)) {
        logger.error('[USER_CREDITS] Invalid status in updateSubscription', { userId, status });
        return false;
      }

      // V16: Grace limit per plan tier
      const GRACE_LIMITS: Record<string, number> = {
        free: 0,
        basic: 100,
        pro: 100,
        ultra: 200,
        enterprise: 1000,
        business: 1000,
      };

      const updateData: any = {
        subscription_plan: plan,
        subscription_status: status,
        grace_limit: GRACE_LIMITS[plan] ?? 0,
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
