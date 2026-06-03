import {
  attachResolvedTargets,
  getResolvedTargets,
  shouldResolveTarget,
} from '../intent-target-resolution';
import { TestQueryResolverService } from '@/services/testing/resolver';
import type { IntentResult } from '@/types';

jest.mock('@/services/testing/resolver', () => ({
  TestQueryResolverService: { resolve: jest.fn() },
}));

const resolveMock = TestQueryResolverService.resolve as jest.Mock;

const intentWith = (sel?: IntentResult['targetSelector']): IntentResult => ({
  intent: 'run_by_tag',
  targetSelector: sel,
});

describe('shouldResolveTarget', () => {
  it('is false without a projectId', () => {
    expect(shouldResolveTarget(intentWith({ type: 'tag', value: 'smoke' }), undefined)).toBe(false);
  });

  it('is false when there is no selector', () => {
    expect(shouldResolveTarget(intentWith(undefined), 'p1')).toBe(false);
  });

  it('is false for non-collection selector types (url/element)', () => {
    expect(shouldResolveTarget(intentWith({ type: 'url', value: 'x' }), 'p1')).toBe(false);
    expect(shouldResolveTarget(intentWith({ type: 'element', value: 'btn' }), 'p1')).toBe(false);
  });

  it('is true for a resolvable descriptor with a project', () => {
    expect(shouldResolveTarget(intentWith({ type: 'keyword', value: 'payment' }), 'p1')).toBe(true);
    expect(shouldResolveTarget(intentWith({ type: 'tag', value: 'smoke' }), 'p1')).toBe(true);
  });
});

describe('attachResolvedTargets', () => {
  beforeEach(() => resolveMock.mockReset());

  it('no-ops when nothing to resolve (resolver not called)', async () => {
    const intent = intentWith(undefined);
    await attachResolvedTargets({ parsedIntent: intent, projectId: 'p1' });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(intent.metadata?.resolvedTargets).toBeUndefined();
  });

  it('attaches resolved ids on a unique resolution', async () => {
    resolveMock.mockResolvedValue({
      resolution: 'unique',
      topId: 'tc_1',
      candidates: [{ id: 'tc_1', name: 'Checkout payment', score: 0.9 }],
    });
    const intent = intentWith({ type: 'keyword', value: 'payment tests' });
    await attachResolvedTargets({ parsedIntent: intent, projectId: 'p1' });

    expect(intent.metadata?.resolvedTargets).toEqual(
      expect.objectContaining({
        selectorType: 'keyword',
        resolution: 'unique',
        ids: ['tc_1'],
        topId: 'tc_1',
      }),
    );
  });

  it('attaches the full candidate set when ambiguous', async () => {
    resolveMock.mockResolvedValue({
      resolution: 'ambiguous',
      candidates: [
        { id: 'a', name: 'Checkout guest', score: 0.6 },
        { id: 'b', name: 'Checkout logged-in', score: 0.55 },
      ],
    });
    const intent = intentWith({ type: 'keyword', value: 'checkout' });
    await attachResolvedTargets({ parsedIntent: intent, projectId: 'p1' });

    expect(intent.metadata?.resolvedTargets.ids).toEqual(['a', 'b']);
    expect(intent.metadata?.resolvedTargets.topId).toBeUndefined();
  });

  it('leaves intent untouched when resolution is none', async () => {
    resolveMock.mockResolvedValue({ resolution: 'none', candidates: [] });
    const intent = intentWith({ type: 'tag', value: 'nonexistent' });
    await attachResolvedTargets({ parsedIntent: intent, projectId: 'p1' });
    expect(intent.metadata?.resolvedTargets).toBeUndefined();
  });

  it('never throws when the resolver fails (best-effort)', async () => {
    resolveMock.mockRejectedValue(new Error('db down'));
    const intent = intentWith({ type: 'tag', value: 'smoke' });
    await expect(
      attachResolvedTargets({ parsedIntent: intent, projectId: 'p1' }),
    ).resolves.toBeUndefined();
    expect(intent.metadata?.resolvedTargets).toBeUndefined();
  });

  it('does not expose candidate urls/tags — only id + name', async () => {
    resolveMock.mockResolvedValue({
      resolution: 'ambiguous',
      candidates: [{ id: 'a', name: 'X', url: 'https://secret', tags: ['t'], score: 0.5 }],
    });
    const intent = intentWith({ type: 'keyword', value: 'x' });
    await attachResolvedTargets({ parsedIntent: intent, projectId: 'p1' });
    expect(intent.metadata?.resolvedTargets.candidates).toEqual([{ id: 'a', name: 'X' }]);
  });
});

describe('getResolvedTargets', () => {
  it('returns undefined when nothing was attached', () => {
    expect(getResolvedTargets({ intent: 'run_by_tag' })).toBeUndefined();
    expect(getResolvedTargets({ intent: 'run_by_tag', metadata: {} })).toBeUndefined();
  });

  it('returns the attached resolved-targets object', () => {
    const intent: IntentResult = {
      intent: 'run_by_tag',
      metadata: { resolvedTargets: { selectorType: 'tag', descriptor: 'smoke', resolution: 'ambiguous', ids: ['a'], candidates: [{ id: 'a', name: 'A' }] } },
    };
    expect(getResolvedTargets(intent)).toEqual(
      expect.objectContaining({ selectorType: 'tag', descriptor: 'smoke', ids: ['a'] }),
    );
  });
});
