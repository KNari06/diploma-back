import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { ReferralsFeature } from '@/config/features/referrals';
import * as referralDb from '@/services/core/db/referral.db';
import type { PartnerRow } from '@/services/core/db/referral.db';
import type { Partner, PartnerStats, ReferredUser } from '@/types/referral.types';

/** How long a captured ?ref code waits (keyed by email) for the user's first auth. */
const PENDING_TTL_SECONDS = 24 * 60 * 60; // 24h — covers email-verification delay
const pendingKey = (email: string) => `qait:referral:pending:${email.trim().toLowerCase()}`;

/**
 * Referrals by link — orchestration only. No supabaseAdmin here; all queries go
 * through db/referral.db.ts.
 *
 * Two write flows:
 *  - attributeUser: first-touch permanent attribution (set-once, DB-enforced).
 *  - rewardOnPayment: partner revenue-share reward (rate × real amount paid) for
 *    the referred user's first N monthly payments, idempotent per-invoice.
 * Both are best-effort and never throw — they sit on the auth and Stripe-webhook
 * paths, which must not fail because of a referral bookkeeping error.
 *
 * Feature-gated: every entry point no-ops when ReferralsFeature is off.
 */
export class ReferralService {
  /**
   * Stash a captured ?ref code at signup, keyed by email, so it survives until
   * the user's first auth (email verification can be minutes/hours later, in a
   * different browser context). Best-effort, never throws. No-op when the
   * feature is off or inputs are empty.
   */
  static async stashPendingCode(
    email: string | null | undefined,
    code: string | null | undefined
  ): Promise<void> {
    if (!ReferralsFeature.isEnabled()) return;
    if (typeof email !== 'string' || typeof code !== 'string' || !code.trim()) return;
    try {
      await cache.set(pendingKey(email), code.trim(), PENDING_TTL_SECONDS);
    } catch (error) {
      logger.warn('[REFERRAL] stashPendingCode failed (non-critical)', {
        error: errMsg(error),
      });
    }
  }

  /**
   * Attribute a user at first auth, resolving the code from (in priority order)
   * an explicit code passed in, else the pending store keyed by email. Clears
   * the pending entry on success. Best-effort, never throws. Safe to call on
   * every auth — the DB enforces first-touch set-once, so a second call after a
   * user is already attributed is a harmless no-op.
   */
  static async attributeAtAuth(
    userId: string,
    email: string | null | undefined,
    explicitCode?: string | null
  ): Promise<boolean> {
    if (!ReferralsFeature.isEnabled()) return false;
    if (!userId) return false;

    let code = explicitCode?.trim() || null;
    if (!code && email) {
      try {
        code = (await cache.get<string>(pendingKey(email))) || null;
      } catch {
        code = null;
      }
    }
    if (!code) return false;

    const didSet = await this.attributeUser(userId, code);
    // Clear the pending entry once consumed (whether or not it set — the code
    // has been used for this user's first auth; a stale entry would linger).
    if (email) {
      try {
        await cache.del(pendingKey(email));
      } catch {
        /* best-effort */
      }
    }
    return didSet;
  }

  /**
   * Attribute a user to a partner by ?ref code — first-touch, permanent.
   * Idempotent and never throws. Returns true only when THIS call set the
   * attribution (so callers can log a one-time event). Safe to call on every
   * auth; the DB enforces set-once.
   */
  static async attributeUser(userId: string, code: string | null | undefined): Promise<boolean> {
    if (!ReferralsFeature.isEnabled()) return false;
    if (!userId || !code || !code.trim()) return false;

    try {
      const partner = await referralDb.findPartnerByCode(code.trim());
      if (!partner) {
        logger.info('[REFERRAL] Unknown ref code, ignoring', { code });
        return false;
      }
      if (partner.status !== 'active') {
        logger.info('[REFERRAL] Ref code belongs to a disabled partner, ignoring', {
          partnerId: partner.id,
        });
        return false;
      }

      const didSet = await referralDb.attributeUserIfUnset(userId, partner.id);
      if (didSet) {
        logger.info('[REFERRAL] Attributed user to partner (first-touch)', {
          userId,
          partnerId: partner.id,
        });
      }
      return didSet;
    } catch (error) {
      logger.warn('[REFERRAL] attributeUser failed (non-critical)', {
        error: errMsg(error),
        userId,
      });
      return false;
    }
  }

