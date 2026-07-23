import { Request, Response } from 'express';
import { ReferralService } from '@/services/core/referral.service';
import { ReferralsFeature } from '@/config/features/referrals';
import { logger } from '@/utils/core/logger';

/**
 * Referrals API — thin controllers. Parse request, call ReferralService, shape
 * the response. No business logic, no Supabase.
 *
 * Feature gate: when REFERRALS_ENABLED is off, every endpoint 404s (the surface
 * is dark), mirroring the test-case-chat flag pattern.
 */

function featureOff(res: Response): boolean {
  if (!ReferralsFeature.isEnabled()) {
    res.status(404).json({ success: false, error: 'Not found' });
    return true;
  }
  return false;
}

// ── partner-scoped (the authenticated partner's OWN data only) ───────────────

/**
 * Resolve the partner owned by the caller. Returns null and sends 403 when the
 * authenticated user is not a partner — the ONLY place a partner id is derived
 * (never from the request body → no IDOR).
 */
async function requirePartner(req: Request, res: Response) {
  const authUserId = req.user?.id;
  if (!authUserId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }
  const partner = await ReferralService.getPartnerForAuthUser(authUserId);
  if (!partner) {
    res.status(403).json({ success: false, error: 'Not a referral partner' });
    return null;
  }
  return partner;
}

export const getMyStats = async (req: Request, res: Response): Promise<void> => {
  if (featureOff(res)) return;
  const partner = await requirePartner(req, res);
  if (!partner) return;

  const stats = await ReferralService.getStatsForPartner(partner.id, partner.code);
  res.json({
    success: true,
    data: {
      ...stats, // includes code
      name: partner.name,
    },
  });
};

export const getMyReferrals = async (req: Request, res: Response): Promise<void> => {
  if (featureOff(res)) return;
  const partner = await requirePartner(req, res);
  if (!partner) return;

  const referrals = await ReferralService.getReferredUsersForPartner(partner.id);
  res.json({ success: true, data: referrals });
};

/**
 * Attribute the authenticated user to a partner code. The OAuth-safe path
 * (query params are lost across the Supabase OAuth exchange) and general
 * fallback: the frontend POSTs the localStorage-captured code after the session
 * is established. userId comes from the token, never the body (no IDOR).
 */
export const attributeMe = async (req: Request, res: Response): Promise<void> => {
  if (featureOff(res)) return;
  const userId = req.user?.id;
  const email = req.user?.email;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const code = typeof req.body?.code === 'string' ? req.body.code : null;
  if (!code) {
    res.status(400).json({ success: false, error: 'code is required' });
    return;
  }
  const attributed = await ReferralService.attributeAtAuth(userId, email, code);
  res.json({ success: true, data: { attributed } });
};

// ── staff / admin ────────────────────────────────────────────────────────────

export const listPartners = async (_req: Request, res: Response): Promise<void> => {
  if (featureOff(res)) return;
  const partners = await ReferralService.listPartnersWithStats();
  res.json({ success: true, data: partners });
};

export const createPartner = async (req: Request, res: Response): Promise<void> => {
  if (featureOff(res)) return;
  const { code, name, email, provisionLogin } = req.body ?? {};
  if (!code || !name) {
    res.status(400).json({ success: false, error: 'code and name are required' });
    return;
  }
  try {
    const partner = await ReferralService.createPartner({
      code,
      name,
      email: email ?? null,
      provisionLogin: !!provisionLogin,
    });
    res.status(201).json({ success: true, data: partner });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create partner';
    logger.info('[REFERRAL] createPartner rejected', { message });
    res.status(400).json({ success: false, error: message });
  }
};

export const updatePartner = async (req: Request, res: Response): Promise<void> => {
  if (featureOff(res)) return;
  const { id } = req.params;
  const { name, email, status, rewardRate, rewardWindowCount } = req.body ?? {};
  if (status !== undefined && status !== 'active' && status !== 'disabled') {
    res.status(400).json({ success: false, error: 'status must be active or disabled' });
    return;
  }
  // Reward overrides: null clears the override (back to the global default); a
  // number must be in range. Anything else is rejected.
  if (rewardRate !== undefined && rewardRate !== null) {
    if (typeof rewardRate !== 'number' || !Number.isFinite(rewardRate) || rewardRate < 0 || rewardRate > 1) {
      res.status(400).json({ success: false, error: 'rewardRate must be a number between 0 and 1, or null' });
      return;
    }
  }
  if (rewardWindowCount !== undefined && rewardWindowCount !== null) {
    if (
      typeof rewardWindowCount !== 'number' ||
      !Number.isInteger(rewardWindowCount) ||
      rewardWindowCount < 0
    ) {
      res
        .status(400)
        .json({ success: false, error: 'rewardWindowCount must be a non-negative integer, or null' });
      return;
    }
  }
  const partner = await ReferralService.updatePartner(id, {
    name,
    email,
    status,
    rewardRate,
    rewardWindowCount,
  });
  if (!partner) {
    res.status(404).json({ success: false, error: 'Partner not found' });
    return;
  }
  res.json({ success: true, data: partner });
};
