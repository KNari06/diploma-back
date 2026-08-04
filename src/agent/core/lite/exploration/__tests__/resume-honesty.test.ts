/**
 * Resume-path honesty (audit bug #8).
 *
 * `resumeFromCheckpoint` deliberately skips Phase 1.5 and Phase 2.5 — it never
 * constructs the Strategist or Sentinel and uses the static queue formula — yet it
 * wrote `status:'completed'` with an EMPTY coverage section, which reads as
 * "assessed, scored 0" rather than "not assessed". It also merged the pre-crash
 * flows back into the result, so the job re-saved them (duplicate rows) and
 * re-charged 10 credits, up to 3 times.
 *
 * The billing half is asserted in the job; here we lock the two data contracts:
 * the summary says coverage was skipped, and already-saved cases are identifiable.
 */

import { markResumedRunSummary } from '../exploration-engine';
import type { ExplorationResult, FlowExplorationTask, DiscoveredTestCase } from '../types';

describe('resumed run summary', () => {
  const resultWithSummary = (): ExplorationResult =>
    ({
      explorationId: 'e1',
      entryUrl: 'https://acme.com/',
      durationMs: 1000,
      tree: [],
      testCases: [],
      summary: { coverageScore: undefined, qualitySummary: undefined, gaps: undefined, recommendations: undefined },
      budgetUsed: {},
    }) as unknown as ExplorationResult;

  it('states that coverage was NOT assessed, rather than leaving it empty', () => {
    const result = resultWithSummary();
    markResumedRunSummary(result);

    expect(result.summary.qualitySummary).toMatch(/resumed/i);
    expect(result.summary.qualitySummary).toMatch(/not assessed/i);
    expect(result.summary.gaps?.join(' ')).toMatch(/skipped/i);
    expect(result.summary.recommendations?.join(' ')).toMatch(/re-run/i);
  });

  it('does not fabricate a coverage score', () => {
    const result = resultWithSummary();
    markResumedRunSummary(result);

    // Leaving it undefined is honest; a 0 would read as "assessed, scored 0".
    expect(result.summary.coverageScore).toBeUndefined();
  });

  it('mentions that flow order was not AI-prioritised', () => {
    const result = resultWithSummary();
    markResumedRunSummary(result);

    expect(result.summary.qualitySummary).toMatch(/prioriti/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate-save guard (the filter the job applies on resume)
// ═══════════════════════════════════════════════════════════════════════════

describe('resume save filter', () => {
  const task = (id: string): FlowExplorationTask =>
    ({ entryPoint: { id } }) as unknown as FlowExplorationTask;
  const discovered = (id: string): DiscoveredTestCase =>
    ({ id, steps: [{ stepNumber: 1 }] }) as unknown as DiscoveredTestCase;

  /** Mirrors the job's filter exactly. */
  const freshOnly = (all: DiscoveredTestCase[], completed: FlowExplorationTask[]) => {
    const alreadySaved = new Set(
      completed.map((t) => t.entryPoint?.id).filter((id): id is string => typeof id === 'string'),
    );
    return all.filter((tc) => !alreadySaved.has(tc.id));
  };

  it('skips cases whose entry point was already completed pre-crash', () => {
    const all = [discovered('ep-1'), discovered('ep-2'), discovered('ep-3')];
    const fresh = freshOnly(all, [task('ep-1'), task('ep-2')]);

    expect(fresh.map((c) => c.id)).toEqual(['ep-3']);
  });

  it('saves everything when the checkpoint completed nothing', () => {
    const all = [discovered('ep-1'), discovered('ep-2')];
    expect(freshOnly(all, [])).toHaveLength(2);
  });

  it('saves nothing when the resume added no new flows', () => {
    const all = [discovered('ep-1')];
    expect(freshOnly(all, [task('ep-1')])).toEqual([]);
  });

  it('ignores malformed checkpoint tasks instead of throwing', () => {
    const all = [discovered('ep-1')];
    const completed = [{}, { entryPoint: {} }, task('ep-9')] as unknown as FlowExplorationTask[];

    expect(() => freshOnly(all, completed)).not.toThrow();
    expect(freshOnly(all, completed)).toHaveLength(1);
  });
});