  /**
   * Grant the referring partner a revenue-share reward for a referred user's
   * paid invoice: the partner earns `rate` (default 70%) of the REAL amount
   * paid, for the user's first `windowCount` (default 2) monthly payments, then
   * 0%. The window is enforced by COUNTING existing reward rows for the user —
   * NOT by the Stripe billing reason — so it works for the first charge AND the
   * next renewal(s) alike. Per-invoice idempotent (ledger ON CONFLICT on
   * stripe_invoice_id), best-effort, never throws — runs on the Stripe webhook
   * path. No-op if the user has no referral partner or the window is exhausted.
   * Returns true only when a reward row was actually written.
   */
  static async rewardOnPayment(input: {
    userId: string;
    invoiceId: string;
    amountPaidMinorUnits: number;
    currency: string;
  }): Promise<boolean> {
    if (!ReferralsFeature.isEnabled()) return false;
    const { userId, invoiceId, amountPaidMinorUnits, currency } = input;
    if (!userId || !invoiceId) return false;

    try {
      const config = await referralDb.getUserRewardConfig(userId);
      if (!config) return false;
      const { partnerId } = config;

      // Per-partner overrides win over the global env default (forward-only: the
      // rate is captured in the ledger row below, so past rewards are unaffected).
      const rate = ReferralsFeature.resolveRewardRate(config.rewardRate);
      const windowCount = ReferralsFeature.resolveRewardWindowCount(config.rewardWindowCount);
      if (windowCount <= 0) return false;

      // Window gate: already rewarded for this user's first `windowCount`
      // payments? Then this payment (month 3+) earns nothing (100% ours).
      const alreadyRewarded = await referralDb.countRewardsForUser(userId);
      if (alreadyRewarded >= windowCount) return false;

      const amount = ReferralsFeature.computeReward(amountPaidMinorUnits, rate);
      if (amount <= 0) return false;

      const rewarded = await referralDb.insertRewardIfAbsent({
        partnerId,
        referredUserId: userId,
        eventType: 'paid_conversion',
        amount,
        currency: currency || 'usd',
        stripeInvoiceId: invoiceId,
        metadata: {
          source: 'stripe:invoice',
          paidAmount: amountPaidMinorUnits,
          rate,
          paymentNumber: alreadyRewarded + 1,
        },
      });
      if (rewarded) {
        logger.info('[REFERRAL] Partner rewarded for referred payment', {
          userId,
          partnerId,
          amount,
          currency,
          paymentNumber: alreadyRewarded + 1,
        });
      }
      return rewarded;
    } catch (error) {
      logger.warn('[REFERRAL] rewardOnPayment failed (non-critical)', {
        error: errMsg(error),
        userId,
      });
      return false;
    }
  }

  // ── partner-scoped reads (product frontend) ────────────────────────────────

  /**
   * The partner owned by an authenticated login user, or null if the user isn't
   * a partner. This is the ONLY way a partner id enters a scoped read — never
   * from the request body (IDOR guard).
   */
  static async getPartnerForAuthUser(authUserId: string): Promise<Partner | null> {
    const row = await referralDb.findPartnerByAuthUserId(authUserId);
    return row ? this.mapPartner(row) : null;
  }

  /** Aggregate stats for one partner (registrations / paid / credits used / owed). */
  static async getStatsForPartner(partnerId: string, code: string): Promise<PartnerStats> {
    const referred = await referralDb.getReferredUsers(partnerId);
    const userIds = referred.map((r) => r.id);
    const [creditsMap, owedBalance] = await Promise.all([
      referralDb.getCreditsUsedForUsers(userIds),
      referralDb.getOwedBalance(partnerId),
    ]);

    let creditsUsedByReferred = 0;
    for (const id of userIds) creditsUsedByReferred += creditsMap.get(id) ?? 0;

    return {
      partnerId,
      code,
      registrations: referred.length,
      paidUsers: referred.filter((r) => r.plan_status === 'paid').length,
      creditsUsedByReferred,
      owedBalance,
    };
  }

  /** The partner's referred users, with masked email (PII) and credits used. */
  static async getReferredUsersForPartner(partnerId: string): Promise<ReferredUser[]> {
    const referred = await referralDb.getReferredUsers(partnerId);
    const creditsMap = await referralDb.getCreditsUsedForUsers(referred.map((r) => r.id));
    return referred.map((r) => ({
      userId: r.id,
      email: maskEmail(r.email),
      referredAt: r.referred_at,
      isPaid: r.plan_status === 'paid',
      creditsUsed: creditsMap.get(r.id) ?? 0,
    }));
  }

