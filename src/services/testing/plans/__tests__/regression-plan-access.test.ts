/**
 * Tests for the workspace-membership access gate on
 * `RegressionPlanService.getById`.
 *
 * Background: before this change, `getById` filtered with
 * `.eq('user_id', userId)`, meaning only the plan's creator could open
 * the plan — even other active members of the same workspace got a
 * "Plan not found" / "Failed to load regression plan" error. The fix
 * loads the plan unconditionally, joins through `projects.workspace_id`,
 * and authorises on `WorkspaceAccessService.hasPermission(...,
 * PROJECT_READ)`.
 *
 * These tests pin the new contract.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks must be declared BEFORE the SUT is imported ────────────────

const __planRow: { data: any; error: any } = {
  data: null,
  error: null,
};

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn((table: string) => {
      if (table === 'regression_plans') {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              single: jest.fn(async () => ({ data: __planRow.data, error: __planRow.error })),
            })),
          })),
        };
      }
      // Defensive default for unexpected tables in this narrow test.
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ single: jest.fn(async () => ({ data: null, error: null })) })),
        })),
      };
    }),
  },
}));

jest.mock('@/services/core/workspace-access.service', () => {
  const actual = jest.requireActual('@/services/core/workspace-access.service');
  return {
    ...actual,
    WorkspaceAccessService: {
      hasPermission: jest.fn(),
    },
  };
});

// Heavy collaborators that don't need to exist for this test surface
jest.mock('@/services/integrations/git-integration.service', () => ({
  GitIntegrationService: { onPlanCreated: jest.fn(), onPlanUpdated: jest.fn() },
}));
jest.mock('@/services/testing/schedules/schedule.service', () => ({
  ScheduleService: { syncForPlan: jest.fn() },
}));
jest.mock('@/utils/core/redis-cache', () => ({
  cache: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  },
}));

import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { RegressionPlanService } from '../regression-plan.service';

const mockHasPermission = WorkspaceAccessService.hasPermission as jest.MockedFunction<
  typeof WorkspaceAccessService.hasPermission
>;

const VALID_PLAN_ROW = {
  id: 'plan-1',
  project_id: 'proj-1',
  user_id: 'creator-user',
  name: 'My Plan',
  description: null,
  is_default: false,
  tags: [],
  automation_config: null,
  notifications_enabled: true,
  schedule_id: null,
  mobile_build_mode: 'latest',
  pinned_mobile_app_build_id: null,
  created_at: '2026-05-01T00:00:00.000Z',
  updated_at: '2026-05-01T00:00:00.000Z',
  // The join field returned by `*, projects!inner(workspace_id)`.
  projects: { workspace_id: 'ws-1' },
};

describe('RegressionPlanService.getById — workspace-membership access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __planRow.data = null;
    __planRow.error = null;
  });

  it('returns the plan when caller is a workspace member with PROJECT_READ', async () => {
    __planRow.data = VALID_PLAN_ROW;
    mockHasPermission.mockResolvedValue(true);

    // Caller is NOT the original creator — this is the regression
    // case beknur hit. Pre-fix this returned null; post-fix it returns
    // the plan because the caller is a workspace member.
    const result = await RegressionPlanService.getById('plan-1', 'other-member-user');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('plan-1');
    expect(mockHasPermission).toHaveBeenCalledWith(
      'other-member-user',
      'ws-1',
      'project:read',
    );
  });

  it('returns null when caller has no workspace access', async () => {
    __planRow.data = VALID_PLAN_ROW;
    mockHasPermission.mockResolvedValue(false);

    const result = await RegressionPlanService.getById('plan-1', 'random-outsider');

    expect(result).toBeNull();
    expect(mockHasPermission).toHaveBeenCalledWith(
      'random-outsider',
      'ws-1',
      'project:read',
    );
  });

  it('returns null when the plan does not exist (PGRST116)', async () => {
    __planRow.data = null;
    __planRow.error = { code: 'PGRST116', message: 'Results contain 0 rows' };

    const result = await RegressionPlanService.getById('missing', 'any-user');

    expect(result).toBeNull();
    // Permission check should be SKIPPED — no row means no workspace
    // to authorise against.
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  it('throws on unexpected DB errors (not PGRST116)', async () => {
    __planRow.data = null;
    __planRow.error = { code: 'PGRST500', message: 'simulated DB outage' };

    await expect(
      RegressionPlanService.getById('plan-1', 'any-user'),
    ).rejects.toThrow(/Failed to get plan/);
  });

  it('returns null when the joined project has no workspace_id (orphan)', async () => {
    __planRow.data = { ...VALID_PLAN_ROW, projects: { workspace_id: null } };

    const result = await RegressionPlanService.getById('plan-1', 'any-user');

    expect(result).toBeNull();
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  it('handles `projects` returned as an array (defensive against type-gen changes)', async () => {
    __planRow.data = {
      ...VALID_PLAN_ROW,
      projects: [{ workspace_id: 'ws-1' }],
    };
    mockHasPermission.mockResolvedValue(true);

    const result = await RegressionPlanService.getById('plan-1', 'member-user');

    expect(result?.id).toBe('plan-1');
    expect(mockHasPermission).toHaveBeenCalledWith(
      'member-user',
      'ws-1',
      'project:read',
    );
  });
});
