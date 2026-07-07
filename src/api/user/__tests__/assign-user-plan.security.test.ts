/**
 * Security regression tests for POST /api/v1/user/plan/assign (assignUserPlan).
 *
 * Bug history: the admin check read a client-supplied `x-user-id` HEADER instead
 * of the verified JWT identity (`req.user`). Any authenticated user who knew an
 * admin's UUID could put it in that header and grant any plan (with its credits)
 * to any account — privilege escalation.
 *
 * The fix derives the admin identity from `req.user.id` and adds `requireAdmin`
 * on the route. These tests lock in that the HEADER is ignored and only the JWT
 * identity decides admin access.
 */

import type { Request, Response } from 'express';
import { assignUserPlan } from '../user.controller';
import { PricingPlansService } from '@/services/core/pricing-plans.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ATTACKER_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

// isAdmin() reads users.role via supabaseAdmin — stub the boundary so role is
// driven per-test by which id is queried.
const adminIds = new Set<string>([ADMIN_ID]);

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => {
      const ctx: { id?: string } = {};
      const builder: any = {
        select: jest.fn(() => builder),
        eq: jest.fn((_col: string, val: string) => {
          ctx.id = val;
          return builder;
        }),
        maybeSingle: jest.fn(async () => ({
          data: ctx.id && adminIds.has(ctx.id) ? { role: 'admin' } : { role: 'user' },
          error: null,
        })),
      };
      return builder;
    }),
  },
}));

jest.spyOn(PricingPlansService, 'assignPlanToUser').mockResolvedValue(true);

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: any } = {};
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as any;
  res.json = jest.fn((payload: any) => {
    res.body = payload;
    return res as Response;
  }) as any;
  res.headersSent = false;
  return res as Response & { statusCode?: number; body?: any };
}

function mockReq(overrides: Partial<Request>): Request {
  return {
    headers: {},
    body: { user_id: TARGET_ID, plan_slug: 'pro' },
    ...overrides,
  } as Request;
}

describe('assignUserPlan — admin identity from JWT, not header', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (PricingPlansService.assignPlanToUser as jest.Mock).mockResolvedValue(true);
  });

  it('rejects a non-admin caller even when a spoofed admin x-user-id header is sent', async () => {
    const req = mockReq({
      user: { id: ATTACKER_ID, role: 'user' } as any,
      headers: { 'x-user-id': ADMIN_ID }, // spoofed — must be ignored
    });
    const res = mockRes();

    await assignUserPlan(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body?.code).toBe('ACCESS_DENIED');
    // The header must never grant access, and no plan is written.
    expect(PricingPlansService.assignPlanToUser).not.toHaveBeenCalled();
  });

  it('rejects when there is no authenticated user (req.user absent)', async () => {
    const req = mockReq({ user: undefined, headers: { 'x-user-id': ADMIN_ID } });
    const res = mockRes();

    await assignUserPlan(req, res);

    expect(res.statusCode).toBe(403);
    expect(PricingPlansService.assignPlanToUser).not.toHaveBeenCalled();
  });

  it('allows a genuine admin (JWT identity) and assigns the plan', async () => {
    const req = mockReq({ user: { id: ADMIN_ID, role: 'admin' } as any });
    const res = mockRes();

    await assignUserPlan(req, res);

    expect(res.body?.success).toBe(true);
    expect(PricingPlansService.assignPlanToUser).toHaveBeenCalledWith(TARGET_ID, 'pro');
  });

  it('validates the plan slug for an admin caller (rejects unknown slug)', async () => {
    const req = mockReq({
      user: { id: ADMIN_ID, role: 'admin' } as any,
      body: { user_id: TARGET_ID, plan_slug: 'enterprise' }, // not in [free, pro, team]
    });
    const res = mockRes();

    await assignUserPlan(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body?.code).toBe('INVALID_PLAN_SLUG');
    expect(PricingPlansService.assignPlanToUser).not.toHaveBeenCalled();
  });
});
