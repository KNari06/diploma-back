/**
 * Unit tests for the floating-corner-widget geometry rule.
 *
 * Synthetic rects only — no DOM, no site-specific fixture. The rule must hold
 * on ANY site, so we assert the pure geometry, not a particular product.
 */

import {
  isFloatingCornerWidget,
  FLOATING_WIDGET_EDGE_MARGIN_PX,
  FLOATING_WIDGET_MAX_COVERAGE,
} from '../floating-widget.util';

const VP = { width: 1280, height: 720 };

describe('isFloatingCornerWidget', () => {
  it('flags a small fixed widget pinned to the bottom-right corner', () => {
    // 360×420 panel, 16px gutter from bottom-right (coverage ~16%)
    const rect = { left: 1280 - 16 - 360, top: 720 - 16 - 420, width: 360, height: 420 };
    expect(isFloatingCornerWidget(rect, 'fixed', false, VP)).toBe(true);
  });

  it('flags fixed widgets in all four corners', () => {
    const w = 200, h = 200, g = 12;
    const topLeft = { left: g, top: g, width: w, height: h };
    const topRight = { left: 1280 - g - w, top: g, width: w, height: h };
    const bottomLeft = { left: g, top: 720 - g - h, width: w, height: h };
    const bottomRight = { left: 1280 - g - w, top: 720 - g - h, width: w, height: h };
    for (const r of [topLeft, topRight, bottomLeft, bottomRight]) {
      expect(isFloatingCornerWidget(r, 'fixed', false, VP)).toBe(true);
    }
  });

  it('rejects a centered fixed element (not corner-anchored)', () => {
    const rect = { left: 540, top: 260, width: 200, height: 200 };
    expect(isFloatingCornerWidget(rect, 'fixed', false, VP)).toBe(false);
  });

  it('rejects a large fixed overlay at or above the modal coverage gate', () => {
    // Full-viewport backdrop pinned to a corner — coverage 100% >= 30%
    const rect = { left: 0, top: 0, width: 1280, height: 720 };
    expect(isFloatingCornerWidget(rect, 'fixed', false, VP)).toBe(false);
  });

  it('rejects sticky elements (sticky headers/footers are not widgets)', () => {
    const rect = { left: 0, top: 0, width: 1280, height: 64 };
    expect(isFloatingCornerWidget(rect, 'sticky', false, VP)).toBe(false);
  });

  it('rejects absolute and static positioning', () => {
    const rect = { left: 1100, top: 600, width: 150, height: 100 };
    expect(isFloatingCornerWidget(rect, 'absolute', false, VP)).toBe(false);
    expect(isFloatingCornerWidget(rect, 'static', false, VP)).toBe(false);
  });

  it('never flags a modal-like element even if it is small + corner-anchored', () => {
    const rect = { left: 1280 - 16 - 300, top: 720 - 16 - 300, width: 300, height: 300 };
    expect(isFloatingCornerWidget(rect, 'fixed', true, VP)).toBe(false);
  });

  it('rejects a corner element hugging only one edge', () => {
    // Hugs the right edge but vertically centered — not a corner
    const rect = { left: 1280 - 16 - 200, top: 300, width: 200, height: 120 };
    expect(isFloatingCornerWidget(rect, 'fixed', false, VP)).toBe(false);
  });

  it('fails closed on a zero-area rect or zero viewport', () => {
    expect(isFloatingCornerWidget({ left: 0, top: 0, width: 0, height: 0 }, 'fixed', false, VP)).toBe(false);
    expect(isFloatingCornerWidget({ left: 0, top: 0, width: 100, height: 100 }, 'fixed', false, { width: 0, height: 0 })).toBe(false);
  });

  it('exposes the shared thresholds as constants', () => {
    expect(FLOATING_WIDGET_EDGE_MARGIN_PX).toBe(24);
    expect(FLOATING_WIDGET_MAX_COVERAGE).toBe(0.30);
  });
});
