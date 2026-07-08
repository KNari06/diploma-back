/**
 * Save-time validation of `link_test_case` steps on both create() and
 * update() — cycle detection + cross-tenant access checks.
 *
 * Regression coverage for four related gaps found in review:
 *   1. create() never validated `link_test_case` references at all.
 *   2. update() silently skipped the cycle check (and discarded the lookup
 *      error) when the test case's project couldn't be resolved.
 *   3. Neither path checked that the linking user can actually access the
 *      linked test case — only cycle safety was checked.
 *   4. (covered by db/__tests__/intent-test-case-graph.db.test.ts) the graph
 *      query was owner-scoped and unpaginated.
 *
 * Mock boundary: the `db/` sublayer is stubbed (per testing.md — service unit
 * tests stub `db/`, never Supabase directly).
 */

let __capturedInsert: Record<string, unknown> | null = null;
let __capturedUpdate: Record<string, unknown> | null = null;
let mockOwners: Record<string, { id: string; user_id: string; project_id: string }> = {};
let mockGraphRows: Array<{ id: string; depends_on: string[]; steps_json: unknown[] }> = [];
let mockGraphError: { message: string } | null = null;
let mockFlowProject: { project_id: string } | null = { project_id: 'proj-1' };
let mockFlowProjectError: { message: string } | null = null;
let mockWorkspaceRow: { workspace_id: string } | null = null;
let mockIsMember = false;

jest.mock('../db/intent-test-case.db', () => ({
  insertTestCaseRow: jest.fn(async (payload: Record<string, unknown>) => {
    __capturedInsert = payload;
    return { data: { id: 'new-tc', created_at: '2026-07-07T00:00:00.000Z', ...payload }, error: null };
  }),
  updateTestCaseRowForUser: jest.fn(async (id: string, _userId: string, updates: Record<string, unknown>) => {
    __capturedUpdate = updates;
    return {
      data: {
        id,
        project_id: 'proj-1',
        user_id: 'user-1',
        name: 'Test',
        steps_json: [],
        status: 'draft',
        kind: 'standalone',
        ...updates,
      },
      error: null,
    };
  }),
  getStepsJsonRow: jest.fn(async () => ({ data: { steps_json: [] }, error: null })),
  getTestCaseFlowProjectForUser: jest.fn(async () => ({ data: mockFlowProject, error: mockFlowProjectError })),
  getProjectGraphRows: jest.fn(async () => ({ data: mockGraphRows, error: mockGraphError })),
  getTestCaseOwnersByIds: jest.fn(async (ids: string[]) => ({
    data: ids.filter((id) => mockOwners[id]).map((id) => mockOwners[id]),
    error: null,
  })),
  getProjectWorkspaceRow: jest.fn(async () => ({ data: mockWorkspaceRow, error: null })),
  markNegativesStaleByParent: jest.fn(async () => ({ error: null, count: 0 })),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn(async () => undefined) },
}));

jest.mock('@/websocket/helpers/project-mutation-emit', () => ({
  emitTestCaseMutated: jest.fn(),
}));

// create() dynamically imports this for default resource binding — stub it.
jest.mock('@/services/test-resource/test-resource.service', () => ({
  enrichBindingsWithDefaults: jest.fn(async () => []),
}));

// canWriteTestCase dynamically imports this for the workspace-membership fallback.
jest.mock('@/services/core/workspace-access.service', () => ({
  WorkspaceAccessService: { isMember: jest.fn(async () => mockIsMember) },
}));

import { IntentTestCaseService } from '../intent-test-case.service';
import { ValidationError } from '@/types';

const linkStep = (linkedTestCaseId: string) => ({
  id: 's1',
  type: 'link_test_case',
  options: { linkTestCase: { linkedTestCaseId } },
});

beforeEach(() => {
  jest.clearAllMocks();
  __capturedInsert = null;
  __capturedUpdate = null;
  mockOwners = {};
  mockGraphRows = [];
  mockGraphError = null;
  mockFlowProject = { project_id: 'proj-1' };
  mockFlowProjectError = null;
  mockWorkspaceRow = null;
  mockIsMember = false;
});

