import { buildParsedSnapshot } from '../parsed-snapshot';

const snap = (over: any = {}): any => ({ elements: [], ...over });
const el = (ref: string, over: any = {}) => ({ ref, name: ref, type: 'button', visible: true, disabled: false, ...over });

describe('buildParsedSnapshot', () => {
  it('indexes element own refs into elementsByRef and allRefs', () => {
    const ps = buildParsedSnapshot(snap({ elements: [el('e1'), el('e2')] }));
    expect(ps.elementsByRef.get('e1')?.ref).toBe('e1');
    expect(ps.allRefs.has('e1')).toBe(true);
    expect(ps.allRefs.has('e2')).toBe(true);
  });

  it('adds modal / transient / pagination refs to allRefs but NOT elementsByRef', () => {
    const ps = buildParsedSnapshot(snap({
      elements: [el('e1')],
      activeModalRef: 'm1',
      transientState: { ref: 'load1' },
      pageStructure: { pagination: { nextRef: 'next1', prevRef: 'prev1' } },
    }));
    for (const ref of ['m1', 'load1', 'next1', 'prev1']) {
      expect(ps.allRefs.has(ref)).toBe(true);
      expect(ps.elementsByRef.has(ref)).toBe(false); // only own element refs are indexed
    }
  });

  it('hasRef is a sugar wrapper over allRefs', () => {
    const ps = buildParsedSnapshot(snap({ elements: [el('e1')], activeModalRef: 'm1' }));
    expect(ps.hasRef('e1')).toBe(true);
    expect(ps.hasRef('m1')).toBe(true);
    expect(ps.hasRef('nope')).toBe(false);
  });

  it('preserves the original snapshot on source', () => {
    const s = snap({ elements: [el('e1')] });
    expect(buildParsedSnapshot(s).source).toBe(s);
  });

  it('handles a snapshot with no optional fields', () => {
    const ps = buildParsedSnapshot(snap({ elements: [el('e1')] }));
    expect(ps.allRefs.size).toBe(1);
    expect(ps.elementsByRef.size).toBe(1);
  });

  it('handles partial pagination (only nextRef)', () => {
    const ps = buildParsedSnapshot(snap({ elements: [], pageStructure: { pagination: { nextRef: 'n1' } } }));
    expect(ps.allRefs.has('n1')).toBe(true);
    expect(ps.allRefs.size).toBe(1);
  });

  it('returns empty structures for an empty snapshot', () => {
    const ps = buildParsedSnapshot(snap({ elements: [] }));
    expect(ps.allRefs.size).toBe(0);
    expect(ps.elementsByRef.size).toBe(0);
  });

  it('keeps the last element when refs collide', () => {
    const ps = buildParsedSnapshot(snap({ elements: [el('dup', { name: 'first' }), el('dup', { name: 'second' })] }));
    expect(ps.elementsByRef.get('dup')?.name).toBe('second');
    expect(ps.allRefs.size).toBe(1);
  });
});
