import type { LiteElement } from '@/agent/core/lite/lite-types';
import { __internalsForTesting } from '../cdp-snapshot.service';

const { dedupeElementsByRef, dedupSurvivorScore } = __internalsForTesting;

/**
 * Build a minimal LiteElement. `bounds` omitted → undefined (treated as
 * zero-area). Pass `noBoundsRescued` to stamp the internal flag that the
 * tier-1 noBounds rescue sets.
 */
function el(
  ref: string,
  opts: {
    tag?: string;
    name?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    noBoundsRescued?: boolean;
  } = {},
): LiteElement {
  const e = {
    ref,
    role: '',
    name: opts.name ?? '',
    tag: opts.tag ?? 'div',
    visible: true,
    bounds: opts.bounds,
  } as LiteElement;
  if (opts.noBoundsRescued) {
    (e as unknown as { __noBoundsRescued: boolean }).__noBoundsRescued = true;
  }
  return e;
}

const REAL_BOX = { x: 498, y: 364, width: 284, height: 56 };

describe('dedupSurvivorScore', () => {
  it('scores a real rendered box higher than a noBounds-rescue node', () => {
    expect(dedupSurvivorScore(el('e0', { bounds: REAL_BOX }))).toBe(1);
    expect(
      dedupSurvivorScore(el('e0', { noBoundsRescued: true })),
    ).toBe(0);
  });

  it('scores zero-area and missing bounds as 0', () => {
    expect(dedupSurvivorScore(el('e0'))).toBe(0); // no bounds
    expect(
      dedupSurvivorScore(el('e0', { bounds: { x: 0, y: 0, width: 0, height: 0 } })),
    ).toBe(0);
    expect(
      dedupSurvivorScore(el('e0', { bounds: { x: 0, y: 0, width: 10, height: 0 } })),
    ).toBe(0); // one zero dimension still 0
  });
});

describe('dedupeElementsByRef — doculite incident', () => {
  it('keeps the visible password input over a noBounds iframe svg sharing e0', () => {
    // Reproduces the exact array shape from the forensic capture: the
    // hidden iframe's noBounds <svg ArrowDropDownIcon> is FIRST in the
    // array, the real password <input> is second. Old keep-first dropped
    // the password; quality-aware keep-winner must keep it.
    const elements = [
      el('e0', { tag: 'svg', name: 'ArrowDropDownIcon', noBoundsRescued: true }),
      el('e0', { tag: 'input', name: 'password', bounds: REAL_BOX }),
      el('e1', { tag: 'input', name: 'email', bounds: { x: 498, y: 292, width: 326, height: 56 } }),
    ];
    const losers = dedupeElementsByRef(elements);

    // Survivor for e0 is the password input.
    const survivorE0 = elements.find((e) => e.ref === 'e0');
    expect(survivorE0?.name).toBe('password');
    expect(survivorE0?.tag).toBe('input');

    // The noBounds svg was the loser.
    expect(losers).toHaveLength(1);
    expect(losers[0].tag).toBe('svg');

    // Email untouched.
    expect(elements.some((e) => e.ref === 'e1' && e.name === 'email')).toBe(true);
    // Exactly one element per ref remains.
    expect(elements.map((e) => e.ref).sort()).toEqual(['e0', 'e1']);
  });

  it('keeps the password input even when it appears BEFORE the svg', () => {
    // Order independence: the winner is decided by score, not position.
    const elements = [
      el('e0', { tag: 'input', name: 'password', bounds: REAL_BOX }),
      el('e0', { tag: 'svg', name: 'ArrowDropDownIcon', noBoundsRescued: true }),
    ];
    dedupeElementsByRef(elements);
    expect(elements).toHaveLength(1);
    expect(elements[0].name).toBe('password');
  });
});

