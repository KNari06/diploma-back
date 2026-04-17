/**
 * Intra-flow overlay gate tests.
 *
 * Covers:
 *   - Empty / missing snapshot → skip (cheap path)
 *   - Noise-only obstacles (cookie_consent, tooltip, toast, etc.) → dismiss
 *   - App dialog present (modal / drawer / paywall) → do NOT dismiss even
 *     if noise is also present (safety-critical bias)
 *   - Only inert obstacles (sticky headers, loading overlays) → skip
 *   - Unclassified obstacles (no hintType) → treated as inert
 *   - Diagnostic fields (noiseTypes, reason) populated correctly
 */

import { evaluateOverlayGate } from '../intra-flow-overlay-gate';
import type { LiteSnapshot, ObstacleFact, ObstacleType } from '../../lite-types';

function mkObstacle(overrides: Partial<ObstacleFact> & { hintType?: ObstacleType }): ObstacleFact {
  return {
    ref: 'ob1',
    tag: 'div',
    position: 'fixed',
    zIndex: 9999,
    coverage: 0.2,
    className: '',
    textPreview: '',
    hasCloseButton: true,
    hasInteractiveChildren: true,
    rect: { top: 0, left: 0, width: 100, height: 100 },
    ...overrides,
  };
}

function mkSnapshot(facts: ObstacleFact[]): LiteSnapshot {
  return {
    url: 'https://ex.com',
    title: '',
    elements: [],
    obstacleFacts: facts,
    timestamp: Date.now(),
  } as LiteSnapshot;
}

describe('evaluateOverlayGate — happy-path skips', () => {
  it('skips when snapshot is null (cheap fast-path)', () => {
    const r = evaluateOverlayGate(null);
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('no_obstacles');
  });

  it('skips when snapshot is undefined', () => {
    const r = evaluateOverlayGate(undefined);
    expect(r.shouldDismiss).toBe(false);
  });

  it('skips when obstacleFacts is empty', () => {
    const r = evaluateOverlayGate(mkSnapshot([]));
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('no_obstacles');
  });

  it('skips when obstacleFacts field is missing entirely', () => {
    const snap = { url: '', title: '', elements: [], timestamp: Date.now() } as LiteSnapshot;
    const r = evaluateOverlayGate(snap);
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('no_obstacles');
  });
});

describe('evaluateOverlayGate — triggers dismissal for noise obstacles', () => {
  it('triggers on cookie consent banner appearing mid-flow', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'cookie_consent' })]),
    );
    expect(r.shouldDismiss).toBe(true);
    expect(r.noiseTypes).toContain('cookie_consent');
    expect(r.reason).toBeUndefined();
  });

  it('triggers on chat widget (Intercom/Drift) opening itself', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'chat_widget' })]),
    );
    expect(r.shouldDismiss).toBe(true);
    expect(r.noiseTypes).toEqual(['chat_widget']);
  });

  it('triggers on onboarding tour kicking in on first form focus', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'onboarding' })]),
    );
    expect(r.shouldDismiss).toBe(true);
  });

  it('triggers on tooltip hover that stuck open', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'tooltip' })]),
    );
    expect(r.shouldDismiss).toBe(true);
  });

  it('triggers on transient toast notification', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'toast' })]),
    );
    expect(r.shouldDismiss).toBe(true);
  });

  it('aggregates multiple noise types into noiseTypes (dedup set)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([
        mkObstacle({ ref: 'a', hintType: 'cookie_consent' }),
        mkObstacle({ ref: 'b', hintType: 'cookie_consent' }), // duplicate
        mkObstacle({ ref: 'c', hintType: 'tooltip' }),
      ]),
    );
    expect(r.shouldDismiss).toBe(true);
    expect(r.noiseTypes.sort()).toEqual(['cookie_consent', 'tooltip']);
  });
});

describe('evaluateOverlayGate — refuses to touch legitimate app state', () => {
  it('refuses when a confirm modal is present, even if cookie banner is also visible', () => {
    // Safety-critical case: an app modal ("Delete this project?") MUST NOT
    // get auto-dismissed, even if a toast/banner is also on screen.
    const r = evaluateOverlayGate(
      mkSnapshot([
        mkObstacle({ ref: 'cookies', hintType: 'cookie_consent' }),
        mkObstacle({ ref: 'confirm', hintType: 'modal' }),
      ]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('app_dialog_present');
    // noiseTypes still populated so trace logging can explain *why* we held back
    expect(r.noiseTypes).toContain('cookie_consent');
  });

  it('refuses when a side drawer is open', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'drawer' })]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('app_dialog_present');
  });

  it('refuses when a paywall is blocking the flow (flow must handle it)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'paywall' })]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('app_dialog_present');
  });
});

describe('evaluateOverlayGate — inert obstacles', () => {
  it('skips when only sticky headers are present (scroll-around, not dismiss)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'sticky_header' })]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('only_inert_obstacles');
  });

  it('skips when only a loading overlay is present (wait, handled elsewhere)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'loading_overlay' })]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('only_inert_obstacles');
  });

  it('skips when obstacle has no hintType (unclassified — leave alone)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: undefined })]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('only_inert_obstacles');
  });
});

describe('evaluateOverlayGate — mixed scenarios', () => {
  it('dismisses when noise + inert are present together (no app dialog)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([
        mkObstacle({ ref: 'a', hintType: 'cookie_consent' }),
        mkObstacle({ ref: 'b', hintType: 'sticky_footer' }), // inert — ignored
      ]),
    );
    expect(r.shouldDismiss).toBe(true);
    expect(r.noiseTypes).toEqual(['cookie_consent']); // inert not included
  });

  it('dropdown alone does not trigger (user-opened, handled by click-away)', () => {
    const r = evaluateOverlayGate(
      mkSnapshot([mkObstacle({ hintType: 'dropdown' })]),
    );
    expect(r.shouldDismiss).toBe(false);
    expect(r.reason).toBe('only_inert_obstacles');
  });
});
