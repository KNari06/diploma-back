/**
 * Integration-level invariants for `EditorIterativeAuthorService.authorTest`.
 *
 * Scope (deliberate): the SERVICE-level interplay the unit tests don't cover —
 * ownership gate, the shared run-lock (mutex with Run-All), the WS progress
 * lifecycle, pipeline wiring, and listener cleanup. Collaborators (preview
 * session, TestPipeline, executor/tracker/detector, WS) are mocked at their
 * module boundary; we drive the real service logic.
 *
 * Each test maps to ONE invariant a future refactor must preserve:
 *   - Risk: writes to a session not owned by the user
 *   - Risk: two runs mutate one preview at once (recording/apply/Run-All race)
 *   - Risk: WS bubble started but never finalized → frontend spinner hangs
 *   - Risk: network listeners leak on the long-lived preview page
 *   - Contract: TestPipeline is driven against the LIVE preview page
 */

// ── Hoisted mock state ────────────────────────────────────────────────────
const wsEmits: Array<{ event: string; payload: any }> = [];
const stopTrackingCalls: number[] = [];
let pipelineRunImpl: () => Promise<any> = async () => ({
  success: true, roundsExecuted: 2, reason: 'Goal achieved', rounds: [],
});
let onRoundCompleteCapture: ((round: any) => void) | undefined;

const fakePage = { url: () => 'https://x.test/login' };
let sessionOwned = true;
let pagePresent = true;

jest.mock('@/services/testing/ui/preview/preview-session.service', () => ({
  getPreviewSessionService: () => ({
    isSessionOwned: () => sessionOwned,
    getPage: () => (pagePresent ? fakePage : null),
    getContext: () => null,
  }),
}));

jest.mock('@/websocket/core/websocket.service', () => ({
  webSocketService: {
    emitToUser: (_userId: string, event: string, payload: any) => { wsEmits.push({ event, payload }); },
  },
}));

jest.mock('@/agent/core/lite/execution/action-executor', () => ({
  ActionExecutor: class { constructor(_p: unknown) { /* noop */ } },
}));
jest.mock('@/agent/core/lite/collectors/network-tracker', () => ({
  NetworkTracker: class {
    constructor(_p: unknown) { /* noop */ }
    stopTracking() { stopTrackingCalls.push(Date.now()); }
  },
}));
jest.mock('@/agent/core/lite/analysis/goal-detector', () => ({
  GoalDetector: class { constructor(_g: string, _id?: string) { /* noop */ } },
}));

jest.mock('@/agent/core/lite/pipeline/test-pipeline', () => ({
  TestPipeline: class {
    private integrations: any;
    constructor(integrations: any) { this.integrations = integrations; onRoundCompleteCapture = integrations.onRoundComplete; }
    async run() { return pipelineRunImpl(); }
  },
}));

jest.mock('@/agent/core/lite/exploration/pipeline-step-extractor', () => ({
  extractDiscoveredSteps: jest.fn(async () => ({ steps: [{ action: 'click', description: 'Click login' }], stepsByRound: [] })),
  // commandToStep is used by the service's WS bridge — provide a simple passthrough.
  commandToStep: (executed: any, n: number) => ({
    stepNumber: n, action: executed.command?.name === 'fill_field' ? 'fill' : 'click',
    description: executed.result?.output || 'step', ref: executed.command?.args?.ref,
    value: executed.command?.args?.is_sensitive ? undefined : executed.command?.args?.value,
    isSensitive: !!executed.command?.args?.is_sensitive,
  }),
}));

import { EditorIterativeAuthorService } from '@/services/testing/ui/preview/editor-iterative-author.service';
import { PreviewRunService } from '@/services/testing/ui/preview/preview-run.service';

const PSID = 'preview_int_test';
const params = (over: Record<string, unknown> = {}) => ({
  previewSessionId: PSID, userId: 'user-1', goal: 'test login', ...over,
});

beforeEach(() => {
  wsEmits.length = 0;
  stopTrackingCalls.length = 0;
  sessionOwned = true;
  pagePresent = true;
  onRoundCompleteCapture = undefined;
  pipelineRunImpl = async () => ({ success: true, roundsExecuted: 2, reason: 'Goal achieved', rounds: [] });
  PreviewRunService.__dangerousClearRunsForTests();
});

