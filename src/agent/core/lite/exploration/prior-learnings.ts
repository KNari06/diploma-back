/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRIOR LEARNINGS — what OTHER flows in this run already found out
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rendered into every flow's Planner prompt so flow N+1 doesn't repeat what
 * flow N already did, and doesn't walk into a dead end flow N already hit.
 *
 * Pure and dependency-free ON PURPOSE. It used to be a private method on
 * `FlowRunner`, which imports Playwright and the OpenAI client — so the
 * non-trivial rule below (which section survives the char cap) could not be
 * unit-tested without standing up that whole graph.
 */

/** Max accomplishment entries rendered (most recent win). */
export const PRIOR_LEARNINGS_MAX_ACCOMPLISHMENTS = 5;
/** Max distinct category blockers rendered. */
export const PRIOR_LEARNINGS_MAX_BLOCKERS = 4;
/** Hard cap on the whole rendered block. */
export const PRIOR_LEARNINGS_MAX_CHARS = 500;

export interface PriorLearningsInput {
  /** category → most recent dead-end reason. */
  blockersByCategory: Record<string, string>;
  /** What earlier flows tried, oldest first; each entry carries its own outcome. */
  accomplishments: string[];
  /** What the Strategist told every flow to prioritise. */
  focusAreas?: string[];
  /** Cap on rendered focus areas (the caller's shared page-insight limit). */
  maxFocusAreas: number;
}

/**
 * Build the Planner-facing block, or undefined when nothing has been learned
 * yet (the first flow of a run).
 *
 * Sections are ordered by what a Planner can LEAST afford to lose, because the
 * cap drops whole trailing sections: a known dead end prevents a wasted flow
 * outright, while "already tried" only saves duplicated effort.
 */
export function buildPriorLearnings(input: PriorLearningsInput): string | undefined {
  const sections: string[] = [];

  const blockerEntries = Object.entries(input.blockersByCategory ?? {});
  if (blockerEntries.length) {
    const blockers = blockerEntries
      .slice(-PRIOR_LEARNINGS_MAX_BLOCKERS)
      .map(([cat, reason]) => `${cat}: ${reason}`);
    sections.push(`Blockers other flows hit: ${blockers.join(' | ')}`);
  }

  if (input.focusAreas?.length) {
    sections.push(`Strategy focus: ${input.focusAreas.slice(0, input.maxFocusAreas).join(', ')}`);
  }

  if (input.accomplishments?.length) {
    const recent = input.accomplishments.slice(-PRIOR_LEARNINGS_MAX_ACCOMPLISHMENTS);
    // Each entry carries its own outcome ("— done" / "— blocked: …" /
    // "— failed"), so the header must NOT claim they all succeeded.
    sections.push(`What earlier flows already tried: ${recent.join('; ')}`);
  }

  if (!sections.length) return undefined;

  // Drop whole trailing sections rather than slicing the joined string: a blind
  // tail-slice truncates mid-sentence AND eats the last section first, which is
  // exactly the most important one under the ordering above.
  const kept: string[] = [];
  let used = 0;
  for (const section of sections) {
    const cost = kept.length ? section.length + 1 : section.length;
    if (used + cost > PRIOR_LEARNINGS_MAX_CHARS) break;
    kept.push(section);
    used += cost;
  }
  // A single section that alone exceeds the cap still has to be capped.
  if (!kept.length) return sections[0].slice(0, PRIOR_LEARNINGS_MAX_CHARS);

  return kept.join('\n');
}
