/**
 * Tests for `applySession`'s editor-trace contract.
 *
 * Contract:
 *   - A request always writes ONE `mobile_apply_request`.
 *   - A verdict (success OR runner-reported failure) writes ONE result.
 *   - A THROWN apply — the connection died, the runner client rejected, the
 *     client disconnected — still writes ONE result with `success: false`.
 *   - Never two results for one step.
 *
 * Why the throw case matters: `writeMobileApplyResult` used to run only on the
 * success path, so an apply that threw left a request with no result.
 * `trace-analysis.util.ts` counts `mobile_apply_result` with
 * `result.success === false` to derive `failedSteps`, so a throw was invisible —
 * `trace_summary` reported `errors: 0, failedSteps: 0` for a run the UI had
 * shown as failed (observed 2026-07-31, where a 7-minute stall could only be
 * diagnosed from a screenshot because the trace claimed the run was clean).
 *
 * Heavy infra imports are mocked to no-ops so only the controller logic runs.
 */

jest.mock('@/config/environment/env', () => ({ env: {} }));
jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {}, QueueManager: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {}, supabase: {} }));
jest.mock('@/services/mobile/dedicated-device.service', () => ({ resolveDedicatedDevice: jest.fn() }));
jest.mock('@/services/mobile/mobile-runner-client', () => ({ getMobileRunnerClient: jest.fn() }));
jest.mock('@/services/mobile/mobile-runner.types', () => ({ MobileRunnerError: class extends Error {} }));
jest.mock('@/services/core/project.service', () => ({ ProjectService: {} }));
jest.mock('@/services/mobile/project-mobile-app.helper', () => ({ getProjectMobileApp: jest.fn() }));
jest.mock('@/services/testing/ui/preview/editor-trace.service', () => ({ EditorTraceService: { getOrCreate: jest.fn() } }));
jest.mock('@/services/testing/ui/preview/editor-trace-upload', () => ({ uploadEditorTrace: jest.fn() }));
jest.mock('@/services/mobile/mobile-idle.service', () => ({ refreshIdle: jest.fn(), cancelIdle: jest.fn() }));
jest.mock('@/websocket/core/websocket.service', () => ({ webSocketService: {} }));
jest.mock('@/websocket/core/server', () => ({ getIO: jest.fn() }));
jest.mock('@/services/mobile/mobile-app-prep.service', () => ({ MobileAppPrepService: {} }));
jest.mock('@/services/storage/mobile-app-storage.service', () => ({ MobileAppStorageService: {} }));
jest.mock('@/services/mobile/permission-policy.service', () => ({ applyProjectPolicyToSession: jest.fn() }));
jest.mock('@/services/mobile/normalize-description', () => ({ normalizeMobileDescription: (s: string) => s }));
// Dynamically imported inside applySession.
jest.mock('@/services/mobile/mobile-step-apply.service', () => ({
  MobileStepApplyService: { apply: jest.fn() },
}));
// Credit charge is fire-and-forget on the success path; keep it inert.
jest.mock('@/services/core/authoring-credits.service', () => ({
  AuthoringCreditsService: { chargeForMobileApply: jest.fn().mockResolvedValue(undefined) },
}));

import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { MobileStepApplyService } from '@/services/mobile/mobile-step-apply.service';
import { hasInFlight, __resetForTests } from '@/services/mobile/session-inflight.registry';
import { applySession } from '../session.controller';

const getOrCreateMock = EditorTraceService.getOrCreate as jest.Mock;
const applyMock = MobileStepApplyService.apply as jest.Mock;

function makeTrace() {
  return { writeMobileApplyRequest: jest.fn(), writeMobileApplyResult: jest.fn() };
}

