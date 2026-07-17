/**
 * Mobile exploration → intent_test_cases conversion: assertion handling.
 *
 * Pins the contract that a discovered mobile case's `assertions` become
 * RUNNABLE ai_check steps in steps_json — without this the case replays its
 * taps and verifies nothing (the assertions were previously dropped on the
 * floor at ingestion). See ExplorationStorageService.saveMobileTestCasesFromSnapshot.
 */
import { jest } from '@jest/globals';

const insert = jest.fn();
const select = jest.fn();

jest.mock('@/db/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      insert: (records: unknown) => {
        insert(records);
        return { select: () => { select(); return Promise.resolve({ data: [{ id: 'tc-1' }], error: null }); } };
      },
    })),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ExplorationStorageService } = require('../exploration-storage.service');

function insertedRecords(): Array<Record<string, any>> {
  return insert.mock.calls[0]?.[0] as Array<Record<string, any>>;
}

describe('saveMobileTestCasesFromSnapshot — assertion → ai_check', () => {
  beforeEach(() => {
    insert.mockClear();
    select.mockClear();
  });

  it('appends a runnable ai_check step for each observation assertion', async () => {
    const flows = [{
      name: 'Login',
      mobile: {
        cases: [{
          name: 'happy',
          intentSteps: [{ id: 's1', type: 'tap', description: 'Login' }],
          assertions: [{ type: 'observation', expect: 'dashboard is visible after login' }],
        }],
      },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');

    const steps = insertedRecords()[0].steps_json as Array<Record<string, any>>;
    expect(steps).toHaveLength(2); // original tap + appended ai_check
    const check = steps[1];
    expect(check.type).toBe('ai_check');
    expect(check.assertionText).toBe('dashboard is visible after login');
    expect(check.expectedOutcome).toBe('success');
    expect(check.options).toEqual({ aiCheckSource: 'tree' });
  });

  it('does not make non-observation assertions into steps, but PRESERVES them as tags [#9]', async () => {
    const flows = [{
      name: 'Api',
      mobile: {
        cases: [{
          name: 'happy',
          intentSteps: [{ id: 's1', type: 'tap', description: 'Go' }],
          assertions: [{ type: 'network', expect: 'POST /api returns 2xx' }],
        }],
      },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    const rec = insertedRecords()[0];
    expect(rec.steps_json as unknown[]).toHaveLength(1); // no ai_check step
    // …but the assertion survives as a tag rather than being dropped silently.
    expect((rec.tags as string[]).some((t) => t.startsWith('assert:network:'))).toBe(true);
  });

  it('inserts a mid-flow observation ai_check AT its afterStep position [#3]', async () => {
    const flows = [{
      name: 'Cart',
      mobile: {
        cases: [{
          name: 'happy',
          intentSteps: [
            { id: 's1', type: 'tap', description: 'Add to cart' },
            { id: 's2', type: 'tap', description: 'Open menu' },
          ],
          // Observed after step 1 (badge check) — must land BETWEEN s1 and s2,
          // not appended after s2.
          assertions: [{ type: 'observation', expect: 'cart badge shows 1', afterStep: 1 }],
        }],
      },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    const steps = insertedRecords()[0].steps_json as Array<Record<string, any>>;
    expect(steps).toHaveLength(3);
    expect(steps[0].description).toBe('Add to cart');
    expect(steps[1].type).toBe('ai_check'); // inserted after step 1
    expect(steps[1].assertionText).toBe('cart badge shows 1');
    expect(steps[2].description).toBe('Open menu');
  });

  it('appends an end-of-flow assertion (afterStep 0/undefined) at the end [#3]', async () => {
    const flows = [{
      name: 'Login',
      mobile: {
        cases: [{
          name: 'happy',
          intentSteps: [{ id: 's1', type: 'tap', description: 'Submit' }],
          assertions: [{ type: 'observation', expect: 'dashboard visible' }], // no afterStep
        }],
      },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    const steps = insertedRecords()[0].steps_json as Array<Record<string, any>>;
    expect(steps).toHaveLength(2);
    expect(steps[1].type).toBe('ai_check'); // appended at end
  });

  it('does not append a check for an empty-text assertion (assertionText required)', async () => {
    const flows = [{
      name: 'Blank',
      mobile: {
        cases: [{
          name: 'happy',
          intentSteps: [{ id: 's1', type: 'tap', description: 'Go' }],
          assertions: [{ type: 'observation', expect: '   ' }],
        }],
      },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    expect(insertedRecords()[0].steps_json as unknown[]).toHaveLength(1);
  });

  it('still saves a case that has no assertions (steps unchanged)', async () => {
    const flows = [{
      name: 'Plain',
      mobile: { cases: [{ name: 'happy', intentSteps: [{ id: 's1', type: 'tap' }] }] },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    expect(insertedRecords()[0].steps_json as unknown[]).toHaveLength(1);
  });

  it('sets the platform column (not just the tag) so mobile cases are queryable', async () => {
    const flows = [{ name: 'F', mobile: { cases: [{ name: 'happy', intentSteps: [{ id: 's1', type: 'tap' }] }] } }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'flutter');
    const rec = insertedRecords()[0];
    expect(rec.platform).toBe('mobile_flutter'); // the latent bug: was defaulting to 'web'
    expect((rec.tags as string[])).toContain('mobile_flutter');
  });

  it('maps the case preconditions (B5) into the preconditions column', async () => {
    const flows = [{
      name: 'Cart',
      mobile: { cases: [{
        name: 'happy',
        intentSteps: [{ id: 's1', type: 'tap' }],
        preconditions: ['App is on the Cart screen'],
      }] },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    expect(insertedRecords()[0].preconditions).toEqual(['App is on the Cart screen']);
  });

  it('leaves preconditions null when the case carries none (root-launch flow)', async () => {
    const flows = [{ name: 'Browse', mobile: { cases: [{ name: 'happy', intentSteps: [{ id: 's1', type: 'tap' }] }] } }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    expect(insertedRecords()[0].preconditions).toBeNull();
  });

  it('drops empty/blank precondition strings rather than persisting noise', async () => {
    const flows = [{
      name: 'Cart',
      mobile: { cases: [{
        name: 'happy',
        intentSteps: [{ id: 's1', type: 'tap' }],
        preconditions: ['  ', 'App is on the Cart screen', ''],
      }] },
    }];
    await ExplorationStorageService.saveMobileTestCasesFromSnapshot(flows, 'proj', 'user', 'android');
    expect(insertedRecords()[0].preconditions).toEqual(['App is on the Cart screen']);
  });
});
