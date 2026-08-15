/**
 * An agent that did the whole job and then offered the artifact instead of
 * producing it.
 *
 * Measured on JanaPost TC-33 (2026-08-13). One REFUSED `mobile_run_draft_steps`
 * earlier in a chat is enough to stop the model calling that tool for the rest
 * of the conversation — a rejected tool call is a strong negative example
 * sitting in the context window, and the model generalises it into "that tool
 * does not work here". Across six live authoring attempts the split was total:
 *
 *     fresh chat                          → drafted (2 of 2)
 *     chat holding a prior draft refusal  → never drafted again (4 of 4)
 *
 * The last of those walked Profile → FAQ → category → question → scroll → Yes,
 * confirmed "Thank you for your feedback!" on the device across 15 tool calls
 * and four minutes, and closed with an offer rather than a draft card.
 *
 * The detector has to fire on that shape and stay quiet on a turn that actually
 * emitted something, otherwise it burns a round telling an agent to do what it
 * has already done.
 */

import { replyOffersDraftInsteadOfEmitting } from '../draft-claim-reconciliation';

describe('a reply that offers a draft instead of emitting one', () => {
  it('catches the TC-33 closing line verbatim', () => {
    expect(
      replyOffersDraftInsteadOfEmitting(
        'Done — I walked the FAQ flow and confirmed the thank-you state. ' +
          'If you want, I can walk it now and then emit the draft cards immediately.',
      ),
    ).toBe(true);
  });

  it('catches a promise conditional on something else happening first', () => {
    expect(
      replyOffersDraftInsteadOfEmitting(
        "Once I can tap FAQ reliably, I'll walk the rest of the flow and draft the cards.",
      ),
    ).toBe(true);
  });

  it('catches the Russian form — these chats are not English-only', () => {
    expect(
      replyOffersDraftInsteadOfEmitting(
        'Готово: я прошёл флоу. Если хотите, могу собрать черновик шагов.',
      ),
    ).toBe(true);
  });
});

describe('replies that must NOT trigger a nudge', () => {
  it('stays quiet when the agent reports work it actually did', () => {
    expect(
      replyOffersDraftInsteadOfEmitting(
        'Done — I drafted the FAQ accordion + feedback test case as editable steps.',
      ),
    ).toBe(false);
  });

  it('stays quiet on a plain observation with no draft in it', () => {
    expect(
      replyOffersDraftInsteadOfEmitting(
        'The screen shows a login form with a phone field and a Login button.',
      ),
    ).toBe(false);
  });

  it('stays quiet on a device blocker, which is a legitimate stop', () => {
    expect(
      replyOffersDraftInsteadOfEmitting(
        "I'm blocked: the FAQ row exposes no accessibility label, so every tap " +
          'lands as a blind vision guess.',
      ),
    ).toBe(false);
  });

  it('stays quiet on empty or missing replies', () => {
    expect(replyOffersDraftInsteadOfEmitting('')).toBe(false);
    expect(replyOffersDraftInsteadOfEmitting('   ')).toBe(false);
    expect(replyOffersDraftInsteadOfEmitting(undefined)).toBe(false);
  });
});