describe('IntentTestCaseService.create — link_test_case validation', () => {
  const baseParams = { projectId: 'proj-1', userId: 'user-1', name: 'New test' };

  it('saves normally when no step links to another test case', async () => {
    await IntentTestCaseService.create({ ...baseParams, steps: [{ id: 's1', type: 'click' }] as any });

    expect(__capturedInsert).not.toBeNull();
  });

  it('rejects a link to a test case that does not exist', async () => {
    await expect(
      IntentTestCaseService.create({ ...baseParams, steps: [linkStep('missing-tc')] as any }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedInsert).toBeNull();
  });

  it('rejects a link to a test case the user has no access to', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-2', project_id: 'proj-2' } };
    mockIsMember = false;

    await expect(
      IntentTestCaseService.create({ ...baseParams, steps: [linkStep('other-tc')] as any }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedInsert).toBeNull();
  });

  it('allows a link to a test case owned by a fellow workspace member', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-2', project_id: 'proj-2' } };
    mockWorkspaceRow = { workspace_id: 'ws-1' };
    mockIsMember = true;

    await IntentTestCaseService.create({ ...baseParams, steps: [linkStep('other-tc')] as any });

    expect(__capturedInsert).not.toBeNull();
  });

  it('allows a link to the user’s own existing test case with no cycle', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-1', project_id: 'proj-1' } };
    mockGraphRows = [{ id: 'other-tc', depends_on: [], steps_json: [] }];

    await IntentTestCaseService.create({ ...baseParams, steps: [linkStep('other-tc')] as any });

    expect(__capturedInsert).not.toBeNull();
  });

  it('surfaces a graph-lookup failure instead of silently allowing the save', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-1', project_id: 'proj-1' } };
    mockGraphError = { message: 'db down' };

    await expect(
      IntentTestCaseService.create({ ...baseParams, steps: [linkStep('other-tc')] as any }),
    ).rejects.toThrow('Failed to validate linked test cases');
    expect(__capturedInsert).toBeNull();
  });
});

describe('IntentTestCaseService.update — link_test_case validation', () => {
  const baseUpdate = { id: 'tc-1', userId: 'user-1' };

  it('rejects a self-link unconditionally, even when the project cannot be resolved', async () => {
    mockFlowProject = null;

    await expect(
      IntentTestCaseService.update({ ...baseUpdate, steps: [linkStep('tc-1')] as any }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });

  it('fails closed instead of silently skipping the cycle check when the project cannot be resolved', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-1', project_id: 'proj-1' } };
    mockFlowProject = null;

    await expect(
      IntentTestCaseService.update({ ...baseUpdate, steps: [linkStep('other-tc')] as any }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });

  it('fails closed when the project lookup itself errors, instead of discarding the error', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-1', project_id: 'proj-1' } };
    mockFlowProject = null;
    mockFlowProjectError = { message: 'connection reset' };

    await expect(
      IntentTestCaseService.update({ ...baseUpdate, steps: [linkStep('other-tc')] as any }),
    ).rejects.toThrow('Failed to validate linked test cases');
    expect(__capturedUpdate).toBeNull();
  });

  it('rejects a link to a test case the user cannot access', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-2', project_id: 'proj-2' } };
    mockIsMember = false;

    await expect(
      IntentTestCaseService.update({ ...baseUpdate, steps: [linkStep('other-tc')] as any }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });

  it('rejects a multi-hop cycle through the project graph', async () => {
    // tc-1 (being updated) -> other-tc; other-tc already links back to tc-1.
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-1', project_id: 'proj-1' } };
    mockGraphRows = [
      { id: 'tc-1', depends_on: [], steps_json: [] },
      { id: 'other-tc', depends_on: [], steps_json: [linkStep('tc-1')] },
    ];

    await expect(
      IntentTestCaseService.update({ ...baseUpdate, steps: [linkStep('other-tc')] as any }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });

  it('saves when the link introduces no cycle', async () => {
    mockOwners = { 'other-tc': { id: 'other-tc', user_id: 'user-1', project_id: 'proj-1' } };
    mockGraphRows = [
      { id: 'tc-1', depends_on: [], steps_json: [] },
      { id: 'other-tc', depends_on: [], steps_json: [] },
    ];

    await IntentTestCaseService.update({ ...baseUpdate, steps: [linkStep('other-tc')] as any });

    expect(__capturedUpdate).not.toBeNull();
  });
});
