/**
 * Unit tests for NegativeGenerationService — estimate + per-negative control +
 * guarded generation/regenerate. DB stubbed at the negative `db/` boundary;
 * generator, plan service, and toggle resolver stubbed.
 */

jest.mock('../db/negative.db', () => ({
  getNegativeOwnership: jest.fn(),
  getTestCaseOwner: jest.fn(),
  deleteNegativeById: jest.fn(),
  setNegativeEnabled: jest.fn(),
  getAvgDurationMsForTestCases: jest.fn(),
  getSourcesWithFreshNegatives: jest.fn(),
  anySourceIsMobile: jest.fn().mockResolvedValue(false),
  getNegativesOwnership: jest.fn(),
  setNegativeEnabledByIds: jest.fn(),
  deleteNegativesByIds: jest.fn(),
}));

jest.mock('@/services/core/plan-access.service', () => ({
  isPaidUser: jest.fn().mockResolvedValue(true),
}));

// In-memory Redis stand-in emulating SET NX EX + the compare-and-del eval, so
// the cross-process source lock behaves deterministically in unit tests.
const redisStore = new Map<string, string>();
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {
    set: jest.fn(async (key: string, val: string, ..._args: any[]) => {
      // We are always called as SET key val EX <sec> NX in this module.
      if (redisStore.has(key)) return null; // NX: already held
      redisStore.set(key, val);
      return 'OK';
    }),
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (redisStore.get(key) === token) {
        redisStore.delete(key);
        return 1;
      }
      return 0;
    }),
  },
}));

jest.mock('@/services/testing/regression/db/regression.db', () => ({
  getProjectForAccess: jest.fn(),
}));

jest.mock('@/services/core/workspace-access.service', () => ({
  WorkspaceAccessService: { getRole: jest.fn() },
}));

jest.mock('@/services/testing/plans/regression-plan.service', () => ({
  RegressionPlanService: { getById: jest.fn(), expandPlan: jest.fn() },
}));

jest.mock('@/services/testing/plans/negative-toggle-resolver.service', () => ({
  NegativeToggleResolverService: { getEnabledTestCaseIds: jest.fn() },
}));

jest.mock('../negative-test-generator.service', () => ({
  NegativeTestGeneratorService: {
    getNegativeCount: jest.fn(),
    generateForTestCase: jest.fn(),
    deleteExistingNegatives: jest.fn(),
  },
}));

import { NegativeGenerationService } from '../negative-generation.service';
import * as negativeDb from '../db/negative.db';
import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { NegativeToggleResolverService } from '@/services/testing/plans/negative-toggle-resolver.service';
import { NegativeTestGeneratorService } from '../negative-test-generator.service';
import { getProjectForAccess } from '@/services/testing/regression/db/regression.db';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';

const asMock = (fn: unknown) => fn as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  asMock(RegressionPlanService.getById).mockResolvedValue({ id: 'p1' }); // plan access ok
  // Default: project owned by the acting user → project access granted.
  asMock(getProjectForAccess).mockResolvedValue({ user_id: 'u1', workspace_id: null });
});

describe('estimate', () => {
  it('counts only sources lacking fresh negatives and uses historical avg duration', async () => {
    asMock(NegativeToggleResolverService.getEnabledTestCaseIds).mockResolvedValue(['a', 'b', 'c']);
    // a has fresh negatives (skip), b & c are pending
    asMock(negativeDb.getSourcesWithFreshNegatives).mockResolvedValue(new Set(['a']));
    asMock(negativeDb.getAvgDurationMsForTestCases).mockResolvedValue(30_000); // 30s/test

    const r = await NegativeGenerationService.estimate('p1', 'u1');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.pendingSources).toBe(2);
    expect(r.data.estimatedNegatives).toBe(8); // 2 * 4
    expect(r.data.estimatedMinutes).toBe(4); // 8 * 30s = 240s = 4 min
  });

  it('falls back to a default per-test time when there is no history', async () => {
    asMock(NegativeToggleResolverService.getEnabledTestCaseIds).mockResolvedValue(['a']);
    asMock(negativeDb.getSourcesWithFreshNegatives).mockResolvedValue(new Set());
    asMock(negativeDb.getAvgDurationMsForTestCases).mockResolvedValue(null);

    const r = await NegativeGenerationService.estimate('p1', 'u1');
    if (r.status !== 'ok') throw new Error('expected ok');
    // 4 negatives * 45s fallback = 180s = 3 min
    expect(r.data.estimatedMinutes).toBe(3);
  });

  it('returns plan_not_found when access is denied', async () => {
    asMock(RegressionPlanService.getById).mockResolvedValue(null);
    const r = await NegativeGenerationService.estimate('p1', 'u1');
    expect(r.status).toBe('plan_not_found');
  });
});

