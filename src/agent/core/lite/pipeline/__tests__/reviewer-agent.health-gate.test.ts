import { ReviewerAgent } from '../reviewer-agent';
import { TestBlackboard } from '../blackboard';
import type { PageHealth } from '../../collectors/page-health';

/**
 * Health-gate behaviour in ReviewerAgent.review() — the deterministic
 * (pre-AI) path. These verdicts are guaranteed by code, not by the LLM, so
 * they're worth pinning: a server error must escalate replan → blocked on a
 * persistent outage, and a recovered round must reset the streak.
 */
function bbWithHealth(health: PageHealth | undefined): TestBlackboard {
  const bb = new TestBlackboard('goal', 'https://app.test/', 'ep-0', false);
  bb.setPageHealth(health);
  return bb;
}

const serverError = (status = 500): PageHealth => ({
  serverErrorStatus: status,
  hasServerError: true,
  consoleErrorCount: 0,
  sessionLost: false,
});

describe('ReviewerAgent health gate — server error escalation', () => {
  it('returns replan on the first 5xx round (transient)', async () => {
    const bb = bbWithHealth(serverError(500));
    const r = await ReviewerAgent.review(bb);
    expect(r.verdict).toBe('replan');
  });

  it('escalates to blocked once 5xx persists across the threshold', async () => {
    const bb = bbWithHealth(serverError(503));
    const first = await ReviewerAgent.review(bb);
    expect(first.verdict).toBe('replan');
    // Same blackboard, still 5xx → second consecutive round escalates.
    const second = await ReviewerAgent.review(bb);
    expect(second.verdict).toBe('blocked');
    expect(second.reason).toMatch(/persist/i);
  });

  it('resets the streak after a clean round (recovered app is not escalated)', async () => {
    const bb = bbWithHealth(serverError(500));
    await ReviewerAgent.review(bb); // streak = 1 (replan)

    // App recovers: clean round clears the verdict + resets the streak.
    bb.setPageHealth(undefined);
    const clean = await ReviewerAgent.review(bb);
    expect(clean.verdict).not.toBe('blocked');

    // A new 5xx later starts the streak fresh → replan, not immediate blocked.
    bb.setPageHealth(serverError(500));
    const afterRecovery = await ReviewerAgent.review(bb);
    expect(afterRecovery.verdict).toBe('replan');
  });
});

describe('ReviewerAgent health gate — session lost', () => {
  it('returns blocked when the flow was redirected to login', async () => {
    const bb = bbWithHealth({
      hasServerError: false,
      consoleErrorCount: 0,
      sessionLost: true,
    });
    const r = await ReviewerAgent.review(bb);
    expect(r.verdict).toBe('blocked');
    expect(r.reason).toMatch(/session|login/i);
  });
});
