// `mobile-step-apply.service.ts` imports `session-runner-routing.ts`, which
// imports `redisConnection` from here — a real ioredis client gets
// constructed at module-load time without this mock, hanging the test
// process (it never reaches the guard branch under test, which returns
// before any Redis/runner call, but Jest won't exit while that live handle
// is open). Sibling test files for mobile-runner-client.ts don't need this
// mock because that file never imports session-runner-routing.ts.
jest.mock('@/config/infrastructure/queues', () => ({
  redisConnection: {},
  QueueManager: {},
  mobileTestRunQueue: { getJob: jest.fn() },
  mobileTestRunQueueEvents: {},
}));

import { MobileStepApplyService } from '../mobile-step-apply.service';

describe('MobileStepApplyService.apply — link_test_case guard', () => {
  it('rejects a link_test_case step draft with a stepResult.error, not just the top-level error', async () => {
    const output = await MobileStepApplyService.apply({
      sessionId: 'session-1',
      stepDraft: { id: 'step-1', type: 'link_test_case', options: { linkTestCase: { linkedTestCaseId: 'tc-2' } } },
      userId: 'user-1',
    });

    expect(output.success).toBe(false);
    expect(output.status).toBe('failed');
    // Every caller of this service (REST controller response, the mobile
    // editor's single-step "Apply" handler, and the sequential "Run from
    // start" loop) reads `stepResult.error` — never the top-level `error` —
    // to populate the per-step failure reason shown in the step list. Before
    // this fix, `stepResult` was omitted entirely on this branch, so the
    // step showed a red X with no visible reason anywhere in the UI.
    expect(output.stepResult).toBeDefined();
    expect(output.stepResult?.success).toBe(false);
    expect(output.stepResult?.error).toBe(
      'Linked test case steps cannot be applied individually — trigger a regression run to test them.'
    );
    // Top-level error is kept for any caller that still reads it directly.
    expect(output.error).toBe(output.stepResult?.error);
  });

  it('recognizes the step type via `kind` as well as `type` (draft shape from the editor UI)', async () => {
    const output = await MobileStepApplyService.apply({
      sessionId: 'session-1',
      stepDraft: { id: 'step-1', kind: 'link_test_case' },
      userId: 'user-1',
    });

    expect(output.success).toBe(false);
    expect(output.stepResult?.error).toContain('Linked test case steps cannot be applied individually');
  });
});