describe('ownership gate', () => {
  it('refuses to author on a session the user does not own (no lock, no WS)', async () => {
    sessionOwned = false;
    const res = await EditorIterativeAuthorService.authorTest(params());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no active editor preview session/i);
    expect(PreviewRunService.isRunning(PSID)).toBe(false);
    expect(wsEmits).toHaveLength(0);
  });

  it('refuses when the session has no live page', async () => {
    pagePresent = false;
    const res = await EditorIterativeAuthorService.authorTest(params());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no live page/i);
  });
});

describe('run mutex (shared with Run-All)', () => {
  it('holds isRunning() true DURING authoring and releases it after', async () => {
    let observedDuringRun = false;
    pipelineRunImpl = async () => {
      observedDuringRun = PreviewRunService.isRunning(PSID);
      return { success: true, roundsExecuted: 1, reason: 'ok', rounds: [] };
    };
    await EditorIterativeAuthorService.authorTest(params());
    expect(observedDuringRun).toBe(true);          // locked while running
    expect(PreviewRunService.isRunning(PSID)).toBe(false); // released after
  });

  it('rejects a second author while one is in progress (no double-run)', async () => {
    // Pre-acquire the lock to simulate an in-flight run.
    const held = PreviewRunService.acquireRunLock(PSID);
    expect(held).not.toBeNull();
    const res = await EditorIterativeAuthorService.authorTest(params());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already in progress/i);
    held!.release();
  });

  it('releases the lock even when the pipeline throws', async () => {
    pipelineRunImpl = async () => { throw new Error('pipeline boom'); };
    const res = await EditorIterativeAuthorService.authorTest(params());
    expect(res.success).toBe(false);
    expect(PreviewRunService.isRunning(PSID)).toBe(false); // lock not leaked
  });
});

describe('WS progress lifecycle', () => {
  it('emits started → completed (always paired) on success', async () => {
    await EditorIterativeAuthorService.authorTest(params());
    const events = wsEmits.map((e) => e.event);
    expect(events).toContain('preview:run:started');
    expect(events).toContain('preview:run:completed');
    expect(wsEmits.find((e) => e.event === 'preview:run:started')!.payload.ephemeral).toBe(true);
  });

  it('still emits completed when the pipeline throws (no hung spinner)', async () => {
    pipelineRunImpl = async () => { throw new Error('boom'); };
    await EditorIterativeAuthorService.authorTest(params());
    const events = wsEmits.map((e) => e.event);
    expect(events).toContain('preview:run:started');
    expect(events).toContain('preview:run:completed');
    expect(wsEmits.find((e) => e.event === 'preview:run:completed')!.payload.success).toBe(false);
  });

  it('streams a preview:run:step per successful command via onRoundComplete', async () => {
    pipelineRunImpl = async () => {
      // Simulate the pipeline calling back with a completed round mid-run.
      onRoundCompleteCapture?.({
        commands: [
          { command: { name: 'click_element', args: { ref: 'e1' } }, result: { success: true, output: 'Clicked' } },
          { command: { name: 'fill_field', args: { ref: 'e2', value: 'x' } }, result: { success: false, output: '' } }, // failed → skipped
        ],
      });
      return { success: true, roundsExecuted: 1, reason: 'ok', rounds: [] };
    };
    await EditorIterativeAuthorService.authorTest(params());
    const steps = wsEmits.filter((e) => e.event === 'preview:run:step');
    expect(steps).toHaveLength(1); // only the successful command became a step
    expect(steps[0].payload.status).toBe('pass');
    expect(steps[0].payload.stepIndex).toBe(0);
  });

  it('never emits a sensitive value on the WS step path', async () => {
    pipelineRunImpl = async () => {
      onRoundCompleteCapture?.({
        commands: [
          { command: { name: 'fill_field', args: { ref: 'e1', value: 'hunter2', is_sensitive: true } }, result: { success: true, output: 'Filled' } },
        ],
      });
      return { success: true, roundsExecuted: 1, reason: 'ok', rounds: [] };
    };
    await EditorIterativeAuthorService.authorTest(params());
    const step = wsEmits.find((e) => e.event === 'preview:run:step');
    expect(step).toBeDefined();
    expect(step!.payload.value).toBeUndefined(); // secret never on the wire
    expect(JSON.stringify(step!.payload)).not.toContain('hunter2');
  });
});

describe('cleanup', () => {
  it('always detaches the network tracker (no listener leak), even on throw', async () => {
    await EditorIterativeAuthorService.authorTest(params());
    expect(stopTrackingCalls).toHaveLength(1);

    stopTrackingCalls.length = 0;
    pipelineRunImpl = async () => { throw new Error('boom'); };
    await EditorIterativeAuthorService.authorTest(params());
    expect(stopTrackingCalls).toHaveLength(1);
  });
});
