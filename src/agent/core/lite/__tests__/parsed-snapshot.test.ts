/**
 * Tests for ParsedSnapshot factory.
 *
 * Critical correctness invariant: allRefs MUST be a superset of every ref
 * that the formatted snapshot string would contain. Switching from regex
 * matching to Set lookup must NOT create false negatives. See parsed-snapshot.ts
 * for the source of truth.
 */

import { buildParsedSnapshot } from '../agents/parsed-snapshot';
import type { LiteElement, LiteSnapshot } from '../lite-types';

function createElement(overrides: Partial<LiteElement>): LiteElement {
  return {
    ref: overrides.ref || 'e0',
    role: overrides.role || 'button',
    name: overrides.name || '',
    tag: overrides.tag || 'button',
    visible: overrides.visible !== undefined ? overrides.visible : true,
    disabled: overrides.disabled || false,
    ...overrides,
  } as LiteElement;
}

function createSnapshot(overrides: Partial<LiteSnapshot> = {}): LiteSnapshot {
  return {
    url: 'https://example.com',
    title: 'Test',
    elements: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('buildParsedSnapshot', () => {
  describe('element refs', () => {
    it('indexes element own refs in elementsByRef and allRefs', () => {
      const snapshot = createSnapshot({
        elements: [
          createElement({ ref: 'e0', name: 'Submit' }),
          createElement({ ref: 'e5', name: 'Cancel' }),
          createElement({ ref: 'e50', name: 'Reset' }),
        ],
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.allRefs.size).toBe(3);
      expect(parsed.allRefs.has('e0')).toBe(true);
      expect(parsed.allRefs.has('e5')).toBe(true);
      expect(parsed.allRefs.has('e50')).toBe(true);
      expect(parsed.elementsByRef.size).toBe(3);
      expect(parsed.elementsByRef.get('e5')?.name).toBe('Cancel');
    });

    it('hasRef distinguishes e5 from e50 (no word-boundary collision)', () => {
      // This test catches the regex hazard: \be5\b would correctly NOT match e50,
      // but our Set lookup must also not collide. Set.has is strict equality,
      // so this is by construction — but we test it anyway as a regression guard.
      const snapshot = createSnapshot({
        elements: [
          createElement({ ref: 'e5' }),
          createElement({ ref: 'e50' }),
        ],
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.hasRef('e5')).toBe(true);
      expect(parsed.hasRef('e50')).toBe(true);
      expect(parsed.hasRef('e500')).toBe(false);
      expect(parsed.hasRef('e')).toBe(false);
    });

    it('hasRef returns false for non-existent refs', () => {
      const snapshot = createSnapshot({
        elements: [createElement({ ref: 'e0' })],
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.hasRef('e99')).toBe(false);
      expect(parsed.hasRef('')).toBe(false);
    });

    it('handles empty snapshot', () => {
      const snapshot = createSnapshot({ elements: [] });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.allRefs.size).toBe(0);
      expect(parsed.elementsByRef.size).toBe(0);
      expect(parsed.hasRef('e0')).toBe(false);
    });
  });

  describe('non-element refs (must be in allRefs to match format() output)', () => {
    it('includes activeModalRef even if not in elements', () => {
      // format() emits "ACTIVE_MODAL: ${activeModalRef}". A regex \be10\b
      // would have matched it before. Set must include it too.
      const snapshot = createSnapshot({
        elements: [createElement({ ref: 'e0' })],
        activeModalRef: 'e10',
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.hasRef('e0')).toBe(true);
      expect(parsed.hasRef('e10')).toBe(true);
      expect(parsed.elementsByRef.has('e10')).toBe(false); // not in element map
    });

    it('includes transientState.ref', () => {
      const snapshot = createSnapshot({
        elements: [createElement({ ref: 'e0' })],
        transientState: { isTransient: true, type: 'spinner', ref: 'e7' },
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.hasRef('e7')).toBe(true);
    });

    it('includes pagination nextRef and prevRef', () => {
      const snapshot = createSnapshot({
        elements: [createElement({ ref: 'e0' })],
        pageStructure: {
          tables: [],
          lists: [],
          pagination: {
            currentPage: 2,
            totalPages: 5,
            nextRef: 'e20',
            prevRef: 'e21',
          },
        },
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.hasRef('e20')).toBe(true);
      expect(parsed.hasRef('e21')).toBe(true);
    });

    it('handles missing pagination gracefully', () => {
      const snapshot = createSnapshot({
        elements: [createElement({ ref: 'e0' })],
        pageStructure: { tables: [], lists: [], pagination: null },
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.hasRef('e0')).toBe(true);
      expect(parsed.allRefs.size).toBe(1);
    });
  });

  describe('source preservation', () => {
    it('preserves original snapshot on .source', () => {
      const snapshot = createSnapshot({
        elements: [createElement({ ref: 'e0', name: 'Hello' })],
      });

      const parsed = buildParsedSnapshot(snapshot);

      expect(parsed.source).toBe(snapshot);
      expect(parsed.source.elements[0].name).toBe('Hello');
    });
  });

  describe('element data access', () => {
    it('provides full element data via elementsByRef.get', () => {
      const snapshot = createSnapshot({
        elements: [
          createElement({ ref: 'e0', name: 'Submit', tag: 'button', disabled: true }),
        ],
      });

      const parsed = buildParsedSnapshot(snapshot);
      const el = parsed.elementsByRef.get('e0');

      expect(el).toBeDefined();
      expect(el?.name).toBe('Submit');
      expect(el?.tag).toBe('button');
      expect(el?.disabled).toBe(true);
    });
  });
});
