/**
 * Tests for IntentTestCaseService.create() persistence of priority +
 * preconditions.
 *
 * Regression guard for the Allure-import data-loss bug: preconditions were
 * built by the mapper but never written, because neither create() nor update()
 * accepted them. create() now takes a `preconditions` param and writes it to
 * the `preconditions` TEXT[] column. These tests capture the exact insert
 * payload and assert the fields land (or are correctly omitted).
 */

let __capturedInsert: Record<string, unknown> | null = null;

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      insert: jest.fn((payload: Record<string, unknown>) => {
        __capturedInsert = payload;
        return {
          select: jest.fn(() => ({
            single: jest.fn(async () => ({
              // Echo the payload back as the persisted row so mapToIntentTestCase
              // has something to map. id/created_at are stamped by the DB.
              data: { id: 'tc-1', created_at: '2026-06-04T00:00:00.000Z', ...payload },
              error: null,
            })),
          })),
        };
      }),
    })),
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// create() dynamically imports this for default resource binding — stub it.
jest.mock('@/services/test-resource/test-resource.service', () => ({
  enrichBindingsWithDefaults: jest.fn(async () => []),
}));

// Flow-mode cache invalidation — no-op in tests.
jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn(async () => undefined) },
}));

import { IntentTestCaseService } from '../intent-test-case.service';

const baseParams = {
  projectId: 'proj-1',
  userId: 'user-1',
  name: 'Imported test',
  steps: [],
};

beforeEach(() => {
  __capturedInsert = null;
});

describe('IntentTestCaseService.create — priority + preconditions', () => {
  it('writes preconditions to the column when supplied', async () => {
    await IntentTestCaseService.create({
      ...baseParams,
      preconditions: ['User is logged in', 'Cart has one item'],
    });

    expect(__capturedInsert).not.toBeNull();
    expect(__capturedInsert!.preconditions).toEqual([
      'User is logged in',
      'Cart has one item',
    ]);
  });

  it('omits preconditions from the insert when not supplied (column default applies)', async () => {
    await IntentTestCaseService.create({ ...baseParams });

    expect(__capturedInsert).not.toBeNull();
    expect(__capturedInsert).not.toHaveProperty('preconditions');
  });

  it('persists an explicit priority', async () => {
    await IntentTestCaseService.create({ ...baseParams, priority: 'critical' });

    expect(__capturedInsert!.priority).toBe('critical');
  });

  it('defaults priority to medium when not supplied', async () => {
    await IntentTestCaseService.create({ ...baseParams });

    expect(__capturedInsert!.priority).toBe('medium');
  });

  it('writes NULL priority when explicitly null (no-opinion opt-out)', async () => {
    await IntentTestCaseService.create({ ...baseParams, priority: null });

    expect(__capturedInsert!.priority).toBeNull();
  });

  it('round-trips preconditions onto the returned test case', async () => {
    const created = await IntentTestCaseService.create({
      ...baseParams,
      preconditions: ['Precondition A'],
    });

    expect(created.preconditions).toEqual(['Precondition A']);
  });
});
