/**
 * Unit tests for SelfServeProvisioningService.selfHealIfApproved — the /auth/me
 * safety net that guarantees an APPROVED user always ends up with a workspace,
 * regardless of which auth path created them.
 *
 * Each test maps to one invariant the heal must preserve:
 *   - only approved users are healed (never pending/rejected)
 *   - a user who already has a workspace triggers NO provisioning
 *   - a healthy verdict is cached → the DB probe is skipped next time
 *   - an approved user WITHOUT a workspace gets fully provisioned
 *   - failures never throw (must not break /auth/me)
 *
 * The db/ sublayer and the heavy collaborators (workspace/project/plan/credits)
 * are mocked at their module boundary; we drive the real service logic.
 */

const cacheStore = new Map<string, unknown>();
const calls = {
  hasWorkspace: 0,
  fetchStatus: 0,
  ensureWorkspace: 0,
  ensureProject: 0,
  assignPlan: 0,
  getOrCreateCredits: 0,
};

let hasWorkspaceImpl: () => Promise<boolean> = async () => true;
let fetchStatusImpl: () => Promise<string | null> = async () => 'approved';

jest.mock('@/utils/core/redis-cache', () => ({
  cache: {
    get: async (k: string) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    set: async (k: string, v: unknown) => { cacheStore.set(k, v); },
    del: async (...keys: string[]) => { keys.forEach((k) => cacheStore.delete(k)); },
  },
}));

jest.mock('@/services/core/db/self-serve.db', () => ({
  userHasAnyWorkspace: jest.fn(async () => { calls.hasWorkspace++; return hasWorkspaceImpl(); }),
  fetchUserStatus: jest.fn(async () => { calls.fetchStatus++; return fetchStatusImpl(); }),
  approvePendingUser: jest.fn(async () => null),
  markWorkspaceOnboardingCompleted: jest.fn(async () => {}),
}));

jest.mock('@/services/core/workspace.service', () => ({
  WorkspaceService: {
    checkOrCreateWorkspace: jest.fn(async () => { calls.ensureWorkspace++; return { workspace_id: 'ws-1', is_new: true }; }),
  },
}));
jest.mock('@/services/core/project.service', () => ({
  ProjectService: {
    createProject: jest.fn(async () => { calls.ensureProject++; return { id: 'p-1' }; }),
  },
}));
jest.mock('@/services/utils/project-context.service', () => ({
  ProjectContextService: { getDefaultProject: jest.fn(async () => null) },
}));
jest.mock('@/services/core/pricing-plans.service', () => ({
  PricingPlansService: { assignPlanToUser: jest.fn(async () => { calls.assignPlan++; return true; }) },
}));
jest.mock('@/services/core/user-credits.service', () => ({
  UserCreditsService: { getOrCreateUserCredits: jest.fn(async () => { calls.getOrCreateCredits++; return {}; }) },
}));
jest.mock('@/services/core/email.service', () => ({ EmailService: { sendApprovalEmail: jest.fn() } }));
jest.mock('@/config/environment/env', () => ({ env: { AUTO_APPROVE_SIGNUP: true, FRONTEND_URL: 'http://x' } }));

import { SelfServeProvisioningService } from '../self-serve-provisioning.service';

beforeEach(() => {
  cacheStore.clear();
  Object.keys(calls).forEach((k) => { (calls as any)[k] = 0; });
  hasWorkspaceImpl = async () => true;
  fetchStatusImpl = async () => 'approved';
});

describe('selfHealIfApproved', () => {
  it('does nothing for a pending user (no probe, no provisioning)', async () => {
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'pending_approval');
    expect(calls.hasWorkspace).toBe(0);
    expect(calls.ensureWorkspace).toBe(0);
  });

  it('does nothing for a rejected user', async () => {
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'rejected');
    expect(calls.ensureWorkspace).toBe(0);
  });

  it('reads status from DB when not passed, and heals an approved user without a workspace', async () => {
    hasWorkspaceImpl = async () => false;
    await SelfServeProvisioningService.selfHealIfApproved('u1'); // status omitted
    expect(calls.fetchStatus).toBe(1);
    expect(calls.ensureWorkspace).toBe(1);
    expect(calls.ensureProject).toBe(1);
    expect(calls.assignPlan).toBe(1);
    expect(calls.getOrCreateCredits).toBe(1);
  });

  it('does NOT provision an approved user who already has a workspace', async () => {
    hasWorkspaceImpl = async () => true;
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'approved');
    expect(calls.hasWorkspace).toBe(1);
    expect(calls.ensureWorkspace).toBe(0);
  });

  it('caches a healthy verdict so the DB probe is skipped on the next call', async () => {
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'approved');
    expect(calls.hasWorkspace).toBe(1);
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'approved');
    expect(calls.hasWorkspace).toBe(1); // fast path — no second probe
  });

  it('caches after a successful heal too (one heal, not repeated)', async () => {
    hasWorkspaceImpl = async () => false;
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'approved');
    expect(calls.ensureWorkspace).toBe(1);
    await SelfServeProvisioningService.selfHealIfApproved('u1', 'approved');
    expect(calls.ensureWorkspace).toBe(1); // cached, not healed again
  });

  it('never throws when the DB probe fails', async () => {
    hasWorkspaceImpl = async () => { throw new Error('db down'); };
    await expect(
      SelfServeProvisioningService.selfHealIfApproved('u1', 'approved'),
    ).resolves.toBeUndefined();
  });

  it('is a no-op for an empty userId', async () => {
    await SelfServeProvisioningService.selfHealIfApproved('', 'approved');
    expect(calls.hasWorkspace).toBe(0);
  });
});

describe('ensureFullyProvisioned', () => {
  it('grants plan + credits + workspace + project in one idempotent pass', async () => {
    await SelfServeProvisioningService.ensureFullyProvisioned('u1');
    expect(calls.assignPlan).toBe(1);
    expect(calls.getOrCreateCredits).toBe(1);
    expect(calls.ensureWorkspace).toBe(1);
    expect(calls.ensureProject).toBe(1);
  });

  it('still creates the workspace even if the credit/plan step throws', async () => {
    const { PricingPlansService } = jest.requireMock('@/services/core/pricing-plans.service');
    PricingPlansService.assignPlanToUser.mockImplementationOnce(async () => { throw new Error('plan boom'); });
    await SelfServeProvisioningService.ensureFullyProvisioned('u1');
    expect(calls.ensureWorkspace).toBe(1); // credit failure does not skip workspace
  });

  it('is a no-op for an empty userId', async () => {
    await SelfServeProvisioningService.ensureFullyProvisioned('');
    expect(calls.ensureWorkspace).toBe(0);
  });
});
