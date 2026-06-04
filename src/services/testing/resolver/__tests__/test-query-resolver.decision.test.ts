import { decideResolution } from '../test-query-resolver.service';
import type { QueryCandidate } from '../resolver.types';

const c = (id: string, score: number): QueryCandidate => ({ id, name: id, score });

describe('decideResolution', () => {
  it('returns none when nothing clears the noise floor', () => {
    const r = decideResolution([c('a', 0.05), c('b', 0.1)], 8);
    expect(r.resolution).toBe('none');
    expect(r.candidates).toHaveLength(0);
  });

  it('returns unique when the top clears the floor and leads by the margin', () => {
    const r = decideResolution([c('a', 0.9), c('b', 0.4)], 8);
    expect(r.resolution).toBe('unique');
    expect(r.topId).toBe('a');
  });

  it('returns unique for a single strong candidate (no runner-up)', () => {
    const r = decideResolution([c('only', 0.8)], 8);
    expect(r.resolution).toBe('unique');
    expect(r.topId).toBe('only');
  });

  it('returns ambiguous when two strong candidates are within the margin', () => {
    const r = decideResolution([c('a', 0.7), c('b', 0.62)], 8);
    expect(r.resolution).toBe('ambiguous');
    expect(r.topId).toBeUndefined();
    expect(r.candidates.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns ambiguous when the leader is below the unique floor even if alone-ish', () => {
    const r = decideResolution([c('a', 0.4), c('b', 0.15)], 8);
    expect(r.resolution).toBe('ambiguous');
  });

  it('sorts by score descending and caps to maxCandidates', () => {
    const r = decideResolution([c('a', 0.3), c('b', 0.9), c('c', 0.5)], 2);
    expect(r.candidates.map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('drops sub-floor noise before ranking', () => {
    const r = decideResolution([c('keep', 0.5), c('drop', 0.05)], 8);
    expect(r.candidates.map((x) => x.id)).toEqual(['keep']);
  });
});
