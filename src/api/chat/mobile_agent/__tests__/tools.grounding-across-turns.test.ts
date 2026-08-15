/**
 * The grounding gate has to recognise a walk that happened one turn ago.
 *
 * `isUngroundedMultiScreenDraft` counts device drives to prove the agent saw
 * the screens it is authoring for. It counted them on the blackboard, which is
 * rebuilt every turn — correct for a one-shot "create a test case for X", wrong
 * for the conversation people actually have:
 *
 *     turn 1  "create a test case for the FAQ feedback flow"  → agent walks it
 *     turn 2  "now emit the draft steps"                      → gate sees zero
 *
 * Run-proved on JanaPost TC-33 (2026-08-13). The refusal fired twice in one
 * turn against an agent that had walked Profile → FAQ → category → question →
 * scroll → Yes → thank-you a message earlier. It then tried to re-walk to
 * satisfy the gate and its `tap "Profile tab in the bottom navigation bar"`
 * failed outright, because the device was parked deep inside FAQ where no
 * Profile tab exists. The turn produced no draft. Five live authoring attempts
 * that day ended without a usable draft; this gate is why, and the reason was
 * invisible until tool refusals were logged.
 *
 * The fix must not weaken what the gate was built for — an agent that has
 * driven NOTHING, in this turn or any other, still has to be refused.
 */

import { isUngroundedMultiScreenDraft } from '../tools';

const tap = { type: 'tap' };
const check = { type: 'ai_check' };

/** A four-tap walk: Profile → FAQ → category → question. */
const FOUR_TAP_DRAFT = [tap, tap, tap, tap, check];

const drive = { tool: 'tap_element', ok: true };
const look = { tool: 'observe_mobile_page', ok: true };

describe('a walk from an earlier turn still counts as grounding', () => {
  it('accepts the TC-33 shape: walked last turn, drafting this turn', () => {
    // Zero drives THIS turn — the agent is only being asked to emit cards.
    expect(isUngroundedMultiScreenDraft(FOUR_TAP_DRAFT, [], 6)).toBe(false);
  });

  it('adds this turn and earlier turns together', () => {
    // 4 navigating steps need 3 drives; 1 now + 2 before clears it.
    expect(isUngroundedMultiScreenDraft(FOUR_TAP_DRAFT, [drive], 2)).toBe(false);
  });

  it('still refuses when the combined total is short', () => {
    expect(isUngroundedMultiScreenDraft(FOUR_TAP_DRAFT, [drive], 1)).toBe(true);
  });
});

describe('what the gate was built to catch is unchanged', () => {
  it('refuses a multi-screen draft from an agent that never drove anything', () => {
    expect(isUngroundedMultiScreenDraft(FOUR_TAP_DRAFT, [look], 0)).toBe(true);
  });

  it('defaults to the old, stricter reading when no prior count is passed', () => {
    // Existing call sites and tests must keep their behaviour.
    expect(isUngroundedMultiScreenDraft(FOUR_TAP_DRAFT, [look])).toBe(true);
  });

  it('ignores a negative count rather than letting it subtract real drives', () => {
    expect(isUngroundedMultiScreenDraft(FOUR_TAP_DRAFT, [drive, drive, drive], -5)).toBe(false);
  });

  it('leaves single-navigation drafts alone — one tap is honest from the injected screen', () => {
    expect(isUngroundedMultiScreenDraft([tap, check], [], 0)).toBe(false);
  });
});