describe('deleteNegative', () => {
  it('deletes when the caller has project access', async () => {
    asMock(negativeDb.getNegativeOwnership).mockResolvedValue({ id: 'n1', userId: 'u1', projectId: 'pr1', sourceTestCaseId: 's1' });
    asMock(negativeDb.deleteNegativeById).mockResolvedValue(true);
    expect(await NegativeGenerationService.deleteNegative('n1', 'u1')).toEqual({ status: 'ok' });
  });

  it('allows a workspace teammate (not the owner) via workspace role', async () => {
    asMock(negativeDb.getNegativeOwnership).mockResolvedValue({ id: 'n1', userId: 'owner', projectId: 'pr1', sourceTestCaseId: 's1' });
    asMock(getProjectForAccess).mockResolvedValue({ user_id: 'owner', workspace_id: 'w1' });
    asMock(WorkspaceAccessService.getRole).mockResolvedValue('member');
    asMock(negativeDb.deleteNegativeById).mockResolvedValue(true);
    expect(await NegativeGenerationService.deleteNegative('n1', 'teammate')).toEqual({ status: 'ok' });
  });

  it('forbids a user with no project/workspace access', async () => {
    asMock(negativeDb.getNegativeOwnership).mockResolvedValue({ id: 'n1', userId: 'owner', projectId: 'pr1', sourceTestCaseId: 's1' });
    asMock(getProjectForAccess).mockResolvedValue({ user_id: 'owner', workspace_id: 'w1' });
    asMock(WorkspaceAccessService.getRole).mockResolvedValue(null);
    expect(await NegativeGenerationService.deleteNegative('n1', 'stranger')).toEqual({ status: 'forbidden' });
    expect(negativeDb.deleteNegativeById).not.toHaveBeenCalled();
  });

  it('returns not_found for a missing negative', async () => {
    asMock(negativeDb.getNegativeOwnership).mockResolvedValue(null);
    expect(await NegativeGenerationService.deleteNegative('n1', 'u1')).toEqual({ status: 'not_found' });
  });
});

describe('setNegativeEnabled', () => {
  it('toggles when the caller has project access', async () => {
    asMock(negativeDb.getNegativeOwnership).mockResolvedValue({ id: 'n1', userId: 'u1', projectId: 'pr1', sourceTestCaseId: 's1' });
    asMock(negativeDb.setNegativeEnabled).mockResolvedValue(true);
    expect(await NegativeGenerationService.setNegativeEnabled('n1', 'u1', false)).toEqual({ status: 'ok' });
    expect(negativeDb.setNegativeEnabled).toHaveBeenCalledWith('n1', false);
  });

  it('forbids a user with no access', async () => {
    asMock(negativeDb.getNegativeOwnership).mockResolvedValue({ id: 'n1', userId: 'owner', projectId: 'pr1', sourceTestCaseId: 's1' });
    asMock(getProjectForAccess).mockResolvedValue({ user_id: 'owner', workspace_id: null });
    expect(await NegativeGenerationService.setNegativeEnabled('n1', 'stranger', true)).toEqual({ status: 'forbidden' });
  });
});

describe('generateForSourceGuarded', () => {
  it('skips when fresh negatives already exist', async () => {
    asMock(NegativeTestGeneratorService.getNegativeCount).mockResolvedValue(3);
    const r = await NegativeGenerationService.generateForSourceGuarded('s1', 'u1');
    expect(r).toEqual({ skipped: true });
    expect(NegativeTestGeneratorService.generateForTestCase).not.toHaveBeenCalled();
  });

  it('generates when none exist', async () => {
    asMock(NegativeTestGeneratorService.getNegativeCount).mockResolvedValue(0);
    asMock(NegativeTestGeneratorService.generateForTestCase).mockResolvedValue(['n1', 'n2']);
    const r = await NegativeGenerationService.generateForSourceGuarded('s1', 'u1');
    expect(r).toEqual({ skipped: false, createdIds: ['n1', 'n2'] });
  });

  it('cross-process source lock: a concurrent call is skipped, no double generate', async () => {
    // The first call holds the Redis lock through a slow generation; the second
    // concurrent call cannot acquire it (NX fails) and is skipped rather than
    // double-generating. This is the cross-process guard (API regenerate vs
    // worker job) the in-memory Map could not provide.
    let count = 0;
    asMock(NegativeTestGeneratorService.getNegativeCount).mockImplementation(async () => count);
    let resolveGen!: (v: string[]) => void;
    asMock(NegativeTestGeneratorService.generateForTestCase).mockImplementation(
      () =>
        new Promise<string[]>((r) => {
          resolveGen = (v: string[]) => {
            count = 2; // generation populated the source
            r(v);
          };
        }),
    );

    // Start the first (acquires the lock and parks in generation).
    const first = NegativeGenerationService.generateForSourceGuarded('s1', 'u1');
    // Yield so the first acquires the lock before the second tries.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // Second call: lock is held → it will poll. Let the first finish first.
    const second = NegativeGenerationService.generateForSourceGuarded('s1', 'u1');
    resolveGen(['n1', 'n2']);

    const [a, b] = await Promise.all([first, second]);
    const results = [a, b];
    // Exactly one generated; the other skipped (lock contention OR count>0).
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(results.filter((r) => r.skipped)).toHaveLength(1);
    expect(NegativeTestGeneratorService.generateForTestCase).toHaveBeenCalledTimes(1);
  });
});

