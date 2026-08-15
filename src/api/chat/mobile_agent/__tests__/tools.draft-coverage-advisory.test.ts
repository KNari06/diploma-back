/**
 * A draft that covers only the tail of the flow is a false green waiting to
 * happen.
 *
 * A saved test starts from a fresh app on whatever screen it opens to — it does
 * NOT inherit the screen the agent was looking at when it authored. So every
 * navigation action the agent performed to reach its steps has to be a step, or
 * the run starts in the wrong place and every later target misses.
 *
 * Run-proved on JanaPost TC-33 (2026-08-14): the agent walked
 * Home → Profile → FAQ → category → scroll → Ия, reached the thank-you state,
 * and emitted three steps — two category taps and an ai_check. Real labels,
 * correctly read off the device, and no way to get there.
 *
 * The check is deliberately loose. An agent always drives more than it authors
 * (exploratory taps, a mis-tap it corrected, going back to re-read a label), so
 * step-for-step parity would fire on every healthy draft.
 */

import { draftCoversFewerActionsThanPerformed } from '../tools';

const drove = (...tools: string[]) => tools.map((tool) => ({ tool, ok: true }));
const authored = (...types: string[]) => types.map((type) => ({ type }));

describe('a draft that omits how the agent got there', () => {
  it('flags the live TC-33 shape: 6 actions performed, 2 authored', () => {
    const result = draftCoversFewerActionsThanPerformed(
      authored('click', 'click', 'ai_check'),
      drove('tap_element', 'tap_element', 'tap_element', 'scroll', 'tap_element', 'tap_element'),
    );
    expect(result.omitted).toBe(true);
    expect(result.performed).toBe(6);
    expect(result.authored).toBe(2);
  });

  it('does not count assertions as coverage — they check, they do not navigate', () => {
    // Three ai_checks reach no screen at all.
    const result = draftCoversFewerActionsThanPerformed(
      authored('ai_check', 'ai_check', 'ai_check'),
      drove('tap_element', 'tap_element', 'tap_element', 'scroll'),
    );
    expect(result.authored).toBe(0);
    expect(result.omitted).toBe(true);
  });
});

describe('healthy drafts are left alone', () => {
  it('accepts a draft that authored most of what it performed', () => {
    // 5 performed, 4 authored — one stray tap the agent corrected.
    expect(
      draftCoversFewerActionsThanPerformed(
        authored('click', 'click', 'scroll', 'click', 'ai_check'),
        drove('tap_element', 'tap_element', 'scroll', 'tap_element', 'tap_element'),
      ).omitted,
    ).toBe(false);
  });

  it('stays quiet on a short walk, where the ratio is noise', () => {
    // 3 performed, 1 authored — an ordinary "tap the thing and check it" turn.
    expect(
      draftCoversFewerActionsThanPerformed(
        authored('click', 'ai_check'),
        drove('tap_element', 'tap_element', 'tap_element'),
      ).omitted,
    ).toBe(false);
  });

  it('ignores failed device calls — a tap that errored is not work performed', () => {
    const invocations = [
      ...drove('tap_element', 'tap_element'),
      { tool: 'tap_element', ok: false },
      { tool: 'tap_element', ok: false },
      { tool: 'scroll', ok: false },
    ];
    expect(
      draftCoversFewerActionsThanPerformed(authored('click', 'ai_check'), invocations).omitted,
    ).toBe(false);
  });

  it('stays quiet when nothing was driven at all', () => {
    const result = draftCoversFewerActionsThanPerformed(authored('click'), []);
    expect(result.performed).toBe(0);
    expect(result.omitted).toBe(false);
  });
});
