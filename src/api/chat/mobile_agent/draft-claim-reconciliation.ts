/**
 * Catch a turn that DESCRIBES a draft revision it never emitted.
 *
 * Observed live while building JanaPost TC-31: asked to fix one step, the agent
 * replied with a full changelog ("Changed step 5 from a guessed marketplace
 * assertion to …", "Added a new step to verify …") and wrote out the revised
 * 7-step list in prose. No new draft card was emitted — the panel still held the
 * original 5 steps, including the very step the reply said had been fixed.
 *
 * That is worse than a visible failure. Save acts on the draft CARD, not on the
 * prose, so a user who reads the changelog and clicks Save persists the OLD
 * steps while believing they saved the new ones, and nothing in the UI
 * contradicts the reply. It took two more turns and an explicit "your last two
 * replies described a revised draft but never emitted a draft card" before a
 * real card appeared — which is how one recoverable agent mistake turns into a
 * dead conversation.
 *
 * The reply text and the emitted draft come from the SAME turn, so they can be
 * reconciled before the turn is returned: if the reply makes a step-level claim
 * and no draft-emitting tool ran, give the model one more round to actually emit
 * it.
 *
 * Pure functions — no LLM, no IO — so the whole decision is unit-testable.
 */

/**
 * Does this reply assert a step-level change to a draft?
 *
 * Deliberately narrow. The structural preconditions in the pipeline (a draft
 * exists to revise, and none was emitted this turn) carry most of the
 * precision, so this only has to separate "I changed step 5" from "the screen
 * shows a login form". It therefore requires either an explicit step reference
 * WITH a number, or a changelog marker — never a bare mention of the word
 * "step".
 *
 * Unicode note (Hard invariant #15): word boundaries use `(?![\p{L}\p{N}])`,
 * never ASCII `\b`, which does not match Cyrillic — the agent answers in the
 * user's language and these chats run in ru/kk as often as en.
 *
 * Not one of Hard invariant #17's five chat control-word buckets: those
 * classify USER intent (affirmative / cancel / rejection / chitchat /
 * confirmation markers) and must live in `intent-keywords.ts`. This reads the
 * AGENT's own output for a prose claim about an artifact, which is a different
 * job with a different failure mode, so it stays next to the pipeline that uses
 * it.
 */
const STEP_REFERENCE_RE =
  /(?:^|[^\p{L}\p{N}])(?:step|шаг|шага|шагу|қадам|қадамды)\s*#?\s*\d+(?![\p{L}\p{N}])/iu;

const CHANGELOG_MARKER_RE =
  /(?:^|[^\p{L}\p{N}])(?:changed|added|removed|replaced|updated|kept|изменил|изменени|добавил|удалил|обновил|оставил|өзгерт|қостым|жойдым)(?:[^\p{L}\p{N}]|$)[^\n]{0,40}?(?:step|steps|шаг|қадам)/iu;

export function replyClaimsStepRevision(reply: string | undefined): boolean {
  if (!reply) return false;
  const text = reply.trim();
  if (!text) return false;
  return STEP_REFERENCE_RE.test(text) || CHANGELOG_MARKER_RE.test(text);
}

/**
 * The nudge pushed as a system message before the extra round.
 *
 * Says what is wrong and what to do about it, and explicitly allows the model
 * to back out — a false positive must be cheap. It also names the full-array
 * contract, because the sibling defect is that revisions silently DROP steps
 * the reply never mentions.
 */
export const DRAFT_CLAIM_NUDGE =
  'Your reply describes a step-level change to the draft, but this turn emitted ' +
  'no draft. The user\'s Save button acts on the draft CARD, not on your reply — ' +
  'so as things stand they would save the OLD steps while reading that you ' +
  'changed them. Call mobile_run_draft_steps now with the COMPLETE revised step ' +
  'array (every step the test should end up with, not only the ones you ' +
  'changed), then briefly tell the user what changed. If you did NOT actually ' +
  'revise anything, reply again WITHOUT claiming a step change.';
