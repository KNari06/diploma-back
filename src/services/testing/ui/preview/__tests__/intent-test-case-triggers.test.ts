/**
 * Triggers persistence on IntentTestCaseService.update + read-back via
 * mapToIntentTestCase.
 *
 * Triggers are the canonical cross-repo event→action contract
 * (@/services/mobile/mobile-runner.types `Trigger`). These tests assert:
 *   1. A valid triggers array round-trips: it's written to the `triggers`
 *      column on update AND surfaced on the mapped result.
 *   2. `[]` clears all triggers (valid).
 *   3. `undefined` leaves the column untouched (no `triggers` key in the
 *      update payload).
 *   4. A malformed trigger shape is REJECTED (ValidationError → 400 at the
 *      route), and nothing is written.
 *
 * Mock boundary: the `db/` sublayer is stubbed (per testing.md — service unit
 * tests stub `db/`, never Supabase directly).
 */

let __capturedUpdate: Record<string, unknown> | null = null;

jest.mock('../db/intent-test-case.db', () => ({
  updateTestCaseRowForUser: jest.fn(async (id: string, _userId: string, updates: Record<string, unknown>) => {
    __capturedUpdate = updates;
    // Echo the update back as the persisted row so mapToIntentTestCase has
    // something to map. project_id/name are stamped by the DB on the real row.
    return {
      data: {
        id,
        project_id: 'proj-1',
        user_id: 'user-1',
        name: 'Permission test',
        steps_json: [],
        status: 'draft',
        kind: 'standalone',
        ...updates,
      },
      error: null,
    };
  }),
  // Only touched when steps are part of the update — these tests update
  // triggers only, so they're never called, but stub them for safety.
  getStepsJsonRow: jest.fn(async () => ({ data: { steps_json: [] }, error: null })),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn(async () => undefined) },
}));

// Live editor cache invalidation — no-op in tests.
jest.mock('@/websocket/helpers/project-mutation-emit', () => ({
  emitTestCaseMutated: jest.fn(),
}));

import { IntentTestCaseService } from '../intent-test-case.service';
import { ValidationError } from '@/types';

const PERMISSION_TRIGGER = {
  id: 'trg-1',
  condition: { kind: 'permission_dialog' },
  action: { kind: 'permission', decision: 'allow' },
};

const baseUpdate = { id: 'tc-1', userId: 'user-1' };

beforeEach(() => {
  __capturedUpdate = null;
  jest.clearAllMocks();
});

describe('IntentTestCaseService.update — triggers persistence', () => {
  it('round-trips a valid triggers array: written to the column and returned on read', async () => {
    const result = await IntentTestCaseService.update({
      ...baseUpdate,
      triggers: [PERMISSION_TRIGGER],
    });

    expect(__capturedUpdate).not.toBeNull();
    expect(__capturedUpdate!.triggers).toEqual([PERMISSION_TRIGGER]);
    // Read-back: the mapped IntentTestCase surfaces triggers for GET.
    expect(result.triggers).toEqual([PERMISSION_TRIGGER]);
  });

  it('persists every condition/action variant of the contract verbatim', async () => {
    const triggers = [
      { id: 't1', condition: { kind: 'any_dialog' }, action: { kind: 'back' } },
      {
        id: 't2',
        condition: { kind: 'dialog_text', contains: 'Allow' },
        action: { kind: 'tap', text: 'OK' },
      },
      {
        id: 't3',
        condition: { kind: 'permission_dialog' },
        action: { kind: 'permission', decision: 'deny' },
      },
    ];

    await IntentTestCaseService.update({ ...baseUpdate, triggers });

    expect(__capturedUpdate!.triggers).toEqual(triggers);
  });

  it('accepts [] to clear all triggers', async () => {
    await IntentTestCaseService.update({ ...baseUpdate, triggers: [] });

    expect(__capturedUpdate!.triggers).toEqual([]);
  });

  it('leaves the column untouched when triggers is undefined', async () => {
    // Pair with another field so update() has something to write.
    await IntentTestCaseService.update({ ...baseUpdate, name: 'Renamed' });

    expect(__capturedUpdate).not.toBeNull();
    expect(__capturedUpdate).not.toHaveProperty('triggers');
  });
});

describe('IntentTestCaseService.update — triggers validation', () => {
  it('rejects a malformed trigger shape and writes nothing', async () => {
    await expect(
      IntentTestCaseService.update({
        ...baseUpdate,
        triggers: [{ id: 'bad', condition: { kind: 'not_a_real_kind' }, action: { kind: 'back' } }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // No DB write happened — validation fails before the update call.
    expect(__capturedUpdate).toBeNull();
  });

  it('rejects a dialog_text condition missing `contains`', async () => {
    await expect(
      IntentTestCaseService.update({
        ...baseUpdate,
        triggers: [{ id: 'x', condition: { kind: 'dialog_text' }, action: { kind: 'back' } }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });

  it('rejects a permission action with an invalid decision', async () => {
    await expect(
      IntentTestCaseService.update({
        ...baseUpdate,
        triggers: [
          {
            id: 'x',
            condition: { kind: 'permission_dialog' },
            action: { kind: 'permission', decision: 'maybe' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });

  it('rejects a non-array triggers payload', async () => {
    await expect(
      IntentTestCaseService.update({ ...baseUpdate, triggers: { id: 'x' } as unknown }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(__capturedUpdate).toBeNull();
  });
});
