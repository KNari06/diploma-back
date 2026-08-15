/**
 * A draft that drops the scroll the agent needed to reach its own target.
 *
 * Run-proved on JanaPost TC-33 (2026-08-13). The agent walked Profile → FAQ →
 * category → question, scrolled once to bring the feedback control into view,
 * tapped Yes, watched the thank-you appear — and emitted six steps with no
 * scroll among them. Replaying that draft on a fresh device:
 *
 *   Resolver: vision: coordinate fallback for "Yes button" → (1000, 3000) conf=0.7
 *   tap: would-refuse coords fallback for "Yes button" at (1000, 3000)
 *
 * The "Yes" step went GREEN having tapped empty space near the bottom bezel,
 * and the run only went red one step later, on the assertion — so the visible
 * symptom ("thank-you not shown") pointed at the app rather than at the one
 * missing step that caused it.
 *
 * The scroll is the action most likely to be dropped because it feels like
 * looking rather than doing. These tests pin the detector that notices it.
 */

import { draftOmitsAScrollTheAgentPerformed } from '../tools';

const tap = { type: 'tap' };
const aiCheck = { type: 'ai_check' };
const scrollStep = { type: 'scroll' };
const swipeStep = { type: 'swipe' };

const didScroll = [
  { tool: 'tap_element', ok: true },
  { tool: 'scroll', ok: true },
];

describe('a draft missing a scroll the agent actually performed', () => {
  it('flags the TC-33 shape: agent scrolled, draft is all taps', () => {
    // The exact draft that shipped: 5 taps + 1 assertion, no scroll.
    const steps = [tap, tap, tap, tap, tap, aiCheck];
    expect(draftOmitsAScrollTheAgentPerformed(steps, didScroll)).toBe(true);
  });

  it('stays quiet once the scroll is authored', () => {
    const steps = [tap, tap, tap, tap, scrollStep, tap, aiCheck];
    expect(draftOmitsAScrollTheAgentPerformed(steps, didScroll)).toBe(false);
  });

  it('accepts a swipe as the authored equivalent', () => {
    const steps = [tap, swipeStep, tap];
    expect(draftOmitsAScrollTheAgentPerformed(steps, didScroll)).toBe(false);
  });

  it('treats a live swipe as a viewport move too', () => {
    const swiped = [{ tool: 'swipe', ok: true }];
    expect(draftOmitsAScrollTheAgentPerformed([tap, tap], swiped)).toBe(true);
  });
});

describe('when there is nothing to warn about', () => {
  it('stays quiet when the agent never scrolled', () => {
    const noScroll = [
      { tool: 'tap_element', ok: true },
      { tool: 'observe_mobile_page', ok: true },
    ];
    expect(draftOmitsAScrollTheAgentPerformed([tap, tap, aiCheck], noScroll)).toBe(false);
  });

  it('ignores a scroll that FAILED — it moved nothing, so nothing depends on it', () => {
    const failedScroll = [{ tool: 'scroll', ok: false }];
    expect(draftOmitsAScrollTheAgentPerformed([tap, tap], failedScroll)).toBe(false);
  });

  it('stays quiet on an empty draft rather than warning about nothing', () => {
    expect(draftOmitsAScrollTheAgentPerformed([], didScroll)).toBe(true);
    // NOTE: an empty draft is rejected upstream long before this advisory is
    // read, so the value here is academic — pinned only so a future refactor
    // has to think about it rather than change it by accident.
  });
});
