import { LinkResolutionService, namespacedMapSource } from '../link-resolution.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

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