describe('dedupeElementsByRef — edge cases', () => {
  it('returns no losers and leaves the array intact when all refs are unique', () => {
    const elements = [
      el('e0', { bounds: REAL_BOX }),
      el('e1', { bounds: REAL_BOX }),
      el('e2', { bounds: REAL_BOX }),
    ];
    const before = [...elements];
    const losers = dedupeElementsByRef(elements);
    expect(losers).toHaveLength(0);
    expect(elements).toEqual(before);
  });

  it('handles an empty array', () => {
    const elements: LiteElement[] = [];
    expect(dedupeElementsByRef(elements)).toHaveLength(0);
    expect(elements).toHaveLength(0);
  });

  it('never drops elements without a ref (empty-ref entries are preserved)', () => {
    const elements = [
      el('', { tag: 'a', name: 'no-ref-1' }),
      el('e0', { bounds: REAL_BOX }),
      el('', { tag: 'a', name: 'no-ref-2' }),
    ];
    const losers = dedupeElementsByRef(elements);
    expect(losers).toHaveLength(0);
    // Both empty-ref entries survive (the post-collect filter handles them).
    expect(elements.filter((e) => !e.ref)).toHaveLength(2);
  });

  it('on a tie (both same score) keeps the earliest array index — stable', () => {
    // Two real-box elements with the same ref: keep the first.
    const first = el('e0', { tag: 'input', name: 'first', bounds: REAL_BOX });
    const second = el('e0', { tag: 'input', name: 'second', bounds: REAL_BOX });
    const elements = [first, second];
    const losers = dedupeElementsByRef(elements);
    expect(elements).toHaveLength(1);
    expect(elements[0].name).toBe('first');
    expect(losers[0].name).toBe('second');
  });

  it('on a tie of two noBounds nodes keeps the earliest (both score 0)', () => {
    const elements = [
      el('e0', { tag: 'svg', name: 'icon-a', noBoundsRescued: true }),
      el('e0', { tag: 'svg', name: 'icon-b', noBoundsRescued: true }),
    ];
    dedupeElementsByRef(elements);
    expect(elements).toHaveLength(1);
    expect(elements[0].name).toBe('icon-a');
  });

  it('collapses three-way collision to the single best element', () => {
    const elements = [
      el('e0', { tag: 'svg', name: 'glyph', noBoundsRescued: true }), // score 0
      el('e0', { tag: 'span', name: 'zero', bounds: { x: 0, y: 0, width: 0, height: 0 } }), // score 0
      el('e0', { tag: 'button', name: 'real-button', bounds: REAL_BOX }), // score 1 — winner
    ];
    const losers = dedupeElementsByRef(elements);
    expect(elements).toHaveLength(1);
    expect(elements[0].name).toBe('real-button');
    expect(losers.map((l) => l.name).sort()).toEqual(['glyph', 'zero']);
  });

  it('returns losers in document order', () => {
    const elements = [
      el('e0', { tag: 'button', name: 'winner', bounds: REAL_BOX }),
      el('e0', { tag: 'svg', name: 'loser-1', noBoundsRescued: true }),
      el('e0', { tag: 'svg', name: 'loser-2', noBoundsRescued: true }),
    ];
    const losers = dedupeElementsByRef(elements);
    expect(losers.map((l) => l.name)).toEqual(['loser-1', 'loser-2']);
  });

  it('handles multiple independent collisions in one pass', () => {
    const elements = [
      el('e0', { tag: 'svg', noBoundsRescued: true }),
      el('e0', { tag: 'input', name: 'pw', bounds: REAL_BOX }),
      el('e1', { tag: 'input', name: 'email', bounds: REAL_BOX }),
      el('e2', { tag: 'svg', name: 'a', noBoundsRescued: true }),
      el('e2', { tag: 'button', name: 'submit', bounds: REAL_BOX }),
    ];
    const losers = dedupeElementsByRef(elements);
    expect(losers).toHaveLength(2);
    const refs = elements.map((e) => e.ref).sort();
    expect(refs).toEqual(['e0', 'e1', 'e2']);
    expect(elements.find((e) => e.ref === 'e0')?.name).toBe('pw');
    expect(elements.find((e) => e.ref === 'e2')?.name).toBe('submit');
  });
});
