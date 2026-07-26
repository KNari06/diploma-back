import { DraftStepsCache } from '../draft-steps-cache';
import type { IntentStep } from '../preview.types';

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const SID = 'chat-1';
const steps = (n = 1): IntentStep[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: 'click', description: 'x' } as IntentStep));

const BINDINGS = [{ kind: 'secret' as const, resource_id: 'res-1', required: true }];

beforeEach(() => DraftStepsCache.__dangerousClearForTests());

describe('DraftStepsCache — credential bindings', () => {
  it('round-trips bindings through get and consume', () => {
    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'u1', resourceBindings: BINDINGS });

    expect(DraftStepsCache.get(SID)?.resourceBindings).toEqual(BINDINGS);
    expect(DraftStepsCache.consume(SID)?.resourceBindings).toEqual(BINDINGS);
  });

  it('PRESERVES bindings when a later writer overwrites the entry without them', () => {
    // This is the real-world sequence: authoring caches the binding, then the
    // agent re-runs / tweaks the steps via qa_run_draft_steps, which builds a
    // fresh entry. A plain replace silently dropped the binding and the saved
    // test 401'd with nothing in the logs pointing here.
    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'u1', resourceBindings: BINDINGS });

    DraftStepsCache.set(SID, { steps: steps(3), startUrl: 'u2', userId: 'u1' });

    const entry = DraftStepsCache.get(SID);
    expect(entry?.resourceBindings).toEqual(BINDINGS);
    expect(entry?.steps).toHaveLength(3);
    expect(entry?.startUrl).toBe('u2');
  });

  it('lets a caller replace the bindings explicitly', () => {
    const other = [{ kind: 'secret' as const, resource_id: 'res-2', required: true }];
    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'u1', resourceBindings: BINDINGS });

    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'u1', resourceBindings: other });

    expect(DraftStepsCache.get(SID)?.resourceBindings).toEqual(other);
  });

  it('does not invent bindings for a draft that never had any', () => {
    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'u1' });

    expect(DraftStepsCache.get(SID)?.resourceBindings).toBeUndefined();
  });

  it('does NOT carry a binding across users sharing one chat session', () => {
    // One chat session is shared by a whole workspace. An unscoped carry-over
    // gives user B's draft a binding to user A's resource; `loadDecrypted`
    // filters on user_id, so at replay the required binding resolves to nothing
    // and THROWS — failing B's test at setup for a reason nothing in it
    // explains.
    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'A', resourceBindings: BINDINGS });

    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'B' });

    const entry = DraftStepsCache.get(SID);
    expect(entry?.userId).toBe('B');
    expect(entry?.resourceBindings).toBeUndefined();
  });

  it('does not leak bindings across chat sessions', () => {
    DraftStepsCache.set(SID, { steps: steps(), startUrl: 'u', userId: 'u1', resourceBindings: BINDINGS });

    DraftStepsCache.set('chat-2', { steps: steps(), startUrl: 'u', userId: 'u1' });

    expect(DraftStepsCache.get('chat-2')?.resourceBindings).toBeUndefined();
  });
});
