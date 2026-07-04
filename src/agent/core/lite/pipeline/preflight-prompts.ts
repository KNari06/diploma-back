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

Decide whether this plan should run. Check these HARD triggers first — each is a CONCRETE reason that overrides any leaning toward "go":
1. REPEAT DEAD END (hard "revise"): the plan repeats an action that WHAT-ALREADY-HAPPENED shows had no effect. If NO STATE CHANGE reports 2+ consecutive rounds and the plan re-issues the same/similar action → "revise" with guidance to try a DIFFERENT element/path. This is NOT a "might fail" guess — the history already proved it does nothing.
2. WRONG DIRECTION (hard "revise"): the plan clearly moves AWAY from the goal (e.g. navigating off to unrelated pages when the goal is on this page) → "revise".
3. UNREACHABLE (hard "block"): PAGE HEALTH shows a server error / session lost, or a LEARNINGS blocker makes the goal impossible right now → "block".

If NONE of the hard triggers fire, default to "go": a first attempt, a plausible new approach, a single no-effect round (not yet 2+), or normal form-filling is ALWAYS "go" — you cannot know a fresh action's result in advance.

Respond with JSON:
{
  "verdict": "go" | "revise" | "block",
  "reason": "Brief explanation",
  "guidance": "Include ONLY when verdict is 'revise' — how the Planner should change the plan; omit otherwise"
}

RULES:
- The hard triggers above win. When one fires, its verdict is correct even though you'd otherwise lean "go".
- When NO hard trigger fires, bias toward "go": do NOT "revise" a plan merely because it MIGHT fail — an untried action's failure is discovered by running it (the Reviewer's job), not pre-judged here.
- "block" is only for genuinely unreachable goals (server down, logged out, known hard blocker), never for "this looks hard".`;
}