describe('regenerate', () => {
  it('deletes then generates when the caller has access to the source', async () => {
    asMock(negativeDb.getTestCaseOwner).mockResolvedValue({ userId: 'u1', projectId: 'pr1' });
    asMock(NegativeTestGeneratorService.deleteExistingNegatives).mockResolvedValue(2);
    asMock(NegativeTestGeneratorService.generateForTestCase).mockResolvedValue(['n1', 'n2', 'n3']);

    const r = await NegativeGenerationService.regenerate('s1', 'u1');
    expect(r).toEqual({ status: 'ok', createdIds: ['n1', 'n2', 'n3'] });
    expect(NegativeTestGeneratorService.deleteExistingNegatives).toHaveBeenCalledWith('s1');
  });

  it('forbids regenerating a source the user can’t access', async () => {
    asMock(negativeDb.getTestCaseOwner).mockResolvedValue({ userId: 'other', projectId: 'pr1' });
    asMock(getProjectForAccess).mockResolvedValue({ user_id: 'other', workspace_id: null });
    const r = await NegativeGenerationService.regenerate('s1', 'u1');
    expect(r).toEqual({ status: 'forbidden' });
    expect(NegativeTestGeneratorService.deleteExistingNegatives).not.toHaveBeenCalled();
  });

  it('returns not_found for a missing source', async () => {
    asMock(negativeDb.getTestCaseOwner).mockResolvedValue(null);
    expect(await NegativeGenerationService.regenerate('s1', 'u1')).toEqual({ status: 'not_found' });
  });

  it('returns error (no throw) when generation fails', async () => {
    asMock(negativeDb.getTestCaseOwner).mockResolvedValue({ userId: 'u1', projectId: 'pr1' });
    asMock(NegativeTestGeneratorService.deleteExistingNegatives).mockResolvedValue(0);
    asMock(NegativeTestGeneratorService.generateForTestCase).mockRejectedValue(new Error('boom'));

    const r = await NegativeGenerationService.regenerate('s1', 'u1');
    expect(r.status).toBe('error');
  });
});

describe('bulkSetEnabled / bulkDelete', () => {
  it('mutates only negatives the user can access, reports forbidden count', async () => {
    // n1,n2 in an accessible project (u1 owns pr1); n3 in a project u1 can't.
    asMock(negativeDb.getNegativesOwnership).mockResolvedValue([
      { id: 'n1', projectId: 'pr1' },
      { id: 'n2', projectId: 'pr1' },
      { id: 'n3', projectId: 'prX' },
    ]);
    asMock(getProjectForAccess).mockImplementation(async (projectId: string) =>
      projectId === 'pr1' ? { user_id: 'u1', workspace_id: null } : { user_id: 'other', workspace_id: null },
    );
    asMock(negativeDb.setNegativeEnabledByIds).mockResolvedValue(2);

    const r = await NegativeGenerationService.bulkSetEnabled(['n1', 'n2', 'n3'], 'u1', false);

    expect(r).toEqual({ status: 'ok', updated: 2, forbidden: 1 });
    // Only the accessible ids reach the db mutation.
    expect(negativeDb.setNegativeEnabledByIds).toHaveBeenCalledWith(['n1', 'n2'], false);
  });

  it('bulkDelete deletes only accessible ids', async () => {
    asMock(negativeDb.getNegativesOwnership).mockResolvedValue([
      { id: 'n1', projectId: 'pr1' },
      { id: 'n2', projectId: 'prX' },
    ]);
    asMock(getProjectForAccess).mockImplementation(async (projectId: string) =>
      projectId === 'pr1' ? { user_id: 'u1', workspace_id: null } : { user_id: 'other', workspace_id: null },
    );
    asMock(negativeDb.deleteNegativesByIds).mockResolvedValue(1);

    const r = await NegativeGenerationService.bulkDelete(['n1', 'n2'], 'u1');

    expect(r).toEqual({ status: 'ok', deleted: 1, forbidden: 1 });
    expect(negativeDb.deleteNegativesByIds).toHaveBeenCalledWith(['n1']);
  });

  it('dedupes ids and never calls the db when nothing is accessible', async () => {
    asMock(negativeDb.getNegativesOwnership).mockResolvedValue([{ id: 'n1', projectId: 'prX' }]);
    asMock(getProjectForAccess).mockResolvedValue({ user_id: 'other', workspace_id: null });

    const r = await NegativeGenerationService.bulkSetEnabled(['n1', 'n1'], 'u1', true);

    expect(r).toEqual({ status: 'ok', updated: 0, forbidden: 1 });
    expect(negativeDb.setNegativeEnabledByIds).not.toHaveBeenCalled();
  });

  it('returns zeros for an empty id list without touching the db', async () => {
    asMock(negativeDb.getNegativesOwnership).mockResolvedValue([]);
    const r = await NegativeGenerationService.bulkDelete([], 'u1');
    expect(r).toEqual({ status: 'ok', deleted: 0, forbidden: 0 });
    expect(negativeDb.deleteNegativesByIds).not.toHaveBeenCalled();
  });
});
