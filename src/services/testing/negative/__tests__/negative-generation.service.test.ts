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

  it('serializes concurrent calls for the same source (no double generate)', async () => {
    // First call sees 0 and generates; a second concurrent call must observe
    // the mutex and (after it releases) see the now-existing count.
    let count = 0;
    asMock(NegativeTestGeneratorService.getNegativeCount).mockImplementation(async () => count);
    asMock(NegativeTestGeneratorService.generateForTestCase).mockImplementation(async () => {
      count = 2; // generation populated the source
      return ['n1', 'n2'];
    });

    const [a, b] = await Promise.all([
      NegativeGenerationService.generateForSourceGuarded('s1', 'u1'),
      NegativeGenerationService.generateForSourceGuarded('s1', 'u1'),
    ]);

    const results = [a, b];
    expect(results.filter((r) => !r.skipped)).toHaveLength(1); // exactly one generated
    expect(results.filter((r) => r.skipped)).toHaveLength(1); // the other skipped
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
