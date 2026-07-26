/**
 * Regression guard for the credential-binding save path.
 *
 * The authoring agent freezes `{{secrets.*}}` into the steps and emits a
 * `secret` binding, but `create()` had NO way to accept one — it always
 * computed bindings from workspace defaults alone. So the authored draft
 * worked and the SAVED test 401'd, with nothing in the logs to say why.
 *
 * These tests assert the persisted insert payload, and that enrichment layers
 * defaults on top of (rather than replacing) an explicit binding.
 */

let __capturedInsert: Record<string, unknown> | null = null;

// Mocked at the `db/` sublayer, NOT at Supabase — mocking Supabase directly
// inside a service test is a BLOCK criterion in .claude/rules/reviewer.md, and
// the sublayer exists here (`intent-test-case.service.ts` imports
// `./db/intent-test-case.db`). It is also simpler than faking the
// `from().insert().select().single()` chain.
jest.mock('../db/intent-test-case.db', () => ({
  insertTestCaseRow: (payload: Record<string, unknown>) => {
    __capturedInsert = payload;
    return Promise.resolve({
      data: { id: 'tc-1', created_at: '2026-07-25T00:00:00.000Z', ...payload },
      error: null,
    });
  },
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const enrichMock = jest.fn();
jest.mock('@/services/test-resource/test-resource.service', () => ({
  enrichBindingsWithDefaults: (...args: unknown[]) => enrichMock(...args),
}));

jest.mock('@/utils/core/redis-cache', () => ({
  cache: { delByPattern: jest.fn(async () => undefined) },
}));

import { IntentTestCaseService } from '../intent-test-case.service';

const SECRET_BINDING = { kind: 'secret', resource_id: 'res-1', required: true };

const baseParams = {
  projectId: 'proj-1',
  userId: 'user-1',
  name: 'Login test',
  steps: [],
};

beforeEach(() => {
  __capturedInsert = null;
  enrichMock.mockReset();
  // Default: enrichment is a pass-through (no workspace defaults configured).
  enrichMock.mockImplementation(async (p: any) => p.bindings);
});

describe('IntentTestCaseService.create — resource bindings', () => {
  it('persists an explicit secret binding onto the new row', async () => {
    await IntentTestCaseService.create({ ...baseParams, resourceBindings: [SECRET_BINDING] });

    expect(__capturedInsert?.resource_bindings).toEqual([SECRET_BINDING]);
  });

  it('seeds enrichment with the explicit binding instead of an empty list', async () => {
    await IntentTestCaseService.create({ ...baseParams, resourceBindings: [SECRET_BINDING] });

    expect(enrichMock).toHaveBeenCalledWith(
      expect.objectContaining({ bindings: [SECRET_BINDING] }),
    );
  });

  it('keeps the explicit binding alongside workspace defaults for other kinds', async () => {
    const envDefault = { kind: 'environment', resource_id: 'env-9' };
    enrichMock.mockImplementation(async (p: any) => [...p.bindings, envDefault]);

    await IntentTestCaseService.create({ ...baseParams, resourceBindings: [SECRET_BINDING] });

    expect(__capturedInsert?.resource_bindings).toEqual([SECRET_BINDING, envDefault]);
  });

  it('keeps the explicit binding when enrichment throws', async () => {
    enrichMock.mockRejectedValue(new Error('lookup down'));

    await IntentTestCaseService.create({ ...baseParams, resourceBindings: [SECRET_BINDING] });

    expect(__capturedInsert?.resource_bindings).toEqual([SECRET_BINDING]);
  });

  it('still writes defaults-only bindings when the caller passes none', async () => {
    const envDefault = { kind: 'environment', resource_id: 'env-9' };
    enrichMock.mockImplementation(async () => [envDefault]);

    await IntentTestCaseService.create({ ...baseParams });

    expect(__capturedInsert?.resource_bindings).toEqual([envDefault]);
  });
});
