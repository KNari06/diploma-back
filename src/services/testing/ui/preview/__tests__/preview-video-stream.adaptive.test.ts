/**
 * Adaptive throttle (client-health driven) tests for PreviewVideoStreamService.
 * applyHealthHint() only mutates the in-memory ladder index / target interval —
 * no CDP, no socket, no page — so we exercise it on a bare instance.
 *
 * Ladder: [22, 33, 66] ms ≈ 45 / 30 / 15 fps.
 * Degrade when clientFps < 0.6 × currentTarget; recover when
 * clientFps ≥ 0.9 × next-faster target (hysteresis).
 */

import { PreviewVideoStreamService } from '../preview-video-stream.service';

const make = () => new PreviewVideoStreamService('sess-1', 'user-1', 'room-1');

describe('PreviewVideoStreamService.applyHealthHint', () => {
  it('stays at 45fps (22ms) when the client keeps up', () => {
    const s = make();
    // Healthy client renders ~44fps against a 45fps target → no change.
    expect(s.applyHealthHint(44)).toBe(22);
    expect(s.applyHealthHint(45)).toBe(22);
  });

  it('steps slower one level when the client struggles (≤60% of target)', () => {
    const s = make();
    // 45fps target × 0.6 = 27. Client at 20 < 27 → step to 33ms (~30fps).
    expect(s.applyHealthHint(20)).toBe(33);
  });

  it('walks the full ladder down under sustained low FPS, then clamps', () => {
    const s = make();
    expect(s.applyHealthHint(5)).toBe(33); // 45→30
    expect(s.applyHealthHint(5)).toBe(66); // 30→15
    expect(s.applyHealthHint(5)).toBe(66); // clamp at slowest, no overflow
  });

  it('recovers a level only when the client clears the next-faster target (hysteresis)', () => {
    const s = make();
    s.applyHealthHint(5); // → 33ms (30fps)
    s.applyHealthHint(5); // → 66ms (15fps)
    // To step 66→33 the client must clear 30fps × 0.9 = 27. At 20 it does NOT.
    expect(s.applyHealthHint(20)).toBe(66);
    // At 28 (> 27) it recovers one step.
    expect(s.applyHealthHint(28)).toBe(33);
    // To step 33→22 the client must clear 45fps × 0.9 = 40.5. At 35 it does NOT.
    expect(s.applyHealthHint(35)).toBe(33);
    // At 42 (> 40.5) it recovers to full speed.
    expect(s.applyHealthHint(42)).toBe(22);
  });

  it('does not flap: a mid-band FPS holds the current level', () => {
    const s = make();
    s.applyHealthHint(5); // → 33ms
    // 30fps band: degrade needs < 30×0.6=18, recover needs ≥ 45×0.9=40.5.
    // 25 is between → no change either way.
    expect(s.applyHealthHint(25)).toBe(33);
    expect(s.applyHealthHint(25)).toBe(33);
  });

  it('ignores bogus reports (negative / NaN / Infinity) without changing state', () => {
    const s = make();
    s.applyHealthHint(5); // → 33ms
    expect(s.applyHealthHint(-1)).toBe(33);
    expect(s.applyHealthHint(NaN)).toBe(33);
    expect(s.applyHealthHint(Infinity)).toBe(33);
  });
});
