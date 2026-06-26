import { diffHoverEffect, hasHoverEffect } from '../hover-effect-probe.util';

const snap = (over: any = {}): any => ({
  interactiveCount: over.interactiveCount ?? 0,
  visualInteractiveCount: over.visualInteractiveCount ?? 0,
  expandedChain: over.expandedChain ?? {},
  dataStateChain: over.dataStateChain ?? {},
});

describe('diffHoverEffect', () => {
  it('returns a no-effect diff when either snapshot is null', () => {
    const none = { newInteractive: 0, newVisualInteractive: 0, expandedTriggered: false, dataStateOpened: false };
    expect(diffHoverEffect(null, snap())).toEqual(none);
    expect(diffHoverEffect(snap(), null)).toEqual(none);
    expect(diffHoverEffect(null, null)).toEqual(none);
  });

  it('computes interactive count deltas (including negative)', () => {
    const d = diffHoverEffect(
      snap({ interactiveCount: 3, visualInteractiveCount: 2 }),
      snap({ interactiveCount: 5, visualInteractiveCount: 1 }),
    );
    expect(d.newInteractive).toBe(2);
    expect(d.newVisualInteractive).toBe(-1);
  });

  it('flags expandedTriggered only on a false→true (or absent→true) transition', () => {
    expect(diffHoverEffect(snap({ expandedChain: { 0: 'false' } }), snap({ expandedChain: { 0: 'true' } })).expandedTriggered).toBe(true);
    expect(diffHoverEffect(snap(), snap({ expandedChain: { 0: 'true' } })).expandedTriggered).toBe(true); // absent before
    expect(diffHoverEffect(snap({ expandedChain: { 0: 'true' } }), snap({ expandedChain: { 0: 'true' } })).expandedTriggered).toBe(false);
    expect(diffHoverEffect(snap({ expandedChain: { 0: 'true' } }), snap({ expandedChain: { 0: 'false' } })).expandedTriggered).toBe(false);
  });

  it('flags dataStateOpened when a state moves into the open family', () => {
    expect(diffHoverEffect(snap(), snap({ dataStateChain: { 0: 'open' } })).dataStateOpened).toBe(true);
    expect(diffHoverEffect(snap({ dataStateChain: { 0: 'closed' } }), snap({ dataStateChain: { 0: 'active' } })).dataStateOpened).toBe(true);
    // already open and unchanged → not a transition
    expect(diffHoverEffect(snap({ dataStateChain: { 0: 'open' } }), snap({ dataStateChain: { 0: 'open' } })).dataStateOpened).toBe(false);
    // moved to a non-open state → not opened
    expect(diffHoverEffect(snap(), snap({ dataStateChain: { 0: 'closed' } })).dataStateOpened).toBe(false);
  });
});

describe('hasHoverEffect', () => {
  const base = { newInteractive: 0, newVisualInteractive: 0, expandedTriggered: false, dataStateOpened: false };

  it('is false for a no-effect diff', () => {
    expect(hasHoverEffect({ ...base })).toBe(false);
  });

  it('is true when any single structural signal is present', () => {
    expect(hasHoverEffect({ ...base, newVisualInteractive: 1 })).toBe(true);
    expect(hasHoverEffect({ ...base, newInteractive: 2 })).toBe(true);
    expect(hasHoverEffect({ ...base, expandedTriggered: true })).toBe(true);
    expect(hasHoverEffect({ ...base, dataStateOpened: true })).toBe(true);
  });

  it('ignores a negative interactive delta', () => {
    expect(hasHoverEffect({ ...base, newInteractive: -2, newVisualInteractive: 0 })).toBe(false);
  });
});
