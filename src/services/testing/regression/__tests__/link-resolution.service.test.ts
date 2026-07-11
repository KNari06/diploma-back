import { LinkResolutionService, namespacedMapSource, MAX_LINKED_TEST_CASE_DEPTH } from '../link-resolution.service';
import { RegressionTestQueryService } from '../db/regression-test-query.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

jest.mock('../db/regression-test-query.db', () => ({
  RegressionTestQueryService: {
    getSavedTestCase: jest.fn(),
  },
}));

const mockGetSavedTestCase = RegressionTestQueryService.getSavedTestCase as jest.Mock;

const step = (id: string, overrides: Partial<IntentStep> = {}): IntentStep => ({
  id,
  type: 'click',
  description: id,
  ...overrides,
});

const linkStep = (id: string, linkedTestCaseId: string, linkedPlatform: string): IntentStep => ({
  id,
  type: 'link_test_case',
  description: id,
  options: { linkTestCase: { linkedTestCaseId, linkedPlatform: linkedPlatform as any } },
});

describe('LinkResolutionService.segmentByLinks', () => {
  it('returns a single steps segment when there are no link_test_case steps', () => {
    const steps = [step('a'), step('b'), step('c')];
    const segments = LinkResolutionService.segmentByLinks(steps);
    expect(segments).toEqual([{ kind: 'steps', steps }]);
  });

  it('returns an empty array for an empty step list', () => {
    expect(LinkResolutionService.segmentByLinks([])).toEqual([]);
  });

  it('splits into steps/link/steps around a single cross-platform link in the middle', () => {
    const before = [step('a'), step('b')];
    const link = linkStep('link1', 'tc-web', 'web');
    const after = [step('c')];
    const segments = LinkResolutionService.segmentByLinks([...before, link, ...after]);

    expect(segments).toEqual([
      { kind: 'steps', steps: before },
      { kind: 'link', step: link },
      { kind: 'steps', steps: after },
    ]);
  });

  it('handles a link as the very last step (no trailing steps segment)', () => {
    const before = [step('a')];
    const link = linkStep('link1', 'tc-web', 'web');
    const segments = LinkResolutionService.segmentByLinks([...before, link]);

    expect(segments).toEqual([
      { kind: 'steps', steps: before },
      { kind: 'link', step: link },
    ]);
  });

  it('handles a link as the very first step (no leading steps segment)', () => {
    const link = linkStep('link1', 'tc-web', 'web');
    const after = [step('a')];
    const segments = LinkResolutionService.segmentByLinks([link, ...after]);

    expect(segments).toEqual([
      { kind: 'link', step: link },
      { kind: 'steps', steps: after },
    ]);
  });

  it('handles back-to-back link steps with no steps segment between them', () => {
    const link1 = linkStep('link1', 'tc-web', 'web');
    const link2 = linkStep('link2', 'tc-mobile', 'mobile_android');
    const segments = LinkResolutionService.segmentByLinks([link1, link2]);

    expect(segments).toEqual([
      { kind: 'link', step: link1 },
      { kind: 'link', step: link2 },
    ]);
  });
});

describe('LinkResolutionService.resolveSameProlatformLinks', () => {
  beforeEach(() => {
    mockGetSavedTestCase.mockReset();
  });

  it('leaves steps untouched when there are no link_test_case steps', async () => {
    const steps = [step('a'), step('b')];
    const resolved = await LinkResolutionService.resolveSameProlatformLinks(steps, 'web', 'user-1');
    expect(resolved).toEqual(steps);
    expect(mockGetSavedTestCase).not.toHaveBeenCalled();
  });

  it('inlines a same-platform link in place, namespacing the linked steps ids', async () => {
    mockGetSavedTestCase.mockResolvedValueOnce({
      id: 'tc-linked',
      steps_json: [step('x'), step('y')],
    });

    const link = linkStep('link1', 'tc-linked', 'web');
    const resolved = await LinkResolutionService.resolveSameProlatformLinks(
      [step('a'), link, step('b')],
      'web',
      'user-1',
    );

    expect(resolved.map((s) => s.id)).toEqual(['a', 'link_tc-linked_x', 'link_tc-linked_y', 'b']);
    expect(mockGetSavedTestCase).toHaveBeenCalledWith('tc-linked', 'user-1');
  });

  it('leaves a cross-platform link untouched as a marker for segmentByLinks', async () => {
    const link = linkStep('link1', 'tc-mobile', 'mobile_android');
    const resolved = await LinkResolutionService.resolveSameProlatformLinks(
      [step('a'), link],
      'web',
      'user-1',
    );

    expect(resolved).toEqual([step('a'), link]);
    expect(mockGetSavedTestCase).not.toHaveBeenCalled();
  });

  it('recursively resolves same-platform links nested inside a linked test case', async () => {
    mockGetSavedTestCase.mockImplementation((id: string) => {
      if (id === 'tc-outer') {
        return Promise.resolve({ id: 'tc-outer', steps_json: [step('outer1'), linkStep('inner-link', 'tc-inner', 'web')] });
      }
      if (id === 'tc-inner') {
        return Promise.resolve({ id: 'tc-inner', steps_json: [step('inner1')] });
      }
      throw new Error(`unexpected id ${id}`);
    });

    const link = linkStep('link1', 'tc-outer', 'web');
    const resolved = await LinkResolutionService.resolveSameProlatformLinks([link], 'web', 'user-1');

    // Outer link's own steps are namespaced under tc-outer; the inner link
    // resolves recursively and its steps get double-namespaced (tc-outer,
    // then re-namespaced again by the outer inline pass) — same convention
    // collectPreconditionSteps already uses for nested preconditions.
    expect(resolved.map((s) => s.id)).toEqual([
      'link_tc-outer_outer1',
      'link_tc-outer_link_tc-inner_inner1',
    ]);
    expect(mockGetSavedTestCase).toHaveBeenCalledWith('tc-outer', 'user-1');
    expect(mockGetSavedTestCase).toHaveBeenCalledWith('tc-inner', 'user-1');
  });

  it('throws when the chain exceeds MAX_LINKED_TEST_CASE_DEPTH', async () => {
    await expect(
      LinkResolutionService.resolveSameProlatformLinks([step('a')], 'web', 'user-1', MAX_LINKED_TEST_CASE_DEPTH + 1),
    ).rejects.toThrow(/exceeds max depth/);
    expect(mockGetSavedTestCase).not.toHaveBeenCalled();
  });

  it('throws when a link_test_case step has no linked test case selected', async () => {
    const badLink: IntentStep = {
      id: 'link1',
      type: 'link_test_case',
      description: 'link1',
      options: { linkTestCase: { linkedTestCaseId: '', linkedPlatform: 'web' as any } },
    };
    await expect(
      LinkResolutionService.resolveSameProlatformLinks([badLink], 'web', 'user-1'),
    ).rejects.toThrow(/no linked test case selected/);
  });
});

describe('namespacedMapSource', () => {
  it('resolves a key under the given prefix', () => {
    const source = namespacedMapSource('link', new Map([['orderId', '12345']]));
    expect(source.lookup('link.orderId')).toBe('12345');
  });

  it('returns undefined for a key not under the prefix', () => {
    const source = namespacedMapSource('link', new Map([['orderId', '12345']]));
    expect(source.lookup('extracted.orderId')).toBeUndefined();
  });

  it('returns undefined for a key under the prefix but not in the map', () => {
    const source = namespacedMapSource('link', new Map([['orderId', '12345']]));
    expect(source.lookup('link.missing')).toBeUndefined();
  });
});
