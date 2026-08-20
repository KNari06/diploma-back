import { withExpectsTransition } from '../expects-transition';

describe('withExpectsTransition', () => {
  it('records the expectation when the runner watched the screen change', () => {
    expect(withExpectsTransition({ timeout: 5 }, true)).toEqual({ timeout: 5, expectsTransition: true });
  });

  it('records it onto a step that had no options at all', () => {
    expect(withExpectsTransition(undefined, true)).toEqual({ expectsTransition: true });
  });

  it('writes NOTHING when the screen did not change', () => {
    // One-way on purpose. The editor's Run loop applies steps too, so a run in
    // which the tap MISSED must not record `expectsTransition: false` and pin
    // the step to the guard's lenient branch permanently.
    const opts = { timeout: 5 };
    expect(withExpectsTransition(opts, false)).toBe(opts);
  });

  it('writes nothing when there was no verdict', () => {
    const opts = { timeout: 5 };
    expect(withExpectsTransition(opts, undefined)).toBe(opts);
  });

  it('never un-sets an expectation already recorded', () => {
    const opts = { expectsTransition: true as const };
    expect(withExpectsTransition(opts, false)).toBe(opts);
    expect(withExpectsTransition(opts, undefined)).toBe(opts);
  });

  it('does not clone when the expectation is already recorded and re-observed', () => {
    const opts = { expectsTransition: true as const };
    expect(withExpectsTransition(opts, true)).toBe(opts);
  });

  it('leaves the caller\'s options object untouched', () => {
    const opts = { timeout: 5 };
    withExpectsTransition(opts, true);
    expect(opts).toEqual({ timeout: 5 });
  });
});
