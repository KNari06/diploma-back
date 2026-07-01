/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PREFLIGHT CHECK PROMPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Reviewer judges AFTER an action ran (was it good?). The PreflightCheck
 * judges BEFORE it runs (is this plan sound, or will it waste a round?). Same
 * blackboard context as the Reviewer, but framed forward-looking: the plan has
 * NOT executed yet.
 *
 * Deterministic FACTS (hallucinated refs, unsafe actions) are handled by the
 * agent before this prompt is ever built — this prompt is only for the SEMANTIC
 * judgment the LLM is actually good at (does the plan repeat a dead end? does it
 * move toward the goal? does it ignore a known blocker?).
 */

import { TestBlackboard } from './blackboard';
import { formatPageHealth } from '../collectors/page-health';

export const PREFLIGHT_SYSTEM_PROMPT =
  'You are a PRE-ACTION GATE for a browser test agent. A Planner just produced a plan that has NOT run yet. Your job is to catch a wasteful or wrong plan BEFORE it executes — not to second-guess every plan. Default to letting sound plans through.';

/**
 * Build the PreflightCheck user prompt from the current blackboard state.
 * Mirrors buildReviewerPrompt's context sections, but the framing is
 * "the plan is about to run" rather than "the plan just ran".
 */
export function buildPreflightPrompt(bb: TestBlackboard): string {
  const sections: string[] = [];

  sections.push(`GOAL: ${bb.getGoal()}`);
  sections.push(`URL: ${bb.getCurrentUrl() || bb.getUrl()}`);

  // The plan under review (not yet executed).
  sections.push(`PROPOSED PLAN (not executed yet):\n${bb.formatPlanForPrompt()}`);

  // Current page — so the gate can judge whether the plan's targets make sense.
  const snapshot = bb.getCurrentSnapshot();
  if (snapshot) {
    const truncated = snapshot.length > 2000 ? snapshot.slice(0, 2000) + '\n... (truncated)' : snapshot;
    sections.push(`CURRENT PAGE STATE:\n${truncated}`);
  }

  // What already happened — the single strongest signal for "this plan repeats
  // a dead end". Without history the gate can't tell a fresh attempt from a loop.
  const rounds = bb.getRounds();
  if (rounds.length > 0) {
    sections.push(`WHAT ALREADY HAPPENED:\n${bb.formatHistoryForPrompt()}`);
  }

  // Progress + no-effect signal — a plan that repeats an action which produced
  // no state change for N rounds is the prime "revise" candidate.
  sections.push(`PROGRESS: ${bb.getProgressScore()}% toward goal`);
  const noProgress = bb.getNoProgressRounds();
  if (noProgress >= 1) {
    sections.push(
      `NO STATE CHANGE: the page has not changed for ${noProgress} round(s) — recent actions had NO visible effect.`,
    );
  }

  // Technical health — a plan that presses on against a 500 / logged-out page
  // is wasted; the gate should block instead of letting it run.
  const health = formatPageHealth(bb.getPageHealth());
  if (health) {
    sections.push(`PAGE HEALTH:\n${health}`);
  }

  // Cross-flow blockers — if a sibling flow already hit a wall in this category,
  // a plan that ignores it is likely to hit the same wall.
  const priorLearnings = bb.getPriorLearnings();
  if (priorLearnings) {
    sections.push(`LEARNINGS FROM OTHER FLOWS:\n${priorLearnings}`);
  }

  return `${PREFLIGHT_SYSTEM_PROMPT}

${sections.join('\n\n')}

Decide whether this plan should run. Judge ONLY these — do not nitpick style:
1. REPEAT DEAD END: does the plan repeat an action that WHAT-ALREADY-HAPPENED shows had no effect (esp. under NO STATE CHANGE)? If so, "revise" with guidance to try a DIFFERENT element/path.
2. WRONG DIRECTION: does the plan clearly move AWAY from the goal (e.g. navigating off to unrelated pages when the goal is on this page)? If so, "revise".
3. UNREACHABLE: does PAGE HEALTH show a server error / session lost, or does a LEARNINGS blocker make the goal impossible right now? If so, "block".
4. Otherwise the plan is reasonable → "go". A first attempt, a plausible new approach, or normal form-filling is ALWAYS "go" — you cannot know a fresh action's result in advance.

Respond with JSON:
{
  "verdict": "go" | "revise" | "block",
  "reason": "Brief explanation",
  "guidance": "For 'revise' only — how the Planner should change the plan"
}

RULES:
- Bias toward "go". Only "revise"/"block" when the history or health gives a CONCRETE reason.
- Never "revise" a plan just because it might fail — failure is discovered by running it, that's the Reviewer's job.
- "block" is for genuinely unreachable goals (server down, logged out, known hard blocker), not for "this looks hard".`;
}
