/**
 * Unit tests for snapshot-diff.util (Etap 2 Task 2.7).
 *
 * Why this matters more than typical diff util tests:
 *   This utility runs in shadow mode (Week 3) to compare CDP-path
 *   vs evaluate-path snapshots. False POSITIVE divergences (saying
 *   snapshots differ when they actually agree) would scare us away
 *   from a working CDP path. False NEGATIVE divergences (missing a
 *   real difference) would let CDP path go to production with hidden
 *   coverage gaps.
 *
 *   So the bar here isn't "does it work" — it's "does it correctly
 *   classify every category of difference we can anticipate".
 */

import { diffSnapshots } from '../snapshot-diff.util';
import type { LiteElement, LiteSnapshot } from '@/agent/core/lite/lite-types';

describe('diffSnapshots', () => {
  describe('top-level fields', () => {
    it('reports url mismatch', () => {
      const a = makeSnapshot({ url: 'https://a.com' });
      const b = makeSnapshot({ url: 'https://b.com' });
      const r = diffSnapshots(a, b);
      expect(r.match).toBe(false);
      expect(r.topLevelDiffs).toContainEqual({
        field: 'url',
        a: 'https://a.com',
        b: 'https://b.com',
      });
    });

    it('reports title mismatch', () => {
      const r = diffSnapshots(makeSnapshot({ title: 'A' }), makeSnapshot({ title: 'B' }));
      expect(r.match).toBe(false);
      expect(r.topLevelDiffs.some((d) => d.field === 'title')).toBe(true);
    });

    it('reports activeModalRef mismatch (modal Layer 2 gap surface)', () => {
      // This is the EXACT divergence Phase 5 Layer 1 vs in-page Layer 2
      // will produce most often. Want explicit coverage.
      const a = makeSnapshot({ activeModalRef: 'e42' });
      const b = makeSnapshot({ activeModalRef: undefined });
      const r = diffSnapshots(a, b);
      expect(r.topLevelDiffs.some((d) => d.field === 'activeModalRef')).toBe(true);
    });

    it('reports viewport mismatch (used by buildAllowedSets modal-coverage)', () => {
      const a = makeSnapshot({ viewport: { width: 1280, height: 720 } });
      const b = makeSnapshot({ viewport: { width: 1024, height: 768 } });
      const r = diffSnapshots(a, b);
      expect(r.topLevelDiffs.some((d) => d.field === 'viewport')).toBe(true);
    });

    it('does NOT report timestamp difference (sources have inherent skew)', () => {
      // CDP path runs at T1, evaluate path at T2 — by design they
      // differ. Including timestamp in diff would always flag every
      // shadow comparison as divergent.
      const a = makeSnapshot({ timestamp: 1000 });
      const b = makeSnapshot({ timestamp: 2000 });
      const r = diffSnapshots(a, b);
      expect(r.topLevelDiffs).toHaveLength(0);
      expect(r.match).toBe(true);
    });
  });

  describe('element identity by ref', () => {
    it('lists onlyInA when ref present in A but not B', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1' }), el({ ref: 'e2' })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1' })] });
      const r = diffSnapshots(a, b);
      expect(r.onlyInA).toEqual(['e2']);
      expect(r.onlyInB).toEqual([]);
      expect(r.match).toBe(false);
    });

    it('lists onlyInB when ref present in B but not A', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1' })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1' }), el({ ref: 'e3' })] });
      const r = diffSnapshots(a, b);
      expect(r.onlyInA).toEqual([]);
      expect(r.onlyInB).toEqual(['e3']);
    });

    it('match=true when both empty', () => {
      const r = diffSnapshots(makeSnapshot({}), makeSnapshot({}));
      expect(r.match).toBe(true);
      expect(r.onlyInA).toEqual([]);
      expect(r.onlyInB).toEqual([]);
    });

    it('summary counts populate correctly', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1' }), el({ ref: 'e2' })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1' }), el({ ref: 'e2' }), el({ ref: 'e3' })] });
      const r = diffSnapshots(a, b);
      expect(r.summary.aElementCount).toBe(2);
      expect(r.summary.bElementCount).toBe(3);
      expect(r.summary.matchedElementCount).toBe(2);
    });
  });

  describe('per-element field differences', () => {
    it('reports field diff with ref + tag for diagnostic readability', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1', tag: 'button', name: 'Save' })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', tag: 'button', name: 'Submit' })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs).toHaveLength(1);
      expect(r.elementDiffs[0].ref).toBe('e1');
      expect(r.elementDiffs[0].tag).toBe('button');
      expect(r.elementDiffs[0].diffs).toContainEqual({
        field: 'name',
        a: 'Save',
        b: 'Submit',
      });
    });

    it('histogram counts divergences per field name', () => {
      // 3 elements, all differ on `name`. Histogram should show
      // `name: 3` so dashboards can spot "AX name routinely diverges
      // from manually-computed name".
      const a = makeSnapshot({
        elements: [
          el({ ref: 'e1', name: 'a' }),
          el({ ref: 'e2', name: 'b' }),
          el({ ref: 'e3', name: 'c' }),
        ],
      });
      const b = makeSnapshot({
        elements: [
          el({ ref: 'e1', name: 'X' }),
          el({ ref: 'e2', name: 'Y' }),
          el({ ref: 'e3', name: 'Z' }),
        ],
      });
      const r = diffSnapshots(a, b);
      expect(r.summary.fieldDivergenceHistogram.name).toBe(3);
    });

    it('treats undefined and null as equal (sparse fields are normal)', () => {
      // LiteElement has many optional fields. CDP path may not fill
      // them; evaluate path may. We don't want every absent-vs-null
      // pair to count as divergence — same observable shape.
      const a = makeSnapshot({ elements: [el({ ref: 'e1', placeholder: undefined })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1' })] }); // placeholder absent entirely
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs).toHaveLength(0);
      expect(r.match).toBe(true);
    });
  });

  describe('value field skip (privacy)', () => {
    it('does NOT compare value field (privacy-redacted in production)', () => {
      // Privacy contract: value never crosses WS pipe. If CDP path
      // accidentally forwarded the value, comparing here would help
      // — but we explicitly skip to keep the contract honest.
      // hasValue (boolean) IS compared; value (string) is NOT.
      const a = makeSnapshot({ elements: [el({ ref: 'e1', value: 'secret-1' })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', value: 'secret-2' })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs).toHaveLength(0);
      expect(r.match).toBe(true);
    });

    it('DOES compare hasValue (state-aware boolean is part of contract)', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1', hasValue: true })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', hasValue: false })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs).toHaveLength(1);
      expect(r.elementDiffs[0].diffs[0].field).toBe('hasValue');
    });
  });

  describe('bbox tolerance (subpixel rounding)', () => {
    it('treats bbox within 1px as equal', () => {
      // CDP layout.bounds and getBoundingClientRect both report
      // subpixel values; rounding differences below this are noise.
      const a = makeSnapshot({ elements: [el({ ref: 'e1', bounds: { x: 100, y: 200, width: 50, height: 30 } })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', bounds: { x: 100.5, y: 200.5, width: 50.5, height: 30.5 } })] });
      const r = diffSnapshots(a, b);
      expect(r.match).toBe(true);
    });

    it('flags bbox >1px difference', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1', bounds: { x: 100, y: 200, width: 50, height: 30 } })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', bounds: { x: 105, y: 200, width: 50, height: 30 } })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs).toHaveLength(1);
      expect(r.elementDiffs[0].diffs[0].field).toBe('bounds');
    });

    it('treats both-undefined bounds as equal', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1' })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1' })] });
      const r = diffSnapshots(a, b);
      expect(r.match).toBe(true);
    });

    it('flags one-side-undefined bounds (one path saw it visible, other did not)', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1', bounds: { x: 100, y: 200, width: 50, height: 30 } })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1' })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs[0].diffs[0].field).toBe('bounds');
    });
  });

  describe('ordered array fields', () => {
    it('compares parentRefChain in order (parent walking divergence is meaningful)', () => {
      // parentRefChain has semantic order: closest-first. If CDP
      // Phase 3c-Node walks differently from existing collector,
      // the chain order would diverge — that's a real bug to surface.
      const a = makeSnapshot({ elements: [el({ ref: 'e1', parentRefChain: ['e2', 'e3'] })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', parentRefChain: ['e3', 'e2'] })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs[0].diffs[0].field).toBe('parentRefChain');
    });

    it('compares containerTitles in order', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1', containerTitles: ['Form', 'Section'] })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', containerTitles: ['Section', 'Form'] })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs[0].diffs[0].field).toBe('containerTitles');
    });

    it('treats different-length arrays as divergent', () => {
      const a = makeSnapshot({ elements: [el({ ref: 'e1', parentRefChain: ['e2', 'e3', 'e4'] })] });
      const b = makeSnapshot({ elements: [el({ ref: 'e1', parentRefChain: ['e2', 'e3'] })] });
      const r = diffSnapshots(a, b);
      expect(r.elementDiffs[0].diffs[0].field).toBe('parentRefChain');
    });
  });

  describe('match=true scenarios', () => {
    it('returns match=true for identical empty snapshots', () => {
      expect(diffSnapshots(makeSnapshot({}), makeSnapshot({})).match).toBe(true);
    });

    it('returns match=true for identical non-trivial snapshot', () => {
      const elements = [
        el({
          ref: 'e1',
          tag: 'button',
          role: 'button',
          name: 'Save',
          bounds: { x: 100, y: 200, width: 50, height: 30 },
          parentRefChain: ['e2', 'e3'],
          isInsideActiveModal: true,
        }),
      ];
      const a = makeSnapshot({ elements, activeModalRef: 'e3', viewport: { width: 1280, height: 720 } });
      const b = makeSnapshot({
        elements: [el({ ...elements[0] })],
        activeModalRef: 'e3',
        viewport: { width: 1280, height: 720 },
      });
      const r = diffSnapshots(a, b);
      expect(r.match).toBe(true);
      expect(r.summary.elementsWithFieldDiffs).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<LiteSnapshot>): LiteSnapshot {
  return {
    url: 'https://example.com',
    title: 'Test',
    elements: [],
    timestamp: 0,
    ...overrides,
  };
}

function el(overrides: Partial<LiteElement> = {}): LiteElement {
  return {
    ref: 'e0',
    role: '',
    name: '',
    tag: 'div',
    visible: true,
    ...overrides,
  } as LiteElement;
}
