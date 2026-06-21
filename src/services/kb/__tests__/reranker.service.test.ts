import { applyRerank } from '../reranker.service';

type Item = { id: string; label: string };
type RerankHit = { id: string; score: number; rank: number };

const items: Item[] = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
];

describe('applyRerank', () => {
  it('returns items unchanged when hits is null', () => {
    expect(applyRerank(items, null)).toBe(items);
  });

  it('returns items unchanged when hits is empty', () => {
    expect(applyRerank(items, [])).toBe(items);
  });

  it('reorders items to match the hit order', () => {
    const hits: RerankHit[] = [
      { id: 'c', score: 0.9, rank: 0 },
      { id: 'a', score: 0.5, rank: 1 },
      { id: 'b', score: 0.2, rank: 2 },
    ];
    expect(applyRerank(items, hits).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends items missing from hits, preserving their original order', () => {
    const hits: RerankHit[] = [{ id: 'c', score: 0.9, rank: 0 }];
    expect(applyRerank(items, hits).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('ignores duplicate hit ids and unknown ids', () => {
    const hits: RerankHit[] = [
      { id: 'b', score: 0.9, rank: 0 },
      { id: 'b', score: 0.8, rank: 1 }, // duplicate
      { id: 'zzz', score: 0.7, rank: 2 }, // not in items
    ];
    expect(applyRerank(items, hits).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });
});
