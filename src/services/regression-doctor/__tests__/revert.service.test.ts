/**
 * Unit tests for `revertDoctorFinding`, mocked at the `db/` boundary.
 *
 * The behaviour that matters most here is the refusal: a revert must never
 * overwrite work the user did after the apply.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

jest.mock('../db/regression-doctor-apply.db');
jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn().mockResolvedValue(undefined) },
}));
// Owner OR project member; the membership half is tested in the shared
// project-access service. Default here: not a member.
jest.mock('@/services/core/project-access.service', () => ({
  hasProjectAccess: jest.fn().mockResolvedValue(false),
}));

import * as db from '../db/regression-doctor-apply.db';
import { hasProjectAccess } from '@/services/core/project-access.service';
import { revertDoctorFinding } from '../revert.service';
import { ApplyAccessError, ApplyConflictError, ApplyNotFoundError } from '../apply.service';

const mockDb = db as jest.Mocked<typeof db>;

const STEPS_BEFORE = [{ id: 'step-1', type: 'click', description: 'the old entry' } as IntentStep];
const STEPS_AFTER = [{ id: 'step-1', type: 'click', description: 'the Support entry' } as IntentStep];

const snapshot = (overrides: Partial<db.SnapshotRow> = {}): db.SnapshotRow => ({
  id: 'snapshot-1',
  test_case_id: 'tc-1',
  steps_before: STEPS_BEFORE,
  steps_after: STEPS_AFTER,
  ...overrides,
});

const testCase = (overrides: Partial<db.TestCaseForApplyRow> = {}): db.TestCaseForApplyRow => ({
  id: 'tc-1',
  user_id: 'user-1',
  project_id: 'project-1',
  flow_id: null,
  steps_json: STEPS_AFTER,
  updated_at: '2026-08-13T11:00:00Z',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();

  (hasProjectAccess as jest.Mock).mockResolvedValue(false);
  mockDb.getFindingForRevert.mockResolvedValue({
    id: 'finding-1',
    user_id: 'user-1',
    project_id: 'project-1',
    status: 'applied',
  });
  mockDb.getSnapshotsForFinding.mockResolvedValue([snapshot()]);
  mockDb.getTestCaseForApply.mockResolvedValue({ row: testCase(), error: null });
  mockDb.updateStepsJsonIfUnchanged.mockResolvedValue({ written: 1, error: null });
  mockDb.deleteApplySnapshot.mockResolvedValue({ error: null });
  mockDb.countSnapshotsForFinding.mockResolvedValue({ count: 0, error: null });
  mockDb.markFindingOpen.mockResolvedValue({ error: null });
  mockDb.markNegativesStaleForTestCase.mockResolvedValue({ count: 0, error: null });
});

describe('validation', () => {
  it('rejects a finding that does not exist', async () => {
    mockDb.getFindingForRevert.mockResolvedValue(null);
    await expect(revertDoctorFinding({ findingId: 'x', userId: 'user-1' })).rejects.toThrow(
      ApplyNotFoundError,
    );
  });

  it('rejects a finding owned by someone outside the project', async () => {
    mockDb.getFindingForRevert.mockResolvedValue({
      id: 'finding-1',
      user_id: 'someone-else',
      project_id: 'project-1',
      status: 'applied',
    });
    await expect(revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      ApplyAccessError,
    );
  });

  it('rejects a finding that was never applied', async () => {
    mockDb.getFindingForRevert.mockResolvedValue({
      id: 'finding-1',
      user_id: 'user-1',
      project_id: 'project-1',
      status: 'open',
    });
    await expect(revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      ApplyConflictError,
    );
  });

  it('rejects a finding with no snapshots to restore', async () => {
    mockDb.getSnapshotsForFinding.mockResolvedValue([]);
    await expect(revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' })).rejects.toThrow(
      ApplyConflictError,
    );
  });
});

describe('workspace access', () => {
  // Deliberate product call: a workspace member may revert a teammate's apply.
  // The snapshot model supports it, and the same member could already undo the
  // change by hand in the editor (canWriteTestCase = owner OR member), so
  // refusing here would only make the audited path harder than the unaudited one.
  it("lets a workspace member revert a teammate's apply", async () => {
    (hasProjectAccess as jest.Mock).mockResolvedValue(true);
    mockDb.getFindingForRevert.mockResolvedValue({
      id: 'finding-1',
      user_id: 'teammate',
      project_id: 'project-1',
      status: 'applied',
    });
    mockDb.getTestCaseForApply.mockResolvedValue({
      row: testCase({ user_id: 'teammate' }),
      error: null,
    });

    const result = await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    expect(result.results[0]).toMatchObject({ status: 'reverted' });
    expect(hasProjectAccess).toHaveBeenCalledWith('project-1', 'user-1');
  });
});

describe('happy path', () => {
  it('restores the exact pre-apply steps', async () => {
    const result = await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    expect(result.results[0]).toMatchObject({ snapshotId: 'snapshot-1', status: 'reverted' });
    expect(mockDb.updateStepsJsonIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ steps: STEPS_BEFORE }),
    );
  });

  it('deletes the snapshot it consumed', async () => {
    await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(mockDb.deleteApplySnapshot).toHaveBeenCalledWith('snapshot-1');
  });

  it('reopens the finding once every snapshot is gone', async () => {
    const result = await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(mockDb.markFindingOpen).toHaveBeenCalledWith('finding-1');
    expect(result.findingStatus).toBe('open');
  });

  it('marks negatives stale — a revert changes steps like any other write', async () => {
    await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(mockDb.markNegativesStaleForTestCase).toHaveBeenCalledWith('tc-1');
  });
});

describe('refusals', () => {
  it('will not overwrite edits the user made after the apply', async () => {
    mockDb.getTestCaseForApply.mockResolvedValue({
      row: testCase({
        steps_json: [
          { id: 'step-1', type: 'click', description: 'hand-tuned by the user' } as IntentStep,
        ],
      }),
      error: null,
    });

    const result = await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'modified_after_apply' });
    expect(mockDb.updateStepsJsonIfUnchanged).not.toHaveBeenCalled();
  });

  it('backs off on a concurrent edit and keeps the snapshot', async () => {
    mockDb.updateStepsJsonIfUnchanged.mockResolvedValue({ written: 0, error: null });
    mockDb.countSnapshotsForFinding.mockResolvedValue({ count: 1, error: null });

    const result = await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });

    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'concurrent_edit' });
    expect(mockDb.deleteApplySnapshot).not.toHaveBeenCalled();
  });

  it('skips a test case the user does not own', async () => {
    mockDb.getTestCaseForApply.mockResolvedValue({
      row: testCase({ user_id: 'someone-else' }),
      error: null,
    });
    const result = await revertDoctorFinding({ findingId: 'finding-1', userId: 'user-1' });
    expect(result.results[0]).toMatchObject({ status: 'skipped', reason: 'access_denied' });
  });
});

describe('partial revert', () => {
  it('keeps the finding applied while any snapshot remains', async () => {
    mockDb.getSnapshotsForFinding.mockResolvedValue([
      snapshot(),
      snapshot({ id: 'snapshot-2', test_case_id: 'tc-2' }),
    ]);
    mockDb.countSnapshotsForFinding.mockResolvedValue({ count: 1, error: null });

    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: 'user-1',
      snapshotIds: ['snapshot-1'],
    });

    expect(result.findingStatus).toBe('applied');
    expect(result.remainingSnapshots).toBe(1);
    expect(mockDb.markFindingOpen).not.toHaveBeenCalled();
  });

  it('ignores snapshot ids that belong to another finding', async () => {
    const result = await revertDoctorFinding({
      findingId: 'finding-1',
      userId: 'user-1',
      snapshotIds: ['snapshot-1', 'snapshot-from-elsewhere'],
    });
    expect(result.totalRequested).toBe(1);
  });
});
