import { collapseLevelsIfBarrierDisabled } from '../level-dispatch.util';

describe('collapseLevelsIfBarrierDisabled', () => {
  it('returns levels unchanged when the barrier is enabled', () => {
    const levels = [['a', 'b'], ['c']];
    expect(collapseLevelsIfBarrierDisabled(levels, false)).toBe(levels);
  });

  it('collapses all levels into one when the barrier is disabled', () => {
    expect(collapseLevelsIfBarrierDisabled([['a', 'b'], ['c'], ['d']], true)).toEqual([
      ['a', 'b', 'c', 'd'],
    ]);
  });

  it('keeps a single level as a single level', () => {
    expect(collapseLevelsIfBarrierDisabled([['a', 'b']], true)).toEqual([['a', 'b']]);
  });

  it('never produces [[]] for an empty run', () => {
    expect(collapseLevelsIfBarrierDisabled([], true)).toEqual([]);
  });
});
