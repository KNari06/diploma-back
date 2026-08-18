/**
 * Unit tests for `applyDoctorFinding`.
 *
 * Mocked at the `db/` boundary, per the repo's testing rules — the previous
 * suite stood up a 600-line in-memory Supabase fake, which the rules
 * specifically forbid and which made the concurrency cases hard to read. With a
 * db/ sublayer, "the user edited the row between our read and our write" is one
 * mock return value.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { StepPatch } from '../types';

jest.mock('../db/regression-doctor-apply.db');
jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn().mockResolvedValue(undefined) },
}));

import * as db from '../db/regression-doctor-apply.db';
import { cache } from '@/utils/core/redis-cache';
import {
  applyDoctorFinding,
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
} from '../apply.service';

const mockDb = db as jest.Mocked<typeof db>;

const PATCH: StepPatch = {
  action: 'update_element',
  reason: 'renamed in 2.3',
  description: 'the Support entry',
  bindingHints: { label: 'Поддержка' },
};

const finding = (overrides: Partial<db.FindingForApplyRow> = {}): db.FindingForApplyRow => ({
  id: 'finding-1',
  user_id: 'user-1',
  project_id: 'project-1',
  status: 'open',
  verdict: 'test_fix',
  test_case_id: 'tc-1',
  step_id: 'step-1',
  proposed_patch: PATCH,
  affected_test_ids: ['tc-1'],
  ...overrides,
});

const testCase = (overrides: Partial<db.TestCaseForApplyRow> = {}): db.TestCaseForApplyRow => ({
  id: 'tc-1',
  user_id: 'user-1',
  project_id: 'project-1',
  flow_id: 'flow-1',
  steps_json: [
    { id: 'step-1', type: 'click', description: 'the old entry' } as IntentStep,
  ],
  updated_at: '2026-08-13T10:00:00Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();

  mockDb.getFindingForApply.mockResolvedValue(finding());
  mockDb.getTestCaseForApply.mockResolvedValue({ row: testCase(), error: null });
  mockDb.insertApplySnapshot.mockResolvedValue({ id: 'snapshot-1', error: null });
  mockDb.updateStepsJsonIfUnchanged.mockResolvedValue({ written: 1, error: null });
  mockDb.deleteApplySnapshot.mockResolvedValue({ error: null });
  mockDb.markFindingApplied.mockResolvedValue({ written: 1, error: null });
  mockDb.markNegativesStaleForTestCase.mockResolvedValue({ count: 0, error: null });
});

describe('validation', () => {
  it('rejects a finding that does not exist', async () => {
    mockDb.getFindingForApply.mockResolvedValue(null);
    await expect(applyDoctorFinding({ findingId: 'x', userId: 'user-1' })).rejects.toThrow(
      ApplyNotFoundError,
    );
  });

  it('rejects a finding owned by someone else', async () => {
    mockDb.getFindingForApply.mockResolvedValue(finding({ user_id: 'someone-else' }));
    await expect(applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      ApplyAccessError,
    );
  });

  it('rejects a finding that was already applied', async () => {
    mockDb.getFindingForApply.mockResolvedValue(finding({ status: 'applied' }));
    await expect(applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      ApplyConflictError,
    );
  });

  it('refuses to apply a finding that blames the application', async () => {
    // Applying "a fix" to a real bug is how the bug stops being reported.
    mockDb.getFindingForApply.mockResolvedValue(
      finding({ verdict: 'app_bug', proposed_patch: PATCH }),
    );
    await expect(applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      /app_bug/,
    );
  });

  it('rejects a finding that identifies no step', async () => {
    mockDb.getFindingForApply.mockResolvedValue(finding({ step_id: null }));
    await expect(applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      ApplyConflictError,
    );
  });
});

describe('happy path', () => {
  it('writes the patched steps and marks the finding applied', async () => {
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    expect(result.findingStatus).toBe('applied');
    expect(result.results).toEqual([
      expect.objectContaining({ testCaseId: 'tc-1', status: 'applied' }),
    ]);
    expect(mockDb.updateStepsJsonIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ testCaseId: 'tc-1', expectedUpdatedAt: '2026-08-13T10:00:00Z' }),
    );
  });

  it('snapshots the pre-apply steps before writing', async () => {
    await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    const snapshotCall = mockDb.insertApplySnapshot.mock.calls[0][0];
    expect(snapshotCall.steps_before[0].description).toBe('the old entry');
    expect(snapshotCall.steps_after[0].description).toBe('the Support entry');
    expect(mockDb.insertApplySnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.updateStepsJsonIfUnchanged.mock.invocationCallOrder[0],
    );
  });

  it('marks derived negative tests stale', async () => {
    // Negatives are generated by mutating the parent's steps; patching the
    // parent without this leaves them asserting against a step that is gone.
    await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(mockDb.markNegativesStaleForTestCase).toHaveBeenCalledWith('tc-1');
  });

  it('invalidates the flow-tree cache', async () => {
    await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(cache.delByPattern).toHaveBeenCalledWith('qait:cache:ptree:flow:flow-1:*');
  });

  it('still reports success when a best-effort side effect fails', async () => {
    mockDb.markNegativesStaleForTestCase.mockRejectedValue(new Error('redis down'));
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0].status).toBe('applied');
  });
});

describe('per-test outcomes', () => {
  it('skips a test case the user does not own', async () => {
    mockDb.getTestCaseForApply.mockResolvedValue({
      row: testCase({ user_id: 'someone-else' }),
      error: null,
    });
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'access_denied' });
  });

  it('skips a test case whose steps no longer contain the finding step', async () => {
    mockDb.getTestCaseForApply.mockResolvedValue({
      row: testCase({ steps_json: [{ id: 'other-step', type: 'click', description: 'x' } as IntentStep] }),
      error: null,
    });
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'no_step_matched' });
    expect(mockDb.updateStepsJsonIfUnchanged).not.toHaveBeenCalled();
  });

  it('skips a patch that does not fit the step type', async () => {
    mockDb.getFindingForApply.mockResolvedValue(
      finding({
        proposed_patch: {
          action: 'update_assertion',
          reason: 'x',
          assertionText: 'something',
        } as StepPatch,
      }),
    );
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'patch_not_applicable' });
  });

  it('reports a concurrent edit instead of overwriting the user', async () => {
    mockDb.updateStepsJsonIfUnchanged.mockResolvedValue({ written: 0, error: null });
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'concurrent_edit' });
  });

  it('deletes the orphaned snapshot after a concurrent edit', async () => {
    mockDb.updateStepsJsonIfUnchanged.mockResolvedValue({ written: 0, error: null });
    await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(mockDb.deleteApplySnapshot).toHaveBeenCalledWith('snapshot-1');
  });

  it('does not claim an applied transition another request performed', async () => {
    mockDb.markFindingApplied.mockResolvedValue({ written: 0, error: null });
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0].status).toBe('applied');
    expect(result.findingStatus).toBe('open');
  });

  it('leaves the finding open when every test case was skipped', async () => {
    mockDb.updateStepsJsonIfUnchanged.mockResolvedValue({ written: 0, error: null });
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.findingStatus).toBe('open');
    expect(mockDb.markFindingApplied).not.toHaveBeenCalled();
  });

  it('detects a patch that is already present', async () => {
    mockDb.getTestCaseForApply.mockResolvedValue({
      row: testCase({
        steps_json: [
          {
            id: 'step-1',
            type: 'click',
            description: 'the Support entry',
            bindingHints: { label: 'Поддержка' },
          } as IntentStep,
        ],
      }),
      error: null,
    });
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'already_patched' });
  });

  it('keeps going when one test case fails', async () => {
    mockDb.getFindingForApply.mockResolvedValue(
      finding({ affected_test_ids: ['tc-1', 'tc-2'] }),
    );
    mockDb.getTestCaseForApply
      .mockResolvedValueOnce({ row: null, error: 'boom' })
      .mockResolvedValueOnce({ row: testCase({ id: 'tc-2' }), error: null });

    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('error');
    expect(result.results[1].status).toBe('applied');
    expect(result.findingStatus).toBe('applied');
  });
});

describe('subset selection', () => {
  it('drops ids that are not part of the finding', async () => {
    // Stale client state must never reach an unrelated test case.
    const result = await applyDoctorFinding({
      findingId: 'finding-1',
      userId: 'user-1',
      testCaseIds: ['tc-1', 'tc-not-affected'],
    });
    expect(result.totalRequested).toBe(1);
    expect(mockDb.getTestCaseForApply).toHaveBeenCalledTimes(1);
  });

  it('rejects a selection that intersects to nothing', async () => {
    await expect(
      applyDoctorFinding({
        findingId: 'finding-1',
        userId: 'user-1',
        testCaseIds: ['tc-not-affected'],
      }),
    ).rejects.toThrow(ApplyConflictError);
  });

  it('applies to its own test case even when affected_test_ids is empty', async () => {
    mockDb.getFindingForApply.mockResolvedValue(finding({ affected_test_ids: [] }));
    const result = await applyDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ testCaseId: 'tc-1', status: 'applied' });
  });
});