  // ── staff / admin ───────────────────────────────────────────────────────────

  /** List every partner with aggregate stats (staff view). */
  static async listPartnersWithStats(): Promise<Array<Partner & { stats: PartnerStats }>> {
    const rows = await referralDb.listPartners();
    return Promise.all(
      rows.map(async (row) => ({
        ...this.mapPartner(row),
        stats: await this.getStatsForPartner(row.id, row.code),
      }))
    );
  }

  /**
   * Create a partner. The partner row is inserted FIRST (the DB's unique
   * lower(code) index is the real dup guard and closes the check-then-insert
   * race). Only after the row exists do we optionally provision a login —
   * inviting the email via Supabase Auth, promoting the synced users row to
   * role='partner' + status='approved', and linking partners.auth_user_id.
   * Ordering matters: provisioning the login first would leave an orphaned,
   * workspace-less login that can log in but has no partner row (a dead account)
   * whenever the insert then fails (dup code, transient error). The login step
   * is best-effort — the partner is returned either way; staff can retry linking.
   */
  static async createPartner(input: {
    code: string;
    name: string;
    email?: string | null;
    provisionLogin?: boolean;
  }): Promise<Partner> {
    const code = input.code.trim();
    if (!code) throw new Error('code is required');
    if (!input.name?.trim()) throw new Error('name is required');

    const existing = await referralDb.findPartnerByCode(code);
    if (existing) throw new Error(`A partner with code "${code}" already exists`);

    let row = await referralDb.insertPartner({
      code,
      name: input.name.trim(),
      email: input.email ?? null,
      authUserId: null,
    });

    if (input.provisionLogin && input.email) {
      const authUserId = await this.provisionPartnerLogin(input.email);
      if (authUserId) {
        const linked = await referralDb.updatePartner(row.id, { authUserId });
        if (linked) row = linked;
      }
    }
    return this.mapPartner(row);
  }

  /** Update a partner (name / email / status / reward overrides / linked login). */
  static async updatePartner(
    id: string,
    patch: {
      name?: string;
      email?: string | null;
      status?: 'active' | 'disabled';
      rewardRate?: number | null;
      rewardWindowCount?: number | null;
    }
  ): Promise<Partner | null> {
    const row = await referralDb.updatePartner(id, patch);
    return row ? this.mapPartner(row) : null;
  }

  /**
   * Provision a partner login for an email. New email → Supabase invite (creates
   * the auth user + sends the invite); already-registered email → resolve the
   * existing user (no email) so they can still be promoted. Either way the synced
   * users row is promoted to a partner login (role='partner', approved). Returns
   * the auth user id, or null on failure (caller treats this as best-effort).
   */
  private static async provisionPartnerLogin(email: string): Promise<string | null> {
    try {
      const authUserId = await referralDb.inviteAuthUser(email.trim());
      if (!authUserId) {
        logger.warn('[REFERRAL] Partner login invite returned no user (non-critical)', { email });
        return null;
      }
      await referralDb.markUserAsPartnerLogin(authUserId);
      return authUserId;
    } catch (error) {
      logger.warn('[REFERRAL] provisionPartnerLogin failed (non-critical)', {
        error: errMsg(error),
      });
      return null;
    }
  }

  // ── mapping ────────────────────────────────────────────────────────────────

  private static mapPartner(row: PartnerRow): Partner {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      email: row.email,
      authUserId: row.auth_user_id,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      rewardRate: row.reward_rate,
      rewardWindowCount: row.reward_window_count,
      createdAt: row.created_at,
    };
  }
}

/**
 * Extract a readable message from any thrown value. Supabase/PostgREST errors
 * are plain objects (not Error instances) with `message`/`details`/`code`, so
 * `String(err)` yields "[object Object]" — this pulls the real text instead.
 */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; details?: string; code?: string };
    return e.message || e.details || e.code || JSON.stringify(err);
  }
  return String(err);
}

/** Mask an email for partner-facing display: j***@acme.com. Never expose the full address. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const first = email[0];
  const domain = email.slice(at);
  return `${first}***${domain}`;
}
