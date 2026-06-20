import { diffSnapshots } from '../snapshot-diff.util';
import type { LiteElement, LiteSnapshot } from '@/agent/core/lite/lite-types';

const el = (ref: string, over: Partial<LiteElement> = {}): LiteElement =>
  ({ ref, tag: 'div', ...over }) as unknown as LiteElement;

const snap = (over: Partial<LiteSnapshot> = {}): LiteSnapshot =>
  ({
    url: 'https://x.com',
    title: 'T',
    viewport: { width: 1000, height: 800 },
    elements: [],
    ...over,
  }) as unknown as LiteSnapshot;

describe('diffSnapshots — matching', () => {
  it('reports a full match for identical snapshots', () => {
    const a = snap({ elements: [el('e1', { tag: 'button' })] });
    const b = snap({ elements: [el('e1', { tag: 'button' })] });
    const r = diffSnapshots(a, b);
    expect(r.match).toBe(true);
    expect(r.topLevelDiffs).toHaveLength(0);
    expect(r.elementDiffs).toHaveLength(0);
    expect(r.summary.matchedElementCount).toBe(1);
  });
});

describe('diffSnapshots — top-level diffs', () => {
  it('flags a URL difference', () => {
    const r = diffSnapshots(snap({ url: 'https://a.com' }), snap({ url: 'https://b.com' }));
    expect(r.match).toBe(false);
    expect(r.topLevelDiffs).toEqual([{ field: 'url', a: 'https://a.com', b: 'https://b.com' }]);
  });

  it('flags a viewport difference', () => {
    const r = diffSnapshots(snap({ viewport: { width: 1000, height: 800 } }), snap({ viewport: { width: 1200, height: 800 } }));
    expect(r.topLevelDiffs.some((d) => d.field === 'viewport')).toBe(true);
  });
});

describe('diffSnapshots — element presence', () => {
  it('reports refs only in one side', () => {
    const a = snap({ elements: [el('e1'), el('e2')] });
    const b = snap({ elements: [el('e1'), el('e3')] });
    const r = diffSnapshots(a, b);
    expect(r.onlyInA).toEqual(['e2']);
    expect(r.onlyInB).toEqual(['e3']);
    expect(r.summary.matchedElementCount).toBe(1);
    expect(r.match).toBe(false);
  });
});

describe('diffSnapshots — field equivalence', () => {
  it('tolerates sub-pixel bbox differences but flags larger ones', () => {
    const near = diffSnapshots(
      snap({ elements: [el('e1', { bounds: { x: 0, y: 0, width: 100, height: 50 } } as any)] }),
      snap({ elements: [el('e1', { bounds: { x: 0.5, y: 0, width: 100, height: 50 } } as any)] }),
    );
    expect(near.elementDiffs).toHaveLength(0);

    const far = diffSnapshots(
      snap({ elements: [el('e1', { bounds: { x: 0, y: 0, width: 100, height: 50 } } as any)] }),
      snap({ elements: [el('e1', { bounds: { x: 5, y: 0, width: 100, height: 50 } } as any)] }),
    );
    expect(far.elementDiffs[0].diffs.some((d) => d.field === 'bounds')).toBe(true);
  });

  it('treats false / undefined / null as equivalent (boolean-falsy normalisation)', () => {
    const r = diffSnapshots(
      snap({ elements: [el('e1', { required: false } as any)] }),
      snap({ elements: [el('e1', {} as any)] }),
    );
    expect(r.elementDiffs).toHaveLength(0);
  });

  it('flags a real boolean divergence (true vs falsy)', () => {
    const r = diffSnapshots(
      snap({ elements: [el('e1', { required: true } as any)] }),
      snap({ elements: [el('e1', {} as any)] }),
    );
    expect(r.elementDiffs[0].diffs.some((d) => d.field === 'required')).toBe(true);
  });

  it('treats raw tag and WAI-ARIA role as equivalent for a known tag', () => {
    const r = diffSnapshots(
      snap({ elements: [el('e1', { tag: 'a', role: 'a' } as any)] }),
      snap({ elements: [el('e1', { tag: 'a', role: 'link' } as any)] }),
    );
    expect(r.elementDiffs).toHaveLength(0);
  });

  it('flags a genuine role mismatch even for a known tag', () => {
    const r = diffSnapshots(
      snap({ elements: [el('e1', { tag: 'a', role: 'a' } as any)] }),
      snap({ elements: [el('e1', { tag: 'a', role: 'button' } as any)] }),
    );
    expect(r.elementDiffs[0].diffs.some((d) => d.field === 'role')).toBe(true);
  });

  it('compares ordered arrays element-by-element', () => {
    const same = diffSnapshots(
      snap({ elements: [el('e1', { parentRefChain: ['a', 'b'] } as any)] }),
      snap({ elements: [el('e1', { parentRefChain: ['a', 'b'] } as any)] }),
    );
    expect(same.elementDiffs).toHaveLength(0);

    const reordered = diffSnapshots(
      snap({ elements: [el('e1', { parentRefChain: ['a', 'b'] } as any)] }),
      snap({ elements: [el('e1', { parentRefChain: ['b', 'a'] } as any)] }),
    );
    expect(reordered.elementDiffs[0].diffs.some((d) => d.field === 'parentRefChain')).toBe(true);
  });

  it('skips the privacy-masked value field', () => {
    const r = diffSnapshots(
      snap({ elements: [el('e1', { value: 'secret-a' } as any)] }),
      snap({ elements: [el('e1', { value: 'secret-b' } as any)] }),
    );
    expect(r.elementDiffs).toHaveLength(0);
  });
});

describe('diffSnapshots — summary histogram', () => {
  it('counts field divergences per field name', () => {
    const a = snap({ elements: [el('e1', { text: 'A' } as any), el('e2', { text: 'B' } as any)] });
    const b = snap({ elements: [el('e1', { text: 'X' } as any), el('e2', { text: 'Y' } as any)] });
    const r = diffSnapshots(a, b);
    expect(r.summary.elementsWithFieldDiffs).toBe(2);
    expect(r.summary.fieldDivergenceHistogram.text).toBe(2);
  });
});
