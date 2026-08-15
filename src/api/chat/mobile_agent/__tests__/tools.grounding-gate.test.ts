/**
 * The GROUNDING GATE: a multi-screen draft authored by an agent that never
 * moved the device is guesswork, and `runMobileRunDraftSteps` rejects it.
 *
 * Why a hard rejection and not another prompt rule: the prompt route was tried
 * first, live, on JanaPost TC-33 (2026-08-13). The system prompt had told the
 * agent twice NOT to drive the device for a test-case request while telling it
 * once to walk the flow while authoring; that contradiction was removed and
 * replaced with an explicit HARD RULE to walk. The very next live run still
 * made ZERO device calls and still emitted a 5-step cross-screen draft whose
 * descriptions were paraphrases of the user's sentence. See
 * `.claude/lessons/20260727-a-prompt-rule-is-not-an-enforcement-point.md`.
 *
 * The threshold is the load-bearing part, so most of these cases pin it: ONE
 * navigating step can be authored honestly from the screen the pipeline
 * eager-injects, because its target is visible there. TWO is the smallest draft
 * that proves a guess, because the second tap must aim at a screen only
 * reachable by performing the first.
 */

import { isUngroundedMultiScreenDraft } from '../tools';

const tap = { type: 'click' };
const assertStep = { type: 'ai_check' };

/** A successful device-driving invocation, as `dispatchSingleCommand` records it. */
const drove = (tool: string) => ({ tool, ok: true });

describe('isUngroundedMultiScreenDraft', () => {
  it('rejects a multi-screen draft when the agent never drove the device', () => {
    // The TC-33 shape: 4 taps + an assertion, zero device calls.
    const steps = [tap, tap, tap, tap, assertStep];
    expect(isUngroundedMultiScreenDraft(steps, [])).toBe(true);
  });

  it('allows a single-screen draft — one tap is visible on the injected screen', () => {
    expect(isUngroundedMultiScreenDraft([tap, assertStep], [])).toBe(false);
  });

  it('allows a draft with no navigation at all (pure assertions)', () => {
    expect(isUngroundedMultiScreenDraft([assertStep, assertStep], [])).toBe(false);
  });

  it('allows a multi-screen draft once the agent actually walked it', () => {
    const steps = [tap, tap, tap, assertStep];
    const trail = [drove('tap_element'), drove('tap_element')];
    expect(isUngroundedMultiScreenDraft(steps, trail)).toBe(false);
  });

  it('counts any device-driving tool as walking, not just tap_element', () => {
    const steps = [tap, tap];
    for (const tool of ['tap_element', 'type_text', 'swipe', 'scroll', 'press_key', 'launch_app']) {
      expect(isUngroundedMultiScreenDraft(steps, [drove(tool)])).toBe(false);
    }
  });

  // The N-1 rule. Live on TC-33 (2026-08-13) the agent tapped Profile ONCE,
  // wrote step 2 correctly from the label it could now see, and then invented
  // steps 3 and 4 for two screens it never opened — and the gate passed,
  // because it only asked "did it move at all". One drive must not buy an
  // arbitrarily long draft.
  it('rejects a 4-tap draft backed by only ONE drive (the TC-33 hole)', () => {
    const steps = [tap, tap, tap, tap, assertStep];
    expect(isUngroundedMultiScreenDraft(steps, [drove('tap_element')])).toBe(true);
  });

  it('needs one drive fewer than the navigating steps — the first is free', () => {
    const steps = [tap, tap, tap]; // 3 nav steps → needs >= 2 drives
    expect(isUngroundedMultiScreenDraft(steps, [drove('tap_element')])).toBe(true);
    expect(
      isUngroundedMultiScreenDraft(steps, [drove('tap_element'), drove('tap_element')]),
    ).toBe(false);
  });

  it('ignores failed drives when counting — a tap that errored moved nothing', () => {
    const steps = [tap, tap, tap];
    const trail = [drove('tap_element'), { tool: 'tap_element', ok: false }];
    expect(isUngroundedMultiScreenDraft(steps, trail)).toBe(true);
  });

  it('does NOT count observation tools as walking — reading the current screen is not moving', () => {
    // This is the whole point: the agent gets one screen for free via
    // eager-inject, and `observe_mobile_page` only ever re-reads wherever it
    // already stands. Neither tells it what is on the NEXT screen.
    const steps = [tap, tap];
    const readOnly = [
      { tool: 'observe_mobile_page', ok: true },
      { tool: 'take_screenshot', ok: true },
      { tool: 'get_foreground', ok: true },
      { tool: 'think_aloud', ok: true },
      { tool: 'plan_flow', ok: true },
    ];
    expect(isUngroundedMultiScreenDraft(steps, readOnly)).toBe(true);
  });

  it('does not count a FAILED device call as having walked anywhere', () => {
    // A tap that errored left the app where it was, so the later screens are
    // still unseen.
    const steps = [tap, tap];
    expect(isUngroundedMultiScreenDraft(steps, [{ tool: 'tap_element', ok: false }])).toBe(true);
  });

  it('treats every navigating step type as navigation', () => {
    for (const type of ['click', 'tap', 'long_press', 'double_tap']) {
      expect(isUngroundedMultiScreenDraft([{ type }, { type }], [])).toBe(true);
    }
  });

  it('does not count non-navigating steps toward the threshold', () => {
    // One tap plus a pile of same-screen work is still a one-screen test.
    const steps = [tap, { type: 'type' }, { type: 'scroll' }, assertStep, { type: 'assert' }];
    expect(isUngroundedMultiScreenDraft(steps, [])).toBe(false);
  });

  it('fires on exactly two navigating steps — the smallest provable guess', () => {
    expect(isUngroundedMultiScreenDraft([tap], [])).toBe(false);
    expect(isUngroundedMultiScreenDraft([tap, tap], [])).toBe(true);
  });
});
