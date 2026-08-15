/**
 * A draft run must be budgeted per step, not per command.
 *
 * `executeBatchCommands` posts the whole authored array in ONE request, and the
 * runner serialises it — each step pays its own settle. The client's
 * `defaultTimeoutMs` (30s) is sized for a SINGLE command, and on JanaPost a
 * single tap's settle was measured at ~28s (754-node Flutter tree). So the
 * budget was already under water at two steps.
 *
 * What makes it worth a test rather than a constant bump: the failure inverted
 * a success. Live on TC-33 (2026-08-13) the agent finally emitted a complete
 * 6-step draft with real device labels — and the run timed out, so the tool
 * returned "6 steps were cached for save, but none executed" and the turn read
 * as a failure. The steps had in fact run on the device; only the reply was
 * late. The draft tool also carries the missing-scroll advisory, so timing out
 * here silently drops the feedback that would have fixed the next turn.
 */

import { draftRunTimeoutMs, DRAFT_RUN_MAX_MS } from '../tools';

describe('a draft run gets a budget proportional to what it actually does', () => {
  it('gives a 6-step draft six steps worth of budget, not one', () => {
    // The exact shape that failed live: 6 steps under a 30s batch budget.
    expect(draftRunTimeoutMs(6)).toBeGreaterThan(30_000);
    expect(draftRunTimeoutMs(6)).toBe(6 * 60_000);
  });

  it('scales with step count — a longer draft is longer, not more patient', () => {
    expect(draftRunTimeoutMs(2)).toBe(2 * draftRunTimeoutMs(1));
    expect(draftRunTimeoutMs(4)).toBeGreaterThan(draftRunTimeoutMs(3));
  });

  it('keeps a single-step draft at the per-command budget', () => {
    expect(draftRunTimeoutMs(1)).toBe(60_000);
  });

  it('treats an empty array as one step rather than budgeting zero', () => {
    // A zero budget would abort instantly and report the draft as un-run.
    expect(draftRunTimeoutMs(0)).toBe(60_000);
  });

  it('caps a pathological draft so it cannot pin the connection all turn', () => {
    expect(draftRunTimeoutMs(1000)).toBe(DRAFT_RUN_MAX_MS);
  });

  it('does not clamp a draft of realistic length — the cap is for runaways only', () => {
    // A 5-min cap looked reasonable and silently put a 6-step draft back under
    // water, reintroducing the timeout this budget exists to prevent. Any draft
    // this suite actually produces must get its full per-step budget.
    for (const n of [6, 8, 10]) {
      expect(draftRunTimeoutMs(n)).toBe(n * 60_000);
    }
  });
});
