/**
 * Tests for `lintSession`'s editor-trace contract.
 *
 * Contract:
 *   - A request always writes ONE `mobile_lint_request` with a correlation id.
 *   - A successful resolve forwards `framework` + the same `requestId` onto the
 *     `mobile_lint_result`.
 *   - A thrown/timed-out lint STILL writes a `mobile_lint_result` (status:'error')
 *     with the same `requestId` — the gap that made failed "Order" searches leave
 *     no trace row at all — and responds 500.
 *
 * Heavy infra imports (redis/queues/websocket/storage) are mocked to no-ops so
 * only the controller logic runs.
 */

jest.mock('@/config/environment/env', () => ({ env: {} }));
jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {}, QueueManager: {} }));
// session.controller transitively imports the dedicated-device service → supabase
// client (throws without env). Stub both so only the controller logic runs.
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
// Dynamically imported inside lintSession — identity normalizer keeps input intact.
jest.mock('@/services/mobile/normalize-description', () => ({ normalizeMobileDescription: (s: string) => s }));

import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { lintSession } from '../session.controller';

const getClientMock = getMobileRunnerClient as jest.Mock;
const getOrCreateMock = EditorTraceService.getOrCreate as jest.Mock;

function makeTrace() {
  return { writeMobileLintRequest: jest.fn(), writeMobileLintResult: jest.fn() };
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeReq() {
  return {
    user: { id: 'user-1' },
    params: { sessionId: 'sess-1' },
    body: { stepDraft: { type: 'tap', elementDescription: 'Order' } },
  } as any;
}

describe('lintSession editor-trace contract', () => {
  let trace: ReturnType<typeof makeTrace>;
  let lintElement: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    trace = makeTrace();
    getOrCreateMock.mockReturnValue(trace);
    lintElement = jest.fn();
    // The lint precheck calls sessionExists() before resolving — default it to
    // alive so these trace-contract tests exercise the resolve path, not the
    // session-gone 410 branch (covered by its own describe below).
    getClientMock.mockReturnValue({ lintElement, sessionExists: jest.fn().mockResolvedValue(true) });
  });

  it('writes a result with status:error and the request id when the lint throws', async () => {
    lintElement.mockRejectedValue(new Error('runner timeout'));
    const res = makeRes();

    await lintSession(makeReq(), res);

    expect(trace.writeMobileLintRequest).toHaveBeenCalledTimes(1);
    expect(trace.writeMobileLintResult).toHaveBeenCalledTimes(1);

    const reqId = trace.writeMobileLintRequest.mock.calls[0][0].requestId;
    expect(typeof reqId).toBe('string');

    const resultArg = trace.writeMobileLintResult.mock.calls[0][0];
    expect(resultArg.requestId).toBe(reqId); // paired to the request
    expect(resultArg.result.status).toBe('error');
    expect(resultArg.result.message).toBe('runner timeout');
    expect(resultArg.description).toBe('Order');
    expect(resultArg.actionType).toBe('tap');

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('forwards framework and the request id on a successful resolve', async () => {
    lintElement.mockResolvedValue({
      status: 'resolved',
      framework: 'flutter',
      topNodes: [{ type: 'FlutterView', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }],
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
      screenSize: { width: 100, height: 100 },
    });
    const res = makeRes();

    await lintSession(makeReq(), res);

    const reqId = trace.writeMobileLintRequest.mock.calls[0][0].requestId;
    const resultArg = trace.writeMobileLintResult.mock.calls[0][0];
    expect(resultArg.requestId).toBe(reqId);
    expect(resultArg.framework).toBe('flutter');
    expect(resultArg.result.status).toBe('resolved');
    expect(resultArg.result.topNodes).toEqual([
      { type: 'FlutterView', bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
    ]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, status: 'resolved' }));
  });

  it('does NOT write an orphan result when the throw precedes the request event', async () => {
    // A throw before writeMobileLintRequest (e.g. client init / module import)
    // must not emit a result row with no paired request. lintStart guards it.
    getClientMock.mockImplementation(() => {
      throw new Error('client init failed');
    });
    const res = makeRes();

    await lintSession(makeReq(), res);

    expect(trace.writeMobileLintRequest).not.toHaveBeenCalled();
    expect(trace.writeMobileLintResult).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('lintSession liveness precheck (session-gone diagnostics)', () => {
  let sessionExists: jest.Mock;
  let getSessionDestroyReason: jest.Mock;
  let writeMobileSessionExpiredSurfaced: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    sessionExists = jest.fn();
    getSessionDestroyReason = jest.fn();
    writeMobileSessionExpiredSurfaced = jest.fn();
    getOrCreateMock.mockReturnValue({
      writeMobileLintRequest: jest.fn(),
      writeMobileLintResult: jest.fn(),
      writeMobileSessionExpiredSurfaced,
    });
    getClientMock.mockReturnValue({ sessionExists, getSessionDestroyReason, lintElement: jest.fn() });
  });

  it('returns a typed 410 carrying the runner destroy reason when the session is gone', async () => {
    sessionExists.mockResolvedValue(false);
    getSessionDestroyReason.mockResolvedValue('evicted');
    const res = makeRes();

    await lintSession(makeReq(), res);

    expect(getSessionDestroyReason).toHaveBeenCalledWith('sess-1');
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SESSION_EXPIRED',
      reason: 'evicted',
    }));
    // The expiry is traced WITH the reason so it's diagnosable from Supabase.
    expect(writeMobileSessionExpiredSurfaced).toHaveBeenCalledWith(
      expect.objectContaining({ surfacedBy: 'lint', reason: 'evicted' }),
    );
  });

  it('still 410s (reason omitted, traced as unknown) when the tombstone is gone', async () => {
    sessionExists.mockResolvedValue(false);
    getSessionDestroyReason.mockResolvedValue(null);
    const res = makeRes();

    await lintSession(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(410);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('SESSION_EXPIRED');
    expect(body).not.toHaveProperty('reason'); // omitted when null
    expect(writeMobileSessionExpiredSurfaced).toHaveBeenCalledWith(
      expect.objectContaining({ surfacedBy: 'lint', reason: 'unknown' }),
    );
  });
});
