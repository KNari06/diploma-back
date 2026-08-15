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

/**
 * Does this reply narrate a completed walk and OFFER a draft instead of emitting one?
 *
 * The sibling defect to the one above, and the more expensive of the two: not
 * "claimed a change it didn't make" but "did the whole job and never produced
 * the artifact".
 *
 * Measured on JanaPost TC-33 (2026-08-13). Once a chat contains even one
 * REFUSED `mobile_run_draft_steps` call, the model stops calling that tool for
 * the rest of the conversation and narrates instead. Across six live authoring
 * attempts the split was total:
 *
 *     fresh chat                              → drafted (2 of 2)
 *     chat holding a prior draft refusal      → never drafted again (4 of 4)
 *
 * The last of those walked Profile → FAQ → category → question → scroll → Yes,
 * confirmed "Thank you for your feedback!" on the device, spent 15 tool calls
 * and four minutes doing it — and closed with "If you want, I can walk it now
 * and then emit the draft cards immediately." A rejected tool call is a strong
 * negative example sitting in the context window, and the model generalises it
 * into "that tool does not work here".
 *
 * So the reply shape to catch is an OFFER or a PROMISE to draft — "I can draft",
 * "I'll emit the cards", "once X, I'll draft" — which is exactly what an agent
 * says when it has the material and has learned not to reach for the tool.
 *
 * Same unicode-boundary rule as above (Hard invariant #15): `\b` never matches
 * Cyrillic, and these chats run in ru/kk as often as en.
 */
const DRAFT_OFFER_RE =
  /(?:^|[^\p{L}\p{N}])(?:can|could|shall|will|i'?ll|want me to|ready to|могу|смогу|готов|хотите|давайте|бол(?:ам|ады)|дайын)(?:[^\n]{0,60}?)(?:draft|emit|produce|create|generate|черновик|карточк|шаг|қадам|draft cards|step cards)/iu;

const DRAFT_ARTIFACT_RE =
  /(?:draft|черновик|қаралама)[^\n]{0,30}?(?:step|card|шаг|карточк|қадам)|(?:step|card|шаг|карточк|қадам)[^\n]{0,30}?(?:draft|черновик|қаралама)/iu;

export function replyOffersDraftInsteadOfEmitting(reply: string | undefined): boolean {
  if (!reply) return false;
  const text = reply.trim();
  if (!text) return false;
  // Both halves required: the reply must be ABOUT a draft artifact and must be
  // offering/promising rather than reporting. "I drafted the steps" (a real
  // emission, narrated) matches the artifact half but not the offer half.
  return DRAFT_OFFER_RE.test(text) && DRAFT_ARTIFACT_RE.test(text);
}

/**
 * Pushed as a system message before the one extra round.
 *
 * States the permission explicitly, because the behaviour being corrected is
 * learned helplessness about a tool the model believes is rejecting it — and
 * names the gate that was actually fixed, so a model that remembers being
 * refused has a concrete reason to try again. Backing out stays cheap: a false
 * positive costs one LLM call.
 */
export const DRAFT_OFFER_NUDGE =
  'You walked this flow on the device and then ended the turn without ' +
  'producing the draft — either offering it as a follow-up, or just reporting ' +
  'what you saw. Emitting the cards is the deliverable, not a follow-up the ' +
  'user has to ask for — they cannot save anything from prose. ' +
  'If the user only asked you to LOOK at something and there is no test to ' +
  'author, ignore this message and answer them. Otherwise: ' +
  'Call mobile_run_draft_steps NOW with the steps you just verified, using the ' +
  'real labels you read on each screen, and include every action you had to ' +
  'perform to reach them (a scroll you needed IS a step). If an earlier attempt ' +
  'in this conversation was refused for not having walked the flow, that no ' +
  'longer applies: the walk you performed counts, including from a previous ' +
  'turn on this same device session. If you genuinely cannot draft, say exactly ' +
  'which screen or element blocked you — do not offer.';