function makeRes() {
  const res: any = {};
  res.writableEnded = false;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq() {
  return {
    user: { id: 'user-1' },
    params: { sessionId: 'sess-1' },
    body: { stepDraft: { id: 'step-1', type: 'type', value: '7077812006', elementDescription: 'Phone' } },
    on: jest.fn(),
    off: jest.fn(),
  } as any;
}

describe('applySession editor-trace contract', () => {
  let trace: ReturnType<typeof makeTrace>;

  beforeEach(() => {
    jest.clearAllMocks();
    trace = makeTrace();
    getOrCreateMock.mockReturnValue(trace);
  });

  it('writes a failure result when the apply throws, so the run is not reported clean', async () => {
    applyMock.mockRejectedValue(new Error('Failed to reach mobile runner: socket hang up'));
    const res = makeRes();

    await applySession(makeReq(), res);

    expect(trace.writeMobileApplyRequest).toHaveBeenCalledTimes(1);
    expect(trace.writeMobileApplyResult).toHaveBeenCalledTimes(1);

    const resultArg = trace.writeMobileApplyResult.mock.calls[0][0];
    expect(resultArg.result.success).toBe(false);
    expect(resultArg.result.error).toContain('socket hang up');
    expect(resultArg.stepId).toBe('step-1');
    expect(resultArg.sessionId).toBe('sess-1');
  });

  it('records the real elapsed time on a throw, not a placeholder zero', async () => {
    // How long a failed apply ran is the primary stall diagnostic: ~7 minutes
    // says "the connection died", ~30s says "runner timeout".
    applyMock.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('boom')), 25)),
    );
    const res = makeRes();

    await applySession(makeReq(), res);

    const resultArg = trace.writeMobileApplyResult.mock.calls[0][0];
    expect(resultArg.latencyMs).toBeGreaterThan(0);
  });

  it('still writes the failure result when the client already disconnected', async () => {
    // The early-return path: `res.writableEnded` is true, so there is nobody to
    // respond to — but the trace must still record the failure.
    applyMock.mockRejectedValue(new Error('Request aborted by caller'));
    const res = makeRes();
    res.writableEnded = true;

    await applySession(makeReq(), res);

    expect(trace.writeMobileApplyResult).toHaveBeenCalledTimes(1);
    expect(trace.writeMobileApplyResult.mock.calls[0][0].result.success).toBe(false);
    // Nothing was sent to the (gone) client.
    expect(res.json).not.toHaveBeenCalled();
  });

  it('writes exactly ONE result on the success path', async () => {
    // Guards the double-write risk: the success path traces as soon as the
    // verdict is known, and post-verdict work (credits, compiled-plan persist)
    // must not cause the catch to trace the same step again.
    applyMock.mockResolvedValue({
      success: true,
      stepResult: { success: true, resolvedVia: 'flutter_finder_first', durationMs: 7638 },
      appliedStep: { id: 'step-1' },
      status: 'ok',
    });
    const res = makeRes();

    await applySession(makeReq(), res);

    expect(trace.writeMobileApplyResult).toHaveBeenCalledTimes(1);
    expect(trace.writeMobileApplyResult.mock.calls[0][0].result.success).toBe(true);
  });

  it('writes exactly ONE result when the runner reports a step failure', async () => {
    applyMock.mockResolvedValue({
      success: false,
      stepResult: { success: false, error: 'no element found' },
      status: 'failed',
    });
    const res = makeRes();

    await applySession(makeReq(), res);

    expect(trace.writeMobileApplyResult).toHaveBeenCalledTimes(1);
    expect(trace.writeMobileApplyResult.mock.calls[0][0].result.error).toBe('no element found');
  });
});

describe('applySession in-flight marking', () => {
  // The WebSocket disconnect cleanup consults this to avoid destroying a
  // session mid-step. If the apply path stopped marking the session busy, the
  // guard in connection.handler.ts would silently do nothing.
  beforeEach(() => {
    jest.clearAllMocks();
    __resetForTests();
    getOrCreateMock.mockReturnValue(makeTrace());
  });

  it('marks the session in-flight while the runner call is running', async () => {
    let seenDuring: boolean | null = null;
    applyMock.mockImplementation(async () => {
      seenDuring = hasInFlight('sess-1');
      return { success: true, stepResult: { success: true }, status: 'ok' };
    });

    await applySession(makeReq(), makeRes());

    expect(seenDuring).toBe(true);
    expect(hasInFlight('sess-1')).toBe(false); // released after
  });

  it('releases the marker when the apply throws', async () => {
    applyMock.mockRejectedValue(new Error('socket hang up'));

    await applySession(makeReq(), makeRes());

    // A leaked marker would block the disconnect cleanup from ever reclaiming
    // this session's emulator.
    expect(hasInFlight('sess-1')).toBe(false);
  });
});
