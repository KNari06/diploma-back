/**
 * Tests for `account-deletion.service.ts` — focused on the
 * sole-owner / multi-member-owner classification path. This is the
 * highest-risk seam in the file: it's the gate between "account
 * scheduled for deletion" and "the user destroys somebody else's
 * workspace data by accident".
 *
 * Tested through the public `previewAccountDeletion` entry point so
 * tests pin the user-visible contract, not the internals. The internal
 * `classifyOwnedWorkspaces` helper is module-private and stays that
 * way.
 *
 * Each test reconfigures the supabaseAdmin mock for the specific table
 * the call is going to hit. `from(table)` returns a per-table builder
 * that mirrors the chain shape the production code uses
 * (`.select(...).eq(...).eq(...).eq(...)` for query, `.maybeSingle()`
 * for the `users` lookup, `.in(...).eq(...).neq(...)` for the
 * member-count batch). New shapes need to be added here if the service
 * changes its query plan.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mock the supabase client BEFORE importing the SUT ──────────────────
// One handle per (call-chain shape, table) is overkill; instead expose a
// `__setTableData` knob that returns whatever the test stages.
type TableData = {
  // Result returned by .maybeSingle() for `users` lookups
  maybeSingle?: { data: any; error: any };
  // Result returned by chained `.select(...).eq(...).eq(...).eq(...)`
  // ending in a thenable (production code awaits the chain directly).
  selectResult?: { data: any; error: any };
};
const __tableData: Record<string, TableData> = {};

jest.mock('@/db/supabase', () => {
  const makeBuilder = (table: string): any => {
    const state = __tableData[table] || {};
    const builder: any = {
      // each chain step returns the same builder so chained .eq().eq()...
      // is idempotent in shape.
      select: jest.fn(() => builder),
      eq: jest.fn(() => builder),
      in: jest.fn(() => builder),
      neq: jest.fn(() => builder),
      maybeSingle: jest.fn(async () => state.maybeSingle ?? { data: null, error: null }),
      // production code awaits the chain (no .maybeSingle()) → builder
      // is itself thenable.
      then: (resolve: (v: any) => any) =>
        resolve(state.selectResult ?? { data: [], error: null }),
    };
    return builder;
  };

  return {
    supabaseAdmin: {
      from: jest.fn((table: string) => makeBuilder(table)),
    },
  };
});

// Mock the audit service — none of these tests exercise the write path,
// but the SUT imports it at module load.
jest.mock('@/services/core/workspace-audit.service', () => ({
  AUDIT_EVENTS: {
    ACCOUNT_DELETION_REQUESTED: 'account.deletion.requested',
    ACCOUNT_DELETION_CANCELLED: 'account.deletion.cancelled',
    ACCOUNT_DELETION_COMPLETED: 'account.deletion.completed',
    ACCOUNT_DELETION_FAILED: 'account.deletion.failed',
  },
  WorkspaceAuditService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock the auth-cache invalidator (called from softDeleteAccount; harmless
// in preview tests but keeps the module-init graph clean).
jest.mock('@/services/auth/auth.service', () => ({
  invalidateAuthCacheForUser: jest.fn().mockResolvedValue(undefined),
}));

import { previewAccountDeletion } from '../account-deletion.service';

const USER_ID = 'user-under-test';

function setTable(table: string, data: TableData): void {
  __tableData[table] = data;
}

function resetTables(): void {
  for (const k of Object.keys(__tableData)) delete __tableData[k];
}

describe('previewAccountDeletion → classifyOwnedWorkspaces', () => {
  beforeEach(() => {
    resetTables();
    // Default: user exists, not deleted.
    setTable('users', { maybeSingle: { data: { id: USER_ID, deleted_at: null }, error: null } });
  });

  it('returns alreadyDeleted shape when users.deleted_at is set', async () => {
    setTable('users', {
      maybeSingle: {
        data: { id: USER_ID, deleted_at: '2026-05-01T00:00:00.000Z' },
        error: null,
      },
    });

    const result = await previewAccountDeletion(USER_ID);

    expect(result).toEqual({
      alreadyDeleted: true,
      deletedAt: '2026-05-01T00:00:00.000Z',
    });
  });

  it('returns empty blocking + soleOwned when the user owns no workspaces', async () => {
    setTable('workspace_members', { selectResult: { data: [], error: null } });

    const result = await previewAccountDeletion(USER_ID);

    if ('alreadyDeleted' in result) throw new Error('expected preview');
    expect(result.preview.blockingWorkspaces).toEqual([]);
    expect(result.preview.soleOwnedWorkspaces).toEqual([]);
    expect(result.preview.graceDays).toBeGreaterThan(0);
    expect(result.preview.scheduledFor).toEqual(expect.any(String));
  });

  it('classifies a sole-owned workspace (0 other members) as soleOwned', async () => {
    // First call to workspace_members: owner-rows lookup.
    // Second call to workspace_members: other-member count batch.
    // Both come through the same `from('workspace_members')` mock, so
    // we'd need to differentiate by arg — for simplicity stage the
    // owner list and assume the count batch returns [] (no other
    // members). That's enough to land in the soleOwned branch.
    let call = 0;
    const supabaseMock = jest.requireMock('@/db/supabase');
    supabaseMock.supabaseAdmin.from.mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: USER_ID, deleted_at: null },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'workspace_members') {
        call += 1;
        if (call === 1) {
          // owner rows
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({
                    data: [
                      {
                        workspace_id: 'ws-1',
                        workspaces: { id: 'ws-1', name: 'My Personal' },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        // other-member count batch
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                neq: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    });

    const result = await previewAccountDeletion(USER_ID);

    if ('alreadyDeleted' in result) throw new Error('expected preview');
    expect(result.preview.blockingWorkspaces).toEqual([]);
    expect(result.preview.soleOwnedWorkspaces).toEqual([
      { id: 'ws-1', name: 'My Personal' },
    ]);
  });

  it('classifies a multi-member-owned workspace as blocking', async () => {
    let call = 0;
    const supabaseMock = jest.requireMock('@/db/supabase');
    supabaseMock.supabaseAdmin.from.mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: USER_ID, deleted_at: null },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'workspace_members') {
        call += 1;
        if (call === 1) {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({
                    data: [
                      {
                        workspace_id: 'ws-shared',
                        workspaces: { id: 'ws-shared', name: 'Team Workspace' },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        // Two other members → blocking.
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                neq: () => Promise.resolve({
                  data: [
                    { workspace_id: 'ws-shared', user_id: 'other-1' },
                    { workspace_id: 'ws-shared', user_id: 'other-2' },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    });

    const result = await previewAccountDeletion(USER_ID);

    if ('alreadyDeleted' in result) throw new Error('expected preview');
    expect(result.preview.blockingWorkspaces).toEqual([
      { id: 'ws-shared', name: 'Team Workspace', otherMemberCount: 2 },
    ]);
    expect(result.preview.soleOwnedWorkspaces).toEqual([]);
  });

  it('fails SAFE on member-count query error (treats as blocking)', async () => {
    // Production behaviour: if we can't count other members, assume
    // there IS at least one and block deletion. Better a false-block
    // than silent destruction of collaborators' data.
    let call = 0;
    const supabaseMock = jest.requireMock('@/db/supabase');
    supabaseMock.supabaseAdmin.from.mockImplementation((table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: USER_ID, deleted_at: null },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'workspace_members') {
        call += 1;
        if (call === 1) {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({
                    data: [
                      {
                        workspace_id: 'ws-x',
                        workspaces: { id: 'ws-x', name: 'X' },
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            in: () => ({
              eq: () => ({
                neq: () => Promise.resolve({
                  data: null,
                  error: { message: 'simulated postgres timeout' },
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    });

    const result = await previewAccountDeletion(USER_ID);

    if ('alreadyDeleted' in result) throw new Error('expected preview');
    expect(result.preview.blockingWorkspaces).toHaveLength(1);
    expect(result.preview.blockingWorkspaces[0]).toMatchObject({
      id: 'ws-x',
      otherMemberCount: 1, // sentinel — the SUT can't know the real count, defaults to "at least one"
    });
    expect(result.preview.soleOwnedWorkspaces).toEqual([]);
  });
});
